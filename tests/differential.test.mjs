/**
 * Differential test: the extracted domain modules must behave exactly like the
 * prototype's inline implementation. Randomised inputs, compared field by field.
 */
import { createRequire } from 'module';
import * as S from '../js/domain/scheduler.js';
const legacy = createRequire(import.meta.url)('../build/legacy.cjs');

const TODAY = '2026-08-29';
const mulberry = seed => () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

function randomCase(rand) {
    const pick = arr => arr[Math.floor(rand() * arr.length)];
    const seatCount = 1 + Math.floor(rand() * 5);
    const activeSeats = {};
    for (let s = 1; s <= seatCount; s++) activeSeats[s] = rand() > 0.25;
    const ops = {
        open: pick(['08:00', '10:00', '11:30']),
        close: pick(['18:00', '22:00', '23:45']),
        break1Start: rand() > 0.4 ? pick(['13:00', '12:30']) : '',
        break1End: rand() > 0.4 ? pick(['14:00', '13:15']) : '',
        break2Start: rand() > 0.7 ? '18:00' : '',
        break2End: rand() > 0.7 ? '18:30' : '',
        closed: false
    };
    const nowMinutes = 480 + Math.floor(rand() * 700);
    const queues = [];
    const total = Math.floor(rand() * 14);
    for (let i = 0; i < total; i++) {
        const status = pick(['waiting', 'waiting', 'waiting', 'serving', 'done', 'cancelled']);
        queues.push({
            id: 'Q' + i,
            status,
            seat: status === 'serving' ? 1 + Math.floor(rand() * (seatCount + 1)) : null,
            duration: pick([0, 15, 25, 30, 45, 90]),
            queueSource: pick(['walkin', 'walkin', 'booking']),
            isFastPass: rand() > 0.85,
            timestamp: new Date(Date.UTC(2026, 7, 29, 1, i * 3)).toISOString(),
            calledAt: status === 'serving'
                ? (rand() > 0.15 ? new Date(Date.UTC(2026, 7, 29, 1 + Math.floor(rand() * 6), 0)).toISOString() : 'broken')
                : null
        });
    }
    const appointments = [];
    for (let i = 0; i < Math.floor(rand() * 6); i++) {
        appointments.push({
            id: 'A' + i, date: TODAY, status: 'upcoming',
            time: `${String(9 + Math.floor(rand() * 12)).padStart(2, '0')}:${pick(['00', '15', '30', '45'])}`,
            duration: pick([0, 20, 30, 60])
        });
    }
    return { activeSeats, ops, nowMinutes, queues, appointments };
}

let checked = 0, mismatches = [];
const rand = mulberry(20260831);

for (let run = 0; run < 4000; run++) {
    const c = randomCase(rand);
    legacy.setState({ queues: c.queues, appointments: c.appointments, activeSeats: c.activeSeats, ops: c.ops, today: TODAY, nowMinutes: c.nowMinutes });

    const before = legacy.getQueueOccupancyIntervals(TODAY, c.appointments, c.queues, c.activeSeats);
    const after = S.buildOccupancyIntervals({ queues: c.queues, appointments: c.appointments, activeSeats: c.activeSeats, ops: c.ops, nowMinutes: c.nowMinutes });
    if (JSON.stringify(before) !== JSON.stringify(after)) {
        mismatches.push({ run, fn: 'occupancyIntervals', before, after, c });
    }
    checked++;

    const ticket = c.queues.find(q => q.status === 'waiting')?.id ?? 'none';
    const wBefore = legacy.estimateQueueWaitMinutes(c.queues, ticket, c.activeSeats);
    const wAfter = S.estimateWaitMinutes({ ...c, ticketId: ticket });
    if (wBefore !== wAfter) mismatches.push({ run, fn: 'estimateWait', before: wBefore, after: wAfter, c });
    checked++;

    const mBefore = [...legacy.buildWaitByRecordId(c.queues, c.activeSeats, c.appointments).entries()];
    const mAfter = [...S.buildWaitByRecordId(c).entries()];
    if (JSON.stringify(mBefore) !== JSON.stringify(mAfter)) mismatches.push({ run, fn: 'waitByRecordId', before: mBefore, after: mAfter, c });
    checked++;

    const aBefore = legacy.getCustomersAheadCount(c.queues, ticket);
    const aAfter = S.customersAheadCount(c.queues, ticket);
    if (aBefore !== aAfter) mismatches.push({ run, fn: 'customersAhead', before: aBefore, after: aAfter, c });
    checked++;

    const slotTime = `${String(9 + Math.floor(rand() * 12)).padStart(2, '0')}:00`;
    const dur = [20, 30, 60][Math.floor(rand() * 3)];
    const qi = after;
    const sBefore = legacy.isAppointmentSlotAvailable(TODAY, slotTime, dur, '', { activeSeats: c.activeSeats, appointments: c.appointments, queueIntervals: qi });
    const sAfter = S.isSlotAvailable({ time: slotTime, duration: dur, ops: c.ops, activeSeats: c.activeSeats, appointments: c.appointments, queueIntervals: qi, nowMinutes: c.nowMinutes });
    if (sBefore !== sAfter) mismatches.push({ run, fn: 'isSlotAvailable', before: sBefore, after: sAfter, c });
    checked++;
}

console.log(`comparisons run : ${checked}`);
console.log(`mismatches      : ${mismatches.length}`);
if (mismatches.length) {
    const m = mismatches[0];
    console.log('\nFIRST MISMATCH in ' + m.fn + ' (run ' + m.run + ')');
    console.log('  before:', JSON.stringify(m.before).slice(0, 300));
    console.log('  after :', JSON.stringify(m.after).slice(0, 300));
    console.log('  input :', JSON.stringify(m.c).slice(0, 600));
    process.exit(1);
}
console.log('\nPASS - extracted modules are behaviourally identical to the prototype.');
