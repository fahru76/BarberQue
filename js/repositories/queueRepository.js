/**
 * queueRepository — the only module that talks to `public.queues` over the
 * Supabase client. Everything else (index.html, js/domain/scheduler.js) works
 * with the plain-object "domain" shape below and never sees a `snake_case`
 * column or a PostgREST response.
 *
 * Step 3 of the migration (see HANDOFF.md): do this one table end to end.
 * `activeSeats`, `shopServices` and settings keys stay in localStorage for now;
 * the scheduler takes everything as parameters, so a half-migrated state works.
 *
 * ---------------------------------------------------------------------------
 * Column selection is not cosmetic here. `supabase/migrations/
 * 20260901000100_rls_policies.sql` revokes ALL on `public.queues` and grants
 * SELECT back column-by-column: anon can read `phone`, `claim_token`,
 * `price_sen`, `completed_at`, `cancelled_at`, `cancelled_by`, `cancel_reason`
 * and `version`. A bare `select('*')` asks Postgres for every column and the
 * WHOLE QUERY is rejected with 42501 for anon, not silently trimmed — column
 * grants are enforce-all-or-fail, unlike RLS row filtering. QUEUE_COLUMNS is
 * therefore an explicit allow-list that matches the anon grant exactly. That
 * list is also a subset of what `authenticated` may read (which gets
 * `select ... on public.queues`, i.e. every column), so the same query works
 * unchanged for a signed-in barber.
 *
 * If the UI later needs a staff-only column (e.g. `price_sen` on a report),
 * that is a new, explicitly-authenticated query — do not widen QUEUE_COLUMNS
 * to get it, or anon breaks again.
 * ---------------------------------------------------------------------------
 *
 * RPC parameter names are not decorative either: PostgREST's named-argument
 * call form (what supabase-js's `.rpc(name, params)` uses) matches on the
 * `p_*` parameter names declared in `supabase/migrations/
 * 20260901000200_ticket_and_rpc.sql`. Renaming a key here silently 404s.
 */
import { supabase } from '../supabaseClient.js';

// Matches the anon SELECT grant in 20260901000100_rls_policies.sql exactly.
const QUEUE_COLUMNS =
    'id, ticket_no, name, service, duration_minutes, seat_no, barber_id, ' +
    'status, source, is_fast_pass, created_at, called_at';

/**
 * DB row -> domain object.
 *
 * Diffed against index.html's actual field reads (27 call sites), not just
 * against js/domain/scheduler.js and legacy.cjs as in the first draft of this
 * file — those two agreed with each other but neither one is the real UI.
 * `id`, `status`, `seat`, `duration`, `timestamp`, `queueSource`, `isFastPass`
 * and `calledAt` are exactly the field names both scheduler.js AND index.html
 * read (confirmed identical). Two things the first draft got wrong, now fixed:
 *
 * - There is no separate "ticket_no vs id" distinction on the client. index.html
 *   mints one string (e.g. "PG01-20260901") and uses it as both the row's
 *   identity and its display number — getDisplayTicketId() just strips the
 *   trailing `-YYYYMMDD` off `.id`. So `takeTicket()` below now uses the
 *   server's minted ticket_no AS the id, instead of a separate random uuid;
 *   `ticketId` has been dropped from this mapping since nothing ever read it.
 * - `price` in index.html is a plain RM float (e.g. 38.5); `price_sen` in the
 *   database is an integer. See `takeTicket()` for where that conversion now
 *   happens — this mapper never receives `price_sen` since it isn't in
 *   QUEUE_COLUMNS (anon can't read it back; see the comment above).
 *
 * `barberId` (the `barber_id` FK) is included for completeness but has no
 * home in index.html today: the prototype assigns barbers to seats as a free
 * -text name (`getBarberAssignments()`, an admin-typed string with no
 * relation to a Supabase Auth account), not a `staff.id`. That only becomes
 * meaningful once step 4 (Supabase Auth for barber/admin) exists — see
 * HANDOFF.md.
 */
function mapQueueRow(row) {
    if (!row) return row;
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
        // Only present when the caller is authenticated staff: callNext() and
        // completeService() (step 4b) go through call_next_customer()/
        // complete_service(), which return the FULL public.queues row — not
        // restricted to QUEUE_COLUMNS the way a plain anon-safe select is —
        // so completed_at actually comes back here. listQueues() never
        // includes it (its query filters to status in waiting/serving, and
        // completed_at is null for both anyway), so this is simply undefined
        // there, which mapQueueRow's callers already treat as "not set".
        completedAt: row.completed_at
    };
}

