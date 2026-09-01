-- Migration step 6: appointments (public.appointments) + the fast-pass
-- approval workflow that spans both `appointments` and `queues`.
--
-- Three decisions made with the user before writing this (recorded so they
-- aren't relitigated):
--
-- 1. isVip/fastPassApproved are NOT stored as their own columns. Tracing
--    every read/write site in index.html found they are 100% redundant
--    with existing fields in every current code path: `isVip` is only ever
--    set alongside `source = 'booking'`, and `fastPassApproved` only ever
--    moves in lockstep with `isFastPass`. So: `is_fast_pass` (already on
--    `queues`, added here to `appointments`) is the one stored approval
--    flag; `isVip` is derived at the repository mapping layer as
--    `source === 'booking'` and never touches the database.
--
-- 2. Cancelling/rescheduling your own appointment goes through the same
--    claim_token + SECURITY DEFINER RPC pattern as `cancel_own_ticket()` —
--    the ID-only local model (`getMyAppIds().includes(appId)`) is meaningless
--    once this talks to a real server.
--
-- 3. The double-booking race (two customers booking the same slot at once)
--    and the walk-in<->appointment conversion (a cross-table write) are both
--    closed with SECURITY DEFINER RPCs that hold a transaction-scoped
--    advisory lock / do the whole conversion in one statement, rather than
--    left as sequential client calls.
--
-- Deliberate scope boundary on (3), stated plainly rather than silently
-- assumed: the server-side capacity check in book_appointment() /
-- reschedule_own_appointment() only considers OTHER UPCOMING APPOINTMENTS
-- for that date. It does not attempt to also model today's live walk-in
-- queue occupancy (which chair is busy until when, break-adjusted) — that
-- logic lives in js/domain/scheduler.js and is a client-side-only, honestly
-- best-effort refinement, same as it is today. Porting the full break-aware
-- scheduler into PL/pgSQL was judged out of proportion to this step; what
-- the RPC closes is the actual race (two servers/devices double-booking the
-- exact same appointment slot), not every soft scheduling nuance.

-- ---------------------------------------------------------------------------
-- queues: add the audit columns the fast-pass approval workflow needs.
-- Not is_vip/fast_pass_approved (see decision 1 above) — just who
-- approved/revoked priority and why, which is real information, not
-- derivable from anything else.
-- ---------------------------------------------------------------------------
alter table public.queues
    add column approved_by      uuid references public.staff (id) on delete set null,
    add column approval_reason  text check (approval_reason is null or length(btrim(approval_reason)) >= 3),
    add column approved_at      timestamptz,
    add column revoked_by       uuid references public.staff (id) on delete set null,
    add column revoked_reason   text,
    add column revoked_at       timestamptz;

comment on column public.queues.approved_by is
    'Staff id of the admin who granted silent priority via approve_fast_pass(). NULL if is_fast_pass was never approved through that path.';
comment on column public.queues.revoked_by is
    'Staff id of the admin who revoked priority via revoke_fast_pass(). NULL for a system-triggered revocation (see appointments.revoked_reason for the appointments-side equivalent — reschedule auto-revokes).';

-- ---------------------------------------------------------------------------
-- appointments : the core table
-- ---------------------------------------------------------------------------
create table public.appointments (
    id                text primary key,

    name              text not null check (length(btrim(name)) between 1 and 60),
    phone             text,
    claim_token       uuid not null,

    service           text not null,
    duration_minutes  integer not null default 25 check (duration_minutes between 1 and 480),
    price_sen         integer not null default 0 check (price_sen >= 0),

    appt_date         date not null,
    appt_time         time not null,

    status            text not null default 'upcoming'
                          check (status in ('upcoming', 'arrived', 'cancelled')),
    is_fast_pass      boolean not null default false,

    approved_by       uuid references public.staff (id) on delete set null,
    approval_reason   text check (approval_reason is null or length(btrim(approval_reason)) >= 3),
    approved_at       timestamptz,
    revoked_by        uuid references public.staff (id) on delete set null,
    revoked_reason    text,
    revoked_at        timestamptz,

    created_at        timestamptz not null default now(),
    updated_at        timestamptz,
    arrived_at        timestamptz,
    cancelled_at      timestamptz,
    cancelled_by      text check (cancelled_by in ('customer', 'admin')),
    cancel_reason     text check (cancel_reason is null or length(btrim(cancel_reason)) >= 3),

    version           integer not null default 1,

    constraint appointments_arrived_has_timestamp check (
        status <> 'arrived' or arrived_at is not null),

    constraint appointments_cancelled_has_reason check (
        status <> 'cancelled'
        or (cancelled_at is not null and cancel_reason is not null and cancelled_by is not null))
);

comment on column public.appointments.cancelled_by is
    'A role string (''customer''/''admin''), not a staff FK -- the local model never tracked which specific admin cancelled a booking, only that an admin did. Matches the existing (pre-migration) behaviour rather than inventing new precision.';

-- Availability checks filter "upcoming appointments on this date" constantly
-- (book_appointment, reschedule_own_appointment, the admin day view).
create index appointments_active_idx on public.appointments (appt_date, status)
    where status = 'upcoming';

-- Today's check-in list.
create index appointments_today_idx on public.appointments (appt_date)
    where status = 'upcoming';

alter table public.appointments enable row level security;

-- ---------------------------------------------------------------------------
-- RLS: narrower anon read than queues/services.
--
-- Anon needs enough to render a live "which slots are already taken" preview
-- while picking a date/time (see js/repositories/appointmentRepository.js's
-- getAppointmentsForDate()) -- but NOT other customers' name/phone/service/
-- price, which the customer-facing UI never shows for anyone but the
-- device's own bookings (rendered straight from localStorage, never re-read
-- from the server -- see the column grants below).
--
-- Staff/admin get the full row: the "Hadir hari ini" list and the fast-pass
-- candidate dropdown both need name/service/phone.
-- ---------------------------------------------------------------------------
create policy "appointments readable by all" on public.appointments
    for select to anon, authenticated using (true);

