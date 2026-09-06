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

const SERVICE_COLUMNS = 'id, name, price_sen, duration_minutes, active, category, target, type, sort_order, style_notes, image_url_front, image_url_back';

// Item 3 (QUEUECUT_HANDOVER.md) -- public-read/admin-write bucket created by
// 20260906130100_service_photos.sql. Kept as a constant here rather than
// repeated per call so the bucket name lives in exactly one place.
const PHOTO_BUCKET = 'service-photos';

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
        sortOrder: row.sort_order,
        // Short optional "penceritaan gaya" shown next to the name on the
        // customer pickers (see 20260906123700_service_style_notes.sql) --
        // normalised to '' rather than null so index.html's render/populate
        // sites never need a null-check on top of the usual falsy check.
        styleNotes: row.style_notes || '',
        // Front/back style photos (Item 3) -- public Supabase Storage URLs,
        // or '' when no photo has been uploaded for that slot yet. index.html
        // must degrade gracefully on '' (no broken image icon) per the
        // handover doc's fallback requirement.
        imageUrlFront: row.image_url_front || '',
        imageUrlBack: row.image_url_back || ''
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
export async function createService({ id, name, priceRm, durationMinutes, category, target, type, styleNotes, imageUrlFront, imageUrlBack }) {
    const { data, error } = await supabase
        .from('services')
        .insert({
            id, name,
            price_sen: Math.round(priceRm * 100),
            duration_minutes: durationMinutes,
            category, target, type,
            style_notes: styleNotes || null,
            image_url_front: imageUrlFront || null,
            image_url_back: imageUrlBack || null
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
    if (patch.styleNotes !== undefined) dbPatch.style_notes = patch.styleNotes || null;
    if (patch.imageUrlFront !== undefined) dbPatch.image_url_front = patch.imageUrlFront || null;
    if (patch.imageUrlBack !== undefined) dbPatch.image_url_back = patch.imageUrlBack || null;

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
 * Item 3 (style photo preview) -- resize+re-encode happens in index.html
 * (canvas, same technique as the existing announcement-image uploader);
 * this just uploads the resulting JPEG Blob to Supabase Storage and hands
 * back a public URL for the caller to save onto the service row.
 *
 * Uploaded to a FIXED path per service+slot (`${id}/${slot}.jpg`, upsert:
 * true) rather than a fresh filename every time, so re-uploading a photo
 * replaces the old object instead of leaving it orphaned in Storage
 * forever. Supabase's public URL for a given path never changes, so a
 * same-path overwrite would otherwise keep showing the OLD image to
 * anyone whose browser/CDN already cached that URL -- the `?v=` query
 * param busts that without needing a new path.
 *
 * `slot` must be 'front' or 'back' -- index.html only ever passes those
 * two, matching the services.image_url_front/image_url_back columns.
 */
export async function uploadServicePhoto(id, slot, blob) {
    const path = `${id}/${slot}.jpg`;
    const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, blob, {
        contentType: 'image/jpeg',
        upsert: true
    });
    if (error) throw new Error(`[serviceRepository] ${error.message ?? error}`, { cause: error });
    const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);
    return `${data.publicUrl}?v=${Date.now()}`;
}

/**
 * Removes the stored object for one slot. Safe to call even if nothing was
 * ever uploaded there (Supabase's remove() does not error on a missing
 * path) -- callers still separately clear the service row's URL column via
 * updateService(), since deleting the Storage object alone would leave a
 * dangling URL pointing at nothing.
 */
export async function deleteServicePhoto(id, slot) {
    const { error } = await supabase.storage.from(PHOTO_BUCKET).remove([`${id}/${slot}.jpg`]);
    if (error) throw new Error(`[serviceRepository] ${error.message ?? error}`, { cause: error });
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
