-- Harden appointment validation for overnight business days.
-- Existing RPCs pass raw clock minutes; both helpers map post-midnight times
-- onto the same continuous business-day axis as the client scheduler.

create or replace function public._appointment_hours_ok(
    p_date date, p_start_minutes integer, p_end_minutes integer
) returns boolean language plpgsql stable security definer set search_path = public as $$
declare
    v_day jsonb;
    v_closed_dates jsonb;
    v_advance_days integer;
    v_shop_status text;
    v_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
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

revoke all on function public._appointment_hours_ok(date, integer, integer) from public, anon, authenticated;

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

    -- The RPC caller supplies raw clock minutes. Convert both the requested
    -- interval and existing appointments to the business-day axis.
    if v_crosses_midnight and p_start_minutes < v_open_minutes then
        p_start_minutes := p_start_minutes + 1440;
        p_end_minutes := p_end_minutes + 1440;
    end if;

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
        if v_count >= v_seats then return false; end if;
        v_minute := v_minute + 1;
    end loop;
    return true;
end $$;

revoke all on function public._appointment_slot_capacity_ok(date, integer, integer, text) from public, anon, authenticated;
