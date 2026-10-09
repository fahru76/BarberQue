-- Barber self-service duty ("Mula Bertugas" / "Tamat Bertugas").
--
-- Fahru's request (2026-10-08): each barber has their own page; the chairs in
-- use on a given day are the ones barbers actually start duty on. The NUMBER
-- of chairs stays fixed by admin (shop_settings.seat_count). Decisions:
--   * a barber picks a specific free chair (not auto-assigned);
--   * admin keeps the existing open/assign controls as well -- both can
--     control a chair;
--   * barbers only control duty + break; services/capability/specialty/
--     durations stay admin-set (enforce_staff_self_update_scope unchanged).
--
-- Duty is per business day: seats.duty_date records the business date the
-- chair was opened. A chair left open past the business day is "stale" --
-- call_next_customer() refuses it and start_duty() closes stale chairs
-- before allocating, so a forgotten "Tamat Bertugas" never carries a chair
-- into the next day.

-- 1. state ---------------------------------------------------------------
alter table public.seats add column duty_date date;

comment on column public.seats.duty_date is
    'Business date this chair was opened (by start_duty() or admin). '
    'Active chairs from an earlier business date are stale/expired.';

-- Backfill so chairs open right now stay open on deploy.
update public.seats set duty_date = public._current_business_date() where active;

-- 2. keep duty_date in step for BOTH paths (barber RPC and admin upsert) ---
-- SECURITY DEFINER: admin's direct upsert runs this as `authenticated`,
-- which has no execute right on _current_business_date().
create or replace function public._seats_stamp_duty_date()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if not new.active then
        new.duty_date := null;
    elsif tg_op = 'INSERT'
       or not coalesce(old.active, false)
       or new.barber_id is distinct from old.barber_id
       or new.duty_date is null then
        new.duty_date := public._current_business_date();
    end if;
    return new;
end $$;

revoke all on function public._seats_stamp_duty_date() from public, anon, authenticated;

drop trigger if exists seats_stamp_duty_date on public.seats;
create trigger seats_stamp_duty_date
    before insert or update on public.seats
    for each row execute function public._seats_stamp_duty_date();

alter table public.seats add constraint seats_active_has_duty_date
    check (not active or duty_date is not null);

-- 3. close chairs left open from an earlier business day -----------------
create or replace function public._close_stale_duty_seats()
returns void language plpgsql security definer set search_path = public as $$
begin
    update public.seats
       set active = false, barber_id = null
     where active
       and duty_date < public._current_business_date()
       and not exists (select 1 from public.queues q
                        where q.seat_no = seats.seat_no and q.status = 'serving');
end $$;

revoke all on function public._close_stale_duty_seats() from public, anon, authenticated;

-- 4. start duty on a chosen free chair -----------------------------------
create or replace function public.start_duty(p_seat_no integer)
returns public.seats language plpgsql security definer set search_path = public as $$
declare
    v_me         uuid := auth.uid();
    v_seat_count integer;
    v_current    integer;
    v_seat       public.seats;
begin
    if not public.is_active_staff() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    -- No settings row yet = the column default (3), same as the app's getSeatCount().
    select seat_count into v_seat_count from public.shop_settings limit 1;
    if p_seat_no is null or p_seat_no < 1 or p_seat_no > coalesce(v_seat_count, 3) then
        raise exception 'Kerusi % tidak wujud di kedai ini', p_seat_no using errcode = '22023';
    end if;

    perform public._close_stale_duty_seats();

    select seat_no into v_current from public.seats where barber_id = v_me and active;
    if v_current is not null then
        raise exception 'Anda sudah bertugas di kerusi %', v_current using errcode = '22023';
    end if;

    select * into v_seat from public.seats where seat_no = p_seat_no for update;
    if v_seat.seat_no is not null and v_seat.active then
        raise exception 'Kerusi % sedang digunakan', p_seat_no using errcode = '22023';
    end if;

    -- seats_one_seat_per_barber_uidx is global (active or not): release any
    -- closed chair still carrying this barber's id before taking a new one.
    update public.seats set barber_id = null
     where barber_id = v_me and not active and seat_no <> p_seat_no;

    insert into public.seats (seat_no, active, barber_id)
    values (p_seat_no, true, v_me)
    on conflict (seat_no) do update set active = true, barber_id = v_me
    returning * into v_seat;

    return v_seat;
end $$;

revoke all on function public.start_duty(integer) from public, anon;
grant execute on function public.start_duty(integer) to authenticated;

-- 5. end duty --------------------------------------------------------------
-- p_seat_no null = "my own chair". A specific chair is allowed for its own
-- barber, or any chair for an admin (admin override).
create or replace function public.end_duty(p_seat_no integer default null)
returns public.seats language plpgsql security definer set search_path = public as $$
declare
    v_me   uuid := auth.uid();
    v_seat public.seats;
begin
    if not public.is_active_staff() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    if p_seat_no is null then
        select * into v_seat from public.seats where barber_id = v_me and active for update;
        if v_seat.seat_no is null then
            raise exception 'Anda tidak sedang bertugas' using errcode = '22023';
        end if;
    else
        select * into v_seat from public.seats where seat_no = p_seat_no for update;
        if v_seat.seat_no is null or not v_seat.active then
            raise exception 'Kerusi % tidak dibuka', p_seat_no using errcode = '22023';
        end if;
        if v_seat.barber_id is distinct from v_me and not public.is_admin() then
            raise exception 'Anda tidak ditugaskan pada kerusi ini' using errcode = '42501';
        end if;
    end if;

    if exists (select 1 from public.queues where seat_no = v_seat.seat_no and status = 'serving') then
        raise exception 'Sila selesaikan pelanggan di kerusi % dahulu', v_seat.seat_no using errcode = '22023';
    end if;

    update public.seats set active = false, barber_id = null
     where seat_no = v_seat.seat_no
    returning * into v_seat;
    return v_seat;
