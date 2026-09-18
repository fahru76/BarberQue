# QueueCut — Product Requirements Document

**Document status:** Drafted from the repository and shipped behavior on 2026-09-18. This is a product/engineering contract, not stakeholder approval and not a new roadmap commitment.

**Product:** QueueCut / BarberQue  
**Live frontend:** `https://fahru76.github.io/BarberQue/`  
**Backend:** Supabase project `cojaebzxrtyvxrnadiuv`  
**Current commit observed:** `05eef11` (`fix(semantics): close six cross-layer bug-hunt findings`)  
**Primary owner / decision maker:** Fahru  
**Deployment model:** raw static frontend on GitHub Pages; Supabase Postgres/Auth/Realtime/RLS backend; no frontend build step.

---

## 1. Executive summary

QueueCut is a single-shop queue and appointment operating system for Syam Barber Shop in Kerteh, Terengganu. It serves four distinct surfaces:

1. **Customer:** join the walk-in queue or book an appointment, then track status and estimated wait.
2. **Display:** read-only TV view showing who is being served and which seat is involved.
3. **Barber:** call the next compatible customer for an assigned seat and complete service.
4. **Admin:** configure shop operations, staff, seats, services, announcements, closures, fast-pass actions, reports, and menu order.

The product modernization objective is:

> Deliver a modern, responsive, accessible interface that improves customer and staff experience while preserving existing business behavior, database contracts, security boundaries, and operational semantics.

The product must not trade correctness for visual polish. Server state is authoritative for cross-device business operations. Local browser state is a cache and a rendering mechanism, not a second independent queue database.

---

## 2. Product problem

A barbershop needs to manage two overlapping schedules and several user contexts without forcing customers or staff to understand the underlying database:

- walk-in demand arrives asynchronously and must be sequenced fairly;
- appointments consume future capacity;
- seats can open, close, or be assigned to specific barbers;
- service duration and price must come from the service catalogue and be validated server-side;
- overnight operating hours cross the civil-day boundary;
- customers may be anonymous and need claim-token ownership rather than accounts;
- staff actions must be role- and seat-authorized;
- multiple devices must converge on the same queue state;
- the display must remain readable and stable in a shop environment;
- administrators need confidence that changes were actually saved.

The former localStorage-first design was fast for a prototype but created classes of risk at the client/server boundary: local-only tickets, optimistic cancellations that could diverge from the server, stale cross-device state, and client/server disagreement on overnight appointment capacity. The product requirements therefore treat state ownership and semantic invariants as first-class requirements.

---

## 3. Users and jobs to be done

### 3.1 Customer

**Context:** phone, one hand, intermittent connectivity, possibly standing or in poor light.  
**Job:** join the queue or book a slot, then understand whether action succeeded and what happens next.  
**Primary success:** one confirmed server-backed ticket or appointment; no fake success state.  
**Secondary success:** status, queue position, wait estimate, seat direction, cancellation, and rescheduling are understandable.

### 3.2 Barber

**Context:** tablet at the chair, hands occupied, fast repeated operations.  
**Job:** see the next eligible customer for the assigned seat, call them, and mark service done.  
**Primary success:** one deliberate tap produces one authorized server transition.  
**Safety:** a barber cannot call a seat they are not assigned to; capability rules must not route work they cannot perform.

### 3.3 Admin / owner

**Context:** desktop or phone, task-driven, responsible for operations and data.  
**Job:** configure the shop, staff, seats, services, operating hours, closures, announcements, fast-pass decisions, and reports.  
**Primary success:** a change has a visible dirty/saved state and is server-confirmed where the setting is server-authoritative.

### 3.4 Display / shop TV

**Context:** unattended, 3–5 metres away, no input.  
**Job:** communicate current serving numbers and seats quickly.  
**Primary success:** correct state appears without interaction, unnecessary chrome, or delayed animation.

---

## 4. Goals

### P0 goals — product invariants

