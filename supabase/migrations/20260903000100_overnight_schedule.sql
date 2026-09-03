-- ---------------------------------------------------------------------------
-- Overnight (midnight-crossing) shop schedule support -- server-side mirror
--
-- Requested directly: "No support for a same-day shop schedule that crosses
-- midnight (e.g. 18:00-01:00)". The client-side fix (index.html,
-- js/domain/time.js, js/domain/scheduler.js) chose the "shift to a business
-- day" model: a booking or ticket taken during the post-midnight tail of a
-- shift belongs to the PREVIOUS calendar day's business day (the day the
-- shift opened) -- the same way a bar/club reports a "Friday night" that
-- runs into Saturday morning.
--
-- Two server-side functions had the identical same-day-only bug this fixes:
--
-- 1. _appointment_hours_ok() assumed a day's `close` always comes after its
--    `open` (`if p_start_minutes < v_open or p_end_minutes > v_close then
--    return false`), which incorrectly rejected every slot on an overnight
--    day. Fixed the same way as the client's businessMinutes()/
--    crossesMidnight() helpers (js/domain/time.js): a day whose close is
--    at/before its open crosses midnight, so its close (and any break time
--    that's also past midnight) is understood as running past 1440, and any
--    candidate start/end minute earlier than that day's open is understood
--    as the post-midnight TAIL of the SAME business day.
--
-- 2. next_ticket_number() reset its daily counter at literal Malaysia
--    midnight ((now() at time zone 'Asia/Kuala_Lumpur')::date), which would
--    reset a still-running overnight shift's ticket numbering out from under
--    it. Fixed by resolving "today" through the new _current_business_date()
--    helper instead -- mirrors getCurrentBusinessDate() in index.html.
--
-- Both are CREATE OR REPLACE of already-defined functions with unchanged
-- signatures, so every existing grant/revoke on them still applies -- this
-- migration does not repeat those statements.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- _current_business_date
--
-- Which calendar date's hours currently govern "is the shop open right
-- now" -- almost always today, EXCEPT in the early-morning tail of an
-- overnight shift (e.g. 18:00-01:00) that opened yesterday and hasn't
-- reached its close time yet. Mirrors getCurrentBusinessDate() in
-- index.html exactly, reading the same weekly_op_hours shop setting.
-- Internal only (no grants) -- called from next_ticket_number() below.
-- ---------------------------------------------------------------------------
create or replace function public._current_business_date()
returns date language plpgsql stable security definer set search_path = public as $$
declare
    v_now               timestamptz := now();
    v_today             date := (v_now at time zone 'Asia/Kuala_Lumpur')::date;
    v_now_minutes       integer := extract(hour from (v_now at time zone 'Asia/Kuala_Lumpur'))::integer * 60
                                 + extract(minute from (v_now at time zone 'Asia/Kuala_Lumpur'))::integer;
    v_weekly            jsonb;
    v_today_ops         jsonb;
    v_open_text         text;
    v_today_open        integer;
    v_yesterday         date;
    v_yesterday_ops     jsonb;
    v_yesterday_closed  boolean;
    v_yesterday_open    integer;
    v_yesterday_close   integer;
begin
    select weekly_op_hours into v_weekly from public.shop_settings where id = true;
    if v_weekly is null then return v_today; end if;

    v_today_ops := v_weekly -> extract(dow from v_today)::integer::text;
    v_open_text := nullif(v_today_ops ->> 'open', '');
    -- Today's own business day has unambiguously started once we're at/after
    -- its own open time (or it has none configured) -- covers every normal,
    -- non-crossing day with zero behaviour change.
    if v_open_text is null then return v_today; end if;
    v_today_open := extract(hour from v_open_text::time)::integer * 60 + extract(minute from v_open_text::time)::integer;
    if v_now_minutes >= v_today_open then return v_today; end if;

    -- Otherwise, the only way we could still be "in business" is that
    -- YESTERDAY's shift crossed midnight and its close time (an early-AM
    -- time expressed on TODAY's clock) hasn't arrived yet.
    v_yesterday := v_today - 1;
    v_yesterday_ops := v_weekly -> extract(dow from v_yesterday)::integer::text;
    v_yesterday_closed := coalesce((v_yesterday_ops ->> 'closed')::boolean, true);
    if v_yesterday_closed then return v_today; end if;

    v_open_text := nullif(v_yesterday_ops ->> 'open', '');
    if v_open_text is null then return v_today; end if;
    v_yesterday_open  := extract(hour from v_open_text::time)::integer * 60 + extract(minute from v_open_text::time)::integer;
    v_yesterday_close := extract(hour from (v_yesterday_ops ->> 'close')::time)::integer * 60
                        + extract(minute from (v_yesterday_ops ->> 'close')::time)::integer;

    if v_yesterday_close <= v_yesterday_open and v_now_minutes < v_yesterday_close then
        return v_yesterday;
    end if;
    return v_today;
end $$;

revoke all on function public._current_business_date() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- next_ticket_number -- same signature/behaviour, business-day-aware "today"
-- ---------------------------------------------------------------------------
create or replace function public.next_ticket_number(p_prefix text)
returns text language plpgsql security definer set search_path = public as $$
declare
    v_today date := public._current_business_date();
    v_next  integer;
begin
    if p_prefix is null or p_prefix !~ '^[A-Z]{2,4}$' then
        raise exception 'Invalid ticket prefix: %', p_prefix using errcode = '22023';
    end if;

    insert into public.ticket_counters (counter_date, last_value)
    values (v_today, 1)
    on conflict (counter_date) do update
        set last_value = public.ticket_counters.last_value + 1
    returning last_value into v_next;

    -- Date suffix keeps ids unique across days; getDisplayTicketId() in the client
    -- strips it so the customer still sees a short "PG01".
    return p_prefix || lpad(v_next::text, 2, '0') || '-' || to_char(v_today, 'YYYYMMDD');
end $$;

-- ---------------------------------------------------------------------------
-- _appointment_hours_ok -- same signature/behaviour, now overnight-aware
-- ---------------------------------------------------------------------------
create or replace function public._appointment_hours_ok(
    p_date date, p_start_minutes integer, p_end_minutes integer
) returns boolean language plpgsql stable security definer set search_path = public as $$
declare
    v_day        jsonb;
    v_closed     boolean;
    v_open       integer;
    v_close      integer;
    v_crosses_midnight boolean;
    v_b1s        integer;
    v_b1e        integer;
    v_b2s        integer;
    v_b2e        integer;
    v_closed_dates jsonb;
    v_advance_days integer;
    v_shop_status  text;
    v_today        date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
begin
    select weekly_op_hours, closed_dates, booking_advance_days, shop_status
      into v_day, v_closed_dates, v_advance_days, v_shop_status
      from public.shop_settings where id = true;
    if v_day is null then return false; end if;

    if p_date < v_today or p_date > v_today + coalesce(v_advance_days, 30) then
        return false;
    end if;
    if p_date = v_today and v_shop_status <> 'open' then
        return false;
    end if;

    if v_closed_dates is not null and v_closed_dates @> to_jsonb(p_date::text) then
        return false;
    end if;

    v_day := v_day -> extract(dow from p_date)::integer::text;
    if v_day is null then return false; end if;

    v_closed := coalesce((v_day ->> 'closed')::boolean, true);
    if v_closed then return false; end if;

    v_open  := extract(hour from (v_day ->> 'open')::time)::integer  * 60 + extract(minute from (v_day ->> 'open')::time)::integer;
    v_close := extract(hour from (v_day ->> 'close')::time)::integer * 60 + extract(minute from (v_day ->> 'close')::time)::integer;

    -- Overnight-schedule support (e.g. open 18:00, close 01:00): mirrors
    -- businessMinutes()/crossesMidnight() in js/domain/time.js. A day whose
    -- close is at/before its own open crosses midnight; its close (and any
    -- raw start/end minute earlier than open) is then understood as running
    -- past 1440, extending onto the business day's own continuous axis
    -- instead of being rejected as "before opening". A same-day config
    -- (close > open) is completely unaffected by every line below.
    v_crosses_midnight := v_close <= v_open;
    if v_crosses_midnight then
        v_close := v_close + 1440;
        if p_start_minutes < v_open then p_start_minutes := p_start_minutes + 1440; end if;
        if p_end_minutes   < v_open then p_end_minutes   := p_end_minutes + 1440; end if;
    end if;

    if p_start_minutes < v_open or p_end_minutes > v_close then return false; end if;

    if nullif(v_day ->> 'break1Start', '') is not null and nullif(v_day ->> 'break1End', '') is not null then
        v_b1s := extract(hour from (v_day ->> 'break1Start')::time)::integer * 60 + extract(minute from (v_day ->> 'break1Start')::time)::integer;
        v_b1e := extract(hour from (v_day ->> 'break1End')::time)::integer   * 60 + extract(minute from (v_day ->> 'break1End')::time)::integer;
        if v_crosses_midnight and v_b1s < v_open then v_b1s := v_b1s + 1440; end if;
        if v_crosses_midnight and v_b1e < v_open then v_b1e := v_b1e + 1440; end if;
        if p_start_minutes < v_b1e and p_end_minutes > v_b1s then return false; end if;
    end if;

    if nullif(v_day ->> 'break2Start', '') is not null and nullif(v_day ->> 'break2End', '') is not null then
        v_b2s := extract(hour from (v_day ->> 'break2Start')::time)::integer * 60 + extract(minute from (v_day ->> 'break2Start')::time)::integer;
        v_b2e := extract(hour from (v_day ->> 'break2End')::time)::integer   * 60 + extract(minute from (v_day ->> 'break2End')::time)::integer;
        if v_crosses_midnight and v_b2s < v_open then v_b2s := v_b2s + 1440; end if;
        if v_crosses_midnight and v_b2e < v_open then v_b2e := v_b2e + 1440; end if;
        if p_start_minutes < v_b2e and p_end_minutes > v_b2s then return false; end if;
    end if;

    return true;
end $$;
