/**
 * serviceRepository — public.services (migration step 5a).
 *
 * Unlike queues/seats, this repository is NOT the thing index.html reads
 * directly for rendering. `getServices()`/`saveServices()` in index.html
 * still read/write the `shopServices` localStorage key exactly as before —
 * every business rule (enforceServiceRules, drag-reorder math, the two
 * customer-facing pickers) is untouched. What changed is that the admin
 * mutation functions (addService, saveServiceEdit, toggleServiceStatus,
 * deleteService, persistServicePriority) now also write through here, and a
 * new refreshServicesFromServer() in index.html treats the server as
 * authoritative on load — pulling it into `shopServices` — which is what
 * actually closes the cross-device gap (a second browser/device previously
 * had no way to see services an admin added elsewhere).
 *
 * `price` in index.html is a plain RM number; `price_sen` here is an
 * integer, same reasoning and same conversion-lives-in-one-module pattern as
 * queueRepository.js's takeTicket().
 */
import { supabase } from '../supabaseClient.js';

const SERVICE_COLUMNS = 'id, name, price_sen, duration_minutes, active, category, target, type, sort_order';

function raiseOnError(error) {
    if (error) throw new Error(`[serviceRepository] ${error.message ?? error}`, { cause: error });
}

function mapServiceRow(row) {
    if (!row) return row;
    return {
        id: row.id,
        name: row.name,
        price: row.price_sen / 100,
        duration: row.duration_minutes,
        active: row.active,
        category: row.category,
        target: row.target,
        type: row.type,
        sortOrder: row.sort_order
    };
}

/**
 * Every service — active and inactive alike. RLS gates what anon actually
 * gets back (active only); this repository is only ever called from
 * admin-gated code in index.html, which needs to see everything, so it
 * never filters client-side on `active`.
 */
export async function listServices() {
    const { data, error } = await supabase
        .from('services')
        .select(SERVICE_COLUMNS)
        .order('category', { ascending: true })
        .order('sort_order', { ascending: true });
    raiseOnError(error);
    return data.map(mapServiceRow);
}

/**
 * Create a service, reusing the SAME id index.html already minted locally
 * (createServiceId(), `SVC-<uuid>`) rather than letting the server generate
 * one — nothing else needs a second identity for the same record.
 */
export async function createService({ id, name, priceRm, durationMinutes, category, target, type }) {
    const { data, error } = await supabase
        .from('services')
        .insert({
            id, name,
            price_sen: Math.round(priceRm * 100),
            duration_minutes: durationMinutes,
            category, target, type
        })
        .select(SERVICE_COLUMNS)
        .single();
    raiseOnError(error);
    return mapServiceRow(data);
}

/** Partial update — only the local shape's fields that changed need to be passed. */
export async function updateService(id, patch = {}) {
    const dbPatch = {};
    if (patch.name !== undefined) dbPatch.name = patch.name;
    if (patch.priceRm !== undefined) dbPatch.price_sen = Math.round(patch.priceRm * 100);
    if (patch.durationMinutes !== undefined) dbPatch.duration_minutes = patch.durationMinutes;
    if (patch.active !== undefined) dbPatch.active = patch.active;
    if (patch.category !== undefined) dbPatch.category = patch.category;
    if (patch.target !== undefined) dbPatch.target = patch.target;
    if (patch.type !== undefined) dbPatch.type = patch.type;

    const { data, error } = await supabase
        .from('services')
        .update(dbPatch)
        .eq('id', id)
        .select(SERVICE_COLUMNS)
        .single();
    raiseOnError(error);
    return mapServiceRow(data);
}

/** Hard delete — mirrors index.html's existing deleteService() (no soft-delete/archival exists locally either). */
export async function deleteService(id) {
    const { error } = await supabase.from('services').delete().eq('id', id);
    raiseOnError(error);
}

/**
 * Bulk-persist a new display order within one category. Every id here always
 * already exists — this is never used to create a row — so this issues a
 * plain UPDATE per row, not an upsert.
 *
 * This was originally a single `upsert(..., {onConflict:'id'})` call, which
 * looked right ("only touches sort_order, can't blank out other columns")
 * but is wrong on Postgres: `INSERT ... ON CONFLICT (id) DO UPDATE` builds
 * the candidate row — and validates its NOT NULL constraints (`name`,
 * `price_sen`, `duration_minutes`, `category`, none of which have defaults)
 * — BEFORE it discovers the id already exists and falls back to the UPDATE
 * branch. So it failed with "null value in column name violates not-null
 * constraint" on every single call, not just a first-seed race — caught
 * live during step-5a verification (adding a second service, then watching
 * its post-create reorder call fail the exact same way). A plain UPDATE
 * never constructs a full candidate row, so it can't trip this.
 *
 * @param {{id: string, sortOrder: number}[]} entries
 */
export async function reorderServices(entries) {
    if (!entries.length) return;
    const results = await Promise.all(
        entries.map(({ id, sortOrder }) =>
            supabase.from('services').update({ sort_order: sortOrder }).eq('id', id)
        )
    );
    const failed = results.find(({ error }) => error);
    if (failed) raiseOnError(failed.error);
}
