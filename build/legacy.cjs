// AUTO-EXTRACTED from the prototype - reference implementation for differential testing
const AVG_WAIT_MINUTES=25;const BREAK_POLICY="finish_in_progress";const SHOP_TIME_ZONE="Asia/Kuala_Lumpur";
const MY_PARTS_FORMATTER=new Intl.DateTimeFormat("en-GB",{timeZone:SHOP_TIME_ZONE,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
let STATE={queues:[],appointments:[],activeSeats:{},ops:{},today:"",nowMinutes:0};
function getQueues(){return STATE.queues;}function getAppointments(){return STATE.appointments;}function getActiveSeats(){return STATE.activeSeats;}function getOpHours(){return STATE.ops;}function getLocalYMD(){return STATE.today;}function getMalaysiaCurrentMinutes(){return STATE.nowMinutes;}function isOnlineBookingDateAllowed(){return true;}


        function timeToMinutes(timeStr) {
            if(!timeStr) return -1;
            let parts = timeStr.split(':');
            return (parseInt(parts[0]) * 60) + parseInt(parts[1]);
        }


        function getMalaysiaDateTimeParts(value = Date.now()) {
            const millis = timestampToMillis(value);
            if (!Number.isFinite(millis)) return null;
            const parts = MY_PARTS_FORMATTER.formatToParts(new Date(millis));
            const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
            return values;
        }


        function timestampToMillis(value) {
            if (value instanceof Date) return value.getTime();
            if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
            if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
            return Date.parse(value);
        }


        function getQueuePriority(queue) {
            if (queue && queue.isFastPass) return 0;
            if (queue && (queue.queueSource === 'booking' || queue.isVip)) return 1;
            return 2;
        }


        function sortWaitingQueue(queueItems) {
            return [...queueItems].sort((a, b) => {
                const priorityDifference = getQueuePriority(a) - getQueuePriority(b);
                if (priorityDifference !== 0) return priorityDifference;
                const timeDifference = timestampToMillis(a.timestamp) - timestampToMillis(b.timestamp);
                if (Number.isFinite(timeDifference) && timeDifference !== 0) return timeDifference;
                return String(a.id || '').localeCompare(String(b.id || ''));
            });
        }


        function getConfiguredBreaks(ops) {
            return [['break1Start','break1End'], ['break2Start','break2End']]
                .map(([startKey, endKey]) => [timeToMinutes(ops[startKey]), timeToMinutes(ops[endKey])])
                .filter(([breakStart, breakEnd]) => breakStart >= 0 && breakEnd > breakStart)
                .sort((a, b) => a[0] - b[0]);
        }


        function moveServicePastBreak(start, duration, ops) {
            let adjustedStart = start;
            for (const [breakStart, breakEnd] of getConfiguredBreaks(ops)) {
                if (adjustedStart < breakEnd && adjustedStart + duration > breakStart) adjustedStart = breakEnd;
            }
            return adjustedStart;
        }


        function getServiceEnd(start, duration, ops, { inProgress = false } = {}) {
            if (!inProgress || BREAK_POLICY === 'finish_in_progress') return start + duration;
            let end = start + duration;
            for (const [breakStart, breakEnd] of getConfiguredBreaks(ops)) {
                if (start >= breakEnd || end <= breakStart) continue;
                end += breakEnd - Math.max(start, breakStart);
            }
            return end;
        }


        function intervalsOverlap(first, second) {
            return first.start < second.end && first.end > second.start;
        }


        function findNextSeatStart(schedule, desiredStart, duration, ops) {
            let candidate = moveServicePastBreak(desiredStart, duration, ops);
            const ordered = [...schedule].sort((a, b) => a.start - b.start);
            let changed = true;
            while (changed) {
                changed = false;
                for (const interval of ordered) {
                    const proposed = { start: candidate, end: candidate + duration };
                    if (!intervalsOverlap(proposed, interval)) continue;
                    candidate = moveServicePastBreak(interval.end, duration, ops);
                    changed = true;
                    break;
                }
            }
            return candidate;
        }


        function intervalOverlapsBreak(start, end, ops) {
            return [['break1Start','break1End'], ['break2Start','break2End']].some(([startKey, endKey]) => {
                const breakStart = timeToMinutes(ops[startKey]);
                const breakEnd = timeToMinutes(ops[endKey]);
                return breakStart >= 0 && breakEnd >= 0 && start < breakEnd && end > breakStart;
            });
        }


        function getQueueOccupancyIntervals(date, appointmentRecords = null, queueRecords = null, activeSeatMap = null) {
            if (date !== getLocalYMD()) return [];
            const activeSeats = activeSeatMap || getActiveSeats();
            const seatNumbers = Object.keys(activeSeats).filter(seat => activeSeats[seat]).map(Number);
            const nowMinutes = getMalaysiaCurrentMinutes();
            const ops = getOpHours(date);
            const queues = Array.isArray(queueRecords) ? queueRecords : getQueues();
            const seatSchedules = new Map(seatNumbers.map(seat => [seat, []]));
            const intervals = [];

            queues.filter(queue => queue.status === 'serving').forEach(queue => {
                const seatNumber = Number(queue.seat);
                let schedule = seatSchedules.get(seatNumber);
                if (!schedule) {
                    console.warn(`Kerusi ${seatNumber} ditutup semasa melayan ${queue.id}.`);
                    schedule = [];
                    seatSchedules.set(seatNumber, schedule);
                }
                const called = getMalaysiaDateTimeParts(queue.calledAt);
                const start = called ? called.hour * 60 + called.minute : nowMinutes;
                const end = Math.max(nowMinutes, getServiceEnd(start, Number(queue.duration) || AVG_WAIT_MINUTES, ops, { inProgress: true }));
                if (end > nowMinutes) {
                    const servingInterval = { start: nowMinutes, end, recordId: queue.id };
                    schedule.push(servingInterval);
                    intervals.push(servingInterval);
                }
            });

            const appointments = appointmentRecords || getAppointments().filter(appointment => appointment.date === date && appointment.status === 'upcoming');
            if (seatNumbers.length) [...appointments].sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time)).forEach(appointment => {
                const appointmentInterval = {
                    start: timeToMinutes(appointment.time),
                    end: timeToMinutes(appointment.time) + (Number(appointment.duration) || AVG_WAIT_MINUTES)
                };
                const availableSeat = seatNumbers.find(seat => !seatSchedules.get(seat).some(interval => intervalsOverlap(interval, appointmentInterval)));
                const selectedSeat = availableSeat !== undefined
                    ? availableSeat
                    : seatNumbers.reduce((leastLoaded, seat) => seatSchedules.get(seat).length < seatSchedules.get(leastLoaded).length ? seat : leastLoaded, seatNumbers[0]);
                seatSchedules.get(selectedSeat).push(appointmentInterval);
            });

            if (seatNumbers.length) sortWaitingQueue(queues.filter(queue => queue.status === 'waiting')).forEach(queue => {
                const duration = Number(queue.duration) || AVG_WAIT_MINUTES;
                const candidates = seatNumbers.map(seat => ({ seat, start: findNextSeatStart(seatSchedules.get(seat), nowMinutes, duration, ops) }));
                const selected = candidates.reduce((earliest, candidate) => candidate.start < earliest.start ? candidate : earliest, candidates[0]);
                const start = selected.start;
                const end = start + duration;
                const queueInterval = { start, end, recordId: queue.id };
                intervals.push(queueInterval);
                seatSchedules.get(selected.seat).push(queueInterval);
            });
            return intervals;
        }


        function estimateQueueWaitMinutes(queues, ticketId, activeSeats) {
            const seatNumbers = Object.keys(activeSeats).filter(seat => activeSeats[seat]).map(Number);
            if (!seatNumbers.length) return null;
            const nowMinutes = getMalaysiaCurrentMinutes();
            const today = getLocalYMD();
            const appointments = getAppointments().filter(appointment => appointment.date === today && appointment.status === 'upcoming');
            const interval = getQueueOccupancyIntervals(today, appointments, queues, activeSeats).find(item => item.recordId === ticketId);
            return interval ? Math.max(0, Math.ceil(interval.start - nowMinutes)) : null;
        }


        function buildWaitByRecordId(queues, activeSeats, appointments = null) {
            if (!Object.values(activeSeats).some(Boolean)) return new Map();
            const today = getLocalYMD();
            const todayAppointments = appointments
                ? appointments.filter(appointment => appointment.date === today && appointment.status === 'upcoming')
                : getAppointments().filter(appointment => appointment.date === today && appointment.status === 'upcoming');
            const nowMinutes = getMalaysiaCurrentMinutes();
            return new Map(getQueueOccupancyIntervals(today, todayAppointments, queues, activeSeats)
                .map(interval => [interval.recordId, Math.max(0, Math.ceil(interval.start - nowMinutes))]));
        }


        function getCustomersAheadCount(queues, ticketId) {
            const waiting = sortWaitingQueue(queues.filter(queue => queue.status === 'waiting'));
            const position = waiting.findIndex(queue => queue.id === ticketId);
            return position >= 0 ? position : 0;
        }


        function isAppointmentSlotAvailable(date, time, duration, excludeAppointmentId = '', availabilityContext = null) {
            if (!date || !time || !Number.isFinite(duration) || duration <= 0) return false;
            if (!isOnlineBookingDateAllowed(date)) return false;

            const activeSeats = availabilityContext?.activeSeats || getActiveSeats();
            const seats = Object.values(activeSeats).filter(Boolean).length;
            if (seats === 0) return false;
            const ops = getOpHours(date);
            if (ops.closed) return false;
            const start = timeToMinutes(time);
            const end = start + duration;
            if (start < timeToMinutes(ops.open) || end > timeToMinutes(ops.close) || intervalOverlapsBreak(start, end, ops)) return false;
            if (date === getLocalYMD()) {
                if (start <= getMalaysiaCurrentMinutes()) return false;
            }

            const existing = availabilityContext?.appointments || getAppointments().filter(a => a.date === date && a.status === 'upcoming' && a.id !== excludeAppointmentId);
            const queueIntervals = availabilityContext?.queueIntervals || getQueueOccupancyIntervals(date, existing, null, activeSeats);
            for (let minute = start; minute < end; minute += 1) {
                const appointmentConcurrency = existing.reduce((count, app) => {
                    const appStart = timeToMinutes(app.time);
                    const appEnd = appStart + (Number(app.duration) || AVG_WAIT_MINUTES);
                    return count + (minute >= appStart && minute < appEnd ? 1 : 0);
                }, 0);
                const queueConcurrency = queueIntervals.reduce((count, interval) => count + (minute >= interval.start && minute < interval.end ? 1 : 0), 0);
                const concurrent = appointmentConcurrency + queueConcurrency;
                if (concurrent >= seats) return false;
            }
            return true;
        }
module.exports={setState:s=>{STATE=s;},timeToMinutes,getMalaysiaDateTimeParts,timestampToMillis,getQueuePriority,sortWaitingQueue,getConfiguredBreaks,moveServicePastBreak,getServiceEnd,intervalsOverlap,findNextSeatStart,intervalOverlapsBreak,getQueueOccupancyIntervals,estimateQueueWaitMinutes,buildWaitByRecordId,getCustomersAheadCount,isAppointmentSlotAvailable};
