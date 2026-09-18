/**
 * kanbanState tests. The test style follows scheduler.test.mjs: tiny eq()
 * harness, named cases, exit code 1 on failure.
 */
import * as K from '../../js/domain/kanbanState.js';

let passed = 0, failed = [];
const eq = (name, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; console.log(`  pass  ${name}`); }
    else { failed.push(name); console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`); };
};
const ok = (name, cond) => eq(name, !!cond, true);

const SEATS = [
    { seatNo: 1, active: true, barberId: 'u1', barberName: 'Syam' },
    { seatNo: 2, active: true, barberId: 'u2', barberName: 'Mat' },
    { seatNo: 3, active: false, barberId: null, barberName: null }
];
const ts = i => new Date(Date.UTC(2026, 8, 18, 1, i)).toISOString();
const q = (id, status, { seat = null, min = 0, fast = false } = {}) =>
    ({ id, name: `C-${id}`, service: 'Potong', duration: 30, seat, barberId: null, status,
       queueSource: 'walkin', isFastPass: fast, timestamp: ts(min), calledAt: null });

console.log('\nColumn construction');
{
    const { columns } = K.buildBoard({ seats: SEATS, queues: [] });
    eq('waiting column first, then seats ascending', columns.map(c => c.id),
        [K.WAITING_COLUMN_ID, 'seat:1', 'seat:2', 'seat:3']);
    eq('column label prefers barber name', columns.map(c => c.label), ['MENUNGGU', 'Syam', 'Mat', 'KURSI 3']);
    eq('closed seat flagged', columns.find(c => c.id === 'seat:3').closed, true);
}

console.log('\nCard placement');
{
    const queues = [
        q('W1', 'waiting', { min: 0 }),
        q('W2', 'waiting', { min: 5 }),
        q('S1', 'serving', { seat: 2, min: 2 }),
        q('X1', 'cancelled', { seat: 1, min: 3 }),
        q('D1', 'completed', { seat: 1, min: 4 })
    ];
    const { columns } = K.buildBoard({ seats: SEATS, queues });
    const wait = columns.find(c => c.kind === 'waiting');
    const seat1 = columns.find(c => c.id === 'seat:1');
    const seat2 = columns.find(c => c.id === 'seat:2');
    eq('waiting column holds waiting tickets FIFO', wait.cards.map(c => c.id), ['W1', 'W2']);
    eq('serving card sits in its seat column', seat2.cards.map(c => c.id), ['S1']);
    eq('completed/cancelled are counts, not cards', seat1.cards, []);
    eq('doneCount tallies on the seat that finished them',
        columns.map(c => c.doneCount), [0, 2, 0, 0]);
}

console.log('\nUnassigned cancellation count');
{
    const { columns } = K.buildBoard({ seats: SEATS, queues: [q('C1', 'cancelled')] });
    eq('cancelled unassigned ticket is counted in waiting column',
        columns.find(c => c.id === K.WAITING_COLUMN_ID).doneCount, 1);
}

console.log('\nFast-pass ordering  (matches sortWaitingQueue)');
{
    const queues = [q('W1', 'waiting', { min: 0 }), q('W2', 'waiting', { min: 5 }), q('FP', 'waiting', { min: 20, fast: true })];
    const { columns } = K.buildBoard({ seats: SEATS, queues });
    eq('fast-pass first despite latest timestamp',
        columns.find(c => c.kind === 'waiting').cards.map(c => c.id), ['FP', 'W1', 'W2']);
}

console.log('\nOrphan seat still gets a column  (no dropped cards)');
{
    const queues = [q('S9', 'serving', { seat: 9, min: 0 })];
    const { columns } = K.buildBoard({ seats: SEATS, queues });
    const seat9 = columns.find(c => c.id === 'seat:9');
    ok('seat:9 synthesized inactive', seat9 && seat9.kind === 'seat' && seat9.closed);
    eq('its card is retained', seat9.cards.map(c => c.id), ['S9']);
}

console.log('\nBad input degrades, never throws');
{
    eq('null queues', K.buildBoard({ seats: SEATS, queues: null }).columns.length, 4);
    eq('null seats with queues', K.buildBoard({ seats: null, queues: [q('W1', 'waiting')] }).columns.length, 1);
    eq('null seats, serving ticket still gets orphan seat column',
        K.buildBoard({ seats: null, queues: [q('S9', 'serving', { seat: 9 })] }).columns.length, 2);
}

console.log('\nplanMove gating');
{
    const queues = [q('W1', 'waiting', { min: 0 }), q('S1', 'serving', { seat: 2, min: 2 })];
    eq('waiting -> seat allowed', K.planMove({ queues, queueId: 'W1', targetColumnId: 'seat:1' }),
        { queueId: 'W1', seatNo: 1, allowed: true });
    eq('waiting -> back to waiting is a valid plan',
        K.planMove({ queues, queueId: 'W1', targetColumnId: K.WAITING_COLUMN_ID }),
        { queueId: 'W1', seatNo: null, allowed: true });
    eq('serving cannot return to waiting', K.planMove({ queues, queueId: 'S1', targetColumnId: K.WAITING_COLUMN_ID }).reason,
        'serving-ticket-cannot-return-to-waiting');
    eq('same-seat move is a no-op', K.planMove({ queues, queueId: 'S1', targetColumnId: 'seat:2' }).reason, 'no-op');
    eq('unknown queue rejected', K.planMove({ queues, queueId: 'ZZ', targetColumnId: 'seat:1' }).reason, 'unknown-queue');
    eq('junk target rejected', K.planMove({ queues, queueId: 'W1', targetColumnId: 'seat:banana' }).reason, 'unknown-target');
}

console.log('\ndiffBoards');
{
    const before = K.buildBoard({ seats: SEATS, queues: [q('W1', 'waiting', { min: 0 }), q('S1', 'serving', { seat: 2, min: 2 })] });
    const after = K.buildBoard({ seats: SEATS, queues: [q('W1', 'serving', { seat: 1, min: 0 }), q('W2', 'waiting', { min: 9 })] });
    const d = K.diffBoards(before, after);
    eq('one move: W1 waiting -> seat:1', d.moved, [{ queueId: 'W1', from: K.WAITING_COLUMN_ID, to: 'seat:1' }]);
    eq('S1 left the board', d.removed, ['S1']);
    eq('W2 appeared', d.added, ['W2']);
    eq('identical boards diff to nothing', K.diffBoards(before, before),
        { moved: [], removed: [], added: [] });
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.error(failed.join('\n')); process.exit(1); }