end $$;

revoke all on function public.end_duty(integer) from public, anon;
grant execute on function public.end_duty(integer) to authenticated;

-- 6. call_next_customer: refuse a chair whose duty belongs to a past day ---
-- Body copied verbatim from 20261008090000 (the live definition) with ONE
-- addition: a stale-duty check right after the seat lookup.
create or replace function public.call_next_customer(p_seat_no integer)
returns public.queues language plpgsql security definer set search_path = public as $$
declare
    v_barber             uuid := auth.uid();
    v_seat_barber        uuid;
    v_capability         text[];
    v_specialty          text[];
    v_service_durations  jsonb;
    v_covered            boolean;
    v_effective_duration integer;
    v_row                public.queues;
begin
    if not public.is_active_staff() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    select barber_id into v_seat_barber
      from public.seats
     where seat_no = p_seat_no and active;

    if v_seat_barber is null then
        raise exception 'Kerusi % tidak dibuka', p_seat_no using errcode = '22023';
    end if;

    -- Barber self duty (20261008100000): duty is per business day.
    if exists (select 1 from public.seats
                where seat_no = p_seat_no
                  and duty_date < public._current_business_date()) then
        raise exception 'Tugasan di kerusi % sudah tamat (hari perniagaan baharu). Sila Mula Bertugas semula.', p_seat_no using errcode = '22023';
    end if;

    if v_seat_barber <> v_barber and not public.is_admin() then
        raise exception 'Anda tidak ditugaskan pada kerusi ini' using errcode = '42501';
    end if;

    if exists (select 1 from public.queues where seat_no = p_seat_no and status = 'serving') then
        raise exception 'Kerusi % masih melayan pelanggan', p_seat_no using errcode = '22023';
    end if;

    select capability_service_ids, specialty_service_ids, service_durations
      into v_capability, v_specialty, v_service_durations
      from public.staff where id = v_seat_barber;

    -- Tier 1: specialty match, ADDITIONALLY gated on the capability subset
    -- check below (see this migration's header). `service_ids && v_specialty`
    -- is an overlap on purpose -- "is any of this ticket's work something
    -- this barber specialises in" -- but it must never pull in a ticket the
    -- barber is not capable of doing in full.
    if v_specialty is not null and array_length(v_specialty, 1) > 0 then
        select * into v_row
          from public.queues
         where status = 'waiting'
           and service_ids is not null
           and service_ids && v_specialty
           and (v_capability is null or service_ids <@ v_capability)
         order by (case when is_fast_pass then 0 when source = 'booking' then 1 else 2 end), created_at
         limit 1
           for update skip locked;
    end if;

    -- Tier 2: capability match -- the hard gate itself. `service_ids <@
    -- v_capability` reads "every service on this ticket is one this barber
    -- is allowed to perform", which is the actual contract. v_capability is
    -- null = unrestricted; service_ids is null = unknown service, treated as
    -- compatible rather than excluded (see header).
    if v_row.id is null then
        select * into v_row
          from public.queues
         where status = 'waiting'
           and (v_capability is null or service_ids is null or service_ids <@ v_capability)
         order by (case when is_fast_pass then 0 when source = 'booking' then 1 else 2 end), created_at
         limit 1
           for update skip locked;
    end if;

    if v_row.id is null then
        raise exception 'Tiada pelanggan menunggu untuk servis yang anda boleh buat' using errcode = 'P0002';
    end if;

    -- Barber-specific duration override: only applied when this barber has
    -- an explicit, well-formed (1-999 minute) override for EVERY service on
    -- the ticket. Any gap, malformed value, or unknown service_ids falls
    -- back to the ticket's original duration_minutes untouched -- fail-safe
    -- by construction, so a bad/missing override can never break calling a
    -- customer in. (Unchanged from 20260908130000.)
    v_effective_duration := null;
    if v_row.service_ids is not null and array_length(v_row.service_ids, 1) > 0
       and v_service_durations is not null then
        select bool_and(
                 v_service_durations ? svc_id
                 and (v_service_durations ->> svc_id) ~ '^[1-9][0-9]{0,2}$'
               )
          into v_covered
          from unnest(v_row.service_ids) as svc_id;

        if coalesce(v_covered, false) then
            select sum((v_service_durations ->> svc_id)::integer)
              into v_effective_duration
              from unnest(v_row.service_ids) as svc_id;
        end if;
    end if;

    update public.queues
       set status           = 'serving',
           seat_no          = p_seat_no,
           barber_id        = coalesce(v_seat_barber, v_barber),
           called_at        = now(),
           duration_minutes = case
                                 when v_effective_duration between 1 and 480 then v_effective_duration
                                 else duration_minutes
                               end
     where id = v_row.id
    returning * into v_row;

    -- Barber break (20261008090000): calling a customer ends any break.
    update public.seats set break_until = null
     where seat_no = p_seat_no and break_until is not null;

    return v_row;
end $$;

revoke all on function public.call_next_customer(integer) from public;
revoke all on function public.call_next_customer(integer) from anon;
grant execute on function public.call_next_customer(integer) to authenticated;