- Every accepted walk-in ticket has a corresponding server row.
- Every accepted appointment passes the same operational and capacity rules on client and server.
- Customer cancellation is not reported as successful until the server confirms it.
- Queue, appointment, seat, staff, and service authorization rules are enforced server-side with RLS and guarded RPCs.
- Cross-device refresh converges on server state without exposing claim tokens or restricted columns.
- Staff-only feeds are not requested for authenticated but inactive/non-staff sessions.
- No UI state claims success for an operation that failed at the authoritative boundary.
- Existing tables, columns, RPC signatures, and business semantics remain backward-compatible unless an explicit migration decision is approved.

### P1 goals — user experience

- Customer actions remain fast and understandable on 390px through desktop widths.
- Customer and staff surfaces expose loading, empty, success, and error states honestly.
- Display view is readable at distance and contains no operational controls.
- Barber actions are large, direct, and protected from duplicate submission.
- Admin settings are findable, editable, and visibly saved.
- Dark/light theme contrast meets WCAG AA for normal text and controls, including alpha-composited surfaces.
- Keyboard, focus, and screen-reader semantics remain intact.

### P2 goals — maintainability and observability

- Domain rules remain testable without DOM, storage, or wall clock.
- Repository modules remain the only Supabase access layer.
- SQL structural and privilege checks remain part of `npm test`.
- Bug fixes add regression coverage before production changes.
- Audit trails and server timestamps remain available for operational review.

---

## 5. Non-goals and explicit boundaries

- No framework or frontend build pipeline.
- No replacement of the single-file frontend during this product cycle.
- No multi-tenant marketplace, payment processing, customer account system, or messaging platform.
- No promise of WhatsApp notifications unless an actual provider and delivery path are implemented.
- No AR hairstyle try-on; it is explicitly parked and requires a separate privacy, consent, and technical feasibility decision.
- No installer for a second shop without a real second-shop requirement, bootstrap/security decision, and end-to-end deployment test.
- No destructive schema rewrite.
- No redesign that changes queue ordering, booking rules, authorization, price calculation, historical barber snapshots, or cancellation semantics.
- No use of localStorage as an authoritative substitute for failed server writes.

---

## 6. Surface requirements

### 6.1 Customer surface (`#customer-app`)

#### Walk-in

- Show shop identity, status, active-seat availability, queue capacity, current queue preview, and selected service summary.
- Require a customer name; phone is optional and validated when supplied.
- Require at least one active service and enforce service-combination rules.
- Submit a server-backed queue row through `QueueRepo.takeTicket()`.
- On successful insert, persist the server ticket ID and claim token locally.
- On network/RPC failure, do not create a local waiting ticket. Show a retryable failure state.
- Prevent double submission while the request is in flight.
- A customer can have only one active walk-in ticket in this browser context.
- Cancellation calls `cancel_own_ticket` first. Local state changes only after the RPC returns true.
- If cancellation returns false or throws, retain the waiting state and show retry/reload guidance.
- Estimate waits using Malaysia time, operating hours, breaks, active seats, serving work, appointments, and fast-pass/booking priority.
- Never represent an estimate as a guarantee.

#### Booking

- Require name, selected active services, valid date, and an available generated time slot.
- Phone remains optional.
- Respect booking advance days, closed dates, weekly closures, shop status, operating hours, breaks, active seats, session gates, appointment concurrency, and queue occupancy.
- Client slot generation and server RPC validation must use the same continuous business-day axis for overnight schedules.
- Server recomputes price and duration from active services; browser price/duration is display input only.
- Store appointment claim tokens locally for the customer’s own appointment actions.
- Reschedule with optimistic concurrency/version checks; conflicts must be surfaced, not overwritten.
- Cancellation and conversion must preserve server authority and claim-token ownership.

#### Customer status

- Render waiting, serving, cancelled, and completed/terminal states distinctly.
- Recognize queue admin cancellation whether `cancelled_by` is the literal legacy marker or an admin UUID mapped to `cancelledByAdmin`.
- Do not show a customer a stale local terminal state if server refresh contradicts it.

