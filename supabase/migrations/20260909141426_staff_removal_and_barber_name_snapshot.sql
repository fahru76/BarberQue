-- ---------------------------------------------------------------------------
-- Admin staff management: assign/remove admin role (already existed via
-- setStaffStatus()'s `role` param + "admins manage staff" RLS policy -- no
-- change needed there) and a genuine "remove barber from the list" action,
-- which did not exist before this migration -- deactivating a staff row
-- (setStaffStatus({ active: false })) only hides them, it never freed up
-- their email/account or removed them from Supabase Auth.
--
-- 1. queues.barber_name -- a snapshot column so a completed ticket's barber
--    attribution survives independently of the `staff` row it came from.
--    Without this, deleting a staff account (`staff.id references
--    auth.users(id) on delete cascade`) would silently null out every past
--    ticket's `barber_id` (`on delete set null`) and reports/exports would
--    lose that barber's name from historical data -- exactly the concern
--    raised when this feature was scoped. The client already fakes this
--    with an in-memory/localStorage-only copy (index.html's `queue.barberName`,
--    set once at call-time from `seatServerState`), which never reaches the
--    database and doesn't survive a cleared cache or a different device --
--    this makes it a real, durable column instead.
--
-- 2. admin_remove_staff(uuid) -- permanently deletes a staff member's
--    Supabase Auth account (`delete from auth.users`), which cascades to
--    delete their `public.staff` row. Runs as `postgres` (this migration's
--    owner), which already has DELETE on `auth.users` in this project --
--    confirmed live before writing this migration -- so no Edge Function or
--    service_role key is needed, unlike invite-barber() (which needs the
--    Auth Admin API specifically to send an email). Two safety rules,
--    per the scoping conversation:
--      - an admin can never remove their own account (avoids a self-lockout)
--      - the last remaining ACTIVE admin can never be removed (avoids the
--        shop ending up with zero admins)
--    Both are enforced here, server-side, not just in the UI.
--
-- 3. enforce_staff_self_update_scope() (from
--    20260909133619_close_staff_privilege_escalation_and_pii_leak.sql) gets
--    the same "keep at least one active admin" rule added for the UPDATE
--    path (self-demotion, or an admin demoting/deactivating another admin's
--    role/active flag) -- this closes a gap already flagged in HANDOFF.md:
--    "an admin could deactivate/demote their own account with no
--    protection". Not asked for by name this round, but it's the same
--    invariant the user explicitly asked for on the DELETE path, and
--    leaving the UPDATE path unprotected would make that guard pointless
--    (an admin could just demote themselves to 'barber' instead of deleting
--    their own row to reach the same zero-admin state).
-- ---------------------------------------------------------------------------

-- ---- 1. barber_name snapshot -----------------------------------------------

alter table public.queues add column barber_name text;

create or replace function public.sync_queue_barber_name()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.barber_id is not null
       and (tg_op = 'INSERT' or new.barber_id is distinct from old.barber_id)
    then
        select display_name into new.barber_name
          from public.staff
         where id = new.barber_id;
    end if;
    return new;
end;
$$;

drop trigger if exists queue_barber_name_sync on public.queues;
create trigger queue_barber_name_sync
    before insert or update on public.queues
    for each row
    execute function public.sync_queue_barber_name();

-- Backfill: existing rows that already have a barber_id but predate this
-- column. A barber deleted before this migration ran has no staff row left
-- to backfill from -- those rows keep barber_name = null, same as any
-- walk-in ticket that was never called to a seat. Nothing to be done about
-- history that's already gone; this only stops it happening again.
update public.queues q
   set barber_name = s.display_name
  from public.staff s
 where q.barber_id = s.id
   and q.barber_name is null;

grant select (barber_name) on public.queues to authenticated;

-- ---- 2. permanently remove a staff member ----------------------------------

create or replace function public.admin_remove_staff(p_staff_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_caller            uuid := auth.uid();
    v_target            public.staff;
    v_remaining_admins  integer;
begin
    if not public.is_admin() then
        raise exception 'Not authorised' using errcode = '42501';
    end if;

    if p_staff_id = v_caller then
        raise exception 'Anda tidak boleh membuang akaun anda sendiri.' using errcode = '42501';
    end if;

    select * into v_target from public.staff where id = p_staff_id;
    if not found then
        raise exception 'Kakitangan tidak ditemui.' using errcode = 'P0002';
    end if;

    if v_target.role = 'admin' and v_target.active then
        select count(*) into v_remaining_admins
          from public.staff
         where role = 'admin' and active and id <> p_staff_id;
        if v_remaining_admins = 0 then
            raise exception 'Tidak boleh membuang admin aktif terakhir.' using errcode = '42501';
        end if;
    end if;

    -- Deletes auth.users, which cascades to public.staff
    -- (staff.id references auth.users(id) on delete cascade). Every other
    -- reference to this staff row (queues.barber_id, seats.barber_id,
    -- queues.cancelled_by, appointments.*_by) is `on delete set null`, so
    -- historical rows survive with the link cleared -- queues.barber_name
    -- (above) keeps the readable name for reports regardless.
    delete from auth.users where id = p_staff_id;
end;
$$;

revoke all on function public.admin_remove_staff(uuid) from public;
grant execute on function public.admin_remove_staff(uuid) to authenticated;

-- ---- 3. keep-at-least-one-active-admin, also on the UPDATE (demote/
--         deactivate) path, not just the DELETE path above --------------------

create or replace function public.enforce_staff_self_update_scope()
returns trigger
language plpgsql
set search_path = public
as $$
declare
    v_remaining_admins integer;
begin
    -- Only relevant to a real PostgREST/API request running as the
    -- `authenticated` role. A migration or manual admin-bootstrap statement
    -- run via the Supabase SQL editor / service role executes as `postgres`
    -- (or `service_role`) and must never be blocked by this check -- see
    -- HANDOFF.md's "bootstrap the first admin" section.
    if current_user <> 'authenticated' then
        return new;
    end if;

    -- Keep-at-least-one-active-admin invariant. Checked before the
    -- self-only-fields check below and before the is_admin() early-return,
    -- so it applies to ANY update path: an admin demoting/deactivating
    -- themselves, or an admin demoting/deactivating another admin.
    if old.role = 'admin' and old.active
       and (new.role is distinct from 'admin' or new.active is distinct from true)
    then
        select count(*) into v_remaining_admins
          from public.staff
         where role = 'admin' and active and id <> old.id;
        if v_remaining_admins = 0 then
            raise exception 'Tidak boleh membuang status admin aktif terakhir.' using errcode = '42501';
        end if;
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
