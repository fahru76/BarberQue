-- ---------------------------------------------------------------------------
-- Security audit follow-up (2026-09-09): client-submitted price_sen was
-- never cross-checked against the real services catalog. A customer editing
-- devtools (or calling the REST/RPC endpoints directly with the public anon
-- key) could submit any price for a real walk-in ticket or online booking.
-- This doesn't corrupt access control, but it does corrupt sales figures --
-- barber_performance() and the admin sales report both sum price_sen/price
-- straight off these rows.
--
-- Fixed at the two genuine customer-input boundaries, both of which already
-- carry a `service_ids` snapshot (Item 1, smart barber assignment):
--
-- 1. Walk-in ticket creation (`queues`, source = 'walkin') -- the only
--    direct client INSERT into this table (queueRepository.js's
--    takeTicket()), so a BEFORE INSERT trigger is the natural enforcement
--    point. Deliberately scoped to source = 'walkin' only: checkin_
--    appointment() also inserts into `queues` (source = 'booking'), copying
--    price_sen/service_ids from an appointment that was already validated
--    at booking time -- re-pricing it against today's prices at checkin,
--    which can be days or weeks later, would silently change what the
--    customer agreed to pay when they booked.
--
-- 2. book_appointment() / convert_walkin_to_appointment() -- both already
--    take p_service_ids; price_sen/duration_minutes are now recomputed from
--    it server-side instead of trusting the caller's parameters, preserving
--    the existing "snapshot at creation time" semantics (HANDOFF.md) --
--    just snapshotted from the server's own prices, not the browser's.
--
-- checkin_appointment() is intentionally left unchanged -- it takes no new
-- client input, only copies an already-validated appointment row.
-- ---------------------------------------------------------------------------

-- ---- 1. Walk-in ticket creation --------------------------------------------

create or replace function public.recompute_walkin_price_from_services()
returns trigger
language plpgsql
set search_path = public
as $$
declare
    v_price_sen         integer;
    v_duration_minutes  integer;
begin
    if new.source <> 'walkin' then
        return new;
    end if;

    if new.service_ids is null or array_length(new.service_ids, 1) is null then
        raise exception 'Tiket mesti mempunyai sekurang-kurangnya satu servis yang sah.' using errcode = '23514';
    end if;

    select coalesce(sum(price_sen), 0), coalesce(sum(duration_minutes), 0)
      into v_price_sen, v_duration_minutes
      from public.services
     where id = any(new.service_ids) and active;

    if v_price_sen = 0 and v_duration_minutes = 0 then
        raise exception 'Servis yang dipilih tidak sah atau tidak aktif.' using errcode = '23514';
    end if;

    new.price_sen := v_price_sen;
    new.duration_minutes := v_duration_minutes;
    return new;
end;
$$;

drop trigger if exists walkin_price_from_services on public.queues;
create trigger walkin_price_from_services
    before insert on public.queues
    for each row
    execute function public.recompute_walkin_price_from_services();

-- ---- 2. Appointment booking / walk-in-to-appointment conversion -----------
-- Signatures unchanged, so `create or replace` is enough (no drop needed).

create or replace function public.book_appointment(
    p_name text, p_phone text, p_claim_token uuid, p_service text,
    p_duration_minutes integer, p_price_sen integer, p_date date, p_time time,
    p_service_ids text[] default null
) returns text language plpgsql security definer set search_path = public as $$
declare
    v_start  integer;
    v_end    integer;
    v_prefix text;
    v_id     text;
    v_computed_price_sen        integer;
    v_computed_duration_minutes integer;
begin
    perform pg_advisory_xact_lock(hashtext('appointments:' || p_date::text));

    if p_claim_token is null then
        raise exception 'Missing claim token' using errcode = '22023';
    end if;

    -- Price/duration are recomputed from the live services catalog rather
    -- than trusted from the caller -- see migration header.
    if p_service_ids is null or array_length(p_service_ids, 1) is null then
        raise exception 'Sila pilih sekurang-kurangnya satu servis yang sah.' using errcode = '23514';
    end if;
    select coalesce(sum(price_sen), 0), coalesce(sum(duration_minutes), 0)
      into v_computed_price_sen, v_computed_duration_minutes
      from public.services
     where id = any(p_service_ids) and active;
    if v_computed_price_sen = 0 and v_computed_duration_minutes = 0 then
        raise exception 'Servis yang dipilih tidak sah atau tidak aktif.' using errcode = '23514';
    end if;
    p_price_sen := v_computed_price_sen;
    p_duration_minutes := v_computed_duration_minutes;

    if p_duration_minutes is null or p_duration_minutes <= 0 or p_duration_minutes > 480 then
        raise exception 'Invalid duration' using errcode = '22023';
    end if;
    v_start := extract(hour from p_time)::integer * 60 + extract(minute from p_time)::integer;
    v_end   := v_start + p_duration_minutes;

    if not public._appointment_hours_ok(p_date, v_start, v_end) then
        raise exception 'Slot ini di luar waktu operasi atau bertindih waktu rehat' using errcode = '22023';
    end if;
    if not public._appointment_slot_capacity_ok(p_date, v_start, v_end, null) then
        raise exception 'Slot ini tidak lagi tersedia' using errcode = '22023';
    end if;

    v_prefix := case when extract(hour from p_time) < 12 then 'PGB' else 'PTGB' end;
    v_id := public.next_ticket_number(v_prefix);

    insert into public.appointments (id, name, phone, claim_token, service, duration_minutes,
                                      price_sen, appt_date, appt_time, status, version, service_ids)
    values (v_id, p_name, p_phone, p_claim_token, p_service, p_duration_minutes,
            p_price_sen, p_date, p_time, 'upcoming', 1, p_service_ids);

    return v_id;
