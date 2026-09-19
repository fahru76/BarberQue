-- ---------------------------------------------------------------------------
-- Bug hunt (2026-09-19, H2) -- same-day booking capacity now counts the live
-- walk-in queue, walk-ins taking precedence.
--
-- Requested directly: "I want to prioritize more for walk-in queue first,
-- thus will be in counts." A walk-in customer is physically present and takes
-- precedence over an online booking, so a same-day online booking must NOT be
-- confirmable into a chair the live walk-in queue will already be using.
--
-- Previously _appointment_slot_capacity_ok() (20260901000700, hardened for
-- overnight days in 20260918100000) counted ONLY other upcoming appointments
-- for that date. The deliberate scope note in 20260901000700 said modelling
-- today's live walk-in occupancy was "a client-side-only, honestly
-- best-effort refinement" -- which meant the authoritative server check and
-- the customer-facing slot picker DISAGREED about whether a same-day slot was
-- available: the client (isAppointmentSlotAvailable, which already folds in
-- getQueueOccupancyIntervals) would reject a slot the server then accepted
-- for a different customer whose local queue view was stale/empty.
--
-- This closes that gap server-side for the SAME-DAY case (p_date = the current
-- business date). For any FUTURE date there is no live queue to count, so the
-- behaviour is exactly as before.
--
-- The walk-in occupancy model mirrors the client's buildOccupancyIntervals()
-- (js/domain/scheduler.js and the inline copy in index.html):
--   * a SERVING ticket holds its seat until called_at + duration_minutes
--     (break policy 'finish_in_progress': the customer in the chair is
--     completed, so the interval is NOT extended over a break);
--   * WAITING tickets then fill the earliest free gap on any active seat in
--     priority order -- fast-pass, then booking, then FIFO by created_at --
--     with a candidate start that never straddles a configured break
--     (moveServicePastBreak).
-- Only queue records that still overlap "now" occupy anything; a serving
-- ticket whose service would already have ended frees its seat.
--
-- The whole thing runs inside _appointment_slot_capacity_ok(), which
-- book_appointment() / reschedule_own_appointment() /
-- convert_walkin_to_appointment() already call under a per-date advisory lock
-- (pg_advisory_xact_lock on 'appointments:'||p_date), so the queue snapshot
-- and the capacity decision are consistent with other bookings for that day.
-- It is read-only with respect to public.queues, so it cannot deadlock against
-- call_next_customer()'s row locks.
-- ---------------------------------------------------------------------------

create or replace function public._appointment_slot_capacity_ok(
    p_date date, p_start_minutes integer, p_end_minutes integer, p_exclude_id text
) returns boolean language plpgsql stable security definer set search_path = public as $$
declare
    v_seats integer;
    v_minute integer;
    v_count integer;
    v_day jsonb;
    v_open_minutes integer;
    v_close_minutes integer;
    v_crosses_midnight boolean;
    v_existing_start integer;
    v_existing_end integer;

    -- walk-in occupancy (same-day only)
    v_business_date date;
    v_now_minutes integer;
    v_break1_start integer;
    v_break1_end integer;
    v_break2_start integer;
    v_break2_end integer;
    v_seat record;
    v_q record;
    v_seat_schedules jsonb := '{}'::jsonb;      -- seat_no (text) -> jsonb array of [start,end)
    v_seat_key text;
    v_schedule jsonb;
    v_interval jsonb;
    v_called_minutes integer;
    v_svc_start integer;
    v_svc_end integer;
    v_best_seat integer;
    v_best_start integer;
    v_cand_start integer;
    v_iv jsonb;
    v_iv_start integer;
    v_iv_end integer;
    v_overlaps boolean;
    v_walkin_concurrency integer;
