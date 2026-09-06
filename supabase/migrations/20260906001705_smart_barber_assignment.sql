-- Migration: smart barber assignment (capability + specialty).
--
-- Item 1 of QUEUECUT_HANDOVER.md. Two independent, separately-stored
-- concepts on public.staff (see that file's decision table for the full
-- rationale -- do not relitigate the model here):
--
--   capability_service_ids -- hard gate. NULL/empty = capable of everything
--     (the non-breaking default: every barber that exists today has never
--     set this, and must keep working exactly as before).
--   specialty_service_ids  -- soft priority. NULL/empty = no preference.
--
-- public.queues and public.appointments both gain a `service_ids` SNAPSHOT
-- column (plain text[], no FK to services.id) -- same pattern as the
-- existing price_sen/duration_minutes snapshotting: a service being edited
-- or deleted later must not change a ticket already taken.
--
-- call_next_customer() is rewritten to try, per the seat's assigned
-- barber: (1) waiting + service in their specialty set, (2) else waiting +
-- service in their capability set (or capability is null = unrestricted),
-- (3) else a distinct "nothing you're set up for" error instead of the
-- generic "nobody waiting" one. Diffed against the current body in
-- 20260902001100_seat_assignment_authorization.sql (the most recent
-- definition, post seat-assignment-authorization) -- every existing check
-- (is_active_staff, seat-open, seat-ownership, already-serving, SKIP
-- LOCKED, tie-break ordering) is preserved unchanged.
--
-- book_appointment() and convert_walkin_to_appointment() both gain a new
-- trailing `p_service_ids text[] default null` parameter -- a DEFAULT so
-- existing callers that don't pass it keep working unchanged (a plain
-- `create or replace` cannot add a parameter; Postgres treats a changed
-- argument list as a different function, so these two are explicitly
-- dropped and recreated). convert_walkin_to_appointment() takes it as a
-- fresh parameter rather than inheriting the original walk-in ticket's
-- service_ids, because index.html's conversion form lets the customer
-- re-edit their service selection before confirming (prepareBookingChange()
-- pre-fills the checkboxes but does not disable them) -- the submitted
-- p_service already reflects that possibly-edited selection, and
-- service_ids must match it, not the stale original ticket.
--
-- checkin_appointment()'s signature is unchanged; it now also copies
-- v_app.service_ids onto the new queues row, same as it already does for
-- service/duration_minutes/price_sen/is_fast_pass.

-- ---------------------------------------------------------------------------
-- staff: capability + specialty
-- ---------------------------------------------------------------------------
alter table public.staff
    add column capability_service_ids text[],
    add column specialty_service_ids  text[],
    add constraint staff_specialty_subset_of_capability check (
        capability_service_ids is null
        or specialty_service_ids is null
        or specialty_service_ids <@ capability_service_ids
    );

comment on column public.staff.capability_service_ids is
    'Hard gate: service.id values this barber may be called for. NULL = capable of everything (default for every barber that predates this feature).';
comment on column public.staff.specialty_service_ids is
    'Soft priority: service.id values call_next_customer() tries first for this barber. NULL = no preference. Always a subset of capability_service_ids when that is restricted (enforced by staff_specialty_subset_of_capability).';

-- ---------------------------------------------------------------------------
-- queues / appointments: service_ids snapshot
-- ---------------------------------------------------------------------------
alter table public.queues add column service_ids text[];
comment on column public.queues.service_ids is
    'Snapshot of the selected service.id values at ticket-creation time (walk-in take, booking check-in, or walk-in-to-appointment conversion) -- see call_next_customer(). Does NOT live-derive from public.services; a service edited or deleted afterward must not change a ticket already taken. NULL for tickets created before this migration, or by any path that predates it -- call_next_customer() treats a NULL here as compatible with any capability list, since refusing an unknown-service ticket would strand a customer over a data gap, not a real mismatch.';

alter table public.appointments add column service_ids text[];
comment on column public.appointments.service_ids is
    'Same snapshot as public.queues.service_ids -- copied onto the queues row checkin_appointment() creates.';

