-- The previous migration's `revoke all ... from public` did not remove the
-- separate DEFAULT PRIVILEGES grant Supabase applies to `anon` on every new
-- public function -- confirmed live via get_advisors right after applying
-- (anon_security_definer_function_executable flagged admin_remove_staff as
-- anon-callable). Same root cause and same fix as
-- 20260901000300_harden_function_grants.sql: revoke per role, not from
-- PUBLIC. admin_remove_staff() does independently check is_admin() and
-- would reject an anon caller (auth.uid() is null for anon, so is_admin()
-- returns false) -- this was defense-in-depth that was accidentally
-- missing, not an open door, but it must be closed properly per the
-- project's own established pattern for this exact class of bug.
revoke execute on function public.admin_remove_staff(uuid) from anon, public;
grant  execute on function public.admin_remove_staff(uuid) to authenticated;
