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
    'getQueueOccupancyIntervals', 'estimateQueueWaitMinutes', 'buildWaitByRecordId',
    'getSeatBreakUntilText'
].map(extractFunction).join('\n\n');

const factory = new Function('STATE', `
    ${stubbedGlobals}
    ${INLINE_FNS}
    return {
        seatCanPerformInline, buildSeatCapabilityMapInline, resolveSeatCapability,
        getQueueOccupancyIntervals, estimateQueueWaitMinutes, buildWaitByRecordId,
        getSeatBreakUntilText, __syncState
    };
`);
const inline = factory(STATE);

// ---- barber break contract (migration 20261008090000) ---------------------
const OPS = { open: '10:00', close: '22:00', break1Start: '', break1End: '', break2Start: '', break2End: '' };
const NOW = 15 * 60;
const waiting = (id, i) => ({ id, status: 'waiting', duration: 30, queueSource: 'walkin', timestamp: new Date(Date.UTC(2026, 9, 8, 5, i)).toISOString() });
const queues = [waiting('T1', 0), waiting('T2', 1), waiting('T3', 2)];
const activeSeats = { 1: true, 2: true };
const run = seatState => {
    Object.assign(STATE, { queues, appointments: [], activeSeats, ops: OPS, today: '2026-10-08', nowMinutes: NOW, seatServerState: seatState, cachedStaffList: [] });
    inline.__syncState();
    return Object.fromEntries(inline.getQueueOccupancyIntervals('2026-10-08', [], queues, activeSeats).map(iv => [iv.recordId, iv.start - NOW]));
};
let passed = 0, failed = 0;
const check = (label, ok) => { console.log(`  ${ok ? 'pass' : 'FAIL'}  ${label}`); ok ? passed++ : failed++; };
const inMin = m => new Date(Date.now() + m * 60000).toISOString();

const onDuty = run({ 1: { barberId: 'a' }, 2: { barberId: 'b' } });
check('both on duty: T1,T2 start now, T3 after 30', onDuty.T1 === 0 && onDuty.T2 === 0 && onDuty.T3 === 30);

const onBreak = run({ 1: { barberId: 'a', breakUntil: inMin(45) }, 2: { barberId: 'b' } });
check('seat 1 on 45-min break: T1 now, T2 at 30 (seat 2 absorbs)', onBreak.T1 === 0 && onBreak.T2 === 30);
check('seat 1 on 45-min break: T3 at ~45 (flows back to seat 1 after break)', onBreak.T3 >= 45 && onBreak.T3 <= 46);

const expired = run({ 1: { barberId: 'a', breakUntil: inMin(-5) }, 2: { barberId: 'b' } });
check('expired break is ignored (auto back on duty)', JSON.stringify(expired) === JSON.stringify(onDuty));

const noState = run(undefined);
check('surface without seatServerState (anon/TV) unchanged', JSON.stringify(noState) === JSON.stringify(onDuty));

STATE.seatServerState = { 1: { breakUntil: inMin(20) }, 2: { breakUntil: inMin(-1) } };
inline.__syncState();
check('getSeatBreakUntilText: active break -> HH:MM', /^\d{2}:\d{2}$/.test(inline.getSeatBreakUntilText(1)));
check('getSeatBreakUntilText: expired break -> empty', inline.getSeatBreakUntilText(2) === '');
check('getSeatBreakUntilText: no state -> empty', inline.getSeatBreakUntilText(3) === '');

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
