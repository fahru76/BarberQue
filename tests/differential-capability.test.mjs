/**
 * Differential test #2 — NEW-behaviour parity (bug hunt 2026-09-19, H1).
 *
 * tests/differential.test.mjs compares js/domain/scheduler.js against
 * build/legacy.cjs, the FROZEN reference of the prototype's ORIGINAL inline
 * scheduler. That proves the no-capability-gate path is unchanged.
 *
 * This file does the complementary job for the capability-aware path added in
 * the H1 fix: it loads the CURRENT inline scheduler out of index.html (the
 * code that actually runs in the browser) and compares it, on capability-aware
 * inputs, against js/domain/scheduler.js. The two must agree exactly -- the
 * whole point of the inline copy's "kept in lockstep" comment is that a drift
 * here is a real bug (the browser and the shared module disagreeing about when
 * a customer gets served).
 *
 * The inline functions are loaded by brace-matching them out of index.html and
 * stubbing the globals they read, the same technique that produced
 * build/legacy.cjs. If a renamed/extracted function goes missing this fails
 * loudly rather than silently passing.
 */
import { readFileSync } from 'node:fs';
import * as S from '../js/domain/scheduler.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/** Extract a top-level `function name(...) { ... }` body by brace matching.
 *  The opening `{` of the BODY is the one after the parameter list's closing
 *  `)` -- scanning from `function name(` and taking the first `{` breaks on
 *  destructured defaults like `{ inProgress = false } = {}` in the signature.
 *  So: find the close of the parameter list (paren depth 0), then the `{`. */
function extractFunction(name) {
    const start = html.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`inline function ${name}() not found in index.html`);
    // Walk the parameter list to its matching close paren.
    let paren = 0, i = html.indexOf('(', start);
    for (; i < html.length; i++) {
        const ch = html[i];
        if (ch === '(') paren++;
        else if (ch === ')') { paren--; if (paren === 0) break; }
    }
    const braceStart = html.indexOf('{', i);
    let depth = 0;
    for (i = braceStart; i < html.length; i++) {
        const ch = html[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) break;
        }
    }
    return html.slice(start, i + 1);
}

// The inline scheduler's free identifiers, stubbed. STATE is set per case.
const STATE = {
    queues: [], appointments: [], activeSeats: {}, ops: {}, today: '', nowMinutes: 0,
    seatServerState: {}, cachedStaffList: []
};

const stubbedGlobals = `
    const AVG_WAIT_MINUTES = 25;
    const BREAK_POLICY = 'finish_in_progress';
    const SHOP_TIME_ZONE = 'Asia/Kuala_Lumpur';
    const MY_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: SHOP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    function getQueues() { return STATE.queues; }
    function getAppointments() { return STATE.appointments; }
    function getActiveSeats() { return STATE.activeSeats; }
    function getOpHours() { return STATE.ops; }
    function getCurrentBusinessDate() { return STATE.today; }
    function getMalaysiaCurrentMinutes() { return STATE.nowMinutes; }
    function getMalaysiaDateTimeParts(value) {
        const millis = timestampToMillis(value);
        if (!Number.isFinite(millis)) return null;
        const parts = MY_FMT.formatToParts(new Date(millis));
        return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
    }
    var seatServerState = {};
    var cachedStaffList = [];
    function __syncState() {
        seatServerState = STATE.seatServerState;
        cachedStaffList = STATE.cachedStaffList;
    }
`;

const INLINE_FNS = [
    'timestampToMillis', 'timeToMinutes', 'crossesMidnight', 'businessMinutes',
    'resolveCloseMinutes', 'getQueuePriority', 'sortWaitingQueue',
    'getConfiguredBreaks', 'intervalOverlapsBreak', 'moveServicePastBreak',
    'getServiceEnd', 'intervalsOverlap', 'findNextSeatStart',
    'seatCanPerformInline', 'buildSeatCapabilityMapInline', 'resolveSeatCapability',
    'getQueueOccupancyIntervals', 'estimateQueueWaitMinutes', 'buildWaitByRecordId'
].map(extractFunction).join('\n\n');

const factory = new Function('STATE', `
    ${stubbedGlobals}
    ${INLINE_FNS}
    return {
        seatCanPerformInline, buildSeatCapabilityMapInline, resolveSeatCapability,
        getQueueOccupancyIntervals, estimateQueueWaitMinutes, buildWaitByRecordId,
        __syncState
    };
`);
const inline = factory(STATE);

// ---- capability-aware comparison cases -------------------------------------
const at = (h, m = 0) => h * 60 + m;
const OPS = { open: '10:00', close: '22:00', break1Start: '13:00', break1End: '14:00', break2Start: '', break2End: '' };
const ts = i => new Date(Date.UTC(2026, 7, 29, 1, i)).toISOString();

