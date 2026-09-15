-- ---------------------------------------------------------------------------
-- Bug-hunt audit (2026-09-15): list_today_queues_full() (and the client's
-- equivalent, listQueues()) scoped "today" using a literal Malaysia
-- calendar-midnight boundary, e.g.
--   (created_at at time zone 'Asia/Kuala_Lumpur')::date = (now() ...)::date
-- rather than this app's own business-date concept
-- (_current_business_date(), added in 20260903000100_overnight_schedule.sql
-- specifically so a shop with overnight hours, e.g. 18:00-01:00, doesn't
-- have its ticket numbering -- or, as found here, its queue LISTING -- reset
-- out from under it at literal midnight).
--
-- Failure scenario this fixes: shop configured 18:00-01:00. A walk-in ticket
-- is taken at 23:50 (still-open business day). The instant the wall clock
-- passes 00:00, that ticket's created_at fails the new day's ">= midnight"
-- filter and disappears from every fresh fetch -- a new customer's phone, a
-- reloaded TV display, a new admin tab never sees it, and a device that
-- already had it cached never sees its status change from another device.
--
-- Fix: a new helper, _business_day_start(), resolves the ACTUAL instant a
-- given business date's shift started (that date's configured `open` time,
-- on that calendar date, in Malaysia time -- or that date's literal
-- midnight if the day has no configured open time). Filtering by
-- `created_at >= _business_day_start(_current_business_date())` correctly
-- captures every record from shift-start through now regardless of which
-- calendar day each individual row's created_at falls on -- unlike a date
-- equality check, this also correctly includes a ticket created in the
-- post-midnight tail of the SAME still-open shift (e.g. 00:20, before the
-- 01:00 close), which a same-business-date equality comparison alone would
-- still incorrectly exclude (that ticket's created_at calendar date is
-- already "tomorrow").
-- ---------------------------------------------------------------------------

create or replace function public._business_day_start(p_date date)
returns timestamptz language plpgsql stable security definer set search_path = public as $$
declare
    v_weekly     jsonb;
    v_ops        jsonb;
    v_open_text  text;
begin
    select weekly_op_hours into v_weekly from public.shop_settings where id = true;
    if v_weekly is null then
        return (p_date::text || ' 00:00')::timestamp at time zone 'Asia/Kuala_Lumpur';
    end if;

    v_ops := v_weekly -> extract(dow from p_date)::integer::text;
    v_open_text := nullif(v_ops ->> 'open', '');
    if v_open_text is null then
        return (p_date::text || ' 00:00')::timestamp at time zone 'Asia/Kuala_Lumpur';
    end if;

    return (p_date::text || ' ' || v_open_text)::timestamp at time zone 'Asia/Kuala_Lumpur';
end $$;

revoke all on function public._business_day_start(date) from public, anon, authenticated;

-- Staff-gated full-row listing: same signature/behaviour, business-day-aware
-- boundary instead of literal calendar-date equality.
create or replace function public.list_today_queues_full()
returns setof public.queues language plpgsql stable security definer set search_path = public as $$
begin
    if not public.is_active_staff() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    return query
        select *
          from public.queues
         where created_at >= public._business_day_start(public._current_business_date())
         order by created_at;
end $$;

-- Anon-safe equivalent of list_today_queues_full(), returning only the same
-- anon-safe column subset as the "queue readable by all" + anon column
-- grants (matches QUEUE_COLUMNS in queueRepository.js exactly). Replaces
-- listQueues()'s previous raw `.from('queues').select(...).gte(...)` query,
-- which duplicated (and got wrong) the business-day boundary math
-- client-side. No is_active_staff() gate -- callable by anon and
-- authenticated alike, same as the table's own "queue readable by all" RLS
-- policy already allows.
create or replace function public.list_today_queues()
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
    called_at         timestamptz
) language plpgsql stable security definer set search_path = public as $$
begin
    return query
        select q.id, q.ticket_no, q.name, q.service, q.duration_minutes, q.seat_no,
               q.barber_id, q.status, q.source, q.is_fast_pass, q.created_at, q.called_at
          from public.queues q
         where q.created_at >= public._business_day_start(public._current_business_date())
         order by q.created_at;
end $$;

revoke all on function public.list_today_queues() from public;
grant execute on function public.list_today_queues() to anon, authenticated;
