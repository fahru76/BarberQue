# QueueCut — Feature Handover: Smart Barber Assignment & Style Catalogue

**Repo:** https://github.com/fahru76/BarberQue (branch `main`)
**Live:** https://fahru76.github.io/BarberQue/
**Status of this document:** Planning/spec only. **Nothing described below has been implemented or committed.** All items are scoped and approved for direction by the project owner (Fahru), but blocked on the inputs noted per item. Do not write code for a blocked item until its blocker is resolved — check with Fahru first if unsure.

---

## 0. Project context (read before touching anything)

- Single-file `index.html` frontend, deployed via GitHub Pages, backed by Supabase (Postgres + Auth + Realtime + RLS). **This is NOT a localStorage-only prototype** — Supabase migration is already substantially complete (staff auth, seat assignment, queue, appointments, services, shop settings are all live-DB-backed via `js/repositories/*.js`). Verify current state against the actual repo before assuming anything; do not rely on stale summaries.
- Full migration history and design rationale lives in `HANDOFF.md` at repo root — **read this in full before making schema or RPC changes**. It documents several past bugs (non-atomic writes, name-collision in reporting, anon column-grant traps) that inform why things are built the way they are.
- Tests: `tests/sql-consistency.mjs` (static structural checks on SQL functions), `tests/differential.test.mjs`, `tests/domain/scheduler.test.mjs` (client-side ordering logic), `tests/live-smoke.mjs` (live assertions against a real Supabase instance, including one against `call_next_customer`). Any change to `call_next_customer()` must keep `sql-consistency.mjs` passing (it checks `search_path` pinning on security-definer functions) and should be exercised against `live-smoke.mjs`-style live testing, not just read for correctness — this function is row-locked and concurrency-sensitive.
- House rules (from project instructions): inspect before assuming, plan before implementing, smallest clean diff, preserve backward compatibility, no destructive schema changes, ask before proceeding if a decision is genuinely ambiguous rather than guessing.

---

## 1. Smart barber assignment (capability + specialty)

**Status:** Approach approved. **Blocked on:** Fahru's finalized style list (Section 2) — specialty/capability checkboxes reference specific `service.id` values, so the service rows must exist first.

### Decision already made (do not re-litigate without asking)
Two independent, separately-stored concepts:

| Concept | Question it answers | Enforcement | Default when unset |
|---|---|---|---|
| **Capability** | "Is this barber allowed to perform this service at all?" | **Hard gate** — never called for it, no fallback | `null`/empty = capable of everything (non-breaking default for existing barbers) |
| **Specialty** | "Given they're capable, should they get this customer first?" | **Soft priority** — tried first, falls back to the rest of their capable set | `null`/empty = no preference among what they're capable of |

This was chosen deliberately over a hard-filter-only or advisory-badge-only design — see conversation rationale if it needs re-explaining to Fahru, but do not silently change the model.

### Selection order for `call_next_customer(p_seat_no)`, per the seat's assigned barber
1. Waiting + service in barber's **specialty** set → order by (fast-pass, then booking, then FIFO created_at)
2. Else, waiting + service in barber's **capability** set (or capability is null = unrestricted) → same ordering
3. Else → raise a distinct exception (not the current generic "nobody waiting" message — barbers need to know *why*, e.g. "no customer waiting for a service you're set up to do")

### Database changes
- New migration file (follow existing naming convention `supabase/migrations/{timestamp}_{description}.sql`, next after `20260903000100_overnight_schedule.sql`):
  - `alter table public.staff add column capability_service_ids text[];`
  - `alter table public.staff add column specialty_service_ids text[];`
  - `alter table public.queues add column service_ids text[];` — **snapshot** of selected service IDs at ticket-creation time, same pattern as existing `price_sen`/`duration_minutes` snapshotting (do not live-derive from `services` at read time — services can change/be deleted after a ticket is taken)
  - Rewrite `call_next_customer(p_seat_no integer)` per the 3-tier logic above. Preserve all existing behavior: `FOR UPDATE SKIP LOCKED`, `is_active_staff()` check, seat-open check, seat-already-serving check, `security definer set search_path = public`. This is an editing task on an existing function, not a new one — diff carefully against the current body in `supabase/migrations/20260901000200_ticket_and_rpc.sql`.
  - Grants: no change needed — same `revoke all ... grant execute ... to authenticated` pattern already in place.

