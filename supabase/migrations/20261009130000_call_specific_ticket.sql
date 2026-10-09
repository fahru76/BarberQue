-- DRAFT FOR REVIEW -- do not apply until reviewed.
--
-- Adds public.call_specific_customer(p_seat_no, p_queue_id): lets a barber
-- call one chosen waiting ticket (for example a walk-in who is standing at
-- the counter) instead of the next one picked by call_next_customer().
--
-- It deliberately repeats the guards of call_next_customer() (latest
-- definition: 20261008100000_barber_self_duty.sql) so a specific call can
-- never do anything the normal call could not:
--   * caller must be active staff
--   * the seat must be open, on duty for the current business day, and
--     belong to the caller (or the caller is admin)
--   * the seat must not already be serving
--   * the ticket must be 'waiting' and inside the seat barber's capability
--     (service_ids <@ capability_service_ids)
--   * the barber's per-service duration override is applied the same way
--   * calling ends any break on the seat
-- Nothing existing is changed or replaced. No table or column changes.
--
-- Rollback: drop function public.call_specific_customer(integer, text);

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

    select capability_service_ids, service_durations
      into v_capability, v_service_durations
      from public.staff where id = v_seat_barber;

    select * into v_row
      from public.queues
     where id = p_queue_id and status = 'waiting'
       and (v_capability is null or service_ids is null or service_ids <@ v_capability)
       for update skip locked;

    if v_row.id is null then
        raise exception 'Tiket tidak lagi menunggu atau di luar kemahiran anda' using errcode = 'P0002';
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

revoke all on function public.call_specific_customer(integer, text) from public;
revoke all on function public.call_specific_customer(integer, text) from anon;
grant execute on function public.call_specific_customer(integer, text) to authenticated;
