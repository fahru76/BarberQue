/**
 * authRepository — Supabase Auth for barber/admin sign-in (migration step 4).
 *
 * Email + password only. Magic links were considered and rejected: this app
 * runs on a shared shop device (a counter tablet), and checking email on
 * every sign-in is impractical there in a way it wouldn't be for a personal
 * device.
 *
 * New accounts are never self-registered — `enable_signup = false` in
 * supabase/config.toml is deliberate (see HANDOFF.md's design-decisions
 * list). The only way an account comes into being is an admin inviting one
 * by email through inviteBarber() below, or the one-time manual bootstrap of
 * the very first admin account, which this module cannot do itself (see
 * HANDOFF.md — it needs the Supabase Dashboard, not client code).
 */
import { supabase } from '../supabaseClient.js';

function raiseOnError(error) {
    if (error) throw new Error(`[authRepository] ${error.message ?? error}`, { cause: error });
}

/** Sign in with email + password. Throws on failure (wrong password, no such user, ...). */
export async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    raiseOnError(error);
    return data.session;
}

export async function signOut() {
    const { error } = await supabase.auth.signOut();
    raiseOnError(error);
}

/** Current session, or null if signed out. */
export async function getSession() {
    const { data, error } = await supabase.auth.getSession();
    raiseOnError(error);
    return data.session;
}

/**
 * Subscribe to auth state changes: sign-in, sign-out, token refresh, and the
 * `PASSWORD_RECOVERY` event fired when someone lands on an invite or
 * password-reset link. Returns an unsubscribe function.
 */
export function onAuthStateChange(callback) {
    const { data } = supabase.auth.onAuthStateChange((event, session) => callback(event, session));
    return () => data.subscription.unsubscribe();
}

/**
 * The signed-in user's own staff row, or null if they have no session or
 * (shouldn't happen — handle_new_staff_user creates one for every
 * auth.users insert) no staff row.
 *
 * Column names translated to camelCase for the same reason
 * queueRepository.js's mapQueueRow() exists: index.html should never need to
 * know a DB column is snake_case.
 */
export async function getMyStaffProfile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const { data, error } = await supabase
        .from('staff')
        .select('id, display_name, role, active')
        .eq('id', user.id)
        .maybeSingle();
    raiseOnError(error);
    if (!data) return null;
    return { id: data.id, displayName: data.display_name, role: data.role, active: data.active };
}

/**
 * Every staff row. RLS ("staff read themselves and colleagues" in
 * 20260901000100_rls_policies.sql) lets any active staff member read every
 * row, not just admins — but only admin-app's UI calls this, since managing
 * the list is an admin action.
 */
export async function listStaff() {
    const { data, error } = await supabase
        .from('staff')
        .select('id, display_name, role, active, created_at')
        .order('created_at', { ascending: true });
    raiseOnError(error);
    return data.map(row => ({
        id: row.id, displayName: row.display_name, role: row.role,
        active: row.active, createdAt: row.created_at
    }));
}

/**
 * Activate/deactivate a staff row, or change its role. The client-side
 * "admin-app only" gating is a convenience, not the real boundary — RLS's
 * "admins manage staff" policy (`for all ... using (is_admin())`) enforces
 * this server-side regardless of what the UI allows a caller to attempt.
 */
export async function setStaffStatus(id, { active, role } = {}) {
    const patch = {};
    if (active !== undefined) patch.active = active;
    if (role !== undefined) patch.role = role;
    const { error } = await supabase.from('staff').update(patch).eq('id', id);
    raiseOnError(error);
}

/**
 * Invite a new barber by email. Goes through the invite-barber Edge Function
 * rather than calling the Auth Admin API from here, because creating a user
 * requires the service_role key — that key must never reach the browser, so
 * it lives only in the Edge Function's own environment. The function
 * independently re-checks the caller is really an active admin (via
 * is_admin()) before inviting anyone; it does not trust anything this client
 * claims about itself.
 *
 * @returns {Promise<{id: string, email: string}>}
 */
export async function inviteBarber(email, displayName) {
    const { data, error } = await supabase.functions.invoke('invite-barber', {
        body: { email, displayName }
    });
    if (error) {
        // supabase-js puts a FunctionsHttpError's response body on error.context
        // (a Response); surface the function's own message when there is one.
        let message = error.message;
        try {
            const body = await error.context?.json?.();
            if (body?.error) message = body.error;
        } catch { /* fall back to error.message */ }
        throw new Error(`[authRepository] ${message}`, { cause: error });
    }
    return data;
}

/**
 * Sets the signed-in account's password. Used both right after an invite
 * link (the account has none yet) and for an ordinary password reset.
 */
export async function setNewPassword(password) {
    const { error } = await supabase.auth.updateUser({ password });
    raiseOnError(error);
}
