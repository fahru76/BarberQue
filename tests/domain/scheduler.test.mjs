/**
 * Regression fixtures. Every case here is a bug found during the audit series —
 * the name records which round, so a future change that breaks one is traceable.
 */
import * as S from '../../js/domain/scheduler.js';

let passed = 0, failed = [];
const eq = (name, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; console.log(`  pass  ${name}`); }
    else { failed.push(name); console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`); };
};

const OPS = { open: '10:00', close: '22:00', break1Start: '13:00', break1End: '14:00', break2Start: '18:00', break2End: '18:30' };
const NO_BREAK = { open: '10:00', close: '22:00', break1Start: '', break1End: '', break2Start: '', break2End: '' };
const at = (h, m = 0) => h * 60 + m;
const ts = i => new Date(Date.UTC(2026, 7, 29, 1, i)).toISOString();

console.log('\nBreak policy  (round 5, BUG 3)');
eq('waiting 12:45+30 is delayed past the break', S.moveServicePastBreak(at(12, 45), 30, OPS), at(14));
eq('waiting 12:30+30 ends exactly at break start, NOT pushed', S.moveServicePastBreak(at(12, 30), 30, OPS), at(12, 30));
eq('serving 12:45+30 finishes the customer, not +60', S.getServiceEnd(at(12, 45), 30, OPS, { inProgress: true }), at(13, 15));
eq('300-min service cascades past both breaks', S.moveServicePastBreak(at(12, 30), 300, OPS), at(18, 30));

console.log('\nUnschedulable is null, not zero  (round 5, BUG 4)');
eq('all seats closed returns null', S.estimateWaitMinutes({
    queues: [{ id: 'W1', status: 'waiting', duration: 30, timestamp: ts(0), queueSource: 'walkin' }],
    appointments: [], activeSeats: { 1: false, 2: false }, ops: NO_BREAK, nowMinutes: at(10), ticketId: 'W1' }), null);
eq('next up returns 0', S.estimateWaitMinutes({
    queues: [{ id: 'W1', status: 'waiting', duration: 30, timestamp: ts(0), queueSource: 'walkin' }],
    appointments: [], activeSeats: { 1: true }, ops: NO_BREAK, nowMinutes: at(10), ticketId: 'W1' }), 0);

console.log('\nServing customer on a closed seat  (round 5, BUG 6)');
{
    const queues = [
        { id: 'S2', status: 'serving', seat: 2, duration: 120, calledAt: '2026-08-29T02:00:00.000Z' },
        { id: 'W1', status: 'waiting', duration: 30, timestamp: ts(1), queueSource: 'walkin' },
        { id: 'W2', status: 'waiting', duration: 30, timestamp: ts(2), queueSource: 'walkin' }
    ];
    const iv = S.buildOccupancyIntervals({ queues, appointments: [], activeSeats: { 1: true, 2: false }, ops: NO_BREAK, nowMinutes: at(10) });
    eq('closed-but-occupied seat is still modelled', iv.some(i => i.recordId === 'S2'), true);
    const w1 = iv.find(i => i.recordId === 'W1'), w2 = iv.find(i => i.recordId === 'W2');
    eq('no new customer is placed on the closed seat', w2.start >= w1.end, true);
}

console.log('\nFast-pass priority  (round 15)');
{
    const queues = [
        { id: 'W1', status: 'waiting', duration: 30, timestamp: ts(0), queueSource: 'walkin' },
        { id: 'W2', status: 'waiting', duration: 30, timestamp: ts(5), queueSource: 'walkin' },
        { id: 'FP', status: 'waiting', duration: 30, timestamp: ts(20), queueSource: 'walkin', isFastPass: true }
    ];
    eq('fast-pass sorts first despite latest timestamp', S.sortWaitingQueue(queues).map(q => q.id), ['FP', 'W1', 'W2']);
    eq('overtaken customer count rises', S.customersAheadCount(queues, 'W1'), 1);
}

console.log('\nfindNextSeatStart terminates  (round 5, loop-safety)');
{
    let seed = 42; const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let ok = true;
    for (let run = 0; run < 200 && ok; run++) {
        const schedule = Array.from({ length: 15 }, () => { const s = 600 + Math.floor(rand() * 600); return { start: s, end: s + Math.floor(rand() * 90) }; });
        try { S.findNextSeatStart(schedule, 600, 30, OPS); } catch { ok = false; }
    }
    eq('200 randomised overlapping schedules terminate', ok, true);
}

console.log('\nSlot availability  (rounds 5 & 11)');
eq('slot inside a break is rejected', S.isSlotAvailable({ time: '13:00', duration: 30, ops: OPS, activeSeats: { 1: true }, nowMinutes: at(9) }), false);
eq('slot running past closing is rejected', S.isSlotAvailable({ time: '21:40', duration: 30, ops: OPS, activeSeats: { 1: true }, nowMinutes: at(9) }), false);
eq('slot on a closed day is rejected', S.isSlotAvailable({ time: '15:00', duration: 30, ops: { ...OPS, closed: true }, activeSeats: { 1: true }, nowMinutes: at(9) }), false);
eq('valid slot is accepted', S.isSlotAvailable({ time: '15:00', duration: 30, ops: OPS, activeSeats: { 1: true }, nowMinutes: at(9) }), true);

console.log('\nOvernight schedule crossing midnight  (round 20, midnight-crossing fix)');
{
    // open 18:00, close 01:00 -- close <= open, so this day's hours cross
    // midnight. Every raw clock-time earlier than `open` is the post-midnight
    // TAIL of this same business day, extended onto minutes 1440+ (see
    // businessMinutes' doc in js/domain/time.js). atNext() writes that tail
    // in the same "hours:minutes" shape as at(), just past the 24h mark.
    const OVERNIGHT_OPS = { open: '18:00', close: '01:00', break1Start: '23:30', break1End: '00:30', break2Start: '', break2End: '' };
    const OVERNIGHT_NO_BREAK = { open: '18:00', close: '01:00', break1Start: '', break1End: '', break2Start: '', break2End: '' };
    const atNext = (h, m = 0) => 1440 + h * 60 + m;

    eq('waiting 23:45+60 is delayed past the midnight-crossing break', S.moveServicePastBreak(at(23, 45), 60, OVERNIGHT_OPS), atNext(0, 30));
    eq('waiting 23:00+30 ends exactly at break start, NOT pushed', S.moveServicePastBreak(at(23, 0), 30, OVERNIGHT_OPS), at(23, 0));
    eq('a raw post-midnight start (00:30) is understood as this business day\'s tail, not delayed further', S.moveServicePastBreak(30, 20, OVERNIGHT_OPS), atNext(0, 30));
    eq('getServiceEnd wraps a raw post-midnight start onto the business-day axis', S.getServiceEnd(30, 45, OVERNIGHT_OPS, { inProgress: true }), atNext(1, 15));

    eq('overnight slot after midnight is accepted', S.isSlotAvailable({ time: '00:00', duration: 30, ops: OVERNIGHT_NO_BREAK, activeSeats: { 1: true }, nowMinutes: at(19) }), true);
    eq('overnight slot inside the midnight-crossing break is rejected', S.isSlotAvailable({ time: '00:00', duration: 60, ops: OVERNIGHT_OPS, activeSeats: { 1: true }, nowMinutes: at(19) }), false);
    eq('overnight slot running past a post-midnight close is rejected', S.isSlotAvailable({ time: '00:45', duration: 30, ops: OVERNIGHT_OPS, activeSeats: { 1: true }, nowMinutes: at(19) }), false);
    eq('overnight slot right after the midnight-crossing break is accepted', S.isSlotAvailable({ time: '00:30', duration: 20, ops: OVERNIGHT_OPS, activeSeats: { 1: true }, nowMinutes: at(19) }), true);
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