### Repository changes (all additive — do not break existing signatures)
- `js/repositories/authRepository.js`: new setter for `capability_service_ids`/`specialty_service_ids` (either extend `setStaffStatus()` or add a dedicated `setStaffSpecialties(id, { capabilityServiceIds, specialtyServiceIds })`; match the module's existing conventions and comments style).
- `js/repositories/queueRepository.js`: `takeTicket()` gains an optional `serviceIds` param, passed through to the insert.
- `js/repositories/appointmentRepository.js`: `bookAppointment()`, `convertWalkinToAppointment()`, `checkinAppointment()` need `serviceIds` carried through wherever a queue row is ultimately produced from a booking — trace the full path, since bookings and walk-ins converge into `public.queues`.

### `index.html` changes
- Both ticket-submission call sites currently join selected service **names** into a comma string (`services = Array.from(cb).map(c => c.value).join(', ')` — walk-in around line ~6014, booking around line ~6099 in current `main` branch, verify line numbers against latest before editing). Each checkbox already carries `data-service-id` — add a parallel `Array.from(cb).map(c => c.dataset.serviceId)` and pass as `serviceIds` alongside the existing `service` string. Do not remove or change the existing name-string field; anything downstream (sales report, audit log) still reads it.
- New admin UI block inside the staff card rendered by `refreshStaffList()`: a checklist of all active services, each row toggleable to one of unchecked / capable / capable+specialty (e.g. a checkbox plus a star toggle next to it, avoiding two separate lists). Save via the new repository setter above; re-render via the existing `renderBarberAssignments(true)` / `refreshStaffList()` refresh pattern already used elsewhere in this file.
- Optional, low-priority: a "★ specialist match" badge on the barber-app's waiting list, cosmetic only, no functional effect — do only if time remains after the above.

### Testing expectations
- Keep `tests/sql-consistency.mjs` passing (structural checks on the SQL function).
- No existing automated test exercises the 3-tier fallback logic live — write a manual verification pass (or a new `live-smoke.mjs`-style case) covering at minimum: (a) specialty match found → gets called first over an earlier-FIFO non-match; (b) no specialty match but capability match exists → falls back correctly; (c) no capability match at all → distinct error raised, customer stays waiting; (d) a barber with null/empty arrays behaves exactly as today (regression check — this is the most important case, since it's the default state for every existing barber).
- Concurrency: verify two barbers calling "next" simultaneously still never double-call the same customer (this is what `SKIP LOCKED` already guarantees — confirm the rewrite hasn't broken it).

---

## 2. Style catalogue finalization ("Gaya Potongan" list)

**Status:** Candidate list proposed, **not yet finalized by Fahru** — pricing and duration are placeholders and must not be used as real values. **Blocked on:** Fahru confirming final style names + real pricing/duration.

### No code changes required for this item
Add/Edit/Delete for services already exists in the admin panel (`addService()`, `editServiceClick()`/`saveServiceEdit()`, `deleteService()`, drag-to-reorder). This is pure data entry through the existing admin "TAMBAH SERVIS BARU" form — **do not write migration or code for this item.**

### Candidate list (names only are research-informed; pricing/duration are illustrative placeholders Fahru must replace)

| Nama Servis | Profil Logik | Harga (RM) — PLACEHOLDER | Masa (Minit) — PLACEHOLDER |
|---|---|---|---|
| Skin Fade | Gaya Potongan | 30 | 40 |
| Low Fade | Gaya Potongan | 25 | 35 |
| Mid Taper Fade | Gaya Potongan | 25 | 35 |
| Burst Fade | Gaya Potongan | 32 | 45 |
| Textured Crop | Gaya Potongan | 28 | 40 |
| French Crop | Gaya Potongan | 28 | 40 |
| Two-Block (Korean) | Gaya Potongan | 30 | 45 |
| 70/30 Side Part | Gaya Potongan | 25 | 30 |
| Crew Cut | Gaya Potongan | 20 | 25 |
| Modern Mullet | Gaya Potongan | 35 | 50 |
| Curtain Fringe | Gaya Potongan | 28 | 40 |
| Warrior Cut | Gaya Potongan | 32 | 45 |
| Caesar Cut | Gaya Potongan | 22 | 30 |

Selecting "Gaya Potongan" as Profil Logik in the existing admin form auto-fills `target: semua`, `category: fashion`, `type: gunting` (see `SERVICE_PROFILES.style` in `index.html`) — only Nama Servis, Harga, and Masa need to be typed per row.

**Do not treat the name list as an authoritative "Malaysian preference" dataset** — it was compiled from general web sources (KL/Selangor barbershop social content, international trend guides adapted for Asian hair), not a verified survey. Difficulty/skill-level judgments used to build this list were the AI's own inference for the purpose of capability-assignment planning, not a styling authority's rating. Cross-check against Fahru's actual booking history for his Kerteh shop before finalizing.

---

## 3. Style photo preview (front + back + notes) — approved, ready to build independently

**Status:** Fully scoped and locked in by Fahru. **Not blocked on anything** — can be built independently of items 1 and 2, in any order.

### Architecture decision (already made — do not revert to the announcement-editor pattern)
The existing announcement image feature stores images as inline base64 data URLs embedded directly in the announcement's HTML text column. **Do not reuse that pattern here.** The services list is fetched on every customer page load (walk-in form, booking form, style picker) — embedding base64 images in `services` rows would drag full image payloads through every fetch, for every visitor, every time. Use actual **Supabase Storage** instead: a bucket with public read / admin write, storing only a URL string on the `services` row.

### Database / infrastructure changes
- New Supabase Storage bucket, e.g. `service-photos`. Public read policy; admin-only write policy (match existing RLS conventions — see `is_admin()` usage elsewhere in the migrations for the pattern).
- `services` table additions (all nullable, purely additive, no migration risk to existing rows):
  - `image_url_front text`
  - `image_url_back text`
  - `style_notes text`

### Repository changes
- `js/repositories/serviceRepository.js`: `createService()` / `updateService()` gain optional `imageUrlFront`, `imageUrlBack`, `styleNotes` params — additive only.

### `index.html` changes
- **Admin upload UI**: two upload slots (front/back) plus one notes textarea, added to the existing "Kemas Kini Servis" and "Tambah Servis Baru" forms. Adapt the resize-then-upload logic from the existing `uploadAnnouncementImage()` (file type/size validation, canvas-based downscaling before upload) but point the upload at Supabase Storage instead of inlining as a data URL — do not copy the base64-inlining part of that function.
- **Customer-facing UI**: a thumbnail (front photo) next to each style-cut checkbox inside `renderCustomerServiceOptions()`; tap opens a lightbox/modal with a front/back toggle and the style notes text.
- **Fallback state**: styles with no photo yet (expected during rollout, since Fahru will add photos gradually across 13 styles) must degrade gracefully — no broken image icon, show a neutral placeholder or hide the thumbnail slot entirely.

### Testing expectations
- Upload rejects invalid file types / oversized files (same validation bar as the existing announcement image uploader).
- Photo displays correctly on customer-facing walk-in and booking forms.
- Missing-photo fallback renders cleanly, does not break layout on mobile.
- Confirm Storage bucket RLS actually blocks anon/non-admin writes (test with an anon or barber-role session attempting upload — should fail).

---

## 4. Parked — not scoped, do not build

**AR / camera-based face try-on for hairstyles.** Explicitly deferred by Fahru as a separate future initiative. Do not attempt to fold this into any of the above work. If revisited later, it needs its own scoping pass covering (at minimum): in-browser face-tracking approach (no server-side compute available — static GitHub Pages + Supabase, not a compute backend), realistic build-vs-buy decision on a vendor AR/virtual-try-on SDK vs. in-house computer vision, per-style rigged hair-overlay assets, and a Malaysia PDPA-compliant consent/privacy design for camera access — before any code is written.

---

## 5. Parked — theme override for every visitor, regardless of their own browser settings (native app / PWA)

**Status:** Not scoped, raised only as a possible follow-up to the "Cerah tak berfungsi" light-theme investigation — do not begin scoping or building without Fahru's explicit go-ahead. **Blocked on:** a product decision from Fahru on whether this is even worth pursuing, given the cost shape below.

### Why this is here
The light-theme bug (full history in `HANDOFF.md`'s "Round 3 — resolved by browser configuration, not by code" section, and `CODEX_HANDOFF_LIGHT_THEME.md`) was closed as a documented limitation, not a code defect. `index.html`'s theme selector is implemented correctly and verified live: `color-scheme: only light` / `only dark` is set on both the page and its meta tag, and this does stop the browser's generic Auto Dark Theme adjustment. But on Samsung Internet, a **separate, browser-level "Dark mode" toggle** (Settings → Webpage view and scrolling → Dark mode — distinct from "Force Dark mode for web content") can still override QueueCut's own chosen theme for that one visitor, regardless of any page-level CSS/meta declaration. This is ordinary browser behaviour, not a bug: a page delivered into a normal browser tab does not get the final say over that browser's own display preference.

### The bigger requirement, if Fahru decides to pursue it
Guaranteeing QueueCut's own theme choice always wins, for every visitor, regardless of what they've set in their own browser, means running the app inside a shell QueueCut itself controls the rendering of — not an ordinary browser tab. Two directions exist, neither evaluated yet:

| Approach | What it buys | Rough cost/effort shape |
|---|---|---|
| Installed PWA (Add to Home Screen) with a web app manifest | Runs in its own standalone window instead of a browser tab — still Chromium/WebView underneath, so it's genuinely unknown whether Samsung Internet's own dark-mode override still reaches a standalone PWA window on this exact device; **this is the first thing to actually test, before assuming either way** | Small — mainly a `manifest.json` + icon set, no framework change, no new deployment pipeline |
| Native wrapper app (e.g. an Android WebView shell, or a cross-platform wrapper) with the WebView's own dark-mode handling explicitly disabled by the wrapping app | Full control, independent of whatever the visitor has set in their separate Samsung Internet app | Meaningfully larger — a real native/hybrid app to build, sign, and distribute (Play Store listing or sideloaded APK), plus ongoing maintenance separate from the current GitHub Pages deployment |

This table is a starting shape for a conversation with Fahru, not a recommendation — nothing here has been tested or costed out yet.

### Do not build without a scoping pass covering, at minimum
- Whether an installed PWA alone already solves it — test on the actual Galaxy Z Fold7 first, since it's by far the cheapest thing to try before considering a native wrapper at all.
- A real build-vs-buy / effort estimate for a native wrapper, only if the PWA route doesn't hold.
- Distribution model (Play Store vs. sideloaded APK vs. staying purely web) and what that costs in update speed: today, a push to `main` reaches every visitor via GitHub Pages within roughly 1–2 minutes; a native wrapper's own shell would not get that same immediacy for anything living inside it.
- Whether this is actually worth building for the scale of the real problem (one user, one specific browser + one specific setting combination they can change themselves in seconds) versus simply pointing affected users at `Samsung Internet → Settings → Webpage view and scrolling → Dark mode → Off`, which fully resolves it today at zero engineering cost.

---

## Suggested execution order

1. **Item 3 (style photos)** can start immediately — no external blocker.
2. **Item 2 (style list finalization)** needs a quick round-trip with Fahru to confirm names + real pricing/duration — do this before item 1, since item 1's admin checkboxes reference these service rows.
3. **Item 1 (smart assignment)** last, once item 2's service rows exist. Treat the `call_next_customer()` rewrite as the highest-risk single change in this whole handover — it touches a row-locked, concurrency-sensitive function that is the operational core of the queue. Do not merge without live testing against a real Supabase instance with 2+ seats and mixed capability/specialty configurations.

Items 4 and 5 are parked and intentionally excluded from this order — neither is scoped, and neither should be started without Fahru first deciding it's worth scoping at all.

Confirm scope with Fahru before starting any item if anything above is ambiguous — do not guess on his behalf, per his own stated preference throughout this planning conversation.
