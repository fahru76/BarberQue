-- Same class of fix as 20260901000300_harden_function_grants.sql, discovered the
-- same way that migration was: `revoke ... from public` alone does not strip
-- Supabase's default per-role EXECUTE grant on a newly created function --
-- `anon`/`authenticated` must be named explicitly. checkin_appointment(),
-- approve_fast_pass() and revoke_fast_pass() are staff/admin-only actions; their
-- own internal is_active_staff()/is_admin() checks already reject an anon caller
-- (verified live: calling any of the three as anon raises "Not authorised"), so
-- this was not actually exploitable -- but the grant should say so too, matching
-- how call_next_customer()/complete_service()/barber_performance() were already
-- hardened in this project.
revoke execute on function public.checkin_appointment(text)                from anon, public;
revoke execute on function public.approve_fast_pass(text, text, text)      from anon, public;
revoke execute on function public.revoke_fast_pass(text, text)             from anon, public;