### 6.2 Display surface (`#display-app`)

- Read-only.
- No customer data beyond what is necessary to identify the queue position and service state.
- Large, high-contrast current serving numbers and seat labels.
- No delayed entrance animation that hides a changed number.
- Refresh through the anon-safe queue read path and data-free realtime signal.
- No staff-only appointment or seat feed.

### 6.3 Barber surface (`#barber-app`)

- Requires an authenticated, active staff profile.
- A barber may operate only their assigned active seat; an admin may operate any authorized seat.
- `call_next_customer` is atomic and row-lock protected.
- Selection order: fast-pass, booking, then FIFO, subject to capability hard gate and specialty priority.
- A multi-service ticket is eligible only when the barber’s capabilities cover the complete selected service set; unknown legacy service IDs remain compatible by explicit policy.
- Complete action is atomic and server-authoritative.
- No confirmation dialog between a barber’s deliberate call/done action and the result.
- Duplicate submissions must be disabled or ignored while in flight.
- Realtime seat changes update call/done eligibility without requiring view re-entry.

### 6.4 Admin surface (`#admin-app`)

Admin sections currently include:

1. Staff
2. Shop/location
3. Announcement
4. Reports
5. Fast pass
6. Cancellations
7. Closed dates
8. Services/durations
9. Operating hours
10. Seats/queue

Requirements:

- Admin role required; staff authentication alone is insufficient.
- Every server-authoritative change confirms through the repository before mirroring local cache.
- Dirty state is visible; saved state is explicit.
- Staff management must preserve active/admin safety rules and historical barber-name snapshots.
- Seat assignment must obey one-barber/one-seat constraints and server authorization.
- Service price and duration changes must not rewrite historical queue/appointment snapshots.
- Fast-pass approval/revocation is server-authoritative and version-safe.
- Admin cancellation requires a meaningful reason and updates the server record.
- Reports use server-backed historical records and preserve daily/monthly/yearly boundaries in Malaysia time.
- Reorderable admin navigation persists safely and does not alter business section identity.

---

## 7. Domain and semantic invariants

### 7.1 Queue states

Allowed queue statuses: `waiting`, `serving`, `done`, `cancelled`. State transitions:

- `waiting -> serving`: authorized atomic call-next only.
- `serving -> done`: authorized atomic complete only.
- `waiting -> cancelled`: customer claim-token RPC or admin cancellation RPC.
- `serving -> cancelled`: not a normal customer cancellation path.
- Terminal states cannot be resurrected by stale clients.

### 7.2 Appointment states

Current appointment states include `upcoming`, `arrived`, and `cancelled`; arrival converts/checks in through the server path and must not create duplicate queue work. Reschedule must check version and capacity.

### 7.3 Priority

Queue priority is:

1. fast-pass;
2. booking;
3. walk-in FIFO;

with timestamp ordering within a tier. Any new priority rule requires an explicit product decision and matching domain/server tests.

### 7.4 Time

- Canonical shop timezone: `Asia/Kuala_Lumpur`.
- Same-day schedules use a continuous minute axis.
- Overnight schedules map post-midnight times to the same business day by adding 1440 minutes.
- `open == close == 00:00` represents a 24-hour operating day, not a zero-length day.
- Break overlap is half-open interval logic: `[start,end)`.
- A service already in progress follows the explicit `finish_in_progress` break policy.
- Client slot availability and server booking validation must be tested as a pair.

### 7.5 Money and catalogue

- Database prices are integer sen.
- Display prices may be RM floats only at the UI boundary.
- Server recomputes booking/ticket price from active service rows.
- Historical records retain price/duration snapshots.
- Service IDs, not display names, are the identity used for capability matching.

### 7.6 State ownership

