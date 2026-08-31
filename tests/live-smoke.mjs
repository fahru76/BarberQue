/**
 * Live smoke test for js/repositories/queueRepository.js, run against the
 * real Supabase project as the anon role — the same role the browser uses.
 *
 * NOT part of `npm test`: it needs network access to
 * cojaebzxrtyvxrnadiuv.supabase.co and, unlike the domain-layer tests, it is
 * exercising a live network service rather than a pure function. Run it by
 * hand (`node tests/live-smoke.mjs`, or `npm run test:live`) after any change
 * to queueRepository.js's column lists or RPC parameter names, since those
 * are exactly the things a local review cannot catch — PostgREST enforces
 * column-level grants at the whole-query level, so a wrong column name in
 * QUEUE_COLUMNS fails the entire request, not just that field.
 *
 * Needs @supabase/supabase-js installed locally (`npm install
 * @supabase/supabase-js --no-save` — it is not a project dependency because
 * the browser loads it from a CDN; see js/supabaseClient.js for why).
 *
 * Every row this script creates is cancelled and left as a `cancelled`
 * ticket (there is no DELETE policy for anon, by design — see HANDOFF.md).
 * That is a handful of harmless rows in an otherwise-empty database, not a
 * bulk or destructive operation; delete them with the service key if you
 * want the table pristine again.
 */
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from '../js/supabaseConfig.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// Mirrors QUEUE_COLUMNS in js/repositories/queueRepository.js on purpose —
// if you change one, change the other, and re-run this.
const QUEUE_COLUMNS =
    'id, ticket_no, name, service, duration_minutes, seat_no, barber_id, ' +
    'status, source, is_fast_pass, created_at, called_at';

let failed = false;
const step = (name, ok, detail) => {
    console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failed = true;
};

const { data: ticketNo, error: ticketErr } = await supabase.rpc('next_ticket_number', { p_prefix: 'ZZ' });
step('next_ticket_number(ZZ) succeeds', !ticketErr, ticketErr?.message);
step('ticket number matches PREFIX##-YYYYMMDD', /^ZZ\d{2}-\d{8}$/.test(ticketNo ?? ''), ticketNo);

const { error: badPrefixErr } = await supabase.rpc('next_ticket_number', { p_prefix: 'zz' });
step('lowercase prefix is rejected', !!badPrefixErr, badPrefixErr?.message);

const id = randomUUID();
const claimToken = randomUUID();
const { data: inserted, error: insertErr } = await supabase
    .from('queues')
    .insert({
        id, ticket_no: ticketNo, name: 'Live Smoke Test', phone: '0100000000',
        claim_token: claimToken, service: 'Smoke Cut', duration_minutes: 20,
        price_sen: 1000, source: 'walkin'
    })
    .select(QUEUE_COLUMNS)
    .single();
step('anon insert with default columns succeeds', !insertErr, insertErr?.message);
step('inserted row defaults to status=waiting', inserted?.status === 'waiting', inserted?.status);
step('phone is NOT in the returned columns (write-only for anon)', !!inserted && !('phone' in inserted));
step('claim_token is NOT in the returned columns', !!inserted && !('claim_token' in inserted));

const { data: listed, error: listErr } = await supabase
    .from('queues').select(QUEUE_COLUMNS).in('status', ['waiting', 'serving']).order('created_at');
step('listQueues (anon) succeeds', !listErr, listErr?.message);
step('listQueues includes the new ticket', (listed ?? []).some(r => r.id === id));

const { error: sneakErr } = await supabase
    .from('queues')
    .insert({
        id: randomUUID(), ticket_no: 'SNEAK', name: 'Sneak', claim_token: randomUUID(),
        service: 'x', duration_minutes: 10, source: 'walkin', status: 'serving'
    });
step('anon cannot insert as status=serving (RLS with-check holds)', !!sneakErr, sneakErr?.message);

const { error: callErr } = await supabase.rpc('call_next_customer', { p_seat_no: 1 });
step('call_next_customer refuses anon', !!callErr, callErr?.message);
const { error: completeErr } = await supabase.rpc('complete_service', { p_id: id });
step('complete_service refuses anon', !!completeErr, completeErr?.message);

const { data: wrongCancel, error: wrongCancelErr } = await supabase
    .rpc('cancel_own_ticket', { p_id: id, p_claim_token: randomUUID() });
step('cancel with wrong claim_token returns false, not an error', !wrongCancelErr && wrongCancel === false);

const { data: cancelled, error: cancelErr } = await supabase
    .rpc('cancel_own_ticket', { p_id: id, p_claim_token: claimToken });
step('cancel_own_ticket(correct token) succeeds', !cancelErr && cancelled === true, cancelErr?.message);

const { data: afterCancel } = await supabase.from('queues').select(QUEUE_COLUMNS).eq('id', id).single();
step('ticket status is now cancelled', afterCancel?.status === 'cancelled', afterCancel?.status);

console.log(failed ? '\nSOME CHECKS FAILED' : '\nall checks passed');
console.log(`(left one row, id ${id}, in status=cancelled — no DELETE policy exists for anon by design)`);
process.exit(failed ? 1 : 0);
