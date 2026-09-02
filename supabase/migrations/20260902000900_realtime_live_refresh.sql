-- Step 7 (see HANDOFF.md): cross-device live updates. Two pieces:
--
-- 1. `public.appointments` is added to the `supabase_realtime` publication.
--    `public.queues` and `public.seats` are already in it (Supabase's default
--    behaviour when a table is created); appointments was created later in the
--    same migration set and was never added. Realtime's own row-visibility
--    check follows each subscriber's RLS as normal ("appointments readable by
--    all" already exists) -- this migration only turns the WAL broadcast on,
--    it does not change who can read what.
--
-- 2. Two new staff-gated RPCs. The client already has anon-safe list
--    functions (queueRepository.js's listQueues(), scoped to QUEUE_COLUMNS)
--    but nothing that returns the FULL row for an authenticated caller --
--    every existing authenticated write (call_next_customer, complete_service,
--    checkin_appointment, ...) returns a full row because it's the one row it
--    just touched, never a list. A realtime-triggered refresh on a barber/
--    admin device needs the full row for EVERY currently-relevant record
--    (price_sen, phone, version, cancelled_by/reason, approved_by/reason/at,
--    revoked_by/reason/at) so that a row created or changed on a DIFFERENT
--    device still has everything this device's own actions need (`version`
--    especially -- the optimistic-concurrency field every cancel/fast-pass
--    write already depends on). Plain table SELECTs can't do this: PostgREST
--    enforces column grants as all-or-nothing, and QUEUE_COLUMNS is
--    deliberately the anon-safe subset (see queueRepository.js's header
--    comment) -- widening it there would widen what anon can read too. RPCs
--    sidestep that the same way every other staff-only read/write in this
--    project already does: SECURITY DEFINER, gated by is_active_staff()
--    inside the function body, returning the full row on its own terms.
--
-- Both are read-only and scoped to "still relevant today or later" rather
-- than the whole table's history, so a merge-by-id on the client only ever
-- touches rows it has reason to touch -- older completed/cancelled rows
-- already in local storage for reporting are never in these result sets and
-- are therefore never overwritten or removed by the merge.

alter publication supabase_realtime add table public.appointments;

-- Today only (Malaysia time), no status filter -- so a transition OUT of
-- waiting/serving (into completed/cancelled) is still visible via the
-- `status` column even though this function (unlike listQueues()) has no
-- status predicate at all.
create or replace function public.list_today_queues_full()
returns setof public.queues language plpgsql stable security definer set search_path = public as $$
begin
    if not public.is_active_staff() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    return query
        select *
          from public.queues
         where (created_at at time zone 'Asia/Kuala_Lumpur')::date = (now() at time zone 'Asia/Kuala_Lumpur')::date
         order by created_at;
end $$;

-- appt_date is already a plain Malaysia-local date (no tz conversion needed).
-- >= today, no upper bound: a booking can be made bookingAdvanceDays ahead,
-- and the point is to see every future/current booking's changes live, not
-- just today's. No status filter, same reasoning as above.
create or replace function public.list_active_appointments()
returns setof public.appointments language plpgsql stable security definer set search_path = public as $$
begin
    if not public.is_active_staff() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    return query
        select *
          from public.appointments
         where appt_date >= (now() at time zone 'Asia/Kuala_Lumpur')::date
         order by appt_date, appt_time;
end $$;

revoke execute on function public.list_today_queues_full()   from anon, public;
revoke execute on function public.list_active_appointments() from anon, public;
grant  execute on function public.list_today_queues_full()   to authenticated;
grant  execute on function public.list_active_appointments() to authenticated;