| State | Authoritative source | Local role |
|---|---|---|
| Queue/appointment business status | Supabase RPC/table | cache/rendering, local customer claim state |
| Staff role/active status | Supabase `staff` + Auth | session/UI gating only |
| Seat assignment/status | Supabase `seats` | render cache |
| Service catalogue | Supabase `services` after hydration | render cache |
| Shop settings | Supabase `shop_settings` after hydration | synchronous render cache |
| Theme preference | browser localStorage | local preference |
| Temporary form dirty state | browser DOM | unsaved UI state |
| Audit/outbox notifications | local browser storage unless explicitly server-backed | local convenience only |

A failed authoritative write must not be converted into a successful local business transaction.

---

## 8. Data model and backend contract

### Tables

- `staff`: identity, display name, role, active state, capability/specialty sets, per-service durations.
- `seats`: seat number, active state, assigned barber.
- `queues`: ticket identity/number, customer data, claim token, service snapshot, price/duration snapshot, seat/barber assignment, status, timestamps, cancellation/approval/revocation metadata, version.
- `ticket_counters`: serialized daily ticket numbering.
- `services`: catalogue identity, name, price in sen, duration, active/category/profile, sort order, notes/photos.
- `shop_settings`: singleton shop identity, status, queue limits, seats, closures, booking horizon, weekly hours, admin navigation order.
- `appointments`: appointment identity, customer data, claim token, service/price/duration snapshot, date/time/status, approval/revocation/cancellation metadata, version.

### Repository boundary

All Supabase access goes through:

- `authRepository.js`
- `queueRepository.js`
- `appointmentRepository.js`
- `seatRepository.js`
- `serviceRepository.js`
- `shopSettingsRepository.js`

Repository mappers translate snake_case database rows into the domain shape used by `index.html` and `js/domain/*`. No UI code should issue direct Supabase queries.

### RPC/security requirements

- Security-definer functions pin `search_path = public`.
- Sensitive functions explicitly revoke execution from `anon` and `public`, then grant only the intended role.
- Anonymous entry points are limited to customer-safe operations and claim-token-verified actions.
- All seven tables remain RLS-enabled.
- Realtime broadcasts carry data-free change signals; clients refetch through column/RLS-gated repository paths.
- No claim token is returned in staff list RPCs or realtime payloads.

---

## 9. UX states and failure semantics

Every network-backed action must define these states:

1. **Idle:** action available.
2. **Submitting/loading:** action disabled or re-entry guarded.
3. **Confirmed:** authoritative server response received; local cache updated.
4. **Rejected:** server rejected; local state unchanged or rolled back.
5. **Unavailable:** network/server failed; user gets retry guidance and no false success.
6. **Stale/conflict:** another device changed the record; refresh and explain.

Minimum user-facing messages must distinguish:

- no active seats;
- shop closed;
- no booking slot;
- queue full;
- invalid input;
- authorization/inactive account;
- network failure;
- stale version/record already changed.

Never silently convert an error to a normal empty state when the user’s requested business action did not happen.

---

## 10. Accessibility and responsive requirements

- Responsive matrix: 390px mobile, 720/820px tablet/laptop, 900px breakpoint, 1366px desktop, 1920px wide.
- No horizontal overflow on any surface.
- Keyboard focus remains visible.
- ARIA tablists retain `role=tab`, `aria-selected`, keyboard arrow behavior, and manual activation semantics.
- Async containers expose loading semantics (`aria-busy` or an equivalent resolved-state contract).
- All images have intentional `alt` values; decorative images use empty alt.
- Normal text and controls meet WCAG AA, including gradients and alpha-composited backgrounds.
- Touch targets remain usable for barber/customer workflows; target minimum should be verified per component rather than assumed globally.
- Display view remains readable from distance and does not depend on hover.

---

## 11. Reporting and audit requirements

Reports must:

- use Malaysia business-date boundaries;
- distinguish queue revenue from appointment revenue without double counting;
- use historical price and barber-name snapshots;
- support daily, monthly, and yearly periods;
- make empty periods explicit;
- export only data the current role is authorized to read;
- never infer current service price/name for historical transactions.

Audit records must preserve meaningful actions such as staff changes, settings changes, queue cancellation, fast-pass decisions, and relevant customer events without exposing claim tokens or unnecessary PII.

