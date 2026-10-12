-- Barber rest = chair closed for serving (no fixed duration).
--
-- Fahru's request (2026-10-12): a barber's rest is no longer a 10-60 minute
-- timer. While he rests, his chair is closed for serving: the queue is
-- projected onto, and called by, the barbers still working, and once he is
-- back the queue flows back to his chair. Rest lasts until he presses
-- "Kembali Bertugas" (or calls a customer). A barber is paid by how many
-- customers he serves, so a resting chair must never hold waiting customers
-- and a returning barber must be back in rotation at once.
--
-- Why a new flag instead of seats.active = false: an inactive chair also
-- lowers walk-in intake (the app refuses walk-ins when no chair is active)
-- and online-booking capacity (counts active chairs). The barber is still on
-- shift, so those stay unchanged; only serving and wait estimates skip a
-- resting chair. He also keeps his chair -- nobody else can start duty on it.
--
-- seats.break_until / set_seat_break() (20261008090000) stay in place so a
-- browser still running the previous page keeps working; the new page no
-- longer sets timed breaks.

-- 1. state ---------------------------------------------------------------
alter table public.seats add column resting_since timestamptz;

comment on column public.seats.resting_since is
    'Set while the chair''s barber is resting: the chair is closed for '
    'serving and wait estimates but stays his and stays open for intake. '
    'Set/cleared via set_seat_rest(); also cleared when the chair is closed, '
    'reassigned, or a customer is called to it.';

alter table public.seats add constraint seats_rest_requires_active_barber
    check (resting_since is null or (active and barber_id is not null));

-- 2. closing/reassigning a chair ends the rest ----------------------------
-- Same trigger 20261008090000 created for break_until, extended to the rest
-- flag so admin's existing setSeatAssignment() upsert and end_duty() never
-- trip seats_rest_requires_active_barber.
create or replace function public._seats_clear_break_on_reassign()
returns trigger language plpgsql set search_path = public as $$
begin
    if new.active is distinct from true
       or new.barber_id is distinct from old.barber_id then
        new.break_until := null;
        new.resting_since := null;
    end if;
    return new;
end $$;

-- 3. start/end rest ----------------------------------------------------------
-- SECURITY DEFINER for the same reason as set_seat_break(): barbers have no
-- UPDATE right on seats; this only touches the rest flag of their own chair
-- (admin: any chair).
create or replace function public.set_seat_rest(p_seat_no integer, p_resting boolean)
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

    if coalesce(p_resting, false) then
        if exists (select 1 from public.queues where seat_no = p_seat_no and status = 'serving') then
            raise exception 'Sila selesaikan pelanggan di kerusi % dahulu', p_seat_no using errcode = '22023';
        end if;
        update public.seats
           set resting_since = coalesce(resting_since, now()),
               break_until   = null
         where seat_no = p_seat_no
        returning * into v_seat;
    else
        update public.seats
           set resting_since = null,
               break_until   = null
         where seat_no = p_seat_no
        returning * into v_seat;
    end if;

    return v_seat;
end $$;

revoke all on function public.set_seat_rest(integer, boolean) from public;
revoke all on function public.set_seat_rest(integer, boolean) from anon;
grant execute on function public.set_seat_rest(integer, boolean) to authenticated;

-- 4. calling a customer to a chair ends its rest ---------------------------
-- Covers call_next_customer() and call_specific_customer() without
-- redefining either: a barber pressing "Panggil" is back at his chair.
create or replace function public._queues_end_rest_on_call()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    update public.seats
       set resting_since = null
     where seat_no = new.seat_no
       and resting_since is not null;
    return null;
end $$;

revoke all on function public._queues_end_rest_on_call() from public, anon, authenticated;

drop trigger if exists queues_end_rest_on_call on public.queues;
create trigger queues_end_rest_on_call
    after update of status on public.queues
    for each row
    when (new.status = 'serving' and new.seat_no is not null
          and old.status is distinct from 'serving')
    execute function public._queues_end_rest_on_call();

-- 5. estimator profile: expose the rest flag -------------------------------
-- Return type changes, so drop and recreate (same body as 20261008140000
-- plus the `resting` column). on_duty is unchanged on purpose: a resting
-- barber is still on shift, so intake is not affected.
drop function if exists public.list_seat_profiles();

create function public.list_seat_profiles()
returns table (
    seat_no                integer,
    on_duty                boolean,
    break_until            timestamptz,
    capability_service_ids text[],
    service_durations      jsonb,
    resting                boolean
) language plpgsql stable security definer set search_path = public as $$
declare
    v_today date := public._current_business_date();
begin
    return query
        select s.seat_no,
               (s.active and s.barber_id is not null
                and (s.duty_date is null or s.duty_date >= v_today)) as on_duty,
               case when s.break_until > now() then s.break_until end,
               case when s.active then st.capability_service_ids end,
               case when s.active then st.service_durations end,
               (s.active and s.resting_since is not null) as resting
          from public.seats s
          left join public.staff st on st.id = s.barber_id
         order by s.seat_no;
end $$;

revoke all on function public.list_seat_profiles() from public;
grant execute on function public.list_seat_profiles() to anon, authenticated;
