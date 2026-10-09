-- Barber short break ("rehat") while on duty.
--
-- Fahru's request (2026-10-08): any registered barber can mark themself on a
-- short break during duty; while they're away the queue flows to the other
-- barbers, and when they return the queue flows back to them.
--
-- Design note: waiting tickets in public.queues are NOT pre-assigned to a
-- barber -- seat_no/barber_id stay null until call_next_customer() pulls the
-- next eligible ticket onto a seat. So "redistribute to other barbers" is
-- already how dispatch works; what was missing is a way to say "this seat is
-- temporarily not pulling", so that:
--   * wait estimates stop counting the absent barber's chair as capacity,
--   * TV/barber screens show the chair as on break instead of idle,
--   * the break auto-expires (a forgotten break never strands a chair).
-- This migration adds that state; nothing about ticket ownership changes.

-- 1. state ---------------------------------------------------------------
alter table public.seats add column break_until timestamptz;

comment on column public.seats.break_until is
    'Barber on short break until this instant. Null or in the past = on duty. '
    'Set via set_seat_break(); cleared automatically when the seat is closed, '
    'reassigned, or its barber calls the next customer.';

-- A closed or unassigned chair cannot be "on break".
alter table public.seats add constraint seats_break_requires_active_barber
    check (break_until is null or (active and barber_id is not null));

-- 2. keep it consistent when admin closes/reassigns a seat ---------------
-- seats_break_requires_active_barber would otherwise make admin's existing
-- setSeatAssignment() upsert FAIL for a seat that happens to be on break.
-- Clearing first keeps the admin flow working exactly as before.
create or replace function public._seats_clear_break_on_reassign()
returns trigger language plpgsql set search_path = public as $$
begin
    if new.active is distinct from true
       or new.barber_id is distinct from old.barber_id then
        new.break_until := null;
    end if;
    return new;
end $$;

drop trigger if exists seats_clear_break_on_reassign on public.seats;
create trigger seats_clear_break_on_reassign
    before update on public.seats
    for each row execute function public._seats_clear_break_on_reassign();

-- 3. set/end a break -------------------------------------------------------
-- SECURITY DEFINER because barbers have no UPDATE right on seats (only
-- "admins manage seats"); this is the one narrow write a barber gets, and
-- it can only touch break_until on their own assigned seat.
--   p_minutes null or 0  -> end break now (back on duty)
--   p_minutes 1..120     -> on break until now() + p_minutes
create or replace function public.set_seat_break(p_seat_no integer, p_minutes integer)
returns public.seats language plpgsql security definer set search_path = public as $$
declare
    v_seat public.seats;
begin
    if not public.is_active_staff() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    select * into v_seat from public.seats where seat_no = p_seat_no for update;

    if v_seat.seat_no is null or not v_seat.active or v_seat.barber_id is null then
        raise exception 'Kerusi % tidak dibuka', p_seat_no using errcode = '22023';
    end if;

    if v_seat.barber_id <> auth.uid() and not public.is_admin() then
        raise exception 'Anda tidak ditugaskan pada kerusi ini' using errcode = '42501';
    end if;

    if coalesce(p_minutes, 0) = 0 then
        update public.seats set break_until = null
         where seat_no = p_seat_no
        returning * into v_seat;
        return v_seat;
    end if;

    if p_minutes not between 1 and 120 then
        raise exception 'Tempoh rehat mesti antara 1 dan 120 minit' using errcode = '22023';
    end if;

    if exists (select 1 from public.queues where seat_no = p_seat_no and status = 'serving') then
        raise exception 'Sila selesaikan pelanggan di kerusi % dahulu', p_seat_no using errcode = '22023';
    end if;

    update public.seats set break_until = now() + make_interval(mins => p_minutes)
     where seat_no = p_seat_no
    returning * into v_seat;
    return v_seat;
end $$;

revoke all on function public.set_seat_break(integer, integer) from public;
revoke all on function public.set_seat_break(integer, integer) from anon;
grant execute on function public.set_seat_break(integer, integer) to authenticated;

-- 4. calling a customer ends the break -------------------------------------
-- Body copied verbatim from 20260916070000 (the live definition) with ONE
-- addition after the queue UPDATE: the seat's break is cleared. A barber
-- pressing "Panggil" is by definition back on duty, so they never have to
-- remember a separate "I'm back" tap for the queue to flow back to them.
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