---

## 12. Verification plan and release gates

### Automated gates

`npm test` must pass with real exit code:

- scheduler regression fixtures;
- Kanban domain tests;
- overnight RPC contract checks;
- semantics contract checks;
- differential comparison: 20,000 randomized cases, 0 mismatches;
- SQL consistency;
- SQL grant consistency.

### Browser gates

Use HTTP stub routing, not `file://`, and `QC_BROWSER_CHANNEL=msedge` on this host.

Verify for both themes and desktop/mobile viewports:

- all four views boot without page errors;
- no duplicate IDs or horizontal overflow;
- queue/appointment loading and failure states;
- customer ticket/appointment success only after authoritative response;
- cancellation failure preserves waiting state;
- inactive authenticated session does not invoke staff-only feeds;
- admin cancellation attribution survives a refresh;
- Kanban count includes unassigned terminal records;
- long admin sections scroll to their true bottom;
- changed labels and controls do not wrap or clip.

### Live Supabase gates

Before release of a migration or RPC change:

- CI migration dry run passes;
- production environment approval is explicit;
- `supabase db push` completes successfully;
- log confirms whether migrations were applied or database was already up to date;
- live test covers overnight booking overlap with one active seat;
- live test covers two concurrent booking attempts for the same capacity;
- live test covers customer cancellation with valid and invalid claim tokens;
- live test covers active versus inactive authenticated staff sessions;
- live test covers admin queue cancellation and cross-device refresh;
- live test covers two barbers calling next concurrently.

A cancelled CI job is not evidence that migrations were or were not applied; inspect the `supabase db push` log.

### Definition of done

A change is done only when:

- the requirement and invariant are explicit;
- a regression test exists and was observed failing before the fix when practical;
- the implementation is minimal and schema-compatible;
- local gates pass;
- browser behavior is exercised for affected surfaces;
- live DB behavior is exercised for affected RPC/migration paths;
- commit, push, CI, environment approval, and deployment evidence are separately recorded;
- `git status` is clean.

---

## 13. Prioritization and roadmap

### P0 — correctness before further UI work

1. Keep the six semantics fixes in `05eef11` deployed and live-verified.
2. Apply and live-test the overnight booking migration.
3. Add real transaction tests for booking/cancellation failure paths.
4. Verify all repository RPC return shapes against the live database.
5. Preserve the no-fake-success rule in every future write flow.

### P1 — user experience and operational confidence

1. Complete loading/error/empty state coverage for every async surface.
2. Add stronger customer retry/recovery UX for network interruption.
3. Add staff/admin conflict messaging when another device changes a record.
4. Complete responsive/device-level verification, including Samsung Internet light mode.
5. Verify display freshness and kiosk stability over a full shop session.

### P2 — product expansion and polish

1. Further reporting/export improvements only after data semantics remain stable.
2. Installer for a second shop only after a real second-shop customer exists and security posture is decided.
3. PWA/native shell only after the Samsung Internet/PWA decision is tested on the target device.
4. Kanban write/reassignment slices only with a separate authorization threat review.
5. AR hairstyle try-on remains a separate product initiative.

---

## 14. Open decisions requiring Fahru

| Decision | Why it matters | Current state |
|---|---|---|
| Is the current six-defect semantics patch approved for production? | Includes a new migration and changes offline/cancellation behavior | Code committed locally; production CI/deploy approval required |
| Should failed walk-in submission offer an explicit retry queue/outbox? | Current safe behavior rejects instead of creating a fake ticket | Recommended: explicit retry, not silent local queue |
| Should customer cancellation support a retry banner with a retained action? | Server-first cancellation can fail transiently | Required UX decision before adding outbox behavior |
| Is the read-only Kanban product feature still wanted? | It was previously kept after a scope misunderstanding | Current UI is read-only; reassignment remains parked |
| Is a second-shop installer needed now? | Installer touches credentials, Auth bootstrap, hosting, and billing | Blocked until a real second shop exists |
| Is PWA/native packaging worth pursuing? | Browser-level Samsung dark mode cannot be controlled by page CSS | Unscoped and unapproved |
| Global operational reset scope | Must avoid destructive history loss while allowing a clean shop reconfiguration | **Decision: Safe operational reset (C)** — preserve staff and queue/appointment history; block while live queues/upcoming appointments exist; require exact `RESET` confirmation |
| Per-section reset defaults | Hardcoded defaults versus last saved state | **Decision: documented defaults** — Shop, Announcement, Closed Dates, Services, Operating Hours, Seats & Queue; Staff/Fast Pass/Cancellations are not resettable sections |