function raiseOnError(error) {
    if (error) throw new Error(`[queueRepository] ${error.message ?? error}`, { cause: error });
}

/** Today's waiting + serving tickets, oldest first. What the board and the TV screen render. */
export async function listQueues() {
    const { data, error } = await supabase
        .from('queues')
        .select(QUEUE_COLUMNS)
        .in('status', ['waiting', 'serving'])
        .order('created_at', { ascending: true });
    raiseOnError(error);
    return data.map(mapQueueRow);
}

/**
 * Step 7 (see HANDOFF.md): full-row mapper for an AUTHENTICATED-only read.
 * mapQueueRow() above deliberately only ever sees QUEUE_COLUMNS (the anon-safe
 * subset) since listQueues() is called by anon and authenticated alike -- this
 * one is for list_today_queues_full()'s RPC result only, which is staff-gated
 * server-side and always returns every column, so it's the one place allowed
 * to read phone/price_sen/version/cancelled_at/cancelled_by/cancel_reason,
 * approved_by/approval_reason/approved_at and revoked_by/revoked_at off a row.
 * Field names match every existing write site's local shape exactly (see
 * index.html's approveFastPass()/revokeFastPass()/confirmAdminCancellation()),
 * not just mapQueueRow()'s smaller set, so a row merged in from ANOTHER
 * device behaves identically to one this device wrote itself -- in
 * particular `version`, which every cancel/fast-pass write already assumes
 * is present and correct before it will let a staff action proceed.
 */
function mapQueueRowFull(row) {
    if (!row) return row;
    return {
        id: row.id,
        name: row.name,
        phone: row.phone,
        service: row.service,
        duration: row.duration_minutes,
        price: row.price_sen / 100,
        seat: row.seat_no,
        barberId: row.barber_id,
        status: row.status,
        queueSource: row.source,
        isFastPass: row.is_fast_pass,
        fastPassApproved: row.is_fast_pass,
        approvedBy: row.approved_by,
        approvalReason: row.approval_reason,
        approvedAt: row.approved_at,
        revokedBy: row.revoked_by,
        revokedAt: row.revoked_at,
        timestamp: row.created_at,
        calledAt: row.called_at,
        completedAt: row.completed_at,
        cancelledAt: row.cancelled_at,
        cancelledBy: row.cancelled_by,
        cancelReason: row.cancel_reason,
        version: row.version
    };
}

/**
 * Step 7: staff-only, every column, today only (Malaysia time), NO status
 * filter -- unlike listQueues() above, this is meant to drive a merge-by-id
 * into an existing local array (see index.html's mergeServerRows()), and a
 * transition OUT of waiting/serving (e.g. another device just completed or
 * cancelled a ticket) has to still show up so the merge can update `status`
 * accordingly. Only ever call this when a staff session exists -- the RPC
 * itself rejects anon/inactive-staff callers (`is_active_staff()`), so this
 * throws for anyone else rather than silently returning nothing.
 */
export async function listTodayQueuesFull() {
    const { data, error } = await supabase.rpc('list_today_queues_full');
    raiseOnError(error);
    return data.map(mapQueueRowFull);
}

/**
 * Step 7: cross-device live updates. This module stays "the only one that
 * talks to public.queues over the Supabase client" (see the file header) --
 * index.html never touches `supabase.channel()` directly, it just gets a
 * plain "something changed, go refetch" callback.
 *
 * Deliberately does NOT hand the payload's row data to the caller. Realtime's
 * postgres_changes broadcasts a row once RLS says the subscribing role may
 * see it, but that check is row-level, not the column-level grants
 * QUEUE_COLUMNS/mapQueueRowFull rely on elsewhere in this file -- reading the
 * payload directly could leak a staff-only column (e.g. phone) to an anon
 * subscriber. The callback is only ever a trigger to re-fetch through the
 * normal PostgREST-gated listQueues()/listTodayQueuesFull() path, which
 * enforces those grants correctly either way. Works for both anon and
 * authenticated callers -- Realtime's own RLS-based row filter still applies
 * per-connection regardless of who's subscribed.
 *
 * @param {() => void} onChange
 * @returns {() => void} call to unsubscribe.
 */
