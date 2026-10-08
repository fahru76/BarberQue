-- Barber-aware wait estimates.
--
-- Fahru's request (2026-10-08): the "Anggaran" wait shown in the queue should
-- use each barber's own service times (staff.service_durations, now
-- self-editable -- 20261008130000), not only the shop defaults.
--
-- The estimate is computed client-side (index.html's
-- getQueueOccupancyIntervals()), so it needs two things it could not see:
--   1. each waiting ticket's service_ids -- both list RPCs deliberately
--      dropped this column (20260916070000) because no client read it. It
--      is non-sensitive (catalogue ids; the service NAME is already in the
--      anon payload), so it is added back to both.
--   2. per-chair working data on EVERY surface, incl. a customer's phone:
--      list_seat_profiles() returns, per chair, only whether it is on duty
--      today, its break end, and its barber's capability + own service
--      times. No barber id, name, or any staff PII -- the same data a
--      customer could infer from wait times anyway.

-- 1. list RPCs: + service_ids (return type changes -> drop + recreate) -----
drop function if exists public.list_today_queues();
drop function if exists public.list_today_queues_full();

create function public.list_today_queues()
returns table (
    id                text,
    ticket_no         text,
    name              text,
    service           text,
    duration_minutes  integer,
    seat_no           integer,
    barber_id         uuid,
    status            text,
    source            text,
    is_fast_pass      boolean,
    created_at        timestamptz,
    called_at         timestamptz,
    service_ids       text[]
) language plpgsql stable security definer set search_path = public as $$
begin
    return query
        select q.id, q.ticket_no, q.name, q.service, q.duration_minutes, q.seat_no,
               q.barber_id, q.status, q.source, q.is_fast_pass, q.created_at, q.called_at,
               q.service_ids
          from public.queues q
         where q.created_at >= public._business_day_start(public._current_business_date())
         order by q.created_at;
end $$;

revoke all on function public.list_today_queues() from public;
grant execute on function public.list_today_queues() to anon, authenticated;

create function public.list_today_queues_full()
returns table (
    id                text,
    ticket_no         text,
    name              text,
    phone             text,
    service           text,
    duration_minutes  integer,
    price_sen         integer,
    seat_no           integer,
    barber_id         uuid,
    barber_name       text,
    status            text,
    source            text,
    is_fast_pass      boolean,
    approved_by       uuid,
    approval_reason   text,
    approved_at       timestamptz,
    revoked_by        uuid,
    revoked_reason    text,
    revoked_at        timestamptz,
    created_at        timestamptz,
    called_at         timestamptz,
    completed_at      timestamptz,
    cancelled_at      timestamptz,
    cancelled_by      uuid,
    cancel_reason     text,
    version           integer,
    service_ids       text[]
) language plpgsql stable security definer set search_path = public as $$
begin
    if not public.is_active_staff() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    return query
        select q.id, q.ticket_no, q.name, q.phone, q.service, q.duration_minutes,
               q.price_sen, q.seat_no, q.barber_id, q.barber_name, q.status,
               q.source, q.is_fast_pass, q.approved_by, q.approval_reason,
               q.approved_at, q.revoked_by, q.revoked_reason, q.revoked_at,
               q.created_at, q.called_at, q.completed_at, q.cancelled_at,
               q.cancelled_by, q.cancel_reason, q.version, q.service_ids
          from public.queues q
         where q.created_at >= public._business_day_start(public._current_business_date())
         order by q.created_at;
end $$;

revoke all on function public.list_today_queues_full() from public, anon;
grant  execute on function public.list_today_queues_full() to authenticated;

-- 2. per-chair profile for the estimator -----------------------------------
create or replace function public.list_seat_profiles()
returns table (
    seat_no                integer,
    on_duty                boolean,
    break_until            timestamptz,
    capability_service_ids text[],
    service_durations      jsonb
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
               case when s.active then st.service_durations end
          from public.seats s
          left join public.staff st on st.id = s.barber_id
         order by s.seat_no;
end $$;

revoke all on function public.list_seat_profiles() from public;
grant execute on function public.list_seat_profiles() to anon, authenticated;