let checked = 0;
const mismatches = [];

function compare(name, setup) {
    const { queues, appointments, activeSeats, ops, nowMinutes, seatState, staff } = setup;
    Object.assign(STATE, { queues, appointments, activeSeats, ops, today: '2026-08-29', nowMinutes, seatServerState: seatState, cachedStaffList: staff });
    inline.__syncState(); // refresh the var bindings resolveSeatCapability() closes over

    const inlineCap = inline.buildSeatCapabilityMapInline(activeSeats, seatState, staff);
    const moduleCap = S.buildSeatCapabilityMap(activeSeats, seatState, staff);
    const norm = m => JSON.stringify([...m.entries()].sort((a, b) => a[0] - b[0]));
    if (norm(inlineCap) !== norm(moduleCap)) mismatches.push({ name, fn: 'capabilityMap', inline: norm(inlineCap), module: norm(moduleCap) });
    checked++;

    // The inline path derives nowMinutes from getMalaysiaCurrentMinutes()
    // (stubbed to STATE.nowMinutes) and passes it through businessMinutes();
    // the module takes it as a parameter. Feed both the same business-day-axis
    // value so the comparison is apples-to-apples. OPS here never crosses
    // midnight, so businessMinutes is a no-op and nowMinutes passes through.
    const inlineIv = inline.getQueueOccupancyIntervals('2026-08-29', appointments, queues, activeSeats, inlineCap);
    const moduleIv = S.buildOccupancyIntervals({ queues, appointments, activeSeats, ops, nowMinutes, seatCapability: moduleCap });
    if (JSON.stringify(inlineIv) !== JSON.stringify(moduleIv)) mismatches.push({ name, fn: 'occupancy', inline: inlineIv, module: moduleIv });
    checked++;

    const ticket = queues.find(q => q.status === 'waiting')?.id ?? 'none';
    const inlineW = inline.estimateQueueWaitMinutes(queues, ticket, activeSeats);
    const moduleW = S.estimateWaitMinutes({ queues, appointments, activeSeats, ops, nowMinutes, ticketId: ticket, seatCapability: moduleCap });
    if (inlineW !== moduleW) mismatches.push({ name, fn: 'estimateWait', inline: inlineW, module: moduleW });
    checked++;
}

// Restricted seat 1 (SVC-A only) + unrestricted seat 2.
const seatState = { '1': { barberId: 'b1' }, '2': { barberId: 'b2' } };
const staff = [{ id: 'b1', capabilityServiceIds: ['SVC-A'] }, { id: 'b2', capabilityServiceIds: null }];

compare('multi-service ticket routed to capable seat', {
    queues: [
        { id: 'SV', status: 'serving', seat: 2, duration: 120, calledAt: '2026-08-29T02:00:00.000Z', serviceIds: ['SVC-A'] },
        { id: 'W1', status: 'waiting', duration: 30, timestamp: ts(1), queueSource: 'walkin', serviceIds: ['SVC-A', 'SVC-B'] }
    ],
    appointments: [], activeSeats: { 1: true, 2: true }, ops: OPS, nowMinutes: at(10), seatState, staff
});

compare('unservable ticket left unscheduled', {
    queues: [{ id: 'NOPE', status: 'waiting', duration: 30, timestamp: ts(1), queueSource: 'walkin', serviceIds: ['SVC-Z'] }],
    appointments: [], activeSeats: { 1: true }, ops: OPS, nowMinutes: at(10), seatState: { '1': { barberId: 'b1' } }, staff
});

compare('no capability data fails open (anon parity)', {
    queues: [{ id: 'W1', status: 'waiting', duration: 30, timestamp: ts(1), queueSource: 'walkin', serviceIds: ['SVC-A', 'SVC-B'] }],
    appointments: [], activeSeats: { 1: true, 2: true }, ops: OPS, nowMinutes: at(10), seatState: {}, staff: []
});

compare('unknown-service ticket treated compatible on all seats', {
    queues: [{ id: 'W1', status: 'waiting', duration: 30, timestamp: ts(1), queueSource: 'walkin', serviceIds: null }],
    appointments: [], activeSeats: { 1: true, 2: true }, ops: OPS, nowMinutes: at(10), seatState, staff
});

console.log(`capability-aware comparisons: ${checked}`);
console.log(`mismatches                  : ${mismatches.length}`);
if (mismatches.length) {
    console.log('\nFIRST MISMATCH:', JSON.stringify(mismatches[0], null, 2).slice(0, 1200));
    process.exit(1);
}
console.log('\nPASS - inline scheduler and js/domain/scheduler.js agree on the capability-aware path.');