end $$;

revoke all on function public.book_appointment(text, text, uuid, text, integer, integer, date, time, text[]) from public;
grant execute on function public.book_appointment(text, text, uuid, text, integer, integer, date, time, text[]) to anon, authenticated;

create or replace function public.convert_walkin_to_appointment(
    p_walkin_id text, p_walkin_claim_token uuid, p_expected_version integer,
    p_name text, p_phone text, p_new_claim_token uuid, p_service text,
    p_duration_minutes integer, p_price_sen integer, p_date date, p_time time,
    p_service_ids text[] default null
) returns text language plpgsql security definer set search_path = public as $$
declare
    v_start  integer;
    v_end    integer;
    v_prefix text;
    v_id     text;
    v_queue  public.queues;
    v_computed_price_sen        integer;
    v_computed_duration_minutes integer;
begin
    perform pg_advisory_xact_lock(hashtext('appointments:' || p_date::text));

    select * into v_queue from public.queues
     where id = p_walkin_id and claim_token = p_walkin_claim_token and status = 'waiting'
     for update;
    if not found then
        raise exception 'Tiket Walk-in tidak lagi boleh ditukar' using errcode = 'P0002';
    end if;
    if v_queue.version <> p_expected_version then
        raise exception 'Tiket Walk-in telah berubah di skrin lain' using errcode = '40001';
    end if;

    -- Price/duration are recomputed from the live services catalog rather
    -- than trusted from the caller -- see migration header. p_service_ids
    -- reflects whatever the customer has checked at conversion time (the
    -- conversion form lets them re-edit their selection), not necessarily
    -- v_queue.service_ids, so it must still be taken as an explicit
    -- parameter, same reasoning as p_service already being one.
    if p_service_ids is null or array_length(p_service_ids, 1) is null then
        raise exception 'Sila pilih sekurang-kurangnya satu servis yang sah.' using errcode = '23514';
    end if;
    select coalesce(sum(price_sen), 0), coalesce(sum(duration_minutes), 0)
      into v_computed_price_sen, v_computed_duration_minutes
      from public.services
     where id = any(p_service_ids) and active;
    if v_computed_price_sen = 0 and v_computed_duration_minutes = 0 then
        raise exception 'Servis yang dipilih tidak sah atau tidak aktif.' using errcode = '23514';
    end if;
    p_price_sen := v_computed_price_sen;
    p_duration_minutes := v_computed_duration_minutes;

    if p_duration_minutes is null or p_duration_minutes <= 0 or p_duration_minutes > 480 then
        raise exception 'Invalid duration' using errcode = '22023';
    end if;
    v_start := extract(hour from p_time)::integer * 60 + extract(minute from p_time)::integer;
    v_end   := v_start + p_duration_minutes;
    if not public._appointment_hours_ok(p_date, v_start, v_end) then
        raise exception 'Slot ini di luar waktu operasi atau bertindih waktu rehat' using errcode = '22023';
    end if;
    if not public._appointment_slot_capacity_ok(p_date, v_start, v_end, null) then
        raise exception 'Slot ini tidak lagi tersedia' using errcode = '22023';
    end if;

    v_prefix := case when extract(hour from p_time) < 12 then 'PGB' else 'PTGB' end;
    v_id := public.next_ticket_number(v_prefix);

    insert into public.appointments (id, name, phone, claim_token, service, duration_minutes,
                                      price_sen, appt_date, appt_time, status, version, service_ids)
    values (v_id, p_name, p_phone, p_new_claim_token, p_service, p_duration_minutes,
            p_price_sen, p_date, p_time, 'upcoming', 1, p_service_ids);

    update public.queues
       set status = 'cancelled', cancelled_at = now(),
           cancel_reason = 'Ditukar kepada Tempahan Online', version = v_queue.version + 1
     where id = p_walkin_id;

    return v_id;
end $$;

revoke all on function public.convert_walkin_to_appointment(text, uuid, integer, text, text, uuid, text, integer, integer, date, time, text[]) from public;
grant execute on function public.convert_walkin_to_appointment(text, uuid, integer, text, text, uuid, text, integer, integer, date, time, text[]) to anon, authenticated;
