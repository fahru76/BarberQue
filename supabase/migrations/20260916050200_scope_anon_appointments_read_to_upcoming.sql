-- ---------------------------------------------------------------------------
-- Bug-hunt audit (2026-09-15), LOW item: "appointments anon SELECT policy has
-- no date/status scoping". The anon column grant is already correctly
-- restricted (id, appt_date, appt_time, duration_minutes, status only -- no
-- name/phone/price leak), but the ROW policy itself
-- ("appointments readable by anon", using (true)) lets an anon client
-- enumerate every appointment ever made, of any status, on any date --
-- including old completed/cancelled ones -- which is wider than this
-- policy's own stated intent (see the column-grant comment in
-- 20260901000700_appointments.sql: "enough to render a live 'which slots are
-- already taken' preview... nothing identifying anyone").
--
-- Confirmed by inspection that no current code path actually queries this
-- policy: there is no `.from('appointments')` read anywhere in js/ or
-- index.html today (the customer-facing slot-availability check in
-- index.html reads purely from localStorage via getAppointments(), and the
-- staff-side listActiveAppointments() goes through the separate
-- list_active_appointments() SECURITY DEFINER RPC, not this policy at all).
-- So this is a pure risk-reduction with zero functional impact today --
-- narrower than a behaviour change, and matches this app's own two existing
-- partial indexes for the same distinction (appointments_active_idx,
-- appointments_today_idx, both `where status = 'upcoming'`).
--
-- Fix: scope the anon SELECT policy to status = 'upcoming' only -- a
-- cancelled/completed/arrived appointment consumes no capacity and was never
-- the intended purpose of this policy. Deliberately no date-range restriction
-- on top: an 'upcoming' row for a future date is exactly what an
-- availability check (present or future) needs to see, so status alone is
-- both correct and sufficient here.
-- ---------------------------------------------------------------------------

drop policy "appointments readable by anon" on public.appointments;

create policy "appointments readable by anon"
    on public.appointments for select to anon
    using (status = 'upcoming');
