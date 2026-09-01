/**
 * appointmentRepository — public.appointments (migration step 6), plus the
 * fast-pass approval workflow that spans both `appointments` and `queues`.
 *
 * Same non-negotiable as serviceRepository.js/shopSettingsRepository.js:
 * index.html's ~26 existing appointment functions read/write the
 * `appointments` localStorage key directly, and that stays completely
 * unchanged here — this repository is only ever called from the admin/
 * customer action handlers that already exist (submitAppointment(),
 * cancelCustomerAppointment(), startRescheduleAppointment(),
 * markAppointmentArrived(), approveFastPass(), revokeFastPass(),
 * confirmAdminCancellation()'s appointment branch), which now write through
 * here FIRST and only touch localStorage once the server confirms — the
 * same no-fallback rule as services/seats/shop settings, because a booking
 * is exactly the kind of record another device legitimately needs to see
 * (the admin checking someone in on the shop tablet).
 *
 * Unlike queues/services/shop_settings, there is deliberately NO hydration
 * step here (no seedOrRefreshAppointments()) — `public.queues` itself does
 * not have one either (see HANDOFF.md's step-7 "realtime subscriptions"
 * item): listQueues() exists and is wired into window.QueueRepo, but
 * nothing calls it yet, because giving one device a live view of what
 * another device just wrote is explicitly a follow-up step (postgres_changes
 * subscriptions), not part of write-through migrations like this one.
 * Appointments follows that same, already-established boundary rather than
 * inventing a bespoke one-table exception.
 *
 * isVip is NOT a stored column (see the migration file's design-decisions
 * comment) — it's derived here from `source === 'booking'`, matching every
 * current read site's actual usage (`queue.queueSource === 'booking' ||
 * queue.isVip` is checked as an OR everywhere, because they were always
 * redundant). fastPassApproved is likewise not stored separately from
 * isFastPass — both local field names are populated from the one
 * `is_fast_pass` column so the ~10 existing read sites that check either
 * name keep working unchanged.
 */
import { supabase } from '../supabaseClient.js';

function raiseOnError(error) {
    if (error) throw new Error(`[appointmentRepository] ${error.message ?? error}`, { cause: error });
}

/**
 * Book a new appointment. `claimToken` is generated HERE (crypto.randomUUID()),
 * same convention as queueRepository.js's takeTicket() — the server never
 * has to hand the token back, since the caller already minted it.
 *
 * Throws on any rejection (outside hours, inside a break, weekly-closed day,
 * shop manually closed today, too far ahead, or the slot's already full) —
 * the RPC's error message is already customer-facing Malay text, so callers
 * can show it directly in an alert().
 *
 * @returns {Promise<{id: string, claimToken: string}>}
 */
export async function bookAppointment({ name, phone, service, durationMinutes, priceRm, date, time }) {
    const claimToken = crypto.randomUUID();
    const { data: id, error } = await supabase.rpc('book_appointment', {
        p_name: name,
        p_phone: phone,
        p_claim_token: claimToken,
        p_service: service,
        p_duration_minutes: durationMinutes,
        p_price_sen: Number.isFinite(priceRm) ? Math.round(priceRm * 100) : 0,
        p_date: date,
        p_time: time
    });
    raiseOnError(error);
    return { id, claimToken };
}

/**
 * @returns {Promise<boolean>} false (not an error) when the appointment was
 *          already arrived/cancelled, or the token didn't match.
 */
export async function cancelOwnAppointment(id, claimToken) {
    const { data, error } = await supabase.rpc('cancel_own_appointment', { p_id: id, p_claim_token: claimToken });
    raiseOnError(error);
    return data;
}

/**
 * Throws on a version conflict ("Tempahan telah berubah di skrin lain") or
 * an unavailable new slot — same shape of error as bookAppointment().
 *
 * @returns {Promise<number>} the new version number to store locally.
 */
export async function rescheduleOwnAppointment(id, claimToken, expectedVersion, date, time) {
    const { data: version, error } = await supabase.rpc('reschedule_own_appointment', {
        p_id: id, p_claim_token: claimToken, p_expected_version: expectedVersion, p_date: date, p_time: time
    });
    raiseOnError(error);
    return version;
}

/**
 * Convert an existing WAITING walk-in ticket into a new appointment.
 * `walkinClaimToken` proves ownership of the ticket being converted (the
 * same one takeTicket() already saved locally); a fresh `claimToken` for the
 * NEW appointment is minted here, same convention as bookAppointment().
 *
 * @returns {Promise<{id: string, claimToken: string}>} the new appointment.
 */
export async function convertWalkinToAppointment({
    walkinId, walkinClaimToken, expectedVersion, name, phone, service, durationMinutes, priceRm, date, time
}) {
    const claimToken = crypto.randomUUID();
    const { data: id, error } = await supabase.rpc('convert_walkin_to_appointment', {
        p_walkin_id: walkinId,
        p_walkin_claim_token: walkinClaimToken,
        p_expected_version: expectedVersion,
        p_name: name,
        p_phone: phone,
        p_new_claim_token: claimToken,
        p_service: service,
        p_duration_minutes: durationMinutes,
        p_price_sen: Number.isFinite(priceRm) ? Math.round(priceRm * 100) : 0,
        p_date: date,
        p_time: time
    });
    raiseOnError(error);
    return { id, claimToken };
}

/**
 * Admin/staff "Hadir" action: an upcoming appointment becomes a live queue
 * entry (same id, separate table). Requires an authenticated, active-staff
 * session — mirrors callNext()/completeService()'s requirement.
 *
 * @returns {Promise<object>} the new queue entry, in the SAME domain shape
 *          queueRepository.js's mapQueueRow() produces, so the caller can
 *          push it onto the local `queues` array exactly like the original
 *          local-only markAppointmentArrived() did.
 */
export async function checkinAppointment(id) {
    const { data: row, error } = await supabase.rpc('checkin_appointment', { p_id: id });
    raiseOnError(error);
    return {
        id: row.id,
        name: row.name,
        service: row.service,
        duration: row.duration_minutes,
        seat: row.seat_no,
        barberId: row.barber_id,
        status: row.status,
        queueSource: row.source,
        isFastPass: row.is_fast_pass,
        timestamp: row.created_at,
        calledAt: row.called_at,
        approvedBy: row.approved_by,
        approvalReason: row.approval_reason,
        approvedAt: row.approved_at,
        version: row.version
    };
}

/**
 * Admin-only. `source` is 'queue' or 'appointment' — same two-table target
 * the existing fastPassCandidate dropdown already lets an admin pick from.
 * approved_by/revoked_by are set from auth.uid() SERVER-SIDE (see the
 * migration file) rather than trusted from a client-supplied value.
 *
 * @returns {Promise<boolean>} false (not an error) if the record was no
 *          longer in a state that could be approved/revoked.
 */
export async function approveFastPass(source, id, reason) {
    const { data, error } = await supabase.rpc('approve_fast_pass', { p_source: source, p_id: id, p_reason: reason });
    raiseOnError(error);
    return data;
}

export async function revokeFastPass(source, id) {
    const { data, error } = await supabase.rpc('revoke_fast_pass', { p_source: source, p_id: id });
    raiseOnError(error);
    return data;
}
