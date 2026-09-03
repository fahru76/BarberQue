/**
 * Seat scheduling.
 *
 * Pure: no DOM, no storage, no wall clock. Everything time-dependent arrives as
 * `nowMinutes` and `ops`, which is what makes this testable and shareable with a
 * server implementation.
 *
 * Behaviour is intentionally identical to the prototype's inline version; the
 * differential test suite asserts that against randomised inputs.
 */

import { timeToMinutes, shopMinutesOfDay, businessMinutes } from './time.js';

export const AVG_WAIT_MINUTES = 25;

/**
 * How a service already in progress interacts with a break.
 *   'finish_in_progress' - the barber completes the customer in the chair, then breaks.
 *   'pause_and_resume'   - work genuinely stops and resumes after the break.
 */
export const BREAK_POLICY = 'finish_in_progress';

export function getConfiguredBreaks(ops) {
    return [['break1Start', 'break1End'], ['break2Start', 'break2End']]
        .map(([startKey, endKey]) => [
            businessMinutes(timeToMinutes(ops?.[startKey]), ops),
            businessMinutes(timeToMinutes(ops?.[endKey]), ops)
        ])
        .filter(([start, end]) => start >= 0 && end > start)
        .sort((first, second) => first[0] - second[0]);
}

export function intervalOverlapsBreak(start, end, ops) {
    return getConfiguredBreaks(ops).some(([breakStart, breakEnd]) => start < breakEnd && end > breakStart);
}

/** Start time for a service that has NOT begun: delayed so it never straddles a break. */
export function moveServicePastBreak(start, duration, ops) {
    let adjustedStart = businessMinutes(start, ops);
    for (const [breakStart, breakEnd] of getConfiguredBreaks(ops)) {
        if (adjustedStart < breakEnd && adjustedStart + duration > breakStart) adjustedStart = breakEnd;
    }
    return adjustedStart;
}

/** End time for any service. `inProgress` selects the configured break policy. */
export function getServiceEnd(start, duration, ops, { inProgress = false } = {}) {
    start = businessMinutes(start, ops);
    if (!inProgress || BREAK_POLICY === 'finish_in_progress') return start + duration;
    let end = start + duration;
    for (const [breakStart, breakEnd] of getConfiguredBreaks(ops)) {
        if (start >= breakEnd || end <= breakStart) continue;
        end += breakEnd - Math.max(start, breakStart);
    }
    return end;
}

export function intervalsOverlap(first, second) {
    return first.start < second.end && first.end > second.start;
}

/**
 * Earliest start on one seat that clears every booked interval and never straddles a break.
 * Terminates because `candidate` strictly increases: an overlap requires candidate < interval.end,
 * and the retry moves candidate to at least interval.end.
 */
export function findNextSeatStart(schedule, desiredStart, duration, ops) {
    let candidate = moveServicePastBreak(desiredStart, duration, ops);
    const ordered = [...schedule].sort((first, second) => first.start - second.start);
    let changed = true;
    while (changed) {
        changed = false;
        for (const interval of ordered) {
            const projected = { start: candidate, end: candidate + duration };
            if (!intervalsOverlap(projected, interval)) continue;
            candidate = moveServicePastBreak(interval.end, duration, ops);
            changed = true;
            break;
        }
    }
    return candidate;
}

export function getQueuePriority(queue) {
    if (queue && queue.isFastPass) return 0;
    if (queue && queue.queueSource === 'booking') return 1;
    return 2;
}

export function sortWaitingQueue(list) {
    return [...list].sort((first, second) => {
        const priorityDelta = getQueuePriority(first) - getQueuePriority(second);
        if (priorityDelta !== 0) return priorityDelta;
        return Date.parse(first.timestamp) - Date.parse(second.timestamp);
    });
}

export function isWalkinQueue(queue) {
    return !queue || queue.queueSource !== 'booking';
}

/**
 * Simulate the day's seat occupancy.
 *
 * Serving records hold their seat (including a seat that was closed while occupied),
 * appointments claim seats next, then waiting walk-ins fill the remaining gaps.
 *
 * @returns {Array<{start:number,end:number,recordId:string}>} queue-record intervals only.
 */