---

## 15. Safe operational reset specification

This section records the accepted reset decision and is implementation-bound.

### Global Reset

The Admin page exposes **RESET OPERASI GLOBAL**. It is visible only to an active admin. The reset:

- resets shop identity/location to the documented Syam Barber Shop/Kerteh defaults;
- resets shop status to open, max queue to 10, seat count to 3, and booking horizon to 30 days;
- resets all weekly hours to 10:00–22:00 with no breaks or session splits;
- clears announcements and closed dates;
- resets the service catalogue to one active `Gunting Biasa` service at RM20 / 30 minutes;
- deactivates seats 1–3 and clears seat assignments;
- clears staff service capability/specialty/duration settings;
- clears the current browser's operational cache after server confirmation;
- preserves all staff accounts;
- preserves all queue and appointment records, including completed/cancelled history and reports.

The reset is rejected when any queue is `waiting` or `serving`, or any appointment is `upcoming`. The server performs this as one admin-only transaction through `reset_operational_state(p_scope)`. No local fallback is permitted.

The confirmation flow must:

1. explain exactly what is reset and preserved;
2. warn that configuration and active catalogue choices will be replaced;
3. require the admin to type exactly `RESET`;
4. keep the destructive action disabled until the exact text matches;
5. display the server rejection when live work blocks the operation;
6. refetch server state after success and show a timestamped success message.

### Section Reset

Resettable sections use the same admin-only RPC and documented defaults:

- **Shop & Location:** identity/location defaults;
- **Announcement:** empty content, enabled;
- **Closed Dates:** empty list;
- **Services & Durations:** one default `Gunting Biasa` service and cleared staff service mappings;
- **Operating Hours:** 10:00–22:00 every day, no breaks/session splits, 30-day booking horizon;
- **Seats & Queue:** three inactive, unassigned seats and max queue 10.

Each section reset also requires typing `RESET`, is blocked by live queues/upcoming appointments, and updates local cache only after server success. Reports filters may reset locally but must never delete report data. Staff, Fast Pass, and Cancellations do not receive reset buttons because they contain identity or transaction/audit state rather than safe configuration.

### Reset acceptance criteria

- An anonymous customer cannot see or invoke any reset control.
- A barber cannot see or invoke any reset control.
- An authenticated inactive staff account cannot invoke reset.
- An active non-admin staff account cannot invoke reset.
- An active admin cannot reset while live queue/appointment work exists.
- Wrong confirmation text never calls the RPC.
- A rejected RPC leaves both server and local business state unchanged.
- A successful global reset leaves staff rows and historical queue/appointment rows intact.
- `npm test`, SQL consistency, SQL grant consistency, DOM boot, and live Supabase verification pass before deployment.

## 16. Implementation handoff

This PRD is the canonical product/semantic contract for future QueueCut work. Before implementing any new feature:

1. Identify the affected surface and authoritative state.
2. Trace the domain rule, repository mapper, RPC/migration, and UI caller.
3. State the invariant that must not change.
4. Write the smallest failing regression test.
5. Implement without changing unrelated schema or frozen theme mechanics.
6. Run the full release gates above.
7. Update `HANDOFF.md` with observed evidence, not intentions.

The next implementation-ready slice is **live verification and CI deployment of the semantics patch**, followed by fixing any live-only discrepancies found by that verification. No additional feature should outrank resolving a failed authoritative transaction or a client/server rule mismatch.