-- Anon inserts a walk-in ticket directly (queueRepository.js's takeTicket()),
-- so it needs INSERT on this new column too. Additive grant -- Postgres
-- column privileges accumulate, this does not disturb the existing list in
-- 20260901000100_rls_policies.sql. Appointments never gets a matching grant:
-- every write there already goes through a SECURITY DEFINER RPC, which is
-- unaffected by the calling role's column grants.
grant insert (service_ids) on public.queues to anon;

-- ---------------------------------------------------------------------------
-- call_next_customer(): 3-tier specialty -> capability -> distinct-error
-- ---------------------------------------------------------------------------
create or replace function public.call_next_customer(p_seat_no integer)
returns public.queues language plpgsql security definer set search_path = public as $$
declare
    v_barber      uuid := auth.uid();
    v_seat_barber uuid;
    v_capability  text[];
    v_specialty   text[];
    v_row         public.queues;
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

    if v_seat_barber <> v_barber and not public.is_admin() then
        raise exception 'Anda tidak ditugaskan pada kerusi ini' using errcode = '42501';
    end if;

    if exists (select 1 from public.queues where seat_no = p_seat_no and status = 'serving') then
        raise exception 'Kerusi % masih melayan pelanggan', p_seat_no using errcode = '22023';
    end if;

    select capability_service_ids, specialty_service_ids
      into v_capability, v_specialty
      from public.staff where id = v_seat_barber;

    -- Tier 1: specialty match. A ticket with NULL service_ids can never
    -- satisfy a specialty (unlike tier 2, an unknown service is not treated
    -- as a specialty match -- "no preference" isn't the same as "matches
    -- everything"). Same tie-break ordering as before: fast-pass, then
    -- booking, then FIFO; SKIP LOCKED so two barbers calling together take
    -- different customers instead of blocking or double-calling.
    if v_specialty is not null and array_length(v_specialty, 1) > 0 then
        select * into v_row
          from public.queues
         where status = 'waiting'
           and service_ids is not null
           and service_ids && v_specialty
         order by (case when is_fast_pass then 0 when source = 'booking' then 1 else 2 end), created_at
         limit 1
           for update skip locked;
    end if;

    -- Tier 2: capability match, only attempted when tier 1 matched nothing.
    -- v_capability is null = unrestricted. service_ids is null = unknown
    -- service (legacy row, or any path that hasn't been updated) -- treated
    -- as compatible with any capability list rather than excluded.
    if v_row.id is null then
        select * into v_row
          from public.queues
         where status = 'waiting'
           and (v_capability is null or service_ids is null or service_ids && v_capability)
         order by (case when is_fast_pass then 0 when source = 'booking' then 1 else 2 end), created_at
         limit 1
           for update skip locked;
    end if;

    if v_row.id is null then
        raise exception 'Tiada pelanggan menunggu untuk servis yang anda boleh buat' using errcode = 'P0002';
    end if;

    update public.queues
       set status    = 'serving',
           seat_no   = p_seat_no,
           barber_id = coalesce(v_seat_barber, v_barber),
           called_at = now()
     where id = v_row.id
    returning * into v_row;

    return v_row;
end $$;

-- Grants unchanged (create or replace preserves them; restated as cheap
-- insurance, same convention as 20260902001100_seat_assignment_authorization.sql).
revoke all on function public.call_next_customer(integer) from public;
revoke all on function public.call_next_customer(integer) from anon;
grant execute on function public.call_next_customer(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- book_appointment(): new trailing p_service_ids text[] default null.
-- Signature is changing (new parameter), so `create or replace` would
-- create a second overload instead of replacing this one -- drop first.
-- ---------------------------------------------------------------------------
drop function if exists public.book_appointment(text, text, uuid, text, integer, integer, date, time);

create function public.book_appointment(
    p_name text, p_phone text, p_claim_token uuid, p_service text,
    p_duration_minutes integer, p_price_sen integer, p_date date, p_time time,
    p_service_ids text[] default null
) returns text language plpgsql security definer set search_path = public as $$
declare
    v_start  integer;
    v_end    integer;
    v_prefix text;
    v_id     text;
begin
    perform pg_advisory_xact_lock(hashtext('appointments:' || p_date::text));

    if p_duration_minutes is null or p_duration_minutes <= 0 or p_duration_minutes > 480 then
        raise exception 'Invalid duration' using errcode = '22023';
    end if;
    if p_claim_token is null then
        raise exception 'Missing claim token' using errcode = '22023';
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

-- ---------------------------------------------------------------------------
-- convert_walkin_to_appointment(): new trailing p_service_ids text[]
-- default null, same reasoning as book_appointment() above. Takes it as an
-- explicit parameter rather than inheriting v_queue.service_ids, because the
-- conversion form lets the customer re-edit their service selection before
-- confirming (same as p_service, which was already an explicit parameter
-- for exactly this reason, not inherited from the original ticket either).
-- ---------------------------------------------------------------------------
drop function if exists public.convert_walkin_to_appointment(text, uuid, integer, text, text, uuid, text, integer, integer, date, time);

create function public.convert_walkin_to_appointment(
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

-- ---------------------------------------------------------------------------
-- checkin_appointment(): signature unchanged, now also copies service_ids.
-- ---------------------------------------------------------------------------
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
    if exists (select 1 from public.queues where id = p_id) then
        raise exception 'Tempahan ini sudah berada dalam giliran' using errcode = '22023';
    end if;

    update public.appointments set status = 'arrived', arrived_at = now(), version = version + 1
     where id = p_id;

    insert into public.queues (id, ticket_no, name, phone, claim_token, service, duration_minutes,
                                price_sen, status, source, is_fast_pass,
                                approved_by, approval_reason, approved_at, version, service_ids)
    values (p_id, p_id, v_app.name || ' (Tempahan)', v_app.phone, gen_random_uuid(), v_app.service,
            v_app.duration_minutes, v_app.price_sen, 'waiting', 'booking', v_app.is_fast_pass,
            v_app.approved_by, v_app.approval_reason, v_app.approved_at, 1, v_app.service_ids)
    returning * into v_queue;

    return v_queue;
end $$;

revoke all on function public.checkin_appointment(text) from public;
grant execute on function public.checkin_appointment(text) to authenticated;
