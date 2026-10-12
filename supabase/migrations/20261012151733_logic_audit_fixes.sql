-- Logic audit 2026-10-12: atomic intake, authoritative reports and booking rules.
begin;
create or replace function public._validate_service_selection(p_ids text[])
returns void language plpgsql stable security definer set search_path = public as $$
declare v_count integer; v_fashion integer; v_basic integer; v_bald integer; v_nonfacial integer; v_targets integer;
begin
 if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 100 or array_position(p_ids, null) is not null then
  raise exception 'Sila pilih servis yang sah.' using errcode = '23514';
 end if;
 select count(*), count(*) filter(where category = 'fashion'),
 count(*) filter(where category = 'asas' and type in ('gunting','botak')),
 count(*) filter(where type = 'botak'), count(*) filter(where type not in ('botak','facial')),
 count(distinct target) filter(where target <> 'semua')
 into v_count, v_fashion, v_basic, v_bald, v_nonfacial, v_targets
 from public.services where id = any(p_ids) and active;
 if v_count <> (select count(distinct id) from unnest(p_ids) id) then
  raise exception 'Servis tidak sah atau tidak aktif.' using errcode = '23514';
 end if;
 if v_targets > 1 or v_fashion > 1 or v_basic > 1 or (v_fashion > 0 and v_basic > 0)
 or v_bald > 1 or (v_bald > 0 and v_nonfacial > 0) then
  raise exception 'Gabungan servis tidak dibenarkan.' using errcode = '23514';
 end if;
end $$;
revoke all on function public._validate_service_selection(text[]) from public, anon, authenticated;

create or replace function public.validate_customer_service_snapshot()
returns trigger language plpgsql security definer set search_path = public as $$
begin
 if TG_OP = 'UPDATE' and new.service_ids is not distinct from old.service_ids then return new; end if;
 -- Check-ins retain the catalogue snapshot agreed when the booking was made.
 if TG_TABLE_NAME = 'queues' then
  if new.source = 'booking' then return new; end if;
 end if;
 perform public._validate_service_selection(new.service_ids);
 if length(coalesce(new.phone,'')) > 30 then raise exception 'Nombor telefon terlalu panjang.' using errcode = '23514'; end if;
 select string_agg(name, ' + ' order by sort_order, id), sum(price_sen), sum(duration_minutes)
 into new.service, new.price_sen, new.duration_minutes from public.services where id = any(new.service_ids) and active;
 if length(new.service) > 1000 then raise exception 'Terlalu banyak servis.' using errcode = '23514'; end if;
 return new;
end $$;
revoke all on function public.validate_customer_service_snapshot() from public, anon, authenticated;
create trigger customer_service_snapshot before insert or update of service_ids on public.queues
for each row execute function public.validate_customer_service_snapshot();
create trigger customer_service_snapshot before insert or update of service_ids on public.appointments
for each row execute function public.validate_customer_service_snapshot();