export function subscribeQueueChanges(onChange) {
    const channel = supabase
        .channel('queues-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'queues' }, onChange)
        .subscribe();
    return () => supabase.removeChannel(channel);
}

/**
 * Take a ticket: mint a server-sequenced number, then insert the row.
 *
 * `id` is the minted ticket number itself (see the mapQueueRow comment above
 * for why — index.html has no separate identity from its display number).
 * `claimToken` is generated here because the anon INSERT policy needs
 * `claim_token` present in the same statement — there is no separate "set my
 * own claim token" step — and nothing else could hand the browser a token to
 * prove ownership with later.
 *
 * `priceRm` is what index.html actually has on hand: a plain RM float summed
 * from the selected services' `data-price`. It is converted to integer sen
 * here (`Math.round(priceRm * 100)`), inside the one module that is allowed
 * to know `price_sen` exists, rather than asking every call site to do
 * currency-rounding arithmetic — which is exactly the bug class `price_sen`
 * was introduced to retire (see the design-decisions section of HANDOFF.md).
 *
 * Every other queues column (`status`, `seat_no`, `barber_id`, `is_fast_pass`,
 * `called_at`, `version`, ...) is left out of the payload on purpose: the
 * table defaults ('waiting', null, null, false, null, 1) are exactly what the
 * anon `with check` on "anon may take a ticket" requires. Setting any of them
 * explicitly — even to their own default value — is unnecessary and, for a
 * staff-authenticated caller with a typo, would be a way to accidentally
 * insert a customer as already `serving`.
 *
 * @param {{prefix: string, name: string, phone?: string, service: string,
 *          durationMinutes: number, priceRm?: number, source?: 'walkin'|'booking'}} record
 * @returns {Promise<object & {claimToken: string}>} the inserted ticket, plus the
 *          claim token the caller must persist (e.g. localStorage) — the
 *          server never returns claim_token again, by design.
 */
export async function takeTicket({ prefix, name, phone, service, durationMinutes, priceRm, source = 'walkin' }) {
    const { data: ticketNo, error: ticketError } = await supabase.rpc('next_ticket_number', { p_prefix: prefix });
    raiseOnError(ticketError);

    const claimToken = crypto.randomUUID();
    const priceSen = Number.isFinite(priceRm) ? Math.round(priceRm * 100) : undefined;

    const { data, error } = await supabase
        .from('queues')
        .insert({
            id: ticketNo,
            ticket_no: ticketNo,
            name,
            phone,
            claim_token: claimToken,
            service,
            duration_minutes: durationMinutes,
            price_sen: priceSen,
            source
        })
        .select(QUEUE_COLUMNS)
        .single();
    raiseOnError(error);

    return { ...mapQueueRow(data), claimToken };
}

/**
 * Call the next waiting customer to `seatNo`. One round trip: the RPC picks
 * the customer (fast-pass, then booking, then FIFO — same ordering as
 * sortWaitingQueue) and marks them serving atomically, so this can never
 * half-succeed the way two separate client updates could.
 *
 * Requires an authenticated, active-staff session — anon has no EXECUTE grant
 * on this function. Throws (does not return null) when the seat isn't open,
 * is already serving someone, or nobody is waiting; callers should catch and
 * show the message from `call_next_customer`'s exception.
 */
export async function callNext(seatNo) {
    const { data, error } = await supabase.rpc('call_next_customer', { p_seat_no: seatNo });
    raiseOnError(error);
    return mapQueueRow(data);
}

/** Mark a `serving` ticket `done`. Requires an authenticated, active-staff session. */
export async function completeService(id) {
    const { data, error } = await supabase.rpc('complete_service', { p_id: id });
    raiseOnError(error);
    return mapQueueRow(data);
}

/**
 * Cancel a ticket you took, using the claim token from `takeTicket`. Works for
 * anon and authenticated alike; only succeeds for a still-`waiting` ticket
 * whose token matches, which is the whole point of the token — a walk-in has
 * no account to attach an ownership check to otherwise.
 *
 * @returns {Promise<boolean>} false (not an error) when the ticket was already
 *          called, already cancelled, or the token didn't match.
 */
export async function cancelOwn(id, claimToken) {
    const { data, error } = await supabase.rpc('cancel_own_ticket', { p_id: id, p_claim_token: claimToken });
    raiseOnError(error);
    return data;
}
