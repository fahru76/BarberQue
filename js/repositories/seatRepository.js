/**
 * seatRepository — public.seats: which chairs are open, and which signed-in
 * staff account each one is assigned to (migration step 4b, seat-assignment
 * half).
 *
 * This is a genuinely new concept, not a straight port: index.html's
 * `barberAssignments` in localStorage has always been a free-text name typed
 * by the admin, with no link to an actual account. `seats.barber_id` is a
 * real foreign key to `staff.id`, and `call_next_customer()` (see
 * queueRepository.js) refuses to call anyone to a seat unless that seat's
 * server-side row has `active = true` AND a `barber_id` — enforced by the
 * database's own `seats_active_requires_barber` check constraint, not just
 * application code. So the admin UI now assigns a *registered staff member*
 * to a seat (a <select>, not free text) — index.html still derives the
 * human-readable name it has always used locally (for the sales report,
 * audit log, etc.) from that same staff member's `display_name`, so nothing
 * downstream of `barberAssignments` had to change shape.
 *
 * `seats readable by all` / `admins manage seats` in
 * supabase/migrations/20260901000100_rls_policies.sql already gate this
 * table correctly (assign/activate is for-all-to-authenticated using
 * is_admin()) — this module doesn't re-implement that, only calls it.
 */
import { supabase } from '../supabaseClient.js';

function raiseOnError(error) {
    if (error) throw new Error(`[seatRepository] ${error.message ?? error}`, { cause: error });
}

/**
 * Every seat the server knows about, with the assigned staff member's
 * display name embedded via the `barber_id` foreign key (Supabase's
 * embedded-resource select) so the admin UI never needs a second round trip
 * just to show a name. A seat_no with no row yet (nothing has ever assigned
 * it) simply doesn't appear — callers should treat "missing" the same as
 * `{ active: false, barberId: null }`.
 */
export async function listSeats() {
    const { data, error } = await supabase
        .from('seats')
        .select('seat_no, active, barber_id, break_until, duty_date, staff:barber_id ( display_name )')
        .order('seat_no', { ascending: true });
    raiseOnError(error);
    return data.map(row => ({
        seatNo: row.seat_no,
        active: row.active,
        barberId: row.barber_id,
        barberName: row.staff?.display_name ?? null,
        breakUntil: row.break_until ?? null,
        dutyDate: row.duty_date ?? null
    }));
}

/**
 * Upsert one seat's open/closed flag and assigned staff member together —
 * they must move together because of `seats_active_requires_barber`
 * (activating a seat with no staffId is rejected by the database, not just
 * by index.html's own pre-existing local validation).
 *
 * Admin-only in practice: the RLS policy is the real boundary
 * (`admins manage seats`, `using (is_admin())`); index.html only calls this
 * from admin-gated screens as a convenience, same pattern as everywhere else
 * in this migration.
 *
 * @param {number} seatNo
 * @param {{active: boolean, staffId: string|null}} assignment
 */
export async function setSeatAssignment(seatNo, { active, staffId }) {
    const { data, error } = await supabase
        .from('seats')
        .upsert({ seat_no: seatNo, active, barber_id: staffId ?? null }, { onConflict: 'seat_no' })
        .select('seat_no, active, barber_id')
        .single();
    raiseOnError(error);
    return { seatNo: data.seat_no, active: data.active, barberId: data.barber_id };
}

/**
 * Per-chair data for the wait estimator (migration 20261008140000), readable
 * on every surface incl. anon: on duty today, break end, and the barber's
 * capability + own service times. Deliberately carries no barber id/name.
 *
 * @returns {Promise<Array<{seatNo:number, onDuty:boolean, breakUntil:string|null,
 *           capabilityServiceIds:string[]|null, serviceDurations:Object|null}>>}
 */
export async function listSeatProfiles() {
    const { data, error } = await supabase.rpc('list_seat_profiles');
    raiseOnError(error);
    return (data ?? []).map(row => ({
        seatNo: row.seat_no,
        onDuty: !!row.on_duty,
        breakUntil: row.break_until ?? null,
        capabilityServiceIds: Array.isArray(row.capability_service_ids) ? row.capability_service_ids : null,
        serviceDurations: row.service_durations && typeof row.service_durations === 'object' ? row.service_durations : null
    }));
}

/**
 * Barber self-service duty (migration 20261008100000). Both go through
 * SECURITY DEFINER RPCs -- a barber never gets a direct UPDATE on seats.
 * start_duty() only takes a free chair within shop_settings.seat_count for
 * the caller; end_duty() closes the caller's own chair (or, for an admin,
 * any chair) and refuses while a customer is being served.
 *
 * @param {number} seatNo chair the barber picked.
 */
export async function startDuty(seatNo) {
    const { data, error } = await supabase.rpc('start_duty', { p_seat_no: seatNo });
    raiseOnError(error);
    return { seatNo: data.seat_no, active: data.active, barberId: data.barber_id, dutyDate: data.duty_date ?? null };
}

/** @param {number|null} [seatNo] null = the caller's own chair. */
export async function endDuty(seatNo = null) {
    const { data, error } = await supabase.rpc('end_duty', { p_seat_no: seatNo });
    raiseOnError(error);
    return { seatNo: data.seat_no, active: data.active };
}

/**
 * Barber short break (migration 20261008090000). Goes through the
 * set_seat_break() SECURITY DEFINER RPC -- barbers have no direct UPDATE
 * right on public.seats; the RPC only lets a seat's own barber (or an admin)
 * touch break_until, and refuses a break while a customer is being served.
 *
 * @param {number} seatNo
 * @param {number} minutes 1-120 to start a break, 0 to end it now.
 * @returns {Promise<{seatNo:number, breakUntil:string|null}>}
 */
export async function setSeatBreak(seatNo, minutes) {
    const { data, error } = await supabase.rpc('set_seat_break', { p_seat_no: seatNo, p_minutes: minutes });
    raiseOnError(error);
    return { seatNo: data.seat_no, breakUntil: data.break_until ?? null };
}

/**
 * Step 7 follow-up (see HANDOFF.md — "no live refresh of seatServerState
 * while barber-app stays open"): same pattern as queueRepository.js's
 * subscribeQueueChanges()/appointmentRepository.js's
 * subscribeAppointmentChanges() — this module stays the only one that talks
 * to public.seats over the Supabase client, index.html just gets a plain
 * "something changed, go refetch" callback. `public.seats` is already in
 * the `supabase_realtime` publication (Supabase's default for a table
 * created without being excluded — see the comment at the top of
 * supabase/migrations/20260902000900_realtime_live_refresh.sql), so no
 * migration is needed here, only this subscription.
 *
 * Deliberately does NOT hand the payload's row data to the caller, same
 * reasoning as subscribeQueueChanges(): the callback is only ever a trigger
 * to re-fetch through listSeats() above, which applies RLS/column grants
 * correctly on its own rather than trusting whatever shape Realtime's
 * postgres_changes payload happens to broadcast.
 *
 * @param {() => void} onChange
 * @returns {() => void} call to unsubscribe.
 */
export function subscribeSeatChanges(onChange) {
    const channel = supabase
        .channel('seats-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'seats' }, onChange)
        .subscribe();
    return () => supabase.removeChannel(channel);
}
