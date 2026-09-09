-- ---------------------------------------------------------------------------
-- Security audit fix (2026-09-09), three issues found and verified live:
--
-- 1. CRITICAL -- privilege escalation. "staff update own display name"
--    (20260901000100_rls_policies.sql) only checks id = auth.uid() in its
--    USING/WITH CHECK -- RLS cannot itself restrict which COLUMNS an
--    allowed row-level UPDATE touches, and the accompanying grant
--    (`grant select, update on public.staff to authenticated`) is
--    unrestricted. Any signed-in barber could run, from the browser
--    console:
--      supabase.from('staff').update({ role: 'admin', active: true }).eq('id', <own id>)
--    and become a fully active admin. setStaffStatus() (authRepository.js)
--    never exercises this path -- it's gated entirely by the separate
--    "admins manage staff" policy -- so nothing in the app relies on
--    unrestricted self-update; only display_name (and its auto-derived
--    name_key) should ever change through this policy. Closed with a
--    BEFORE UPDATE trigger, since RLS alone can't express a column-scoped
--    check.
--
-- 2. HIGH -- customer PII leak. "queue readable by all" / "appointments
--    readable by all" grant SELECT to `anon, authenticated` with
--    `using (true)`, and only the `anon` column grant is scoped to exclude
--    phone/price -- the `authenticated` grant is unrestricted. Any signed-in
--    staff account, including one invited but never approved, or one
--    deactivated (`staff.active = false`) but never deleted from Supabase
--    Auth, can read every customer's phone number and every booking's price
--    directly, bypassing the app's own "must be active staff" rule that
--    every other privileged read/write already enforces. Closed by
--    splitting each combined policy into an anon policy (unchanged) and a
--    staff policy gated on is_active_staff(), matching the pattern already
--    used for `services`.
--
-- 3. MEDIUM -- unauthorized report access. barber_performance() only checks
--    is_active_staff(), not is_admin(), even though the sales report is
--    admin-only in the UI (admin-app). Any active barber can call the RPC
--    directly and see every colleague's revenue. Closed by requiring
--    is_admin() instead. Confirmed via full-repo grep that nothing in
--    index.html or js/repositories/*.js currently calls this RPC, so
--    tightening it has no client-side impact to account for.
-- ---------------------------------------------------------------------------

-- ---- Fix 1: staff self-update column scope --------------------------------

create or replace function public.enforce_staff_self_update_scope()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    -- Only relevant to a real PostgREST/API request running as the
    -- `authenticated` role. A migration or manual admin-bootstrap statement
    -- run via the Supabase SQL editor / service role executes as `postgres`
    -- (or `service_role`) and must never be blocked by this check -- see
    -- HANDOFF.md's "bootstrap the first admin" section.
    if current_user <> 'authenticated' then
        return new;
    end if;

    -- Admins may change anything about any staff row -- already the scope
    -- of the separate "admins manage staff" policy; this trigger only
    -- narrows what the *other* policy ("staff update own display name")
    -- lets a non-admin do to their own row.
    if public.is_admin() then
        return new;
    end if;

    if new.role is distinct from old.role
        or new.active is distinct from old.active
        or new.capability_service_ids is distinct from old.capability_service_ids
        or new.specialty_service_ids is distinct from old.specialty_service_ids
        or new.service_durations is distinct from old.service_durations
        or new.id is distinct from old.id
        or new.created_at is distinct from old.created_at
    then
        raise exception 'Hanya nama paparan boleh dikemas kini oleh diri sendiri.' using errcode = '42501';
    end if;
    return new;
end;
$$;

drop trigger if exists staff_self_update_scope on public.staff;
create trigger staff_self_update_scope
    before update on public.staff
    for each row
    execute function public.enforce_staff_self_update_scope();

-- ---- Fix 2: queues/appointments SELECT requires active staff (not just any
--      signed-in account) for anything beyond the public/anon columns -------

drop policy "queue readable by all" on public.queues;
create policy "queue readable by anon" on public.queues
    for select to anon using (true);
create policy "queue readable by active staff" on public.queues
    for select to authenticated using (public.is_active_staff());

drop policy "appointments readable by all" on public.appointments;
create policy "appointments readable by anon" on public.appointments
    for select to anon using (true);
create policy "appointments readable by active staff" on public.appointments
    for select to authenticated using (public.is_active_staff());

-- ---- Fix 3: barber_performance() requires admin, not just active staff ----

create or replace function public.barber_performance(p_from date, p_to date)
returns table (barber_id uuid, display_name text, customers bigint, sales_sen bigint)
language plpgsql stable security definer set search_path = public as $$
begin
    if not public.is_admin() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    return query
    select s.id,
           s.display_name,
           count(q.id),
           coalesce(sum(q.price_sen), 0)
      from public.staff s
      left join public.queues q
             on q.barber_id = s.id
            and q.status = 'done'
            and (q.completed_at at time zone 'Asia/Kuala_Lumpur')::date between p_from and p_to
     where s.active
     group by s.id, s.display_name
     order by coalesce(sum(q.price_sen), 0) desc, s.display_name;
end $$;

revoke execute on function public.barber_performance(date, date) from anon, public;
grant  execute on function public.barber_performance(date, date) to authenticated;
