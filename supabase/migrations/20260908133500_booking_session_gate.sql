-- Migration: optional pagi/petang/malam session gate for same-day online
-- booking.
--
-- Fahru's request: a customer must not be able to book online for a session
-- (pagi/petang/malam) that is currently happening or already past, TODAY
-- only -- e.g. if it is currently petang, only malam is bookable today;
-- tomorrow and later dates are completely unrestricted regardless of the
-- current time. Confirmed decisions:
--   - Admin sets the two session cut-off times (pagi->petang, petang->malam)
--     per day of week, in the same "Waktu Operasi" panel as open/close/
--     break times, stored as two more keys (sessionSplit1, sessionSplit2)
--     inside the existing weekly_op_hours jsonb -- no schema change needed.
--     Both blank (the default) means this shop hasn't opted in for that
--     day; behaviour is completely unchanged.
--   - If "now" is still before the shop's own open time, the pagi session
--     hasn't started yet, so pagi (and every later session) remains
--     bookable today.
--   - A session with no actual slots (fully covered by a break, or the
--     day's hours) simply shows no bookable times for it -- no special
--     casing needed, the existing slot/capacity checks already produce
--     that.
--
-- This mirrors the equivalent client-side change in
-- isAppointmentSlotAvailable() (index.html) exactly, including the
-- overnight "+1440" axis shift every other time comparison in this
-- function already uses. Client and server must agree, since this function
-- is the one thing book_appointment()/reschedule_own_appointment()/
-- convert_walkin_to_appointment() all call to reject a slot outside
-- operating hours -- a client-only check would just be UX, not enforcement.
--
-- create or replace, same signature -- every existing grant/revoke on this
-- function still applies, not repeated here.
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
    v_sess1_text     text;
    v_sess2_text     text;
    v_petang_start   integer;
    v_malam_start    integer;
    v_now_minutes    integer;
    v_session_start  integer;
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

    -- Session gate (see migration header comment). Only ever tightens things
    -- for TODAY -- a future date is untouched, and a day with either split
    -- blank behaves exactly as before this migration.
    if p_date = v_today then
        v_sess1_text := nullif(v_day ->> 'sessionSplit1', '');
        v_sess2_text := nullif(v_day ->> 'sessionSplit2', '');
        if v_sess1_text is not null and v_sess2_text is not null then
            v_petang_start := extract(hour from v_sess1_text::time)::integer * 60 + extract(minute from v_sess1_text::time)::integer;
            v_malam_start  := extract(hour from v_sess2_text::time)::integer * 60 + extract(minute from v_sess2_text::time)::integer;
            if v_crosses_midnight and v_petang_start < v_open then v_petang_start := v_petang_start + 1440; end if;
            if v_crosses_midnight and v_malam_start  < v_open then v_malam_start  := v_malam_start  + 1440; end if;

            v_now_minutes := extract(hour from (now() at time zone 'Asia/Kuala_Lumpur'))::integer * 60
                            + extract(minute from (now() at time zone 'Asia/Kuala_Lumpur'))::integer;
            if v_crosses_midnight and v_now_minutes < v_open then v_now_minutes := v_now_minutes + 1440; end if;

            -- p_start_minutes was already shifted onto the same +1440 axis
            -- above when v_crosses_midnight, so this comparison is apples
            -- to apples with v_petang_start/v_malam_start.
            v_session_start := case
                when p_start_minutes < v_petang_start then v_open
                when p_start_minutes < v_malam_start  then v_petang_start
                else v_malam_start
            end;
            if v_now_minutes >= v_session_start then return false; end if;
        end if;
    end if;

    return true;
end $$;