begin
    select count(*) into v_seats from public.seats where active;
    if v_seats = 0 then return false; end if;

    select weekly_op_hours -> extract(dow from p_date)::integer::text
      into v_day
      from public.shop_settings
     where id = true;
    if v_day is null or coalesce((v_day ->> 'closed')::boolean, true) then return false; end if;

    v_open_minutes := extract(hour from (v_day ->> 'open')::time)::integer * 60
        + extract(minute from (v_day ->> 'open')::time)::integer;
    v_close_minutes := extract(hour from (v_day ->> 'close')::time)::integer * 60
        + extract(minute from (v_day ->> 'close')::time)::integer;
    v_crosses_midnight := v_close_minutes <= v_open_minutes;

    -- The RPC caller supplies raw clock minutes. Convert the requested interval
    -- to the business-day axis (post-midnight tail of an overnight day runs
    -- past 1440) -- unchanged from 20260918100000.
    if v_crosses_midnight and p_start_minutes < v_open_minutes then
        p_start_minutes := p_start_minutes + 1440;
        p_end_minutes := p_end_minutes + 1440;
    end if;

    -- -----------------------------------------------------------------------
    -- Build today's live walk-in occupancy, ONLY when the booking is for the
    -- current business date. _current_business_date() (20260903000100) is the
    -- same business-day-aware "today" the rest of the system uses, so an
    -- overnight shift's post-midnight tail correctly maps to the day it
    -- opened. For any future p_date there is no live queue to model.
    -- -----------------------------------------------------------------------
    v_business_date := public._current_business_date();
    if p_date = v_business_date then
        v_now_minutes := extract(hour from (now() at time zone 'Asia/Kuala_Lumpur'))::integer * 60
                       + extract(minute from (now() at time zone 'Asia/Kuala_Lumpur'))::integer;
        if v_crosses_midnight and v_now_minutes < v_open_minutes then
            v_now_minutes := v_now_minutes + 1440;
        end if;

        -- Configured breaks on the business-day axis (only well-formed pairs).
        v_break1_start := null; v_break1_end := null; v_break2_start := null; v_break2_end := null;
        if nullif(v_day ->> 'break1Start', '') is not null and nullif(v_day ->> 'break1End', '') is not null then
            v_break1_start := extract(hour from (v_day ->> 'break1Start')::time)::integer * 60 + extract(minute from (v_day ->> 'break1Start')::time)::integer;
            v_break1_end   := extract(hour from (v_day ->> 'break1End')::time)::integer   * 60 + extract(minute from (v_day ->> 'break1End')::time)::integer;
            if v_crosses_midnight and v_break1_start < v_open_minutes then v_break1_start := v_break1_start + 1440; v_break1_end := v_break1_end + 1440;
            elsif v_crosses_midnight and v_break1_end < v_break1_start then v_break1_end := v_break1_end + 1440; end if;
            if v_break1_end <= v_break1_start then v_break1_start := null; v_break1_end := null; end if;
        end if;
        if nullif(v_day ->> 'break2Start', '') is not null and nullif(v_day ->> 'break2End', '') is not null then
            v_break2_start := extract(hour from (v_day ->> 'break2Start')::time)::integer * 60 + extract(minute from (v_day ->> 'break2Start')::time)::integer;
            v_break2_end   := extract(hour from (v_day ->> 'break2End')::time)::integer   * 60 + extract(minute from (v_day ->> 'break2End')::time)::integer;
            if v_crosses_midnight and v_break2_start < v_open_minutes then v_break2_start := v_break2_start + 1440; v_break2_end := v_break2_end + 1440;
            elsif v_crosses_midnight and v_break2_end < v_break2_start then v_break2_end := v_break2_end + 1440; end if;
            if v_break2_end <= v_break2_start then v_break2_start := null; v_break2_end := null; end if;
        end if;

        -- One schedule list per active seat.
        for v_seat in select seat_no from public.seats where active loop
            v_seat_schedules := jsonb_set(v_seat_schedules, array[v_seat.seat_no::text], '[]'::jsonb, true);
        end loop;

        -- 1. SERVING tickets hold their seat from now until called_at+duration.
        --    called_at is a real timestamp; reduce it to shop-local minutes on
        --    the business-day axis. Break policy finish_in_progress: no
        --    extension over a break.
        for v_q in
            select seat_no, called_at, duration_minutes
              from public.queues
             where status = 'serving' and seat_no is not null
        loop
            v_called_minutes := extract(hour from (v_q.called_at at time zone 'Asia/Kuala_Lumpur'))::integer * 60
                              + extract(minute from (v_q.called_at at time zone 'Asia/Kuala_Lumpur'))::integer;
            if v_crosses_midnight and v_called_minutes < v_open_minutes then
                v_called_minutes := v_called_minutes + 1440;
            end if;
            v_svc_start := v_called_minutes;
            v_svc_end := greatest(v_now_minutes, v_svc_start + coalesce(v_q.duration_minutes, 25));
            if v_svc_end > v_now_minutes then
                v_seat_key := v_q.seat_no::text;
                if v_seat_schedules ? v_seat_key then
                    v_seat_schedules := jsonb_set(
                        v_seat_schedules, array[v_seat_key],
                        (v_seat_schedules -> v_seat_key) || jsonb_build_array(jsonb_build_array(v_now_minutes, v_svc_end)),
                        false);
                end if;
            end if;
        end loop;

        -- 2. WAITING tickets fill the earliest free gap on any active seat, in
        --    priority order (fast-pass, booking, FIFO). A candidate start never
        --    straddles a break (moveServicePastBreak).
        for v_q in
            select duration_minutes
              from public.queues
             where status = 'waiting'
             order by (case when is_fast_pass then 0 when source = 'booking' then 1 else 2 end), created_at
        loop
            v_best_seat := null;
            v_best_start := null;
            for v_seat in select seat_no from public.seats where active loop
                v_seat_key := v_seat.seat_no::text;
                v_schedule := v_seat_schedules -> v_seat_key;
                -- earliest start >= now that clears this seat's intervals and breaks
                v_cand_start := v_now_minutes;
                -- move past breaks
                if v_break1_start is not null and v_cand_start < v_break1_end and v_cand_start + coalesce(v_q.duration_minutes,25) > v_break1_start then
                    v_cand_start := v_break1_end; end if;
                if v_break2_start is not null and v_cand_start < v_break2_end and v_cand_start + coalesce(v_q.duration_minutes,25) > v_break2_start then
                    v_cand_start := v_break2_end; end if;
                -- clear overlaps (bounded retry: candidate strictly increases)
                loop
                    v_overlaps := false;
                    for v_iv in select * from jsonb_array_elements(v_schedule) loop
                        v_iv_start := (v_iv ->> 0)::integer;
                        v_iv_end   := (v_iv ->> 1)::integer;
                        if v_cand_start < v_iv_end and v_cand_start + coalesce(v_q.duration_minutes,25) > v_iv_start then
                            v_cand_start := v_iv_end;
                            if v_break1_start is not null and v_cand_start < v_break1_end and v_cand_start + coalesce(v_q.duration_minutes,25) > v_break1_start then
                                v_cand_start := v_break1_end; end if;
                            if v_break2_start is not null and v_cand_start < v_break2_end and v_cand_start + coalesce(v_q.duration_minutes,25) > v_break2_start then
                                v_cand_start := v_break2_end; end if;
                            v_overlaps := true;
                            exit;
                        end if;
                    end loop;
                    exit when not v_overlaps;
                end loop;

                if v_best_start is null or v_cand_start < v_best_start then
                    v_best_start := v_cand_start;
                    v_best_seat := v_seat.seat_no;
                end if;
            end loop;

            if v_best_seat is not null then
                v_seat_key := v_best_seat::text;
                v_seat_schedules := jsonb_set(
                    v_seat_schedules, array[v_seat_key],
                    (v_seat_schedules -> v_seat_key) || jsonb_build_array(jsonb_build_array(v_best_start, v_best_start + coalesce(v_q.duration_minutes,25))),
                    false);
            end if;
        end loop;
    end if;

    -- -----------------------------------------------------------------------
    -- Capacity sweep: per minute, concurrent (upcoming appointments + walk-in
    -- occupancy) must stay below the active seat count. Walk-ins are now IN
    -- the count, which is exactly "walk-in queue takes precedence" -- a chair
    -- the live queue will be using is not a chair an online booking can take.
    -- -----------------------------------------------------------------------
    v_minute := p_start_minutes;
    while v_minute < p_end_minutes loop
        select count(*) into v_count
          from public.appointments
         where appt_date = p_date
           and status = 'upcoming'
           and (p_exclude_id is null or id <> p_exclude_id)
           and (
               case when v_crosses_midnight
                    and (extract(hour from appt_time)::integer * 60 + extract(minute from appt_time)::integer) < v_open_minutes
                    then (extract(hour from appt_time)::integer * 60 + extract(minute from appt_time)::integer) + 1440
                    else (extract(hour from appt_time)::integer * 60 + extract(minute from appt_time)::integer)
               end
           ) <= v_minute
           and v_minute < (
               case when v_crosses_midnight
                    and (extract(hour from appt_time)::integer * 60 + extract(minute from appt_time)::integer) < v_open_minutes
                    then (extract(hour from appt_time)::integer * 60 + extract(minute from appt_time)::integer) + 1440
                    else (extract(hour from appt_time)::integer * 60 + extract(minute from appt_time)::integer)
               end + duration_minutes
           );

        -- Walk-in occupancy overlapping this minute (same-day only; empty otherwise).
        v_walkin_concurrency := 0;
        if p_date = v_business_date then
            for v_schedule in select value from jsonb_each(v_seat_schedules) loop
                for v_iv in select * from jsonb_array_elements(v_schedule) loop
                    v_iv_start := (v_iv ->> 0)::integer;
                    v_iv_end   := (v_iv ->> 1)::integer;
                    if v_minute >= v_iv_start and v_minute < v_iv_end then
                        v_walkin_concurrency := v_walkin_concurrency + 1;
                    end if;
                end loop;
            end loop;
        end if;

        if v_count + v_walkin_concurrency >= v_seats then return false; end if;
        v_minute := v_minute + 1;
    end loop;
    return true;
end $$;

-- Internal helper: still not a PostgREST-exposed RPC (unchanged from before).
revoke all on function public._appointment_slot_capacity_ok(date, integer, integer, text) from public, anon, authenticated;
