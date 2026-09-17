/**
 * kanbanState — pure derivation of the barber kanban board from today's data.
 *
 * Pure: no DOM, no storage, no wall clock, no fetch. Everything arrives as
 * already-mapped repository shapes:
 *   - seats: seatRepository.getAllSeats() rows -> { seatNo, active, barberId, barberName }
 *   - queues: queueRepository listQueues()/listQueuesToday() rows -> { id, name, service,
 *     duration, seat, barberId, status, queueSource, isFastPass, timestamp, calledAt, ... }
 *
 * Column model:
 *   - one column per seat that has ever been configured (seat numbers from
 *     `seats`, unioned with seat numbers referenced by today's tickets, so a
 *     ticket never vanishes just because its seat row was never upserted);
 *   - a synthetic "WAITING" column holding unassigned waiting tickets;
 *   - serving tickets are the cards; completed/cancelled tickets are NOT
 *     cards (history, not work-in-progress) — they only appear in counts.
 *
 * Realtime events just re-run `buildBoard` and diff by queue id, so this
 * module is the single source of truth for card placement; the existing
 * serving-seat UI should eventually render from it too.
 */

export const WAITING_COLUMN_ID = '__waiting__';
export const DONE_COLUMN_ID = '__done__';

/**
 * Today's board, as an array of columns in stable order.
 *
 * @param {object} input
 * @param {Array<{seatNo:number, active:boolean, barberId:string|null, barberName:string|null}>} input.seats
 * @param {Array<object>} input.queues  mapped queues rows (today, no status filter)
 * @param {string[]} [input.statusOrder] ticket statuses treated as cards, in priority order
 * @returns {{columns: Array<{id: string, kind: 'waiting'|'seat', seatNo: number|null,
 *   label: string, active: boolean, cards: Array<object>, doneCount: number,
 *   closed: boolean}>}}
 */
export function buildBoard({ seats, queues, statusOrder = ['serving', 'waiting'] }) {
    const safeQueues = Array.isArray(queues) ? queues : [];
    const safeSeats = Array.isArray(seats) ? seats : [];

    const bySeatNo = new Map();
    for (const seat of safeSeats) {
        if (seat && Number.isFinite(seat.seatNo)) bySeatNo.set(seat.seatNo, seat);
    }

    // A seat referenced by a ticket but missing from `seats` still gets a
    // column, so a card is never silently dropped by the board.
    for (const q of safeQueues) {
        if (q && Number.isFinite(q.seat) && !bySeatNo.has(q.seat)) {
            bySeatNo.set(q.seat, { seatNo: q.seat, active: false, barberId: null, barberName: null });
        }
    }

    const seatNos = [...bySeatNo.keys()].sort((a, b) => a - b);

    const columns = new Map();
    columns.set(WAITING_COLUMN_ID, {
        id: WAITING_COLUMN_ID,
        kind: 'waiting',
        seatNo: null,
        label: 'MENUNGGU',
        active: true,
        closed: false,
        cards: [],
        doneCount: 0
    });
    for (const seatNo of seatNos) {
        const seat = bySeatNo.get(seatNo);
        columns.set(`seat:${seatNo}`, {
            id: `seat:${seatNo}`,
            kind: 'seat',
            seatNo,
            label: seat.barberName || `KURSI ${seatNo}`,
            active: !!seat.active,
            closed: !seat.active,
            cards: [],
            doneCount: 0
        });
    }

    for (const q of safeQueues) {
        if (!q || !q.id) continue;
        if (!statusOrder.includes(q.status)) {
            // Completed / cancelled / anything else: count, not card.
            const target = columns.get(`seat:${q.seat}`);
            if (target) target.doneCount++;
            continue;
        }
        const columnId = q.status === 'serving' && Number.isFinite(q.seat)
            ? `seat:${q.seat}`
            : WAITING_COLUMN_ID;
        const column = columns.get(columnId) || columns.get(WAITING_COLUMN_ID);
        column.cards.push(q);
    }

    for (const column of columns.values()) {
        column.cards.sort(cardComparator);
    }

    return { columns: [...columns.values()] };
}

/**
 * Card sort: fast-pass first (matches scheduler.sortWaitingQueue), then FIFO
 * by created_at. Serving cards keep the same rule so their order inside a
 * seat column is deterministic.
 */
export function cardComparator(a, b) {
    const fa = a.isFastPass ? 1 : 0;
    const fb = b.isFastPass ? 1 : 0;
    if (fa !== fb) return fb - fa;
    const ta = a.timestamp || '';
    const tb = b.timestamp || '';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : 1;
}

/**
 * Target column id for a drag-and-drop move — the RPC-level reassignment is
 * `queueId -> seatNo` (null = back to waiting, only valid for waiting tickets).
 * The caller still validates server-side; this is UI gating only.
 *
 * @returns {{queueId: string, seatNo: number|null, allowed: boolean, reason?: string}}
 */
export function planMove({ queues, queueId, targetColumnId }) {
    const queue = (queues || []).find(q => q && q.id === queueId);
    if (!queue) return { queueId, seatNo: null, allowed: false, reason: 'unknown-queue' };

    if (targetColumnId === WAITING_COLUMN_ID) {
        if (queue.status !== 'waiting') {
            return { queueId, seatNo: null, allowed: false, reason: 'serving-ticket-cannot-return-to-waiting' };
        }
        return { queueId, seatNo: null, allowed: true };
    }

    const match = /^seat:(\d+)$/.exec(String(targetColumnId));
    if (!match) return { queueId, seatNo: null, allowed: false, reason: 'unknown-target' };

    const seatNo = Number(match[1]);
    if (!Number.isFinite(seatNo)) return { queueId, seatNo: null, allowed: false, reason: 'unknown-target' };

    if (queue.status === 'serving' && Number.isFinite(queue.seat) && queue.seat === seatNo) {
        return { queueId, seatNo, allowed: false, reason: 'no-op' };
    }
    if (queue.status !== 'waiting' && queue.status !== 'serving') {
        return { queueId, seatNo, allowed: false, reason: 'status-not-card' };
    }
    return { queueId, seatNo, allowed: true };
}

/**
 * Minimal structural diff between two board builds, so the renderer can move
 * existing card DOM nodes (appendChild) instead of re-rendering everything.
 *
 * @returns {{ moved: Array<{queueId: string, from: string, to: string}>,
 *   removed: string[], added: string[] }}
 */
export function diffBoards(prev, next) {
    const ids = board => {
        const out = new Map();
        for (const column of board.columns) {
            for (const card of column.cards) out.set(card.id, column.id);
        }
        return out;
    };
    const prevMap = ids(prev);
    const nextMap = ids(next);
    const moved = [];
    const removed = [];
    const added = [];
    for (const [queueId, from] of prevMap) {
        const to = nextMap.get(queueId);
        if (to === undefined) removed.push(queueId);
        else if (to !== from) moved.push({ queueId, from, to });
    }
    for (const queueId of nextMap.keys()) {
        if (!prevMap.has(queueId)) added.push(queueId);
    }
    return { moved, removed, added };
}
