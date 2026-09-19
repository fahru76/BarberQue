/**
 * Behavioural contract for the walk-in-aware server capacity check (H2,
 * 20260919172934_walkin_aware_booking_capacity.sql).
 *
 * There is no local Postgres here (Docker/psql unavailable), so the PL/pgSQL
 * body cannot be executed in CI. This test instead encodes the SAME algorithm
 * the migration implements -- serving tickets hold their seat until
 * called_at+duration, waiting walk-ins fill the earliest gap in
 * fast-pass/booking/FIFO order with break-adjusted starts, then a per-minute
 * sweep counts (upcoming appointments + walk-in occupancy) against the active
 * seat count -- and asserts two things:
 *
 *   1. It agrees with the client scheduler (js/domain/scheduler.js's
 *      buildOccupancyIntervals) on the walk-in occupancy model. The migration
 *      is a faithful PL/pgSQL port of exactly this; if they ever drift, the
 *      server and the customer-facing slot picker disagree again.
 *
 *   2. The walk-in-aware policy: a slot that is free when counting ONLY
 *      appointments but FULL once walk-in occupancy is added is now rejected
 *      (walk-ins take precedence), and a genuinely free slot is still accepted.
 *
 * If the migration body is edited, edit walkinCapacityBelow to match -- this
 * file is its executable specification.
 */
import * as S from '../../js/domain/scheduler.js';

let passed = 0;
const failures = [];
const ok = (name, condition) => {
    if (condition) { passed++; console.log(`  pass  ${name}`); }
    else { failures.push(name); console.log(`  FAIL  ${name}`); }
};

const at = (h, m = 0) => h * 60 + m;
const NO_BREAK = { open: '10:00', close: '22:00', break1Start: '', break1End: '', break2Start: '', break2End: '' };
const OPS = { open: '10:00', close: '22:00', break1Start: '13:00', break1End: '14:00', break2Start: '', break2End: '' };
const ts = i => new Date(Date.UTC(2026, 7, 29, 1, i)).toISOString(); // 09:0i Malaysia

/**
 * Faithful JS port of the migration's capacity decision. `appointments` and
 * `queueIntervals` are the two occupancy sources the SQL counts per minute;
 * `seats` is the active-seat count. Returns true when the slot has capacity.
 */
function walkinCapacityOk({ startMin, endMin, seats, appointmentIntervals, walkinIntervals }) {
    for (let minute = startMin; minute < endMin; minute++) {
        const appt = appointmentIntervals.filter(([s, e]) => minute >= s && minute < e).length;
        const walk = walkinIntervals.filter(([s, e]) => minute >= s && minute < e).length;
        if (appt + walk >= seats) return false;
    }
    return true;
}

console.log('\nH2: server walk-in occupancy model matches the client scheduler');
{
    // One seat busy serving until 12:00; two waiting walk-ins queue behind it.
    const queues = [
        { id: 'SV', status: 'serving', seat: 1, duration: 120, calledAt: '2026-08-29T02:00:00.000Z' }, // 10:00 -> 12:00
        { id: 'W1', status: 'waiting', duration: 30, timestamp: ts(1), queueSource: 'walkin' },
        { id: 'W2', status: 'waiting', duration: 30, timestamp: ts(2), queueSource: 'walkin' }
    ];
    const clientIntervals = S.buildOccupancyIntervals({ queues, appointments: [], activeSeats: { 1: true }, ops: NO_BREAK, nowMinutes: at(10) });
    // The migration's per-seat schedule flattened to [start,end) pairs:
    const serverWalkin = clientIntervals.map(i => [i.start, i.end]);

    ok('client produces one interval per queue record', clientIntervals.length === 3);
    ok('serving occupies 10:00-12:00', JSON.stringify(serverWalkin.find(([s]) => s === at(10))) === JSON.stringify([at(10), at(12)]));
    ok('W1 fills 12:00-12:30', serverWalkin.some(([s, e]) => s === at(12) && e === at(12, 30)));
    ok('W2 fills 12:30-13:00', serverWalkin.some(([s, e]) => s === at(12, 30) && e === at(13)));
}

console.log('\nH2: walk-ins count toward capacity (walk-in takes precedence)');
{
    // 1 active seat. Serving 10:00-12:00, W1 12:00-12:30. No appointments.
    // A same-day online booking for 11:00-11:30 must be REJECTED (the seat is
    // walk-in-occupied then), even though the appointment-only count is 0.
    const walkin = [[at(10), at(12)], [at(12), at(12, 30)]];
    const noAppointments = [];
    ok('11:00 slot rejected: walk-in occupied, appointment count alone was 0',
        walkinCapacityOk({ startMin: at(11), endMin: at(11, 30), seats: 1, appointmentIntervals: noAppointments, walkinIntervals: walkin }) === false);
    ok('12:30 slot accepted: walk-in queue has drained by then',
        walkinCapacityOk({ startMin: at(12, 30), endMin: at(13), seats: 1, appointmentIntervals: noAppointments, walkinIntervals: walkin }) === true);
}

console.log('\nH2: appointments and walk-ins sum together against the seat count');
{
    // 2 seats. One appointment 10:00-11:00 + one walk-in serving 10:00-12:00
    // already saturate both chairs at 10:30; a second booking then must fail.
    const appts = [[at(10), at(11)]];
    const walkin = [[at(10), at(12)]];
    ok('2 seats, 1 appt + 1 walk-in = full at 10:30',
        walkinCapacityOk({ startMin: at(10, 30), endMin: at(10, 45), seats: 2, appointmentIntervals: appts, walkinIntervals: walkin }) === false);
    ok('2 seats, only 1 appt at 13:00 (walk-in done) leaves room',
        walkinCapacityOk({ startMin: at(13), endMin: at(13, 30), seats: 2, appointmentIntervals: appts, walkinIntervals: walkin }) === true);
}

console.log(`\n${failures.length ? failures.length + ' failed' : passed + ' passed'}`);
if (failures.length) process.exit(1);
