-- Fixes a bug in 20260901000400_services_catalog.sql's select policy, found
-- during step-5a verification (server version 20260831174520 applied first,
-- this fix applied the same day as a separate migration — see that file's
-- note).
--
-- The original policy was a single `to anon, authenticated` policy:
--     using (active or public.is_active_staff())
-- 20260901000300_harden_function_grants.sql revoked EXECUTE on
-- is_active_staff() from anon specifically, on the stated assumption that
-- "no anon policy calls them". Postgres evaluates a row-security USING
-- clause as one boolean expression regardless of which role's policy
-- matched the row; for any INACTIVE service, `active` is false, so Postgres
-- must evaluate is_active_staff() to decide the row — and since anon has no
-- EXECUTE grant on it, the entire query erred with 42501 for an anon caller
-- the instant even one inactive service existed, instead of just filtering
-- that row out. Confirmed live via a rollback-safe `set_config(...)`
-- simulation before and after this fix.
--
-- Fix: split into two role-scoped policies. A policy scoped `to anon` is
-- never evaluated at all when the querying role is `authenticated` (and vice
-- versa) — Postgres skips policies that don't apply to the current role
-- entirely, it doesn't just filter their result — so anon's policy simply
-- never references is_active_staff(), restoring the "no anon policy calls
-- them" invariant the harden migration relied on.
drop policy "active services readable by all, all services readable by staff" on public.services;

create policy "active services readable by anon"
    on public.services for select
    to anon
    using (active);

create policy "all services readable by staff"
    on public.services for select
    to authenticated
    using (active or public.is_active_staff());