create or replace function public.take_walkin_ticket(p_name text, p_phone text, p_service_ids text[], p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_settings public.shop_settings; v_id text; v_row public.queues; v_day date := public._current_business_date();
v_ops jsonb; v_min integer; v_open integer; v_close integer;
begin
 perform pg_advisory_xact_lock(hashtext('appointments:' || v_day::text));
 select * into v_settings from public.shop_settings where id = true for update;
 if not found or v_settings.shop_status <> 'open' or v_settings.closed_dates @> to_jsonb(v_day::text) then
 raise exception 'Kedai ditutup.' using errcode = '22023'; end if;
 v_ops := v_settings.weekly_op_hours -> extract(dow from v_day)::integer::text;
 if v_ops is null or coalesce((v_ops->>'closed')::boolean,true) then raise exception 'Kedai ditutup.'; end if;
 v_open := extract(hour from (v_ops->>'open')::time)::integer*60 + extract(minute from (v_ops->>'open')::time)::integer;
 v_close := extract(hour from (v_ops->>'close')::time)::integer*60 + extract(minute from (v_ops->>'close')::time)::integer;
 v_min := extract(hour from now() at time zone 'Asia/Kuala_Lumpur')::integer*60 + extract(minute from now() at time zone 'Asia/Kuala_Lumpur')::integer;
 if v_close <= v_open then v_close := v_close+1440; if v_min < v_open then v_min:=v_min+1440; end if; end if;
 if v_min < v_open or v_min >= v_close then raise exception 'Di luar waktu operasi.'; end if;
 if not exists(select 1 from public.seats s join public.staff st on st.id=s.barber_id
 where s.active and st.active and s.duty_date = v_day) then raise exception 'Tiada kerusi bertugas.'; end if;
 if (select count(*) from public.queues where status = 'waiting' and source = 'walkin') >= v_settings.max_queue then raise exception 'Giliran penuh.'; end if;
 if p_name is null or length(btrim(p_name)) not between 1 and 60 or length(coalesce(p_phone,'')) > 30 or p_claim_token is null then
 raise exception 'Maklumat pelanggan tidak sah.' using errcode = '22023'; end if;
 perform public._validate_service_selection(p_service_ids);
 v_id := public.next_ticket_number(case when v_min < 720 then 'PG' else 'PTG' end);
 insert into public.queues(id,ticket_no,name,phone,claim_token,service,service_ids,duration_minutes,price_sen,source)
 values(v_id,v_id,btrim(p_name),p_phone,p_claim_token,'',p_service_ids,1,0,'walkin') returning * into v_row;
 return to_jsonb(v_row) - 'claim_token' - 'phone';
end $$;
revoke all on function public.take_walkin_ticket(text,text,text[],uuid) from public, anon, authenticated;
grant execute on function public.take_walkin_ticket(text,text,text[],uuid) to anon, authenticated;
drop policy if exists "anon may take a ticket" on public.queues;
drop policy if exists "queue readable by anon" on public.queues;
revoke insert, select on public.queues from anon;
-- Column grants must also be removed; table-level REVOKE does not remove them.
do $$ declare c record; begin
 for c in select column_name from information_schema.columns where table_schema='public' and table_name='queues' loop
 execute format('revoke select (%I), insert (%I) on public.queues from anon', c.column_name,c.column_name);
 end loop;
end $$;
revoke execute on function public.next_ticket_number(text) from public, anon, authenticated;
revoke execute on function public.set_my_services(text[],text[],jsonb) from public, anon, authenticated;

create or replace function public._appointment_hours_ok(
    p_date date, p_start_minutes integer, p_end_minutes integer
) returns boolean language plpgsql stable security definer set search_path = public as $$
declare
    v_day jsonb;
    v_closed_dates jsonb;
    v_advance_days integer;
    v_shop_status text;
    v_today date := public._current_business_date();
    v_open integer;
    v_close integer;
    v_b1s integer;
    v_b1e integer;
    v_b2s integer;
    v_b2e integer;
    v_crosses_midnight boolean;
begin
    select weekly_op_hours, closed_dates, booking_advance_days, shop_status
      into v_day, v_closed_dates, v_advance_days, v_shop_status
      from public.shop_settings where id = true;
    if v_day is null or p_date < v_today or p_date > v_today + coalesce(v_advance_days, 30)
       or (p_date = v_today and v_shop_status <> 'open')
       or (v_closed_dates is not null and v_closed_dates @> to_jsonb(p_date::text)) then return false; end if;

    v_day := v_day -> extract(dow from p_date)::integer::text;
    if v_day is null or coalesce((v_day ->> 'closed')::boolean, true) then return false; end if;
    v_open := extract(hour from (v_day ->> 'open')::time)::integer * 60 + extract(minute from (v_day ->> 'open')::time)::integer;
    v_close := extract(hour from (v_day ->> 'close')::time)::integer * 60 + extract(minute from (v_day ->> 'close')::time)::integer;
    v_crosses_midnight := v_close <= v_open;
    if v_crosses_midnight then
        if v_close = v_open then v_close := v_close + 1440;
        else v_close := v_close + 1440; end if;
        if p_start_minutes < v_open then
            p_start_minutes := p_start_minutes + 1440;
            p_end_minutes := p_end_minutes + 1440;
        end if;
    end if;
    if p_date = v_today and (public._business_day_start(p_date) + make_interval(mins => p_start_minutes - v_open)) <= now() then return false; end if;
    if p_start_minutes < v_open or p_end_minutes > v_close then return false; end if;

    if nullif(v_day ->> 'break1Start', '') is not null and nullif(v_day ->> 'break1End', '') is not null then
        v_b1s := extract(hour from (v_day ->> 'break1Start')::time)::integer * 60 + extract(minute from (v_day ->> 'break1Start')::time)::integer;
        v_b1e := extract(hour from (v_day ->> 'break1End')::time)::integer * 60 + extract(minute from (v_day ->> 'break1End')::time)::integer;
        if v_crosses_midnight and v_b1s < v_open then
            v_b1s := v_b1s + 1440; v_b1e := v_b1e + 1440;
        elsif v_crosses_midnight and v_b1e < v_b1s then
            v_b1e := v_b1e + 1440;
        end if;
        if p_start_minutes < v_b1e and p_end_minutes > v_b1s then return false; end if;
    end if;
    if nullif(v_day ->> 'break2Start', '') is not null and nullif(v_day ->> 'break2End', '') is not null then
        v_b2s := extract(hour from (v_day ->> 'break2Start')::time)::integer * 60 + extract(minute from (v_day ->> 'break2Start')::time)::integer;
        v_b2e := extract(hour from (v_day ->> 'break2End')::time)::integer * 60 + extract(minute from (v_day ->> 'break2End')::time)::integer;
        if v_crosses_midnight and v_b2s < v_open then
            v_b2s := v_b2s + 1440; v_b2e := v_b2e + 1440;
        elsif v_crosses_midnight and v_b2e < v_b2s then
            v_b2e := v_b2e + 1440;
        end if;
        if p_start_minutes < v_b2e and p_end_minutes > v_b2s then return false; end if;
    end if;
    return true;
end $$;
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
    if p_date = public._current_business_date() then
 select count(*) into v_seats from public.seats s join public.staff st on st.id=s.barber_id where s.active and st.active and s.duty_date = p_date;
 else select seat_count into v_seats from public.shop_settings where id = true; end if;
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
        for v_seat in select s.seat_no from public.seats s join public.staff st on st.id=s.barber_id where s.active and st.active and s.duty_date = p_date loop
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
            for v_seat in select s.seat_no from public.seats s join public.staff st on st.id=s.barber_id where s.active and st.active and s.duty_date = p_date loop
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
create or replace function public.checkin_appointment(p_id text)
returns public.queues language plpgsql security definer set search_path = public as $$
declare
    v_app   public.appointments;
    v_queue public.queues;
begin
    if not public.is_active_staff() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    select * into v_app from public.appointments where id = p_id and status = 'upcoming' for update;
    if not found then
        raise exception 'Tempahan tidak ditemui atau bukan aktif' using errcode = 'P0002';
    end if;
    if v_app.appt_date <> public._current_business_date() then raise exception 'Tempahan bukan untuk hari ini.' using errcode = '22023'; end if;
    if exists (select 1 from public.queues where id = p_id) then
        raise exception 'Tempahan ini sudah berada dalam giliran' using errcode = '22023';
    end if;

    update public.appointments set status = 'arrived', arrived_at = now(), version = version + 1
     where id = p_id;

    insert into public.queues (id, ticket_no, name, phone, claim_token, service, duration_minutes,
                                price_sen, status, source, is_fast_pass,
                                approved_by, approval_reason, approved_at, version, service_ids)
    values (p_id, p_id, v_app.name, v_app.phone, gen_random_uuid(), v_app.service,
            v_app.duration_minutes, v_app.price_sen, 'waiting', 'booking', v_app.is_fast_pass,
            v_app.approved_by, v_app.approval_reason, v_app.approved_at, 1, v_app.service_ids)
    returning * into v_queue;

    return v_queue;
end $$;
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

    select service_durations into v_service_durations from public.staff where id=v_seat_barber;
    select * into v_row from public.queues where status='waiting'
    order by (case when is_fast_pass then 0 when source='booking' then 1 else 2 end),created_at
    limit 1 for update skip locked;
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
create or replace function public.call_specific_customer(p_seat_no integer, p_queue_id text)
returns public.queues language plpgsql security definer set search_path = public as $$
declare
    v_barber             uuid := auth.uid();
    v_seat_barber        uuid;
    v_capability         text[];
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

    select service_durations
      into v_service_durations
      from public.staff where id = v_seat_barber;

    select * into v_row
      from public.queues
     where id = p_queue_id and status = 'waiting'
       for update skip locked;

    if v_row.id is null then
        raise exception 'Tiket tidak lagi menunggu' using errcode = 'P0002';
    end if;

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

    update public.seats set break_until = null
     where seat_no = p_seat_no and break_until is not null;

    return v_row;
end $$;

create index if not exists queues_completed_report_idx on public.queues(completed_at) where status='done';
create or replace function public._report_business_date(p_at timestamptz)
returns date language plpgsql stable security definer set search_path = public as $$
declare d date := (p_at at time zone 'Asia/Kuala_Lumpur')::date; ops jsonb; t time := (p_at at time zone 'Asia/Kuala_Lumpur')::time;
begin
 select weekly_op_hours -> extract(dow from d-1)::integer::text into ops from public.shop_settings where id=true;
 if not coalesce((ops->>'closed')::boolean,true) and (ops->>'close')::time <= (ops->>'open')::time
 and t < (ops->>'close')::time then return d-1; end if;
 return d;
end $$;
revoke all on function public._report_business_date(timestamptz) from public,anon,authenticated;
create or replace function public.report_completed_tickets(p_from date,p_to date,p_own boolean default false)
returns table(id text,name text,service text,duration_minutes integer,seat_no integer,barber_id uuid,barber_name text,status text,source text,is_fast_pass boolean,created_at timestamptz,called_at timestamptz,completed_at timestamptz,price_sen integer,service_ids text[]) language plpgsql stable security definer set search_path = public as $$
begin
 if not public.is_active_staff() then raise exception 'Not authorised' using errcode='42501'; end if;
 if p_from is null or p_to is null or p_to < p_from or p_to-p_from > 366 then raise exception 'Invalid report period'; end if;
 return query select q.id,q.name,q.service,q.duration_minutes,q.seat_no,q.barber_id,q.barber_name,q.status,q.source,q.is_fast_pass,q.created_at,q.called_at,q.completed_at,q.price_sen,q.service_ids from public.queues q where q.status='done'
 and q.completed_at >= (p_from::timestamp at time zone 'Asia/Kuala_Lumpur')
 and q.completed_at < ((p_to+2)::timestamp at time zone 'Asia/Kuala_Lumpur')
 and public._report_business_date(q.completed_at) between p_from and p_to
 and ((not p_own and public.is_admin()) or q.barber_id=auth.uid()) order by q.completed_at,q.id;
end $$;
revoke all on function public.report_completed_tickets(date,date,boolean) from public,anon,authenticated;
grant execute on function public.report_completed_tickets(date,date,boolean) to authenticated;
create or replace function public.barber_performance(p_from date,p_to date)
returns table(barber_id uuid,display_name text,customers bigint,sales_sen bigint)
language plpgsql stable security definer set search_path=public as $$
begin
 if not public.is_admin() then raise exception 'Not authorised' using errcode='42501'; end if;
 return query select q.barber_id,coalesce(q.barber_name,s.display_name,'Tidak direkodkan'),count(*),coalesce(sum(q.price_sen),0)
 from public.report_completed_tickets(p_from,p_to) q left join public.staff s on s.id=q.barber_id
 group by q.barber_id,coalesce(q.barber_name,s.display_name,'Tidak direkodkan') order by sum(q.price_sen) desc;
end $$;
create or replace function public.my_barber_performance(p_from date,p_to date)
returns table(barber_id uuid,display_name text,customers bigint,sales_sen bigint)
language plpgsql stable security definer set search_path=public as $$
begin
 if not public.is_active_staff() then raise exception 'Not authorised' using errcode='42501'; end if;
 return query select q.barber_id,coalesce(q.barber_name,s.display_name,'Tidak direkodkan'),count(*),coalesce(sum(q.price_sen),0)
 from public.report_completed_tickets(p_from,p_to) q left join public.staff s on s.id=q.barber_id where q.barber_id=auth.uid()
 group by q.barber_id,coalesce(q.barber_name,s.display_name,'Tidak direkodkan');
end $$;
revoke all on function public.my_barber_performance(date,date) from public,anon,authenticated;
grant execute on function public.my_barber_performance(date,date) to authenticated;
commit;
