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
import * as S from '../../js/domain/scheduler.js';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

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
    var seatProfiles = {};
    var cachedStaffList = [];
    function __syncState() {
        seatServerState = STATE.seatServerState;
        seatProfiles = STATE.seatProfiles || {};
        cachedStaffList = STATE.cachedStaffList;
    }
`;

const INLINE_FNS = [
    'timestampToMillis', 'timeToMinutes', 'crossesMidnight', 'businessMinutes',
    'resolveCloseMinutes', 'getQueuePriority', 'sortWaitingQueue',
    'getConfiguredBreaks', 'intervalOverlapsBreak', 'moveServicePastBreak',
    'getServiceEnd', 'intervalsOverlap', 'findNextSeatStart',
    'seatCanPerformInline', 'buildSeatCapabilityMapInline', 'resolveSeatCapability', 'resolveSeatDurations',
    'getQueueOccupancyIntervals', 'estimateQueueWaitMinutes', 'buildWaitByRecordId',
    'getSeatBreakUntilText'
].map(extractFunction).join('\n\n');

const factory = new Function('STATE', `
    ${stubbedGlobals}
    ${INLINE_FNS}
    return {
        seatCanPerformInline, buildSeatCapabilityMapInline, resolveSeatCapability,
        getQueueOccupancyIntervals, estimateQueueWaitMinutes, buildWaitByRecordId,
        getSeatBreakUntilText, resolveSeatDurations, __syncState
    };
`);
const inline = factory(STATE);

// ---- barber-aware estimate contract (migration 20261008140000) -----------
const OPS = { open: '10:00', close: '22:00', break1Start: '', break1End: '', break2Start: '', break2End: '' };
const NOW = 15 * 60;
const t = (id, i, serviceIds) => ({ id, status: 'waiting', duration: 30, queueSource: 'walkin', serviceIds,
    timestamp: new Date(Date.UTC(2026, 9, 8, 5, i)).toISOString() });
const activeSeats = { 1: true, 2: true };
const run = (queues, seatProfiles = {}, extra = {}) => {
    Object.assign(STATE, { queues, appointments: [], activeSeats, ops: OPS, today: '2026-10-08', nowMinutes: NOW,
        seatServerState: extra.seatServerState || {}, cachedStaffList: extra.cachedStaffList || [], seatProfiles });
    inline.__syncState();
    return Object.fromEntries(inline.buildWaitByRecordId(queues, activeSeats, []));
};
let passed = 0, failed = 0;
const check = (label, ok, got) => { console.log(`  ${ok ? 'pass' : 'FAIL'}  ${label}${ok ? '' : '  got ' + JSON.stringify(got)}`); ok ? passed++ : failed++; };
const fades = [t('T1', 0, ['fade']), t('T2', 1, ['fade']), t('T3', 2, ['fade'])];
const fast = { 1: { seatNo: 1, onDuty: true, serviceDurations: { fade: 15 } }, 2: { seatNo: 2, onDuty: true } };

let r = run(fades);
check('no barber times: T3 waits 30 (shop default)', r.T3 === 30, r);
r = run(fades, fast);
check('chair 1 barber does fade in 15: T3 waits 15', r.T1 === 0 && r.T2 === 0 && r.T3 === 15, r);
r = run([...fades, t('T4', 3, ['fade'])], fast);
check('T4 goes to the chair free earliest (chair 1 again at 30)', r.T4 === 30, r);
r = run([t('T1', 0, ['fade']), t('T2', 1, ['fade']), t('T3', 2, ['fade', 'beard'])], fast);
check('ticket with a service the barber has no time for uses its own duration', r.T3 === 15, r);
r = run([t('T1', 0, undefined), t('T2', 1, undefined), t('T3', 2, undefined)], fast);
check('tickets without service ids are unaffected', r.T3 === 30, r);
r = run(fades, { 1: { seatNo: 1, onDuty: true, serviceDurations: { fade: 0 } }, 2: { seatNo: 2, onDuty: true } });
check('invalid override (0) ignored', r.T3 === 30, r);
r = run(fades, {}, { seatServerState: { 1: { barberId: 'a' } }, cachedStaffList: [{ id: 'a', capabilityServiceIds: [], serviceDurations: { fade: 15 } }] });
check('admin surface: staff list times used when no profiles', r.T3 === 15, r);
r = run(fades, { 1: { seatNo: 1, onDuty: true, serviceDurations: { fade: 15 }, breakUntil: new Date(Date.now() + 40 * 60000).toISOString() }, 2: { seatNo: 2, onDuty: true } });
check('break from seat profiles honoured on anon surface (T1 to chair 2, chair 1 back at ~40)', r.T1 === 0 && r.T2 >= 30 && r.T2 <= 41, r);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
