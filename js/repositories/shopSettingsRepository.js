/**
 * shopSettingsRepository — public.shop_settings (migration step 5b).
 *
 * A SINGLETON table: exactly one row, ever (see the migration file's
 * comment for how that's enforced). Unlike queues/seats/services, there is
 * no per-record identity here — `getShopSettings()` returns either the one
 * row (mapped) or `null` if the table is still empty (the very first load
 * against a brand-new database, before anyone has seeded it).
 *
 * Same non-negotiable as `serviceRepository.js`: index.html's ~90 existing
 * reads of `getAppName()`, `getWeeklyOpHours()`, `localStorage.getItem
 * ('shopStatus')` etc. are ALL synchronous, and many run inside `updateUI()`
 * — a hot path invoked constantly. Converting those to async would mean
 * threading Promises through dozens of call sites for no real benefit.
 * Instead: localStorage stays the thing every existing getter reads,
 * completely unchanged. This repository is only ever called from the
 * Supabase bridge module script (to hydrate localStorage from the server in
 * the background — see `seedOrRefreshShopSettings()` in index.html) and
 * from the classic script's admin save handlers (which write through here
 * FIRST, then mirror the same values into localStorage once the server
 * confirms — same no-fallback rule as services/seats).
 *
 * The JS object shape here uses the EXACT SAME key names as the
 * localStorage keys (`appName`, `shopMapLink`, `weeklyOpHours`, ...) on
 * purpose: hydrating localStorage from a `getShopSettings()` result is then
 * just `Object.entries(settings).forEach(([k, v]) => safeSetItem(k, v))` —
 * no key-translation table needed at the call site.
 */
import { supabase } from '../supabaseClient.js';

const COLUMNS =
    'app_name, shop_name, shop_map_link, shop_map_query, shop_map_address, shop_location_name, ' +
    'shop_announcement, shop_announcement_html, shop_announcement_enabled, ' +
    'shop_status, shop_status_changed_at, max_queue, seat_count, closed_dates, ' +
    'booking_advance_days, weekly_op_hours';

// camelCase (matches both the localStorage key and this module's public
// object shape) -> snake_case column name.
const FIELD_TO_COLUMN = {
    appName: 'app_name',
    shopName: 'shop_name',
    shopMapLink: 'shop_map_link',
    shopMapQuery: 'shop_map_query',
    shopMapAddress: 'shop_map_address',
    shopLocationName: 'shop_location_name',
    shopAnnouncement: 'shop_announcement',
    shopAnnouncementHtml: 'shop_announcement_html',
    shopAnnouncementEnabled: 'shop_announcement_enabled',
    shopStatus: 'shop_status',
    shopStatusChangedAtUtc: 'shop_status_changed_at',
    maxQueue: 'max_queue',
    seatCount: 'seat_count',
    closedDates: 'closed_dates',
    bookingAdvanceDays: 'booking_advance_days',
    weeklyOpHours: 'weekly_op_hours'
};

function raiseOnError(error) {
    if (error) throw new Error(`[shopSettingsRepository] ${error.message ?? error}`, { cause: error });
}

function mapRow(row) {
    if (!row) return null;
    return {
        appName: row.app_name,
        shopName: row.shop_name,
        shopMapLink: row.shop_map_link,
        shopMapQuery: row.shop_map_query,
        shopMapAddress: row.shop_map_address,
        shopLocationName: row.shop_location_name,
        shopAnnouncement: row.shop_announcement,
        shopAnnouncementHtml: row.shop_announcement_html,
        shopAnnouncementEnabled: row.shop_announcement_enabled,
        shopStatus: row.shop_status,
        shopStatusChangedAtUtc: row.shop_status_changed_at,
        maxQueue: row.max_queue,
        seatCount: row.seat_count,
        closedDates: row.closed_dates,
        bookingAdvanceDays: row.booking_advance_days,
        weeklyOpHours: row.weekly_op_hours
    };
}

/** Translates a partial settings object (camelCase keys) to a partial row (snake_case columns). Throws on an unknown key rather than silently dropping a typo. */
function toColumns(fields) {
    const out = {};
    for (const [key, value] of Object.entries(fields)) {
        const column = FIELD_TO_COLUMN[key];
        if (!column) throw new Error(`[shopSettingsRepository] unknown settings field "${key}"`);
        out[column] = value;
    }
    return out;
}

/**
 * The one row, or `null` if nothing has seeded it yet. Readable by anon —
 * every field here is shown to customers somewhere.
 */
export async function getShopSettings() {
    const { data, error } = await supabase.from('shop_settings').select(COLUMNS).maybeSingle();
    raiseOnError(error);
    return mapRow(data);
}

/**
 * One-time seed: creates the singleton row from this device's real current
 * settings. Admin-only (RLS "admins seed shop settings"). Throws (unique
 * violation on `id`) if a row already exists — callers should only invoke
 * this after `getShopSettings()` returned `null`, and should still expect
 * this to occasionally lose a race to another tab/device doing the same
 * thing at the same moment (see the services seed precedent in HANDOFF.md).
 *
 * @param {object} settings a full settings object, same shape as getShopSettings()'s return
 */
export async function createShopSettings(settings) {
    const { data, error } = await supabase.from('shop_settings').insert(toColumns(settings)).select(COLUMNS).single();
    raiseOnError(error);
    return mapRow(data);
}

/**
 * Partial update — only pass the fields that changed. Admin-only (RLS
 * "admins update shop settings"). `.eq('id', true)` is redundant with the
 * table only ever holding one row, but makes the intent explicit rather
 * than relying on an unfiltered UPDATE being safe by construction.
 */
export async function updateShopSettings(patch) {
    const { data, error } = await supabase.from('shop_settings').update(toColumns(patch)).eq('id', true).select(COLUMNS).single();
    raiseOnError(error);
    return mapRow(data);
}
