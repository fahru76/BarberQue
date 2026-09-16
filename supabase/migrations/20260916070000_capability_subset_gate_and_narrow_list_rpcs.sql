-- ---------------------------------------------------------------------------
-- Bug-hunt audit (2026-09-16) — three fixes, one migration.
--
-- 1. call_next_customer(): the capability "hard gate" used array OVERLAP
--    (`&&`) where the documented contract requires SUBSET (`<@`).
--
--    public.staff.capability_service_ids is documented (see
--    20260906001705_smart_barber_assignment.sql) as a HARD GATE: the set of
--    service.id values this barber may be called for at all, with "never
--    called for it, no fallback". `service_ids && v_capability` only checks
--    that AT LEAST ONE of the ticket's selected services is in that set —
--    which happens to be equivalent for a single-service ticket, and wrong
--    for every multi-service one.
--
--    Multi-service tickets are the normal UI path, not an edge case:
--    index.html renders each service as its own checkbox and collects them
--    with `Array.from(cb).map(c => c.dataset.serviceId).filter(Boolean)`,
--    so a ticket for [Skin Fade, Perm] carries BOTH ids in service_ids.
--    Under `&&`, a barber capable of only Skin Fade is called for the whole
--    ticket and cannot perform the Perm — the exact case the hard gate
--    exists to prevent.
--
--    Tier 1 (specialty) has the same hole and is fixed the same way.
--    specialty_service_ids is constrained to be a SUBSET of
--    capability_service_ids, so a barber's specialty can never be wider than
--    their capability — but overlapping a ticket's services does not imply
--    the ticket is within capability either. Ticket [A, C] matches a barber
--    whose specialty is [A] under `&&`, even when C is outside that barber's
--    capability entirely. The specialty check stays an OVERLAP (it is a soft
--    priority — "is any of this ticket's work something they specialise
--    in?" — and the project's design note explicitly keeps it as a priority
--    signal that falls back), but it is now additionally gated on the same
--    subset check, so a specialty match can never pull in a ticket the
--    barber is not capable of.
--
--    NULL handling is unchanged and deliberate, matching the column's own
--    documented default: `v_capability is null` = unrestricted (capable of
--    everything), and `service_ids is null` = unknown service (a legacy row,
--    or a creation path that predates the snapshot) — treated as compatible
--    rather than excluded, because refusing an unknown-service ticket would
--    strand a real customer over a data gap, not a genuine mismatch.
--
-- 2. list_today_queues_full() / list_active_appointments(): both were
--    declared `returns setof public.<table>`, which returns EVERY column —
--    including `claim_token`, the credential that authorises cancelling that
--    booking as that customer. Both are is_active_staff()-gated and revoked
--    from anon, so this was never a public leak; the client (see
--    queueRepository.js's mapQueueRowFull() and appointmentRepository.js's
--    listActiveAppointments()) deliberately never maps claim_token into its
--    returned object. But the value still crossed the wire to the browser
--    and sat in the JS heap, which is the same "payload carries more than
--    the consumer needs" shape as the Realtime exposure closed in
--    20260916060000. Narrowing both to an explicit column list removes it
--    without changing any field the client actually reads.
--
--    Verified before changing the return shape that nothing depends on
--    claim_token coming back from either RPC: index.html reads its own
--    walk-in token from localStorage['activeTicketClaimToken'] and its own
--    appointment tokens from a separate per-appointment map — never off a
--    server-merged queue/appointment object. `mergeServerRows()` spreads
--    `{ ...item, ...freshRow }`, so a row that simply lacks the key leaves
--    any locally-held value untouched rather than clearing it.
--
--    Both functions' return types therefore change, which `create or
--    replace` cannot do — each is dropped and recreated, and its grants are
--    restated (dropping a function discards its ACL). Migrations run in a
--    transaction, so the drop/create pair is atomic and there is no window
--    in which the RPC is missing.
-- ---------------------------------------------------------------------------


-- ---- 1. call_next_customer(): capability gate is a subset check -----------

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

    if v_seat_barber <> v_barber and not public.is_admin() then
        raise exception 'Anda tidak ditugaskan pada kerusi ini' using errcode = '42501';
    end if;

    if exists (select 1 from public.queues where seat_no = p_seat_no and status = 'serving') then
        raise exception 'Kerusi % masih melayan pelanggan', p_seat_no using errcode = '22023';
    end if;

    select capability_service_ids, specialty_service_ids, service_durations
      into v_capability, v_specialty, v_service_durations
      from public.staff where id = v_seat_barber;

    -- Tier 1: specialty match, ADDITIONALLY gated on the capability subset
    -- check below (see this migration's header). `service_ids && v_specialty`
    -- is an overlap on purpose -- "is any of this ticket's work something
    -- this barber specialises in" -- but it must never pull in a ticket the
    -- barber is not capable of doing in full.
    if v_specialty is not null and array_length(v_specialty, 1) > 0 then
        select * into v_row
          from public.queues
         where status = 'waiting'
           and service_ids is not null
           and service_ids && v_specialty
           and (v_capability is null or service_ids <@ v_capability)
         order by (case when is_fast_pass then 0 when source = 'booking' then 1 else 2 end), created_at
         limit 1
           for update skip locked;
    end if;

    -- Tier 2: capability match -- the hard gate itself. `service_ids <@
    -- v_capability` reads "every service on this ticket is one this barber
    -- is allowed to perform", which is the actual contract. v_capability is
    -- null = unrestricted; service_ids is null = unknown service, treated as
    -- compatible rather than excluded (see header).
    if v_row.id is null then
        select * into v_row
          from public.queues
         where status = 'waiting'
           and (v_capability is null or service_ids is null or service_ids <@ v_capability)
         order by (case when is_fast_pass then 0 when source = 'booking' then 1 else 2 end), created_at
         limit 1
           for update skip locked;
    end if;

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

    return v_row;
end $$;

revoke all on function public.call_next_customer(integer) from public;
revoke all on function public.call_next_customer(integer) from anon;
grant execute on function public.call_next_customer(integer) to authenticated;


-- ---- 2. narrow both staff list RPCs off `select *` (drop claim_token) -----

-- Return types change (setof <table> -> explicit table(...)), which
-- `create or replace` cannot do, so each function is dropped and recreated.
drop function if exists public.list_today_queues_full();
drop function if exists public.list_active_appointments();

-- Every column of public.queues EXCEPT claim_token and service_ids (the
-- latter is non-sensitive but is never read by any client call site -- see
-- queueRepository.js's mapQueueRowFull() -- so it is not carried either).
create function public.list_today_queues_full()
returns table (
    id                text,
    ticket_no         text,
    name              text,
    phone             text,
    service           text,
    duration_minutes  integer,
    price_sen         integer,
    seat_no           integer,
    barber_id         uuid,
    barber_name       text,
    status            text,
    source            text,
    is_fast_pass      boolean,
    approved_by       uuid,
    approval_reason   text,
    approved_at       timestamptz,
    revoked_by        uuid,
    revoked_reason    text,
    revoked_at        timestamptz,
    created_at        timestamptz,
    called_at         timestamptz,
    completed_at      timestamptz,
    cancelled_at      timestamptz,
    cancelled_by      uuid,
    cancel_reason     text,
    version           integer
) language plpgsql stable security definer set search_path = public as $$
begin
    if not public.is_active_staff() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    return query
        select q.id, q.ticket_no, q.name, q.phone, q.service, q.duration_minutes,
               q.price_sen, q.seat_no, q.barber_id, q.barber_name, q.status,
               q.source, q.is_fast_pass, q.approved_by, q.approval_reason,
               q.approved_at, q.revoked_by, q.revoked_reason, q.revoked_at,
               q.created_at, q.called_at, q.completed_at, q.cancelled_at,
               q.cancelled_by, q.cancel_reason, q.version
          from public.queues q
         where q.created_at >= public._business_day_start(public._current_business_date())
         order by q.created_at;
end $$;

-- Every column of public.appointments EXCEPT claim_token and service_ids.
create function public.list_active_appointments()
returns table (
    id                text,
    name              text,
    phone             text,
    service           text,
    duration_minutes  integer,
    price_sen         integer,
    appt_date         date,
    appt_time         time,
    status            text,
    is_fast_pass      boolean,
    approved_by       uuid,
    approval_reason   text,
    approved_at       timestamptz,
    revoked_by        uuid,
    revoked_reason    text,
    revoked_at        timestamptz,
    created_at        timestamptz,
    updated_at        timestamptz,
    arrived_at        timestamptz,
    cancelled_at      timestamptz,
    cancelled_by      text,
    cancel_reason     text,
    version           integer
) language plpgsql stable security definer set search_path = public as $$
begin
    if not public.is_active_staff() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    return query
        select a.id, a.name, a.phone, a.service, a.duration_minutes, a.price_sen,
               a.appt_date, a.appt_time, a.status, a.is_fast_pass, a.approved_by,
               a.approval_reason, a.approved_at, a.revoked_by, a.revoked_reason,
               a.revoked_at, a.created_at, a.updated_at, a.arrived_at,
               a.cancelled_at, a.cancelled_by, a.cancel_reason, a.version
          from public.appointments a
         where a.appt_date >= (now() at time zone 'Asia/Kuala_Lumpur')::date
         order by a.appt_date, a.appt_time;
end $$;

-- Grants restated: dropping a function discards its ACL, so these are not
-- optional here the way they are after a plain `create or replace`.
revoke all on function public.list_today_queues_full()   from public, anon;
revoke all on function public.list_active_appointments() from public, anon;
grant  execute on function public.list_today_queues_full()   to authenticated;
grant  execute on function public.list_active_appointments() to authenticated;