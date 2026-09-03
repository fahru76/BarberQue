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

/**
 * Overnight-schedule support (e.g. open 18:00, close 01:00).
 *
 * The scheduler's whole minute-axis is 0..1439 ("minutes since this business
 * day's midnight"), which silently assumed `close` always came after `open`.
 * Rather than introduce a second axis, a day whose hours cross midnight is
 * modelled as simply running PAST 1439: its `close` (and any break that's
 * also past midnight) is understood as `close + 1440`, and any candidate
 * clock-time that's earlier than `open` is understood as the post-midnight
 * TAIL of the same business day, not the following one — there is no other
 * valid meaning for "in this business day's schedule, at a time before it
 * opened". A same-day config (`close > open`) is completely unaffected:
 * `crossesMidnight` is false, so `businessMinutes` is a no-op everywhere.
 */

/** True when a day's own close time is at/before its open time -- e.g. 18:00-01:00. */
export function crossesMidnight(ops) {
    const open = timeToMinutes(ops?.open);
    const close = timeToMinutes(ops?.close);
    return open >= 0 && close >= 0 && close <= open;
}

/**
 * Extends a raw clock-time-in-minutes (0..1439) onto the business day's own
 * continuous axis. Only ever adds a calendar day, and only when `ops` crosses
 * midnight and `minutes` is earlier than that day's `open` -- every other
 * value (a same-day config, or a time at/after opening) passes through
 * unchanged. Negative/non-finite input (the `-1`/`NaN` sentinels used
 * elsewhere for "not configured") also passes through unchanged.
 */
export function businessMinutes(minutes, ops) {
    if (!Number.isFinite(minutes) || minutes < 0) return minutes;
    return crossesMidnight(ops) && minutes < timeToMinutes(ops?.open) ? minutes + 1440 : minutes;
}
