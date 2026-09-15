-- ---------------------------------------------------------------------------
-- Bug-hunt audit (2026-09-15): the "staff manage the queue" UPDATE policy
-- and the "staff may take a ticket for a walk-in" INSERT policy on
-- public.queues only checked is_active_staff(), with no row or column
-- scoping beyond that.
--
-- Every real safeguard this app has for the queue -- seat-assignment
-- authorization (call_next_customer()), price/duration integrity
-- (recompute_walkin_price_from_services(), a BEFORE INSERT trigger scoped
-- to source = 'walkin' only), fast-pass approval (approve_fast_pass()), and
-- the cancellation audit trail (admin_cancel_record()) -- lives only inside
-- those RPC/trigger bodies, all of which are SECURITY DEFINER. A SECURITY
-- DEFINER function executes with its OWNER's privileges regardless of the
-- calling role's own table grants, so none of them need `authenticated` to
-- hold a direct UPDATE grant on this table to work correctly.
--
-- Confirmed by inspection that no JS code path performs a direct staff-side
-- UPDATE on public.queues: js/repositories/queueRepository.js's only two
-- direct `.from('queues')` calls are the anon-safe SELECT in listQueues()
-- and the INSERT in takeTicket() (used for both anon and staff-assisted
-- walk-ins); every other mutation (callNext, completeService, cancelOwn,
-- approveFastPass, revokeFastPass, adminCancelRecord, checkinAppointment,
-- convertWalkinToAppointment) goes through an RPC. index.html never calls
-- `.from('queues')` directly at all -- everything routes through
-- window.QueueRepo.
--
-- Without this, an active-but-malicious or compromised staff session could
-- call supabase.from('queues').update(...) directly (bypassing the app's
-- own UI/RPCs entirely) to:
--   - set status/seat_no/barber_id/called_at directly, stealing a seat
--     assignment past call_next_customer()'s ownership check;
--   - set an arbitrary price_sen/status/barber_id on any row, corrupting
--     barber_performance()'s commission/sales figures (the price-validation
--     trigger only fires on INSERT, never on UPDATE);
--   - set is_fast_pass = true directly, skipping approve_fast_pass()'s
--     admin-only, reason-required gate;
--   - set cancelled_by to any staff id (a plain writable FK, not forced to
--     auth.uid()), spoofing the cancellation audit trail past
--     admin_cancel_record()'s admin gate.
-- Similarly, the INSERT policy's lack of row scoping meant a staff INSERT
-- (unlike the tightly-scoped anon INSERT policy) could set any column to
-- any value at ticket-creation time, provided it only stayed off the
-- BEFORE INSERT trigger's source = 'walkin' path.
--
-- Fix:
--   1. Revoke UPDATE on queues from authenticated entirely and drop "staff
--      manage the queue". A no-op for the app (nothing legitimate uses it,
--      per the above) that closes the UPDATE attack surface completely.
--   2. Re-scope the staff INSERT policy to the exact same shape as the
--      existing anon INSERT policy (plain waiting walk-in only) --
--      takeTicket() is the only code path that performs a staff-side
--      INSERT, and it always produces exactly this shape, so this is also
--      functionally a no-op for legitimate use.
-- ---------------------------------------------------------------------------

drop policy if exists "staff manage the queue" on public.queues;

revoke update on public.queues from authenticated;

drop policy if exists "staff may take a ticket for a walk-in" on public.queues;

create policy "staff may take a ticket for a walk-in"
    on public.queues for insert to authenticated
    with check (
        public.is_active_staff()
        and status = 'waiting'
        and source = 'walkin'
        and seat_no is null
        and barber_id is null
        and is_fast_pass = false
        and called_at is null
        and completed_at is null
        and cancelled_at is null
        and cancelled_by is null
        and version = 1
    );