export function buildOccupancyIntervals({ queues = [], appointments = [], activeSeats = {}, ops = {}, nowMinutes = 0 }) {
    const seatNumbers = Object.keys(activeSeats).filter(seat => activeSeats[seat]).map(Number);
    const seatSchedules = new Map(seatNumbers.map(seat => [seat, []]));
    const intervals = [];
    // Extends onto the business day's own axis -- see businessMinutes doc. A
    // same-day `ops` (the overwhelming majority) passes through unchanged.
    nowMinutes = businessMinutes(nowMinutes, ops);

    queues.filter(queue => queue.status === 'serving').forEach(queue => {
        const seatNumber = Number(queue.seat);
        let schedule = seatSchedules.get(seatNumber);
        if (!schedule) {
            // Seat closed while occupied. The chair is still physically busy, so track it —
            // but it stays out of seatNumbers so no new customer is scheduled onto it.
            schedule = [];
            seatSchedules.set(seatNumber, schedule);
        }
        const calledMinutes = shopMinutesOfDay(queue.calledAt);
        const start = calledMinutes === null ? nowMinutes : calledMinutes;
        const duration = Number(queue.duration) || AVG_WAIT_MINUTES;
        const end = Math.max(nowMinutes, getServiceEnd(start, duration, ops, { inProgress: true }));
        if (end > nowMinutes) {
            const servingInterval = { start: nowMinutes, end, recordId: queue.id };
            schedule.push(servingInterval);
            intervals.push(servingInterval);
        }
    });

    if (seatNumbers.length) {
        [...appointments]
            .sort((first, second) => businessMinutes(timeToMinutes(first.time), ops) - businessMinutes(timeToMinutes(second.time), ops))
            .forEach(appointment => {
                const start = businessMinutes(timeToMinutes(appointment.time), ops);
                const appointmentInterval = {
                    start,
                    end: start + (Number(appointment.duration) || AVG_WAIT_MINUTES)
                };
                const availableSeat = seatNumbers.find(seat =>
                    !seatSchedules.get(seat).some(interval => intervalsOverlap(interval, appointmentInterval)));
                // No free seat: put it on the least-loaded one so the conflict shows up in the
                // numbers instead of the appointment vanishing from the model.
                const selectedSeat = availableSeat !== undefined
                    ? availableSeat
                    : seatNumbers.reduce((leastLoaded, seat) =>
                        seatSchedules.get(seat).length < seatSchedules.get(leastLoaded).length ? seat : leastLoaded,
                        seatNumbers[0]);
                seatSchedules.get(selectedSeat).push(appointmentInterval);
            });

        sortWaitingQueue(queues.filter(queue => queue.status === 'waiting')).forEach(queue => {
            const duration = Number(queue.duration) || AVG_WAIT_MINUTES;
            const candidates = seatNumbers.map(seat => ({
                seat,
                start: findNextSeatStart(seatSchedules.get(seat), nowMinutes, duration, ops)
            }));
            const selected = candidates.reduce(
                (earliest, candidate) => candidate.start < earliest.start ? candidate : earliest, candidates[0]);
            const queueInterval = { start: selected.start, end: selected.start + duration, recordId: queue.id };
            intervals.push(queueInterval);
            seatSchedules.get(selected.seat).push(queueInterval);
        });
    }

    return intervals;
}

/** @returns {number|null} minutes until service starts, or null when unschedulable. */
export function estimateWaitMinutes({ queues, appointments, activeSeats, ops, nowMinutes, ticketId }) {
    if (!Object.values(activeSeats || {}).some(Boolean)) return null;
    const resolvedNowMinutes = businessMinutes(nowMinutes, ops);
    const interval = buildOccupancyIntervals({ queues, appointments, activeSeats, ops, nowMinutes })
        .find(item => item.recordId === ticketId);
    return interval ? Math.max(0, Math.ceil(interval.start - resolvedNowMinutes)) : null;
}

/** Map of recordId to wait minutes, so a render pass runs one simulation instead of N. */
export function buildWaitByRecordId({ queues, appointments, activeSeats, ops, nowMinutes }) {
    if (!Object.values(activeSeats || {}).some(Boolean)) return new Map();
    const resolvedNowMinutes = businessMinutes(nowMinutes, ops);
    return new Map(buildOccupancyIntervals({ queues, appointments, activeSeats, ops, nowMinutes })
        .map(interval => [interval.recordId, Math.max(0, Math.ceil(interval.start - resolvedNowMinutes))]));
}

/** How many waiting customers are ahead of this ticket, honouring fast-pass priority. */
export function customersAheadCount(queues, ticketId) {
    const waiting = sortWaitingQueue((queues || []).filter(queue => queue.status === 'waiting'));
    const position = waiting.findIndex(queue => queue.id === ticketId);
    return position >= 0 ? position : 0;
}

/** Can a `duration`-minute appointment start at `time` on `date`? */
export function isSlotAvailable({ time, duration, ops, activeSeats, appointments = [], queueIntervals = [], nowMinutes = null }) {
    if (!time || !Number.isFinite(duration) || duration <= 0) return false;
    const seats = Object.values(activeSeats || {}).filter(Boolean).length;
    if (seats === 0) return false;
    if (ops?.closed) return false;

    const start = businessMinutes(timeToMinutes(time), ops);
    const end = start + duration;
    if (start < timeToMinutes(ops?.open) || end > businessMinutes(timeToMinutes(ops?.close), ops)) return false;
    if (intervalOverlapsBreak(start, end, ops)) return false;
    if (nowMinutes !== null && start <= businessMinutes(nowMinutes, ops)) return false;

    for (let minute = start; minute < end; minute += 1) {
        const appointmentConcurrency = appointments.reduce((count, appointment) => {
            const appointmentStart = businessMinutes(timeToMinutes(appointment.time), ops);
            const appointmentEnd = appointmentStart + (Number(appointment.duration) || AVG_WAIT_MINUTES);
            return count + (minute >= appointmentStart && minute < appointmentEnd ? 1 : 0);
        }, 0);
        const queueConcurrency = queueIntervals.reduce(
            (count, interval) => count + (minute >= interval.start && minute < interval.end ? 1 : 0), 0);
        if (appointmentConcurrency + queueConcurrency >= seats) return false;
    }
    return true;
}