-- No INSERT policy for anyone, staff included -- book_appointment() and
-- convert_walkin_to_appointment() are genuinely the only ways a row is ever
-- created (both SECURITY DEFINER, both bypass RLS for their own INSERT), so
-- there is no plain-insert path for a direct client write to fall back to.
-- An admin creating a booking on a walk-up customer's behalf calls the same
-- book_appointment() RPC anyone else does -- it's already granted to
-- authenticated below, and doing it this way means an admin-entered booking
-- gets the same capacity check as a customer-entered one, not a bypass.

create policy "admins manage appointments" on public.appointments
    for update to authenticated
    using (public.is_admin()) with check (public.is_admin());

-- Deliberately no DELETE policy anywhere -- same reasoning as queues:
-- cancellation is a status change, not a row removal, so the record and its
-- reason survive for the audit trail.

revoke all on public.appointments from anon, authenticated;

-- Anon: just enough to preview availability, nothing identifying anyone.
grant select (id, appt_date, appt_time, duration_minutes, status)
    on public.appointments to anon;

grant select, update on public.appointments to authenticated;

-- ---------------------------------------------------------------------------
-- _appointment_slot_capacity_ok
--
-- Internal helper (no grants -- callable only from other SECURITY DEFINER
-- functions in this schema). Re-implements just the "how many appointments
-- already overlap this exact slot, versus how many chairs exist" part of
-- isAppointmentSlotAvailable() -- see the scope-boundary note at the top of
-- this file for what it deliberately does not model.
--
-- Sweeps minute-by-minute (bounded by duration_minutes <= 480) rather than a
-- single pairwise overlap test, because concurrency can be 3+ appointments
-- deep with several chairs -- a plain "do these two ranges overlap" check
-- can't tell you whether the busiest single minute in the range exceeds
-- capacity when there are more than two overlapping bookings.
-- ---------------------------------------------------------------------------
create or replace function public._appointment_slot_capacity_ok(
    p_date date, p_start_minutes integer, p_end_minutes integer, p_exclude_id text
) returns boolean language plpgsql stable security definer set search_path = public as $$
declare
    v_seats   integer;
    v_minute  integer;
    v_count   integer;
begin
    select count(*) into v_seats from public.seats where active;
    if v_seats = 0 then return false; end if;

    v_minute := p_start_minutes;
    while v_minute < p_end_minutes loop
        select count(*) into v_count
          from public.appointments
         where appt_date = p_date
           and status = 'upcoming'
           and (p_exclude_id is null or id <> p_exclude_id)
           and v_minute >= (extract(hour from appt_time)::integer * 60 + extract(minute from appt_time)::integer)
           and v_minute <  (extract(hour from appt_time)::integer * 60 + extract(minute from appt_time)::integer + duration_minutes);
        if v_count >= v_seats then return false; end if;
        v_minute := v_minute + 1;
    end loop;
    return true;
