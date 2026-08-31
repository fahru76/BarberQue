/**
 * Shop-local time helpers.
 *
 * Every function here is pure: none of them read the wall clock. Callers pass an
 * explicit timestamp, which is what lets the scheduler be tested deterministically
 * and lets the same code run on the server later.
 */

export const SHOP_TIME_ZONE = 'Asia/Kuala_Lumpur';

const PARTS_FORMATTER = new Intl.DateTimeFormat('en-GB', {
    timeZone: SHOP_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
});

/** Milliseconds from an ISO string, epoch number, or Date. NaN when unparseable. */
export function timestampToMillis(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return Date.parse(value);
    return Number.NaN;
}

/** Shop-local calendar/clock parts, or null when the input cannot be parsed. */
export function shopDateTimeParts(value) {
    const millis = timestampToMillis(value);
    if (!Number.isFinite(millis)) return null;
    const parts = PARTS_FORMATTER.formatToParts(new Date(millis));
    return Object.fromEntries(
        parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)])
    );
}

/** Shop-local YYYY-MM-DD, or '' when the input cannot be parsed. */
export function shopDateString(value) {
    const parts = shopDateTimeParts(value);
    if (!parts) return '';
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** Minutes since shop-local midnight, or null when the input cannot be parsed. */
export function shopMinutesOfDay(value) {
    const parts = shopDateTimeParts(value);
    return parts ? parts.hour * 60 + parts.minute : null;
}

/** "HH:MM" to minutes since midnight. -1 for empty, NaN for malformed. */
export function timeToMinutes(timeString) {
    if (!timeString) return -1;
    const parts = String(timeString).split(':');
    const hours = Number.parseInt(parts[0], 10);
    const minutes = Number.parseInt(parts[1], 10);
    return (hours * 60) + minutes;
}

/** Minutes since midnight to "HH:MM". */
export function minutesToTime(minutes) {
    const total = Math.max(0, Math.round(minutes));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Day index 0..6 (Sunday..Saturday) for a YYYY-MM-DD string, or null. */
export function dayIndexFromDate(dateString) {
    if (Number.isInteger(dateString) && dateString >= 0 && dateString <= 6) return dateString;
    const match = String(dateString || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
}
