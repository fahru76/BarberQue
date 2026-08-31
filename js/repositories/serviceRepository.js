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
 * Bulk-persist a new display order within one category. Each entry only
 * touches `sort_order` — Supabase's upsert only overwrites the columns
 * present in each row, so this can never accidentally blank out a service's
 * name/price/etc. for rows that already exist (every id here always already
 * exists; this is never used to create a row).
 *
 * @param {{id: string, sortOrder: number}[]} entries
 */
export async function reorderServices(entries) {
    if (!entries.length) return;
    const { error } = await supabase
        .from('services')
        .upsert(entries.map(({ id, sortOrder }) => ({ id, sort_order: sortOrder })), { onConflict: 'id' });
    raiseOnError(error);
}