end $$;

-- Internal only: not meant to be a PostgREST-exposed RPC. Ownership already
-- lets the SECURITY DEFINER functions above call this regardless of these
-- revokes (object ownership implies execute rights); this only blocks it
-- from being invoked directly as /rpc/_appointment_slot_capacity_ok.
revoke all on function public._appointment_slot_capacity_ok(date, integer, integer, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- _appointment_hours_ok
--
-- Reads shop_settings (weekly_op_hours/closed_dates/booking_advance_days/
-- shop_status) and checks a [start,end) minute range against that day's
-- hours and both breaks, PLUS the same date-range and today's-shop-status
-- gates isOnlineBookingDateAllowed() applies client-side. Mirrors that
-- function and getOpHours()/intervalOverlapsBreak() closely enough to catch
-- the obvious cases (closed day, outside hours, inside a break, too far
-- ahead, shop manually closed today); it is not a byte-for-byte port of the
-- client's break-adjusted scheduling engine.
-- ---------------------------------------------------------------------------
create or replace function public._appointment_hours_ok(
    p_date date, p_start_minutes integer, p_end_minutes integer
) returns boolean language plpgsql stable security definer set search_path = public as $$
declare
    v_day        jsonb;
    v_closed     boolean;
    v_open       integer;
    v_close      integer;
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
    if p_start_minutes < v_open or p_end_minutes > v_close then return false; end if;

    if nullif(v_day ->> 'break1Start', '') is not null and nullif(v_day ->> 'break1End', '') is not null then
        v_b1s := extract(hour from (v_day ->> 'break1Start')::time)::integer * 60 + extract(minute from (v_day ->> 'break1Start')::time)::integer;
        v_b1e := extract(hour from (v_day ->> 'break1End')::time)::integer   * 60 + extract(minute from (v_day ->> 'break1End')::time)::integer;
        if p_start_minutes < v_b1e and p_end_minutes > v_b1s then return false; end if;
    end if;

    if nullif(v_day ->> 'break2Start', '') is not null and nullif(v_day ->> 'break2End', '') is not null then
        v_b2s := extract(hour from (v_day ->> 'break2Start')::time)::integer * 60 + extract(minute from (v_day ->> 'break2Start')::time)::integer;
        v_b2e := extract(hour from (v_day ->> 'break2End')::time)::integer   * 60 + extract(minute from (v_day ->> 'break2End')::time)::integer;
        if p_start_minutes < v_b2e and p_end_minutes > v_b2s then return false; end if;
    end if;

    return true;
end $$;

revoke all on function public._appointment_hours_ok(date, integer, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- book_appointment
--
-- The only way an appointment row is ever created. Holds a transaction-scoped
-- advisory lock keyed by date so two concurrent bookers for the same day
-- serialise through this function -- closing the double-booking race rather
-- than just narrowing it, without the retry-loop complexity of full
-- SERIALIZABLE isolation.
--
-- claim_token is a CALLER-supplied parameter, not server-generated -- same
-- convention as queueRepository.js's takeTicket() (crypto.randomUUID() on
-- the client, sent in with the write). That precedent exists precisely so
-- the server never has to hand a normally-unreadable column back to anon:
-- the client already knows the token because it minted it. Same reasoning
-- for the return type -- just the new id (like next_ticket_number()) rather
-- than the full row: name/phone/service/price/date/time are all things the
-- caller already knows, since it just submitted them.
-- ---------------------------------------------------------------------------
create or replace function public.book_appointment(
    p_name text, p_phone text, p_claim_token uuid, p_service text,
    p_duration_minutes integer, p_price_sen integer, p_date date, p_time time
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
                                      price_sen, appt_date, appt_time, status, version)
    values (v_id, p_name, p_phone, p_claim_token, p_service, p_duration_minutes,
            p_price_sen, p_date, p_time, 'upcoming', 1);

    return v_id;
end $$;

revoke all on function public.book_appointment(text, text, uuid, text, integer, integer, date, time) from public;
grant execute on function public.book_appointment(text, text, uuid, text, integer, integer, date, time) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- cancel_own_appointment / reschedule_own_appointment
--
-- Same claim_token ownership check as cancel_own_ticket().
-- ---------------------------------------------------------------------------
create or replace function public.cancel_own_appointment(p_id text, p_claim_token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_updated integer;
begin
    update public.appointments
       set status = 'cancelled', cancelled_at = now(),
           cancelled_by = 'customer', cancel_reason = 'Dibatalkan oleh pelanggan'
     where id = p_id and claim_token = p_claim_token and status = 'upcoming';

    get diagnostics v_updated = row_count;
    return v_updated = 1;
end $$;

revoke all on function public.cancel_own_appointment(text, uuid) from public;
grant execute on function public.cancel_own_appointment(text, uuid) to anon, authenticated;

-- Returns just the new version number, not the full row: date/time are
-- already known to the caller (it just submitted them) and nothing else
-- about the appointment changes here except is_fast_pass/revoked_* when a
-- fast pass gets auto-cleared -- which the caller can already tell for
-- itself from its OWN pre-call local copy (same as index.html's existing
-- `const hadFastPass = Boolean(appointment.fastPassApproved || ...)` check,
-- computed before calling this), so there is nothing new to echo back there
-- either.
create or replace function public.reschedule_own_appointment(
    p_id text, p_claim_token uuid, p_expected_version integer, p_date date, p_time time
) returns integer language plpgsql security definer set search_path = public as $$
declare
    v_start integer;
    v_end   integer;
    v_row   public.appointments;
    v_had_fast_pass boolean;
begin
    perform pg_advisory_xact_lock(hashtext('appointments:' || p_date::text));

    select * into v_row from public.appointments
     where id = p_id and claim_token = p_claim_token and status = 'upcoming'
     for update;
    if not found then
        raise exception 'Tempahan tidak ditemui atau bukan milik anda' using errcode = 'P0002';
    end if;
    if v_row.version <> p_expected_version then
        raise exception 'Tempahan telah berubah di skrin lain' using errcode = '40001';
    end if;

    v_start := extract(hour from p_time)::integer * 60 + extract(minute from p_time)::integer;
    v_end   := v_start + v_row.duration_minutes;
    if not public._appointment_hours_ok(p_date, v_start, v_end) then
        raise exception 'Slot ini di luar waktu operasi atau bertindih waktu rehat' using errcode = '22023';
    end if;
    if not public._appointment_slot_capacity_ok(p_date, v_start, v_end, p_id) then
        raise exception 'Slot ini tidak lagi tersedia' using errcode = '22023';
    end if;

    v_had_fast_pass := v_row.is_fast_pass;

    update public.appointments
       set appt_date = p_date, appt_time = p_time, updated_at = now(),
           version = v_row.version + 1,
           is_fast_pass    = case when v_had_fast_pass then false else is_fast_pass end,
           revoked_by      = case when v_had_fast_pass then null else revoked_by end,
           revoked_reason  = case when v_had_fast_pass
                                   then 'Tarikh atau masa tempahan diubah; kelulusan semula Admin diperlukan.'
                                   else revoked_reason end,
           revoked_at      = case when v_had_fast_pass then now() else revoked_at end
     where id = p_id
    returning * into v_row;

    return v_row.version;
end $$;

revoke all on function public.reschedule_own_appointment(text, uuid, integer, date, time) from public;
grant execute on function public.reschedule_own_appointment(text, uuid, integer, date, time) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- convert_walkin_to_appointment
--
-- The reverse of checkin_appointment below: an existing WAITING walk-in
-- ticket becomes a new appointment. Ownership of the walk-in is proved with
-- its own claim_token (the same one bookTicket() already saves locally) --
-- the local prototype never actually checked this (everything lived in one
-- browser), but a server-backed version must, or any anon caller could
-- convert (and thereby cancel) any other customer's active walk-in ticket.
-- ---------------------------------------------------------------------------
-- Two claim tokens involved: p_walkin_claim_token proves ownership of the
-- EXISTING walk-in ticket being converted (already known to the caller, same
-- one takeTicket() gave it); p_new_claim_token is freshly minted by the
-- caller (crypto.randomUUID(), same convention as book_appointment()) for
-- the NEW appointment row this creates. Returns just the new appointment's
-- id -- name/phone/service/price/date/time are all things the caller already
-- knows, since it's converting its own already-known ticket.
create or replace function public.convert_walkin_to_appointment(
    p_walkin_id text, p_walkin_claim_token uuid, p_expected_version integer,
    p_name text, p_phone text, p_new_claim_token uuid, p_service text,
    p_duration_minutes integer, p_price_sen integer, p_date date, p_time time
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
                                      price_sen, appt_date, appt_time, status, version)
    values (v_id, p_name, p_phone, p_new_claim_token, p_service, p_duration_minutes,
            p_price_sen, p_date, p_time, 'upcoming', 1);

    update public.queues
       set status = 'cancelled', cancelled_at = now(),
           cancel_reason = 'Ditukar kepada Tempahan Online', version = v_queue.version + 1
     where id = p_walkin_id;

    return v_id;
end $$;

revoke all on function public.convert_walkin_to_appointment(text, uuid, integer, text, text, uuid, text, integer, integer, date, time) from public;
grant execute on function public.convert_walkin_to_appointment(text, uuid, integer, text, text, uuid, text, integer, integer, date, time) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- checkin_appointment
--
-- Admin/staff action ("Hadir" button): an upcoming appointment becomes a
-- live queue entry, reusing the same id (queues and appointments are
-- separate PK spaces, so no collision). Copies is_fast_pass and its approval
-- metadata onto the new queue row so the barber-facing UI still shows why
-- this customer has priority, same as the local prototype did.
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
                                approved_by, approval_reason, approved_at, version)
    values (p_id, p_id, v_app.name || ' (Tempahan)', v_app.phone, gen_random_uuid(), v_app.service,
            v_app.duration_minutes, v_app.price_sen, 'waiting', 'booking', v_app.is_fast_pass,
            v_app.approved_by, v_app.approval_reason, v_app.approved_at, 1)
    returning * into v_queue;

    return v_queue;
end $$;

revoke all on function public.checkin_appointment(text) from public;
grant execute on function public.checkin_appointment(text) to authenticated;

-- ---------------------------------------------------------------------------
-- approve_fast_pass / revoke_fast_pass
--
-- Admin-only, targets either a queue row or an appointment row by id. Built
-- as RPCs (rather than a plain client UPDATE like updateService()) so that
-- approved_by/revoked_by can be set from auth.uid() -- the verified caller --
-- instead of trusting a client-supplied value, which a plain column grant
-- can't distinguish from any other authenticated admin's claim.
-- ---------------------------------------------------------------------------
create or replace function public.approve_fast_pass(p_source text, p_id text, p_reason text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_updated integer;
begin
    if not public.is_admin() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;
    if p_reason is null or length(btrim(p_reason)) < 3 then
        raise exception 'Sebab kelulusan diperlukan' using errcode = '22023';
    end if;

    if p_source = 'queue' then
        update public.queues
           set is_fast_pass = true, approved_by = auth.uid(), approval_reason = p_reason,
               approved_at = now(), version = version + 1
         where id = p_id and status = 'waiting';
    elsif p_source = 'appointment' then
        update public.appointments
           set is_fast_pass = true, approved_by = auth.uid(), approval_reason = p_reason,
               approved_at = now(), version = version + 1
         where id = p_id and status = 'upcoming';
    else
        raise exception 'Invalid source: %', p_source using errcode = '22023';
    end if;

    get diagnostics v_updated = row_count;
    return v_updated = 1;
end $$;

revoke all on function public.approve_fast_pass(text, text, text) from public;
grant execute on function public.approve_fast_pass(text, text, text) to authenticated;

create or replace function public.revoke_fast_pass(p_source text, p_id text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_updated integer;
begin
    if not public.is_admin() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    if p_source = 'queue' then
        update public.queues
           set is_fast_pass = false, revoked_by = auth.uid(), revoked_at = now(),
               version = version + 1
         where id = p_id;
    elsif p_source = 'appointment' then
        update public.appointments
           set is_fast_pass = false, revoked_by = auth.uid(), revoked_at = now(),
               version = version + 1
         where id = p_id;
    else
        raise exception 'Invalid source: %', p_source using errcode = '22023';
    end if;

    get diagnostics v_updated = row_count;
    return v_updated = 1;
end $$;

revoke all on function public.revoke_fast_pass(text, text) from public;
grant execute on function public.revoke_fast_pass(text, text) to authenticated;
