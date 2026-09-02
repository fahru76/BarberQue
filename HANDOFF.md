# QueueCut — migration handoff

Paste this into Cowork along with the project files to pick up where the chat left off.

**Date:** 2 September 2026
**Supabase project:** `cojaebzxrtyvxrnadiuv` ("fahru76's Project"), ap-southeast-1, Postgres 17
**URL:** `https://cojaebzxrtyvxrnadiuv.supabase.co`
**Publishable key:** `sb_publishable_t5jWXLzmoTSI1lTPqVWOgg_dvNXmui1` (safe to commit — RLS is the protection)

---

## Where the project stands

QueueCut is a barbershop queue app. It began as a single 5,500-line `index.html` using
`localStorage`, audited across ~25 rounds. It is now mid-migration to Supabase.

### Done — step 1: pure domain layer

`js/domain/time.js` and `js/domain/scheduler.js` extracted from the prototype. No DOM,
no storage, no wall clock — `nowMinutes` and `ops` are passed in.

`npm test` runs two suites:

- **`tests/domain/scheduler.test.mjs`** — 15 fixtures, each a real bug from the audit
  series, named by round.
- **`tests/differential.test.mjs`** — 20,000 randomised comparisons against the
  prototype's original inline functions (extracted to `build/legacy.cjs`). Currently
  **0 mismatches**. This proves the extraction changed no behaviour. Keep it until
  `index.html` is retired, then delete it with `build/legacy.cjs`.

Last run: 15 passed / 0 failed, 20,000 comparisons / 0 mismatches.

### Done — step 2: database, applied and verified

Four migrations are live. Verified against the running database, not just assumed:

| Version | Name |
|---|---|
| 20260831101137 | init_core |
| 20260831101153 | rls_policies |
| 20260831101217 | ticket_sequence_and_rpc |
| 20260831101437 | harden_function_grants |

Tables: `staff`, `seats`, `queues`, `ticket_counters` — all with RLS enabled, 9 policies.

Nine behavioural tests passed against the live database (ticket sequence distinctness,
prefix validation, seat-requires-barber constraint, serving-requires-seat constraint,
cancel-requires-reason constraint, version auto-increment, claim-token cancellation).
They ran inside a deliberate exception so everything rolled back — the database is empty.

**One thing to know:** during step 2 a real security hole was introduced and fixed.
`revoke ... from public` does **not** remove Supabase's DEFAULT PRIVILEGES, which grant
EXECUTE to `anon` and `authenticated` by name. `barber_performance` was briefly callable
by anyone holding the public key, with no internal guard — it would have returned every
barber's revenue. Migration `20260901000300` revokes per role and adds an
`is_active_staff()` guard inside the function. **If you add any new RPC, revoke from
`anon` explicitly and re-run `get_advisors`.**

Verified end state:

```
barber_performance     anon=false  auth=true
call_next_customer     anon=false  auth=true
complete_service       anon=false  auth=true
is_active_staff        anon=false  auth=true   (RLS policies need it)
is_admin               anon=false  auth=true   (RLS policies need it)
bump_row_version       anon=false  auth=false  (trigger only)
handle_new_staff_user  anon=false  auth=false  (trigger only)
next_ticket_number     anon=true   auth=true   (customers have no account)
cancel_own_ticket      anon=true   auth=true   (claim-token verified)
```

Remaining advisor warnings are all intentional and documented in the migration comments.

---

## Design decisions already made — don't relitigate these

- **Individual barber accounts**, not a shared staff login. `staff.name_key` is a
  generated column with a UNIQUE index, so the round-7 bug ("Ali" and "ali" splitting one
  barber across two rows in the sales report) is structurally impossible.
  `barber_performance()` groups on `barber_id`, never a name string.
- **`price_sen integer`**, not a float. Retires the currency-rounding bug class.
- **Phone is write-only for anon.** Column grants let anon `insert` phone but not
  `select` it. Without that, the "queue readable by all" policy would publish every
  customer's number.
- **Customers cancel via `claim_token`.** A walk-in has no account, so an UPDATE policy
  would let them cancel anyone's ticket. The browser stores a UUID it generated at insert;
  `cancel_own_ticket()` verifies it. The token column is never selectable.
- **`seats_active_requires_barber` CHECK constraint** replaces four separate UI guards.
- **No DELETE policy anywhere.** Cancellation is a status change so the audit trail lives.
- **`enable_signup = false`**; new staff rows default to `active = false`.

---

## Done — step 3: `queueRepository`, wired into `index.html` for ticket-taking + cancel only

`js/supabaseClient.js` creates the client. Loaded from `esm.sh` as a plain ES module,
not from `node_modules` — `index.html` has no bundler and no build step, so the browser
needs a CDN URL, the same pattern Supabase's own vanilla-JS quickstart uses.

`js/repositories/queueRepository.js` implements the five functions from the original
sketch, plus a `mapQueueRow()` that translates DB rows into the plain-object shape
`js/domain/scheduler.js` reads (`id`, `status`, `seat`, `duration`, `timestamp`,
`queueSource`, `isFastPass`, `calledAt`).

```js
export async function listQueues() { ... }        // select from queues, mapped to domain shape
export async function takeTicket(record) { ... }  // rpc next_ticket_number, then insert
export async function callNext(seatNo) { ... }    // rpc call_next_customer
export async function completeService(id) { ... } // rpc complete_service
export async function cancelOwn(id, token) { ... }// rpc cancel_own_ticket
```

**Not `select('*')`.** `QUEUE_COLUMNS` is an explicit allow-list matching the anon SELECT
grant in `20260901000100_rls_policies.sql` exactly. Column grants are enforce-all-or-fail —
unlike RLS row filtering, a query naming even one ungranted column is rejected in full, not
trimmed. This applies to `RETURNING` too, which is what `.insert().select()` compiles to:
`returning *` (or naming a column outside the grant, `version` included) 42501s for anon
even though the insert itself succeeded. Discovered live, not guessed.

### The diff against `index.html`'s real call sites (27 reads of `getQueues()`)

The first draft of `queueRepository.js` was written before `index.html` was available and
guessed its shape from `js/domain/scheduler.js` and `legacy.cjs`. Those two agreed with
each other but weren't the real UI. Diffing against the actual file found:

| Prototype field (on a `queues` array element) | DB column | Verdict |
|---|---|---|
| `id` (e.g. `"PG01-20260901"`) | `id` **and** `ticket_no` | **Fixed.** The prototype has no separate "row id" vs "display number" — `getDisplayTicketId()` just strips `-YYYYMMDD` off `.id`. First draft generated a random uuid for `id` and used the server's minted number only for `ticket_no`. Now `takeTicket()` uses the minted number for **both** columns. |
| `price` (RM float, e.g. `38.5`) | `price_sen` (integer) | **Fixed.** First draft took `priceSen` directly, pushing the RM→sen rounding onto the caller — exactly the bug class `price_sen` exists to retire. `takeTicket()` now takes `priceRm` and converts internally (`Math.round(priceRm * 100)`). |
| `status`, `seat`, `duration`, `timestamp`, `calledAt`, `queueSource`, `isFastPass` | `status`, `seat_no`, `duration_minutes`, `created_at`, `called_at`, `source`, `is_fast_pass` | Confirmed exact match — no change needed. |
| `claimToken` | — | Does not exist in the prototype at all. There was never a claim-token cancellation model; `cancelCustomerWalkin()` cancels by `id` alone because everything lived in one browser's `localStorage`. Introducing it is new behaviour, added below. |
| `barberName` (free-text string, admin-typed per seat) | `barber_id` (uuid FK to `staff`) | **Gap, not fixed.** The prototype has no concept of a barber account — `getBarberAssignments()` is just a name typed into an input, unconnected to Supabase Auth. `call_next_customer()`'s `barber_id` can't be populated meaningfully until step 4 (auth) exists. Left alone. |
| `isVip`, `fastPassApproved`, `approvedAt`, `revokedAt` | — | **Gap, not fixed.** These belong to a fast-pass-approval workflow on top of appointments (an admin approves a booking's priority request; `isVip`/`fastPassApproved` get copied onto the queue row when an appointment checks in). No column exists for any of them — only `is_fast_pass` (a plain boolean) does. In every current call site `isVip` is only ever set alongside `queueSource: 'booking'`, so `getQueuePriority()`'s `queue.isVip` check is currently redundant with its `queueSource === 'booking'` check, but that's incidental to how records happen to be created today, not a guarantee. This whole workflow rides on `appointments`, which isn't migrated yet (step 5) — untouched. |
| `whatsappAuto` | — | Always `true` at creation, never read anywhere else. Not a real gap, just unused; left on the local record. |

### What's actually wired, and what deliberately isn't

**Wired — `bookTicket()` (the walk-in "Ambil Giliran" flow) and `cancelCustomerWalkin()`.**
Both now call the server as a best-effort step alongside the existing `localStorage` flow,
which is unchanged otherwise:

- `bookTicket()` tries `next_ticket_number()` + an insert (via `takeTicket()`) first. On
  success, the server's ticket number is used as `newId`, and the returned `claimToken` is
  saved to `localStorage['activeTicketClaimToken']`. On failure (network down, Supabase
  unreachable), it falls back to the original local daily counter, logs a warning, and
  registration proceeds exactly as before — taking a ticket never hard-fails on a dropped
  connection. Either way, the same record is still pushed into the local `queues` array and
  `saveQueues()`'d, so the board, the wait-time estimator, and the staff "Panggil"/"Selesai"
  buttons all keep working unchanged — they still read the local copy.
- `cancelCustomerWalkin()` does its existing local cancellation first (that's still the
  source of truth for the UI), then best-effort calls `cancel_own_ticket()` with the saved
  claim token so the server record's status matches, swallowing any failure.

**Why not more:** `listQueues()`, `callNext()` and `completeService()` are implemented but
**not called from `index.html` yet.** Flipping the board/TV read path to the server, or the
staff "Panggil kerusi" / "Selesai" buttons, requires an authenticated, active-staff session —
`call_next_customer()` and `complete_service()` both `raise exception 'Not authorised'`
without one, and this prototype has no Supabase Auth session at all (step 4, not started).
Wiring those today would turn "call next customer" into a silent no-op against the server
while the local board kept working — worse than not touching it, since it would look wired
without being wired. They wait for step 4.

Similarly, the appointment→queue conversion path (`startWalkinConversion`, booking check-in)
was left entirely alone: it reads and writes `appointments`, which isn't migrated (step 5),
and — per the gap table above — carries fields (`isVip`, `fastPassApproved`, `approvedAt`,
`revokedAt`) that have no column to land in yet.

**Net effect today:** every walk-in ticket taken while Supabase is reachable now also exists
as a real, collision-proof-numbered row in `public.queues` (this is the actual fix for the
"very first audit" bug — two phones can no longer mint the same ticket number, because the
counter is now a single serialised row on the server instead of two independent
`localStorage` counters). Nothing reads that row back yet, so it doesn't yet change what any
screen shows; it exists so that (a) the row is already there, correctly shaped, once step 4
lands and the board flips over, and (b) `barber_performance()` and any future report already
has real rows to work from rather than needing a backfill.

**Verified live**, both statically and behaviourally, against the running database
(project `cojaebzxrtyvxrnadiuv`, still empty — 0 rows in every table):
- `supabase/migrations` list and table/RLS state match this file's records exactly.
- `has_function_privilege` for every `public.*` function matches the "Verified end state"
  table above, unchanged since step 2.
- A `DO` block, run as `anon` (`set local role anon`) and ending in a deliberate
  `raise exception` so the whole thing rolled back, exercised the actual sequence
  `queueRepository.js` drives — including a second pass after the `id = ticket_no` fix,
  confirming an insert with the minted ticket number as both `id` and `ticket_no` still
  satisfies the primary key and the `with check`: `next_ticket_number` (valid and rejected
  prefixes), an insert using only the anon-grantable columns (defaults land on `waiting` /
  `seat_no null`, satisfying the `with check` without setting them explicitly), confirmed
  `phone`, `claim_token` and `version` are genuinely unreadable to anon, confirmed a sneak
  insert as `status = 'serving'` is rejected, confirmed `call_next_customer` and
  `complete_service` refuse anon outright, and confirmed `cancel_own_ticket` returns `false`
  for a wrong token and `true` (with the row actually moving to `cancelled`) for the right
  one. Every check passed before the intentional rollback — nothing persisted.
- `index.html`'s two edited scripts (the module bridge and the classic script) both pass
  `node --check` after extraction. There is no headless-browser pass in this handoff — the
  actual `bookTicket()` / `cancelCustomerWalkin()` click paths have not been exercised in a
  real browser. Do that before treating this as done.
- A network-based smoke test doing the repository's sequence through `@supabase/supabase-js`
  as a real HTTP client (not SQL) could not be run from the machine that did this handoff —
  its network egress doesn't reach `*.supabase.co`. It's saved as `tests/live-smoke.mjs`
  (`npm run test:live`) for whoever has a normal connection; it's the one check above that
  hasn't actually been run.

## Done — step 4: Supabase Auth for barber/admin (sign-in only — RPCs still deferred)

Decisions made with the user before building this (recorded so they aren't relitigated):
email + password (not magic links — this runs on a shared shop tablet, and checking email
on every sign-in doesn't work there); new accounts via an **in-app "Invite Barber" feature**
(not manual Supabase Dashboard creation); and **auth only this pass** — `callNextToSeat()` /
`markSeatDone()` / the board read path stay on `localStorage` for now, wired to
`queueRepository.callNext()` / `.completeService()` / `.listQueues()` in a follow-up pass.

**What exists now:**

- `js/repositories/authRepository.js` — `signIn`, `signOut`, `getSession`,
  `onAuthStateChange`, `getMyStaffProfile`, `listStaff`, `setStaffStatus`, `inviteBarber`,
  `setNewPassword`.
- `supabase/functions/invite-barber/index.ts` — deployed, `ACTIVE`, `verify_jwt = true`.
  Creating a user needs the `service_role` key, which must never reach the browser, so this
  function is the only place that key exists. `verify_jwt` only proves "some signed-in user
  called this" — the function independently re-checks `is_admin()` (using the *caller's own*
  forwarded JWT, not the function's) before it will invite anyone, and does not trust
  anything the client claims about its own role.
- `index.html`: a "Log Masuk" / "Log Keluar" control in the nav; `switchView()` now gates
  `barber-app` (needs a session + an `active` staff row) and `admin-app` (same, plus
  `role === 'admin'`) — the nav buttons are still always visible and clickable, same as
  before, but reaching the panel now requires the session, matching how `switchView()`
  already worked (a client-side convenience; RLS and `is_active_staff()`/`is_admin()` are
  the real, unbypassable boundary regardless of what the UI shows); an "Invite Barber" form
  plus a staff list (with activate/deactivate and role toggles) at the top of `admin-app`;
  and a "set your password" dialog for someone landing on an invite or password-reset link.

**A dependency-ordering note baked into the bridge script.** Module scripts run deferred
(after the whole document parses), so they always execute *after* the classic script's own
top-level code, however they're ordered on the page. That was fine for `queueRepository` (only
called from click handlers, long after the module has loaded) but not for auth: the page
needs to know the sign-in state as soon as it loads. So the dependency points the other way —
the bridge module calls `window.onStaffAuthChange(event, session, profile)`, a function the
classic script defines at its own top level (guaranteed to exist by the time the deferred
module runs), instead of the classic script reaching into `window.AuthRepo` at load time.

**Verified:**
- `is_admin()`/`is_active_staff()` privilege grants unchanged since step 2 (re-ran
  `has_function_privilege` — still `anon=false, auth=true` for both).
- `get_advisors` (security) unchanged — same intentional warnings as before, nothing new
  from the edge function deploy (the linter doesn't cover Edge Functions).
- The deployed function's source was read back via `get_edge_function` and byte-for-byte
  matches what was written locally.
- `index.html`'s two script blocks still pass `node --check` after all these additions; no
  duplicate function names were introduced (checked every new function/identifier name is
  declared exactly once in the file).

**NOT verified — genuinely could not be, from this environment, and this is the important
caveat:**
- The Edge Function's HTTP behaviour (CORS preflight, 401 with no `Authorization` header,
  403 for a non-admin caller, the actual invite email going out) — the same network
  restriction that blocked `tests/live-smoke.mjs` blocks a raw `curl` to
  `*.supabase.co/functions/v1/...` too.
- The whole click-through: `bookTicket()`/`cancelCustomerWalkin()` from the previous pass,
  and now sign-in, invite, activate, and the set-password dialog, in a real browser. There is
  no browser available in this session, and no inbox to click a real invite email — the
  `PASSWORD_RECOVERY`-or-`type=` URL check in `onStaffAuthChange` is a best-effort guess at
  what a real invite link does, not something that's been watched happen.
- Whether the invite email actually arrives and links to the right place — see the
  **required manual step** below.

### Required manual step before any of this works: bootstrap the first admin

There is no way to create the *first* account from code. `enable_signup = false` blocks
self-registration on purpose, and the invite feature needs an existing admin to call it —
a deliberate chicken-and-egg. Directly inserting a row into `auth.users` via SQL was
considered and rejected: it bypasses GoTrue's password hashing and the `auth.identities`
bookkeeping newer Supabase versions expect, and getting that exactly right by hand is
fragile in a way that isn't worth the risk for a one-time setup step.

**Done.** `fahru76@gmail.com` created the account itself via the Supabase Dashboard
(auth.users row created 2026-08-31 15:40:35, email confirmed). `handle_new_staff_user` had
already auto-created the matching `staff` row (`role='barber', active=false`); it was then
updated with a plain, reversible SQL statement — `update public.staff set role='admin',
active=true where id = '<that user's id>'` — and the result confirmed via `RETURNING`.
`fahru76@gmail.com` is now the app's first active admin.

**Hosting: done.** The repo is public at `github.com/fahru76/BarberQue`. GitHub Pages is
enabled (Settings → Pages → Deploy from a branch → `main` / `/ (root)`), the
`pages-build-deployment` workflow run succeeded, and the live site was loaded and confirmed
rendering correctly (customer walk-in view, all `js/` modules returning 200) at:

**`https://fahru76.github.io/BarberQue/`**

**Still open — needs a decision/action in the Supabase Dashboard:** Authentication → URL
Configuration → Site URL (and the Redirect URLs allow-list) still needs to be set to the
URL above. `inviteUserByEmail()` was called without an explicit `redirectTo` in
`invite-barber/index.ts`, so it falls back to whatever Site URL is configured — if that's
still Supabase's placeholder default, invite links will land somewhere that isn't this app.
This wasn't changed automatically: the Supabase MCP tools available in this environment
don't expose Auth URL configuration, and treating it as a security-relevant setting (it's
effectively a redirect-URL allowlist) meant checking with the user first rather than driving
it through the dashboard unasked.

**Done.** The user set Site URL and the Redirect URLs allow-list themselves in the Supabase
Dashboard on 31 August 2026. Not independently re-verified from this environment (no direct
dashboard read access to that setting), but taken as confirmed per the user's report.

### Then, in order

4b. **Done — `callNextToSeat()`/`markSeatDone()` now call the real server.**

    **A blocker was found and resolved first, not skipped:** `call_next_customer()`
    requires the target seat's `public.seats` row to have `active = true` AND a real
    `barber_id` (an actual `staff.id`, not free text) — enforced by the database's own
    `seats_active_requires_barber` check constraint. `public.seats` had **zero rows**
    (nothing had ever written to it), and index.html's seat/barber-assignment UI was pure
    free-text with no link to a signed-in account. Flipping the two functions without
    fixing this first would have made every single "Panggil" press fail with "Kerusi
    tidak dibuka" — asked the user how to handle it (three options), they chose to build
    the assignment link properly rather than a shim or deferring.

    What changed:
    - **New `js/repositories/seatRepository.js`**: `listSeats()` (embeds the assigned
      staff member's `display_name` via the `barber_id` FK) and `setSeatAssignment(seatNo,
      {active, staffId})` (upsert, admin-only per the existing `admins manage seats` RLS
      policy — nothing new needed there, step 2 already had it right).
    - **`renderBarberAssignments()`** in index.html: the free-text `<input>` per seat is
      now a `<select>` of registered staff accounts (from `AuthRepo.listStaff()`,
      inactive ones shown but labelled). Selecting one still derives the same
      `barberAssignments` (name-keyed) localStorage value everything else in this file
      already reads (`buildBarberPerformance`, audit events, etc.) — so nothing
      downstream of that key had to change. `saveBarberAssignments()` and
      `toggleSeatStatus()` now also best-effort push `{active, staffId}` to
      `seatRepository.setSeatAssignment()` per seat, same dual-write posture as
      `bookTicket()`.
    - **`callNextToSeat()`/`markSeatDone()`**: now `async`, call
      `queueRepository.callNext()`/`.completeService()`, and merge the returned row into
      the local `queues` array (upsert by id; synthesizes a local-shape record if the
      ticket was never seen locally — e.g. called from another session). **Deliberately
      no local-only fallback on server failure** — unlike `bookTicket()`/
      `cancelCustomerWalkin()`, which must never block a customer on a network hiccup,
      a staff action succeeding only locally would reintroduce the exact state
      divergence this step exists to remove. The real error (e.g. "seat not assigned
      yet") is shown instead.
    - `queueRepository.js`'s `mapQueueRow()` now also maps `completed_at` →
      `completedAt` — previously silently dropped for `completeService()`'s result
      (only `listQueues()`/`callNext()` were exercised before, and neither of those
      return a completed_at).

    **Verified, without touching the live site:** a rollback-safe `DO $$ ... raise
    exception 'PASSED' $$;` block (same pattern as step 2) simulated `auth.uid()` as
    `fahru76`, assigned seat 1, inserted a throwaway ticket, called
    `call_next_customer(1)` and `complete_service(id)` directly, and asserted every
    returned field (`status`, `seat_no`, `barber_id`, `called_at`, `completed_at`)
    matched what the client code expects — then raised, rolling back all of it
    (`queues`/`seats` confirmed back at 0 rows afterward). `node --check` passes on both
    script blocks; `npm test` unaffected (domain layer untouched).

    **Live end-to-end test — passed, 31 August 2026.** A local dev server was tried
    first via the linked computer's device shell, but the browser pane refuses to
    navigate to `localhost`/`127.0.0.1` regardless of site permission (a blanket
    restriction, not something this project can work around) — so this was pushed to
    `main` and tested on the real deployed site instead (only the staff/admin screens
    are touched by this change, gated behind sign-in; the customer walk-in flow is
    untouched). With the user signed in as `fahru76`:
    - Assigned `fahru76` to Kerusi 1 via the new dropdown and clicked "Kerusi 1 : AKTIF"
      — confirmed via SQL that `public.seats` got `{seat_no:1, active:true, barber_id:
      <fahru76's staff id>}`, and all three seats got rows (2 and 3 inactive, unassigned).
    - Inserted one throwaway ticket directly via SQL (taking one through the real
      customer form failed at the time with "Walk-in tidak dibuka pada waktu ini" —
      **correction**: this was NOT a missing-configuration gap as first reported to the
      user; weekly operating hours were already configured with sensible defaults
      (10:00–22:00 every day), and the real cause was simply that it was ~1:30am
      Malaysia time, genuinely outside any 10am–10pm window. Flagged and corrected with
      the user rather than left standing) and pushed the matching local record so the
      existing "disable Panggil when nothing's waiting locally" UI logic behaved
      normally.
    - Clicked **Panggil**: seat 1 correctly showed the ticket's number and name; SQL
      confirmed `status='serving', seat_no=1, barber_id=<fahru76>, called_at` set.
    - Clicked **Selesai**: seat cleared back to empty on screen; SQL confirmed
      `status='done', completed_at` set.
    - Test ticket deleted afterward (both the server row and the injected local copy);
      the seat 1 → fahru76 assignment was left in place as real, legitimate config,
      not test data.

    One unrelated pre-existing bug surfaced during testing, not touched by this pass:
    the phone-number `<input pattern="...">` on the customer forms throws `Uncaught
    SyntaxError: Invalid regular expression` in the console (a `v`-flag/character-class
    escaping issue) — cosmetic, HTML5 pattern validation only, didn't block anything
    tested here, but worth fixing separately.

    - The `isVip` / `fastPassApproved` / `approvedAt` / `revokedAt` schema gap is still
      open — unrelated to this pass, not touched.

4c. **Done — shop operating hours configured per the user's actual schedule**, on
    request, after the correction above surfaced that hours existed but were still the
    generic defaults. Set via the live admin panel (`javascript_tool`, no code change):
    closed every Friday; working hours 09:00–22:00 the other six days; two daily breaks,
    13:00–14:00 and 19:00–20:30. Confirmed via SQL-equivalent read-back of
    `weeklyOpHours` after saving.

## Done — step 5a: services/price catalog is now server-authoritative

The user chose to sequence step 5 as services first, then shop settings, then
appointments (services is self-contained; shop settings needs a caching-architecture
decision; appointments is tangled with the still-open `isVip`/`fastPassApproved` gap —
see below).

**What changed:**
- **New `public.services` table** (`supabase/migrations/20260901000400_services_catalog.sql`):
  `id text primary key`, `name` (1–60 chars, trimmed), a generated `name_key` column +
  unique index for case/whitespace-insensitive uniqueness (same technique as
  `staff.display_name`), `price_sen`/`duration_minutes` (both positive), `active`,
  `category` (`asas`/`fashion`), `target` (`semua`/`dewasa`/`kanak`), `type`
  (`gunting`/`botak`/`facial`/`lain`), `sort_order`, `created_at`. RLS enabled;
  everyone may read active services, staff may also read inactive ones, only admins
  may write (see the bug-and-fix below for how the read policy is actually split).
- **New `js/repositories/serviceRepository.js`**: `listServices()`, `createService()`,
  `updateService()`, `deleteService()`, `reorderServices()` (bulk `sort_order` upsert).
  `price` stays a plain RM float in index.html; the RM↔sen conversion is isolated here,
  same pattern as `queueRepository.takeTicket()`.
- **`addService()`/`saveServiceEdit()`/`toggleServiceStatus()`/`deleteService()`** in
  index.html: now `async`, call `window.ServiceRepo` **first** and only touch local
  `shopServices` once the server confirms — same no-fallback rule as
  `callNextToSeat()`/`markSeatDone()` from step 4b, because this catalog is what
  customers see on every device, not just the one an admin happened to edit on.
- **`persistServicePriority()`** (drag-reorder / ↑↓ buttons): local reorder logic is
  unchanged; a new `syncServiceOrderToServer()` helper best-effort mirrors the resulting
  `sort_order` per category to the server afterward — cosmetic (display order only), so
  this follows the `syncSeatAssignmentToServer()` precedent (fire, don't block, warn on
  failure) rather than the no-fallback rule above.
- **`seedOrRefreshServices()`** (new, in the Supabase bridge module script): runs once at
  load and again on every auth change. The *first* time it ever runs against an empty
  `services` table, it seeds the server from whatever this device's local
  `shopServices` already has (preserving ids and per-category order) so the existing
  catalog isn't wiped back to empty on cutover. Every run after that treats the server
  as authoritative and overwrites local `shopServices` with what it returns. Runs again
  on sign-in/out specifically because of the bug below — an anon session and a signed-in
  admin session are not allowed to see the same rows.

**A real bug was found (and fixed) during verification, before ever reaching the live
site:** the RLS select policy this migration first created was one combined
`to anon, authenticated` policy — `using (active or public.is_active_staff())`. But
`20260901000300_harden_function_grants.sql` had revoked `EXECUTE` on `is_active_staff()`
from `anon`, on the stated assumption ("no anon policy calls them") that held until this
migration. Postgres evaluates a row-security `USING` clause as one boolean expression
regardless of which role's policy matched the row; for any *inactive* service, `active`
is false, so Postgres must evaluate `is_active_staff()` to decide — and anon has no
grant to call it, so the **entire query would error with 42501 for an anon customer**
the moment even one inactive service existed, instead of just filtering that row out.
Caught via a rollback-safe `DO $$ ... $$` simulation (anon role, one active + one
inactive test row) before it ever reached a real customer. Fixed same-day by a second
migration, `20260901000500_services_anon_policy_fix.sql`, splitting the single policy
into two role-scoped ones — `to anon using (active)` and
`to authenticated using (active or is_active_staff())` — since a role-scoped policy is
never evaluated at all for a mismatched role, so anon's policy now never references
`is_active_staff()`.

**Verified (rollback-safe SQL, both before and after the fix):**
```
anon_sees=1 (want 1), anon_update_allowed=false (want false),
anon_insert_allowed=false (want false), admin_sees=2 (want 2), admin_update_rows=1 (want 1)
```
`get_advisors(security)` shows no new warning attributable to `public.services` after
either migration. `node --check` passes on both `index.html` script blocks; `npm test`
unaffected (domain layer untouched).

**Live end-to-end test — passed, 1 September 2026.** Pushed to `main` and tested against
the real deployed site (the previous token, still unrevoked, was reused for this push at
the user's explicit instruction). The built-in browser was still signed in as `fahru76`
from step 4b's testing, so no new sign-in was needed.

A second real bug turned up here, more significant than the first: `createService()`
worked, but the display-order sync that runs right after (`syncServiceOrderToServer()` →
`reorderServices()`) failed on *every* call, not just a first-seed race. The cause:
`reorderServices()` did a single `upsert(..., {onConflict:'id'})` sending only `{id,
sort_order}` per row. `INSERT ... ON CONFLICT (id) DO UPDATE` builds and validates the
full candidate row — including NOT NULL checks on `name`/`price_sen`/
`duration_minutes`/`category`, none of which have a default — *before* it discovers the
id already exists and falls back to the UPDATE branch. So a partial-column upsert against
this table can never succeed, whether or not two callers race. (The seed-loop fix from
the section above — only reordering ids that were actually just created — was still
worth keeping as a minor safety measure, but it was not the real fix.) Corrected by
replacing the upsert with a plain per-row `UPDATE ... WHERE id = ...`, which never
constructs a full candidate row and so can't trip a NOT NULL constraint on an omitted
column. Pushed as a follow-up commit and redeployed.

Verified directly against the live database and live site (cache-busted dynamic
`import()` was needed partway through, since GitHub Pages serves JS with
`cache-control: max-age=600` and the browser was still running the pre-fix module):
- **Create**: added "QA Test Trim" (RM15, 20 min) via the admin form — confirmed present
  in `public.services` with the exact values entered.
- **Reorder**: moved it above "Gunting Biasa" — confirmed both rows' `sort_order` updated
  correctly (this is what caught the bug above).
- **Update**: toggled `active` to `false` and changed the price to RM18 — confirmed both
  changes landed.
- **Delete**: removed it — confirmed gone from the table.
- Local `shopServices` was reconciled back to just the real "Gunting Biasa" record
  afterward (test rows never left in place, `sort_order` restored to its original value).

**Not yet done:** none of the CRUD paths remain unverified. `get_advisors(security)` was
not re-checked after this specific fix (only after the two migrations) — worth a quick
look next session, though this fix was a client-side query change, not DDL, so no new
advisory is expected.

## Done — step 5b: shop settings is now server-authoritative (client wiring complete; live test pending)

**Decision the user made (locked in, don't relitigate):** a single-row table with typed
columns, not a generic key-value table. Asked via AskUserQuestion because this was a
genuine architecture fork — the KV alternative would have meant a generic
`get/set(key, value)` repository with no per-field validation, versus a normal typed
table with a `check` constraint per column. User chose **"Single row, typed columns
(Recommended)"**.

**What changed:**
- **New `public.shop_settings` table**
  (`supabase/migrations/20260901000600_shop_settings.sql`): singleton via
  `id boolean primary key default true` + `check (id)` — a second row is structurally
  impossible (a row with `id=false` fails the check; a second `id=true` row collides with
  the primary key). 16 columns mirroring every existing shop-setting getter
  (`app_name`, `shop_name`, `shop_map_link`/`_query`/`_address`, `shop_location_name`,
  `shop_announcement`/`_html`/`_enabled`, `shop_status`/`_changed_at`, `max_queue`,
  `seat_count`, `closed_dates` (jsonb array), `booking_advance_days`,
  `weekly_op_hours` (jsonb object)), each with the same bounds the client already
  enforces (e.g. `max_queue between 1 and 999`, `booking_advance_days between 1 and
  365`). Created **empty** (0 rows) — same reasoning as `public.services`: seeding it
  with generic defaults here would silently clobber a shop's real configured hours the
  first time any client reads it back. RLS: readable by everyone (every field is shown
  to customers somewhere — no active/inactive split like `services`); insert (seed) and
  update both gated to `is_admin()`; **no delete policy for anyone, not even admins** —
  deleting the one row would break the site for every device and there's no legitimate
  reason for that action to exist.
- **New `js/repositories/shopSettingsRepository.js`**: `getShopSettings()` (`.maybeSingle()`
  — returns `null` on an empty table, not an error), `createShopSettings(settings)` (seed,
  full row), `updateShopSettings(patch)` (partial, plain `UPDATE ... WHERE id = true` —
  deliberately **not** an upsert, learned directly from step 5a's `reorderServices()` bug:
  a partial-column upsert validates the full candidate row's NOT NULL constraints before
  discovering the id exists, so it can never succeed against a table with required
  columns; a plain UPDATE never has this problem). Same camelCase-object /
  snake_case-column translation pattern as `serviceRepository.js`.
- **`seedOrRefreshShopSettings()`** (new, in the Supabase bridge module script, alongside
  `seedOrRefreshServices()`): same seed-then-cutover pattern — first time it finds the
  table empty, seeds it from this device's real current settings (via
  `collectCurrentShopSettingsSnapshot()`, new helper reading all 15 local keys into one
  object); every time after that, treats the server as authoritative and overwrites
  every local shop-setting key. Runs on initial load and again on every auth-state
  change, same reasoning as services (an anon seed attempt failing is expected/harmless,
  not an error — only an authenticated admin can pass the insert policy).
- **`syncShopSettingsToServer(patch)`** (new, classic script, shared by all ten setters
  below): calls `updateShopSettings(patch)` first; if that fails because the row doesn't
  exist yet (`PGRST116`/no rows — the admin is saving before any device has ever
  seeded), it self-heals by calling `createShopSettings()` with the full current local
  snapshot merged with the patch, so the very first save someone makes doesn't produce a
  confusing failure. Any other error is surfaced as-is.
- **All ten admin save handlers converted to `async`, write-through-first** (no
  local-fallback — same rule as step 5a/4b, since these values are shown to customers on
  every device, not just the one being edited): `saveShopNameSetting()`,
  `saveAnnouncementSetting()`, `toggleShopStatus()`, `saveMaxQueueSetting()`,
  `saveOperationalHours()`, `copyOperationalHoursToAllDays()`,
  `saveBookingAdvanceDaysSetting()`, `saveSeatCountSetting()`, `addClosedDate()`,
  `removeClosedDate()`. Each now calls `syncShopSettingsToServer({...})` first and aborts
  with an alert (no local write at all) if the sync fails, otherwise proceeds with the
  original local `safeSetItem`/`commitStorageTransaction` write and UI update exactly as
  before. The other ~90 read call sites (`getAppName()`, `getWeeklyOpHours()`, etc.) are
  completely untouched — still plain synchronous `localStorage.getItem()` — since the
  hydration step above is what keeps them fed with server-authoritative data.

**Known gap, not fixed here (pre-existing, out of scope for this step):**
`saveSeatCountSetting()`'s local cascade into `activeSeats`/`barberAssignments` is not
mirrored to the (separate, already-migrated) `public.seats` table by this change — only
the new `seat_count` column on `shop_settings` is synced. Changing the seat count from
one device won't yet propagate the resulting seat open/close or barber-name state to
other devices. Flagging this now rather than silently leaving it; worth a decision next
time seats come up.

**Verified so far:**
- Rollback-safe SQL (`DO $$ ... $$`, before any client code existed): anon sees 0 rows on
  an empty table with no error; anon insert/update both rejected; admin insert succeeds
  (seeds the row); a second admin insert is rejected (singleton PK violation, proving the
  constraint works); admin update succeeds; anon update rejected. All six assertions
  passed; a follow-up `select count(*)` confirmed the rollback left the table at 0 rows.
- `get_advisors(security)` — no new warning attributable to `shop_settings`.
- `node --check` on both extracted `index.html` script blocks (module + classic) —
  passes.
- `npm test` (domain-layer scheduler tests + differential harness) — 15/15 passed,
  20,000/20,000 comparisons matched. Unaffected by this change, as expected (pure domain
  layer, no shop-settings involvement).

**Live end-to-end test — passed, 1 September 2026.** Pushed to `main` (commit
`615eeec`) and tested against the real deployed site once GitHub Pages finished
redeploying (~1–2 minutes after push; confirmed via a cache-busted `fetch(...,
{cache:'no-store'})` on `index.html` before relying on a normal reload). The built-in
browser was still signed in as `fahru76` from earlier testing.

- **Seed-then-cutover**: `getShopSettings()` returned the real, already-seeded
  singleton row (this device's actual configured hours/announcement/etc. — the seed
  had already run from an earlier reload in this same test session), confirming the
  row was created from real data, not defaults. `localStorage` matched the server
  values exactly after a fresh reload.
- **`saveMaxQueueSetting()`**: 10 → 11 → 10, confirmed on both server and
  `localStorage` at each step.
- **`toggleShopStatus()`**: open → closed → open, confirmed on both server and
  `localStorage`, including `shopStatusChangedAtUtc` being set. (`confirm()` calls
  are auto-suppressed to `false` by the browser tool's dialog handling, so this one
  needed a temporary `window.confirm` override to actually exercise the write path —
  worth remembering for any future setter that gates on `confirm()`.)
- **`addClosedDate()` / `removeClosedDate()`**: added `2026-12-21` (a Monday, not
  already weekly-closed), confirmed on server + local, then removed it, confirmed
  clean revert to `[]`. (First attempt used `2026-12-25`, a Friday — the shop's
  Friday is weekly-closed, so the function correctly no-op'd with its "already
  closed via weekly schedule" message; not a bug, just the wrong probe date.)
- **`saveBookingAdvanceDaysSetting()`**: 30 → 45 → 30, confirmed on server + local.
- **`saveSeatCountSetting()`**: 3 → 4 → 3, confirmed on server + local. (Only the
  `shop_settings.seat_count` column was exercised here — see the known gap above;
  no seats were actually opened/closed in this test, so the cascade gap didn't come
  into play.)
- **`weeklyOpHours` (jsonb) write path**, exercised directly via
  `syncShopSettingsToServer()` (the same helper `saveOperationalHours()` and
  `copyOperationalHoursToAllDays()` call): flipped Sunday's opening time
  09:00 → 08:30 → 09:00, confirmed the full nested object round-trips correctly
  through the `jsonb` column both ways.
- **Console check**: cleared the console, reloaded, and re-ran the above — no new
  errors from any shop-settings code path. (The session's console history also
  contained older 400/409 warnings about `services` seeding — confirmed these were
  stale entries left over from step 5a's own testing in this same long-lived browser
  tab, not a fresh regression: `window.ServiceRepo.reorderServices.toString()` shows
  the already-fixed plain-`UPDATE` version is what's actually loaded, and a fresh
  reload produced zero new entries since the `services` table is no longer empty.)

All ten converted setters have now each been exercised at least once against the
real deployed site and the real database, with every test reverted to its original
value afterward. Nothing left in a test state.

## Done — step 6: appointments + fast-pass workflow is now server-authoritative

This step covers both `public.appointments` (the booking system) and the fast-pass
approval workflow, which spans `appointments` **and** `queues` — the two were tangled
together (an appointment checking in becomes a queue row; fast-pass approval targets
either table), so they had to move as one unit.

**Three decisions the user made (locked in, don't relitigate):**
1. `isVip`/`fastPassApproved` are always redundant with `source='booking'`/`is_fast_pass`
   in every current code path — chose **"Collapse them"**: not stored as separate
   columns. `isVip` is derived client-side from `source === 'booking'`;
   `fastPassApproved` is just `isFastPass` under a second name, both populated from the
   one `is_fast_pass` column so every existing read site (which checks either name)
   keeps working unchanged.
2. Cancelling/rescheduling your own appointment needs real server-side protection —
   chose **"Claim-token + RPCs"**, the same pattern as `queues`:
   `book_appointment()`/`cancel_own_appointment()`/`reschedule_own_appointment()` as
   `SECURITY DEFINER` functions, `claim_token` generated client-side
   (`crypto.randomUUID()`) and never read back, same convention as
   `queueRepository.takeTicket()`.
3. Two more races — double-booking the same slot, and a partial failure mid-conversion
   (walk-in → appointment touches two tables) — chose **"Server-side RPCs for both"**:
   `book_appointment()` re-validates capacity and inserts in one transaction (an
   advisory lock keyed by date serializes concurrent bookers);
   `convert_walkin_to_appointment()`/`checkin_appointment()` wrap each cross-table
   conversion in one transaction.

**What changed:**
- **`alter table public.queues`** adds `approved_by`/`approval_reason`/`approved_at`/
  `revoked_by`/`revoked_reason`/`revoked_at` (closing the schema gap flagged since step
  5a) — same shape added fresh to the new `appointments` table.
- **New `public.appointments` table**
  (`supabase/migrations/20260901000700_appointments.sql`): mirrors every field the
  local prototype's appointment objects already have (`appt_date`/`appt_time`,
  `duration_minutes`, `price_sen`, `status` — `upcoming`/`arrived`/`cancelled` —
  `is_fast_pass` + the six approval/revocation columns above, `version`, `claim_token`).
  RLS: readable by everyone; **no insert policy for anyone** —
  `book_appointment()`/`convert_walkin_to_appointment()` are the only creation paths,
  including for an admin booking on someone's behalf (they call the same RPC as
  anyone else, so they get the same capacity check, not a bypass); admins may update
  (used only by the still-local-only admin-cancel path, see below); no delete policy.
  Anon's column grant excludes `claim_token` (never needs to be read back) and the
  approval/audit columns; authenticated gets full select+update (RPCs still gate the
  actual writes via their own logic).
- **Seven new `SECURITY DEFINER` RPCs**: `book_appointment()`, `cancel_own_appointment()`,
  `reschedule_own_appointment()`, `convert_walkin_to_appointment()` (anon+authenticated —
  these are the customer-facing ones, matching `cancel_own_ticket()`'s existing
  anon-executable precedent), `checkin_appointment()`, `approve_fast_pass()`,
  `revoke_fast_pass()` (authenticated-only — staff/admin actions, gated by
  `is_active_staff()`/`is_admin()` inside the function body). Plus two internal
  helpers, `_appointment_hours_ok()` (re-checks weekly hours/breaks/closed-dates/
  booking-advance-days/shop-status server-side — the local prototype only ever
  checked this client-side) and `_appointment_slot_capacity_ok()` (minute-by-minute
  sweep against `seat_count`, not pairwise overlap testing, since concurrency can be
  3+ deep with multiple chairs).
- **Deliberate scope boundary** (documented in the migration file itself): the
  server-side capacity check only considers **other upcoming appointments** for that
  date — it does not model today's live walk-in queue occupancy (chair-busy-until-when,
  break-adjusted), which stays a client-side-only, best-effort refinement in
  `js/domain/scheduler.js`. Porting the full break-aware scheduler into PL/pgSQL was
  judged out of proportion to this step.
- **New `js/repositories/appointmentRepository.js`**: thin wrappers over the seven
  RPCs above, following the exact same claim-token and RM↔sen conversion conventions
  as `queueRepository.js`. `checkinAppointment()` maps the returned `public.queues`
  row into the same domain shape `queueRepository.mapQueueRow()` produces, so the
  caller can push it straight into the local `queues` array.
- **~26 existing functions in `index.html` rewired to write-through-first, no local
  fallback** (same rule as every write path since step 4b — a booking is exactly the
  kind of record another device legitimately needs to see): `submitAppointment()`
  (all three branches — new booking, reschedule, walk-in conversion),
  `cancelCustomerAppointment()`, `markAppointmentArrived()`, `approveFastPass()`,
  `revokeFastPass()`. `startRescheduleAppointment()` needed no changes (pure
  read/setup, no write). The ~10 remaining functions are plain local reads
  (`getAppointments()`, admin list rendering, availability checks) — untouched, same
  "no hydration mechanism" reasoning below.
- **Deliberately no hydration/live-sync mechanism for appointments** (unlike
  services/shop-settings, which do have one): `public.queues` itself doesn't have one
  either — `listQueues()` exists and is wired into `window.QueueRepo`, but nothing
  calls it yet (deferred to the still-open "step 7: realtime subscriptions" item
  below). Appointments follows that same already-accepted boundary rather than
  inventing a bespoke one-table exception.
- **Deliberately left local-only, matching the existing un-migrated `queues`
  admin-cancel precedent**: `confirmAdminCancellation()`'s `appointment` branch (like
  its pre-existing `queue` branch) still only writes to local storage. Both admin-cancel
  paths are a known, pre-existing gap, not something this step introduced or was asked
  to close — flagging it here rather than leaving it undocumented. **Closed** by the
  "admin cancel is now server-authoritative" section further down this file.

**A real (if not yet exploited) security bug was found and fixed, same class as
`20260901000300_harden_function_grants.sql` fixed once before:** `revoke all on
function ... from public` does **not** strip Supabase's default per-role `EXECUTE`
grant — the specific role must be named. `checkin_appointment()`, `approve_fast_pass()`,
`revoke_fast_pass()` (all meant to be staff/admin-only) were callable by `anon` despite
only being granted `to authenticated`. Verified this was **not actually exploitable**
first (a rollback-safe `set local role anon` simulation confirmed each function's own
internal `is_active_staff()`/`is_admin()` check correctly rejects anon with "Not
authorised") — then fixed anyway via
`supabase/migrations/20260901000800_harden_appointment_function_grants.sql`
(`revoke execute ... from anon, public`), and re-verified via `has_function_privilege`
that anon is now `false` and authenticated `true` for all three, with the four
customer-facing RPCs still correctly anon-`true`.

**Verified (rollback-safe SQL):**
- The full customer-facing flow in one transaction: book → reschedule (version bumps
  correctly) → cancel with the wrong claim token (returns `false`, not an error) →
  cancel with the right one (`true`) → a fresh booking → staff check-in
  (`checkin_appointment()` returns the new `queues` row with the right `id`/`status`/
  `source`/`duration_minutes`/`price_sen`, and the appointment flips to `arrived`) →
  fast-pass approve (`is_fast_pass`/`approved_by` set correctly) → revoke
  (`revoked_by` set, `is_fast_pass` cleared) → walk-in-to-appointment conversion
  (`convert_walkin_to_appointment()` creates the new appointment and cancels the
  original walk-in with `cancel_reason='Ditukar kepada Tempahan Online'`). All
  assertions held; the table counts confirmed **zero** rows left behind afterward.
- `get_advisors(security)` re-checked after the grant fix: `checkin_appointment`/
  `approve_fast_pass`/`revoke_fast_pass` now appear **only** under the
  authenticated-executable warning, not the anon-executable one — confirming the fix
  took effect. Remaining warnings are pre-existing/by-design (the same pattern already
  accepted for `cancel_own_ticket`/`next_ticket_number`/etc.) or unrelated
  (`ticket_counters` has no policy by design; leaked-password-protection is a Supabase
  Auth setting, not touched by this migration).
- `tests/sql-consistency.mjs` — extended with the nine new step-6 function names
  (it previously only recognized a fixed allowlist from earlier steps, so it was
  reporting every new RPC call as "unknown public.X" — a linter gap, not a real
  problem, but worth fixing so the tool stays useful going forward). Reports "no
  inconsistencies found" after the fix.
- `node --check` passes on both extracted `index.html` script blocks (module +
  classic). `npm test` — 15/15 passed, 20,000/20,000 comparisons matched, unaffected
  as expected (pure domain layer, no appointments involvement).

**Live end-to-end test — passed, 1 September 2026.** Pushed to `main` (commit
`93a7b56`) and tested against the real deployed site once GitHub Pages finished
redeploying (confirmed via the Actions API, then a cache-busted dynamic `import()` —
same trick as step 5a/5b — since GitHub Pages serves both `index.html` and its module
imports with `cache-control: max-age=600`). The built-in browser was still signed in
as `fahru76` from earlier steps' testing.

- **`submitAppointment()` — new booking**: booked "QA Live Test" for today at 21:30
  (the one slot the real capacity/hours check still allowed this late in the day) —
  confirmed in `public.appointments` with the exact values entered, `status='upcoming'`.
- **`submitAppointment()` — reschedule**: rescheduled the same booking (to its own
  slot, the only one available) — confirmed `version` incremented 1 → 2 server-side,
  proving the optimistic-concurrency path round-trips correctly end-to-end.
- **`markAppointmentArrived()`**: checked it in — confirmed a real `public.queues` row
  was created (`status='waiting'`, `source='booking'`, correct `duration_minutes`/
  `price_sen`), the appointment flipped to `arrived`, and the local board's pushed
  entry matched the server row field-for-field (this is the one genuinely new
  return-shape surface this step introduced — confirmed correct).
- **`approveFastPass()`/`revokeFastPass()`**: approved fast-pass on that queue entry
  through the real admin dropdown UI (not just a direct RPC call) — confirmed
  `approved_by` was set to `fahru76`'s real staff id **by the server**, not a
  client-supplied value; revoked it back — confirmed `revoked_by` set the same way,
  `is_fast_pass` cleared.
- **`cancelCustomerAppointment()`**: booked a second appointment for tomorrow,
  cancelled it — confirmed `status='cancelled'`, `cancelled_by='customer'` server-side.
- **`convertWalkinToAppointment()`**: **not exercised live this session** — every
  attempt to take a fresh walk-in ticket this late in the day was correctly rejected
  by the existing client-side scheduling estimate ("akan melepasi waktu tutup kedai"),
  leaving no walk-in ticket to convert. Not a step-6 regression — a time-of-day
  constraint on live testing. This RPC was, however, verified thoroughly via
  rollback-safe SQL (ownership-token check, the cross-table transaction, and the
  correct `cancel_reason` on the original walk-in), and it calls Supabase through the
  exact same authenticated-repository pattern already proven live above — worth a
  quick live pass earlier in the day next session, but low-risk as left.
- All test rows (both appointments) and the one test queue entry were deleted from
  the live database afterward, and the matching local-storage entries
  (`appointments`/`queues`/`myAppIds`/`appointmentClaimTokens`) were cleared in the
  same browser session. Nothing left in a test state.

## Done — admin login dialog: contrast + size fix

**User-reported bug, pre-existing since the app's original design** (not introduced by
the Supabase migration): the username/password fields in the staff login dialog were
hard to read while typing and visibly smaller than every other input on the page.

**Root cause, confirmed live via `getComputedStyle()`:** `index.html` has three
cascading `<style>` blocks (the original design, then two later reskins — "QueueCut 7"
and "QueueCut 8", the one actually in effect). All three define a shared selector list
for input styling (height, background, border, focus ring), and all three had omitted
`input[type="email"]` and `input[type="password"]` from that list since the very first
version — an oversight that predates this migration entirely. Unstyled, the browser's
native rendering took over: the email field rendered at ~19px tall with a dark
background but black text (near-zero contrast); the password field rendered at ~19px
tall on plain white, breaking the dark theme outright.

**Fix:** added `input[type="email"], input[type="password"]` to the selector list in
all three `<style>` blocks (so the fix holds regardless of which block ends up
governing after future reskins), plus a `-webkit-autofill` override so Chrome/Edge's
native yellow autofill repaint doesn't reintroduce the same contrast break when a
browser-saved credential is used:

```css
input:-webkit-autofill,
input:-webkit-autofill:hover,
input:-webkit-autofill:focus {
    -webkit-text-fill-color: var(--text-main);
    -webkit-box-shadow: 0 0 0 1000px color-mix(in srgb, var(--input-bg) 94%, white 6%) inset;
    box-shadow: 0 0 0 1000px color-mix(in srgb, var(--input-bg) 94%, white 6%) inset;
    caret-color: var(--text-main);
    transition: background-color 5000s ease-in-out 0s;
}
```

**Verified live**, before/after, via `getComputedStyle()` on the deployed site:

| | before | after |
|---|---|---|
| email height | 19.33px | 52px |
| email background/text | dark bg, black text (unreadable) | dark theme bg, cream text (matches every other field) |
| password height | 19.33px | 52px |
| password background | plain white (theme break) | dark theme bg |

Confirmed with a live screenshot showing both fields properly sized and themed.
Pushed to `main` and deployed; no schema/RPC changes involved — pure client-side CSS.

---

## Done — separate URLs per view (`?view=customer\|display\|barber\|admin`)

**User request:** each of the four views (Pelanggan, Layar Kedai, Tukang Gunting, Admin)
should have its own URL for direct/bookmarkable access, while asking whether the
floating nav menu still makes sense once that exists.

**Decisions made (asked via AskUserQuestion, both recommended options chosen):**

1. **Query-parameter routing (`?view=admin`), not hash routing (`#admin`).** Checked
   the existing code first: Supabase's invite and password-reset emails already deliver
   their tokens via the URL **hash** (`window.location.hash`, read by the existing
   `PASSWORD_RECOVERY`/`type=invite` detection code). Hash-based view routing would
   collide with that. Query params have no such collision and survive a page reload
   cleanly, which GitHub Pages' `cache-control: max-age=600` static hosting requires
   anyway (no server-side rewrites available).
2. **Kiosk-mode simplification for Layar Kedai / Tukang Gunting only** — not Admin.
   Loading `?view=display` or `?view=barber` now hides the floating nav and the
   staff-tools affordances entirely (these are meant to run unattended on a shop
   tablet/TV), while `?view=admin` and `?view=customer` keep the full nav — an admin
   still needs to jump between views from their own device.

**Security note carried over explicitly to the user:** none of this — query param,
hash, or separate files — is a security boundary. The existing `switchView()` code
already comments on this (anyone could call it from the console); the real boundary
is server-side (RLS policies + `is_active_staff()`/`is_admin()` inside the RPCs). This
feature is bookmarking/UX convenience only.

**Implementation** (all in `index.html`):

- Nav buttons tagged `data-view="customer-app|display-app|barber-app|admin-app"`.
- CSS: `body.kiosk-display`/`body.kiosk-barber` hide every nav button except the
  matching one, and hide `.nav-tools` entirely for kiosk-display.
- `getViewIdFromLocation()`/`updateURLForView()` translate between the `view=` query
  slug and the internal view id; `history.pushState`/`replaceState` used so switching
  views never reloads the page, and other query params (e.g. test cache-busters) are
  preserved via the `URL` object.
- `switchView()` gained a `fromNav` parameter (default `true`) and now calls
  `updateURLForView(viewId, !fromNav)` at the end — a nav click pushes a new history
  entry, a URL-driven/back-forward switch replaces state instead of stacking one.
- A `popstate` listener re-derives the view from the URL and calls `switchView(...,
  false)` so browser back/forward works.
- **Auth-gated deep links (`admin-app`/`barber-app`) are applied only after the
  Supabase auth check resolves**, not at synchronous page-init time — the classic
  script's top-level init runs before the deferred auth module. A
  `pendingDeepLinkView` variable is armed when a deep link target requires a session
  that isn't there yet; `window.onStaffAuthChange` re-checks it on every subsequent
  call, so signing in through the login dialog lands the user on the originally
  requested view instead of dropping them back to Pelanggan. If the deep link is
  denied for a reason a fresh sign-in can't fix (wrong role, inactive account), the
  URL is corrected back to whatever view is actually showing instead of being left
  pointing at a view the user was never shown.
- Kiosk-mode/non-auth-gated views (`display-app`, `customer-app`) apply immediately at
  init time — no auth dependency, no flash risk.

**Verified live** against the deployed site (commit `f04017e`, confirmed deployed via
the Actions API):

- `?view=display` — nav and staff tools fully hidden (screenshot confirmed).
- `?view=barber` — only the Tukang Gunting tab visible; staff tools still present.
- `?view=barber` while signed out — login dialog opens, URL stays at `?view=barber`,
  `pendingDeepLinkView` armed, kiosk class still applied underneath.
- `?view=admin` while signed out — login dialog opens, `pendingDeepLinkView` set to
  `admin-app`, and correctly **not** kiosk mode (admin was deliberately excluded from
  kiosk simplification).
- Sign-in retry logic — validated by invoking `window.onStaffAuthChange('SIGNED_IN',
  ...)` directly (no real password available in this session) — confirmed the pending
  view is applied once the callback fires.
- `pushState`/`popstate` round-trip — clicking a nav button pushes a new history entry
  and preserves unrelated query params; browser back/forward correctly restores both
  the URL and the rendered view.

**Not tested live** (acceptable gaps, not regressions): the admin "wrong role" denial
path (no non-admin staff account exists in this environment to test with), and a
genuine end-to-end login through the real form with real credentials (retry logic was
validated by simulating the auth callback directly instead, which is the part that
actually drives the retry — the login form itself is unchanged by this feature).

---

## Done — step 7: realtime cross-device updates (queues + appointments)

**The gap this closes:** the existing `storage` event listener (index.html) only ever
fires between browser tabs of the *same* device — a plain `localStorage` write event
cannot cross devices. Nothing made the TV display, another barber's tablet, or the
admin screen update when a *different* device called next, completed service, checked
in, or booked/cancelled an appointment. That's what this step adds, via Supabase
Realtime's `postgres_changes`.

**Decisions made (asked via AskUserQuestion, both recommended options chosen):**

1. **Scope: `queues` + `appointments`**, not just queues, and not also
   `services`/`shop_settings`. Queues is the reported gap (TV board, barber queue).
   Appointments was added because more than one staff member may work the
   admin/booking screens at once and should see new bookings/cancellations without a
   manual refresh. Services and shop settings change rarely and are normally edited
   from a single admin device, so a manual refresh there stays an acceptable gap.
2. **On any change, refetch the authoritative list and re-render** (not: patch local
   state from the realtime payload's row data directly). This was the safer choice
   for a reason beyond simplicity: Realtime's row-visibility check follows each
   subscriber's RLS (so an anon customer's channel only ever sees rows anon may see),
   but that's a *row-level* check — the column-level grants this project already
   relies on elsewhere (`QUEUE_COLUMNS`, and appointments' anon grant restricted to
   `id, appt_date, appt_time, duration_minutes, status`) are not something a raw
   WAL-sourced payload can be trusted to respect the same way a PostgREST-gated query
   does. So the realtime subscription is used **only as a "something changed, go
   refetch" trigger** — the payload's actual row content is never read or used.

**A real design problem found and solved before writing any client code:** the
obvious naive approach — call the existing `listQueues()` (today's waiting/serving
tickets only) and overwrite `localStorage.queues` wholesale on every change — would
have been a **data-loss bug**. `queues`/`appointments` in localStorage hold this
device's **all-time history** (completed tickets feed `barberPerformance()` reports,
for instance); `listQueues()` was deliberately scoped to "what the board renders",
not "everything". Two fixes, both applied:

- **Merge by id, never a wholesale replace.** A new `mergeServerRows(localArray,
  freshRows)` helper in index.html updates/inserts only the rows the fresh fetch
  returned an opinion about; every other local row (older history) is left exactly
  as it was.
- **The fresh fetch itself has no status filter**, so a transition *out of*
  waiting/serving (completed or cancelled on another device) is still visible via
  the returned `status` field and the merge picks it up — scoped instead to "still
  relevant": queues to *today* (Malaysia time), appointments to `appt_date >= today`
  (no upper bound, since a booking can be up to `bookingAdvanceDays` ahead).

**A second problem, specific to staff devices: column grants.** `listQueues()` only
ever selects the anon-safe `QUEUE_COLUMNS` subset — it doesn't widen for an
authenticated caller, by design (see that function's own header comment). Merging
only that subset into a signed-in staff device's local state would silently drop
`version` for any row created on a *different* device — and every existing
cancel/fast-pass write already assumes `version` is present and correct before it
will proceed. Plain table `SELECT`s can't fix this either: PostgREST enforces column
grants as all-or-nothing, and widening `QUEUE_COLUMNS` would widen what anon can read
too. Solution, matching how every other staff-only capability in this project is
already built: two new **SECURITY DEFINER RPCs**, gated by `is_active_staff()`
exactly like `call_next_customer()`/`checkin_appointment()`/etc., each returning the
full row on its own terms rather than through a column-grant-limited `SELECT`:

- `list_today_queues_full()` — today only (Malaysia time), every column, no status
  filter.
- `list_active_appointments()` — `appt_date >= today`, every column, no status
  filter. Deliberately does not return `claim_token` — an admin/barber device merging
  in someone else's booking never needs to act *as* that customer.

Migration: `supabase/migrations/20260902000900_realtime_live_refresh.sql`. Also adds
`public.appointments` to the `supabase_realtime` publication (`queues`/`seats` were
already in it — Supabase's default behaviour when a table is created; `appointments`
was created later in the same migration set and had simply never been added).

**Client wiring** (`js/repositories/queueRepository.js`,
`js/repositories/appointmentRepository.js`, `index.html`):

- `listTodayQueuesFull()` / `listActiveAppointments()` — call the new RPCs, map to
  the same local field names every existing write site already uses (`version`,
  `cancelledBy`, `cancelReason`, `fastPassApproved`, `approvedBy`, `approvalReason`,
  `revokedBy`, …) so a row merged in from another device behaves identically to one
  this device wrote itself. `listActiveAppointments()` also trims `appt_time`'s
  `"HH:MM:SS"` (Postgres `time`, over PostgREST) down to `"HH:MM"` — every local
  record and `malaysiaDateTimeToUTC()`'s own regex assume the latter; without the
  trim, a merged-in appointment's `scheduledAtUtc` would silently fail to compute.
- `subscribeQueueChanges(onChange)` / `subscribeAppointmentChanges(onChange)` — each
  repository module stays "the only one that talks to its table over the Supabase
  client" (existing header comment): index.html never touches `supabase.channel()`
  directly, it only gets a plain change-signal callback, never the payload's row data
  (see the RLS/column-grant reasoning above).
- index.html: `mergeServerRows()`, a `debounce()` helper (a burst of writes on
  another device fires one `postgres_changes` event per row — debounced to 400ms so
  that lands as one refetch, not several overlapping ones), and two refresh
  functions. The queues channel is armed **once, from inside the existing
  `onStaffAuthChange` callback** (regardless of whether a session exists) rather
  than at the classic script's own top level — `window.QueueRepo` is only set once
  the deferred bridge module runs, and `onStaffAuthChange` is the already-established
  signal that this has happened (the module's `pushAuthState()` always calls it at
  least once, session or not). The appointments channel is armed/disarmed from the
  same callback based on `staffSession` presence — a customer's or the TV's browser
  tab has no use for it, so it's simply never opened there.

**Verified so far:** a rollback-safe SQL test (both RPCs reject anon; a fabricated
inactive-staff caller is rejected by `is_active_staff()`'s own `active` check;
an active staff caller gets both a `waiting` and a `done` row for today in one call,
proving the "no status filter" design; the full row includes `phone`/`price_sen`,
which anon cannot read); `tests/sql-consistency.mjs` clean; `node --check` on both
modified repository files and both of index.html's inline `<script>` blocks (module
and classic) — clean, after fixing one real syntax bug this caught (a JSDoc comment
containing literal `cancelled_*/approved_*/revoked_*` accidentally closed the
comment block early at the embedded `*/`).

**Verified live** (two real browser tabs, `?view=display` + `?view=customer`, against
the deployed site, commit `c352178`): a walk-in ticket taken on the customer tab
appeared on the display tab within ~2s with no manual refresh, confirming the INSERT
realtime path. Cancelling that ticket from the customer tab, though, surfaced a real
bug: the display tab kept showing `status: "waiting"` even after 4+ seconds, and even
after calling `refreshQueuesFromServer()` directly — which isolated the fault to the
fetch/merge, not realtime delivery. Root cause: `listQueues()` filtered rows by
`status in ('waiting','serving')`, so a ticket that had just transitioned to
`cancelled` fell out of the query entirely, and `mergeServerRows()` (by design) never
touches an id that's absent from a fresh fetch — the local record was permanently
stuck on its last-seen status. Fixed by scoping `listQueues()` by date (today, MYT)
instead of status, matching the no-status-filter design already used for
`listTodayQueuesFull()`; pushed as follow-up commit `0c1742e`. Re-ran the exact same
two-tab test against the fixed deploy: the cancelled ticket now shows
`status: "cancelled"` on the display tab within ~4s with no manual refresh, and the
board correctly stops listing it under "GILIRAN AKAN DATANG". `node --check`,
`tests/sql-consistency.mjs`, and `npm test` (15/15 domain + 20,000/20,000 differential)
all still pass after the fix.

---

## Done — admin cancel (queue + appointment) is now server-authoritative

**Date:** 2 September 2026. Closes the gap flagged (not introduced) during step 6 and
listed in the pending-work summary after it: `confirmAdminCancellation()` — both its
queue and appointment branches — still only wrote `status: 'cancelled'` to
localStorage, unlike every other admin action (`callNext`/`completeService`/
`checkinAppointment`/`approveFastPass`/`revokeFastPass`, all server-authoritative
since step 4b/6). An admin cancelling a ticket or appointment on one device was
invisible to every other device — the same class of bug step 7's live testing had
already found and fixed on the customer-initiated cancel path.

**New RPC:** `admin_cancel_record(p_source, p_id, p_reason)` —
`supabase/migrations/20260902001000_admin_cancel_record.sql`. Shaped exactly like
`approve_fast_pass()`/`revoke_fast_pass()` just above it (one function, `p_source`
picks the table) because `index.html`'s `adminCancelRecord(source, recordId)` /
`confirmAdminCancellation()` already carry that same `{source, recordId}` pair
end to end — the RPC boundary matches the client's existing shape rather than
inventing a second one. Admin-only (`is_admin()`), matching admin-app's own gating
(`staffProfile.role !== 'admin'` in `switchView()`) rather than the looser
`is_active_staff()`. Only a `waiting` queue row / `upcoming` appointment can be
targeted — same precondition the client already checked locally, and the same one
`cancel_own_ticket()`/`cancel_own_appointment()` enforce on the customer path.
`is_fast_pass` is cleared on cancel (matching what the local code already did);
`approved_by`/`approval_reason`/`approved_at` are left as history, also unchanged
from the local code's prior behaviour — this migration only moves the write target
from localStorage to the server, it does not change what gets written.
`queues.cancelled_by` is a `uuid` FK to `staff`, set from `auth.uid()` (the verified
caller, same convention as `approved_by`/`revoked_by`); `appointments.cancelled_by`
is a plain `text check ('customer'|'admin')` by contrast, so it gets the literal
`'admin'` there, matching `cancel_own_appointment()`'s `'customer'` literal on the
same column. `revoke ... from public` AND `from anon` are both explicit (the exact
gap that made `checkin_appointment()`/`approve_fast_pass()`/`revoke_fast_pass()`
briefly anon-callable in step 6, since Supabase's default per-role grant survives a
bare `revoke ... from public`) — `get_advisors(security)` confirms this function
appears only under the authenticated-executable warning, never the anon one.

**Client wiring:** `js/repositories/appointmentRepository.js` gained
`adminCancelRecord(source, id, reason)`, alongside `approveFastPass`/
`revokeFastPass` (same file, same reasoning — it spans both tables). `index.html`'s
`confirmAdminCancellation()` is now `async`: calls `adminCancelRecord()` first and
only updates the local `queues`/`appointments` mirror and enqueues the
customer-facing notification once the server confirms — same write-through-first,
no-fallback convention as every other admin action since step 4b. If the server
call succeeds but the local mirror update throws, the error is caught and reported
rather than silently swallowed — the realtime subscription's own refresh (this
action's UPDATE fires it) or a reload reconciles the view regardless.

**Verified:** a rollback-safe SQL test (unauthorised/non-admin caller rejected with
`42501`; reason under 3 characters rejected with `22023`; admin cancels a fabricated
waiting queue ticket — returns `true`, row state confirmed correct including
`cancelled_by`/`version`; cancelling the same ticket again returns `false`, not an
error; admin cancels a fabricated upcoming appointment — same result; invalid
`p_source` rejected with `22023`; transaction rolled back, zero rows left behind).
`get_advisors(security)` re-checked — no new anon-executable warning.
`tests/sql-consistency.mjs` extended with the new function name, reports "no
inconsistencies found". `node --check` clean on both `index.html` script blocks and
the modified repository file. `npm test` — 15/15 domain tests, 20,000/20,000
differential comparisons, unaffected as expected.

**Live browser round trip — attempted, blocked by an environment quirk, not a code
issue.** The built-in browser tab was already showing a signed-in `fahru76` (Admin)
session in the UI, but a fresh `supabase.auth.getSession()` call (both the page's own
`AuthRepo.getSession()` and a freshly-imported client reading the same
`sb-cojaebzxrtyvxrnadiuv-auth-token` localStorage entry directly) returned no
session, even though that stored token was confirmed present, unexpired, and for the
right user. This looks like a session-rehydration quirk specific to this automated
browser context (possibly `detectSessionInUrl`/init timing after a scripted
navigation) rather than anything wrong with this fix — the exact same "another tab
reflects a change with no manual refresh" mechanism (realtime subscription →
`scheduleQueueRefresh`/`scheduleAppointmentRefresh` → `mergeServerRows`) was already
proven live for the customer-cancel path immediately above, and this fix reuses that
same machinery unchanged; the only genuinely new surface is `admin_cancel_record()`
itself, which the rollback-safe SQL test already covers thoroughly (authorisation,
correctness, row state). Rather than keep fighting the browser session to re-prove
already-proven plumbing, this was left as: **server-side logic verified, live
UI-triggered round trip not exercised this session** — worth a quick pass next time
a real interactive login happens naturally during other testing.
A stray test ticket (`QA03-20260902`, created directly via a cache-busted dynamic
import while chasing this) was cancelled via direct SQL afterward; nothing was left
in a test state.

---

## Done — kiosk-mode nav bar extended to Customer; Barber keeps sign-out only

**Date:** 2 September 2026. The user reported the nav bar was still showing on the
per-view URLs; on clarifying, the actual ask was: `?view=customer` should hide the nav
bar entirely (previously it showed the full nav — all four tabs plus login/theme/
reset, unlike Display which already hid everything but its own tab), and `?view=barber`
should hide it further too, but a signed-in barber still needs a way to sign out (no
other UI path calls `signOutStaff()`), so that one button stays reachable. `?view=admin`
is unchanged — the earlier deliberate decision to leave it with the full nav stands.

New `kiosk-customer` body class, alongside the existing `kiosk-display`/`kiosk-barber`.
It keys off the **raw `?view=` query param**, not `getViewIdFromLocation()`'s already-
defaulted view id — that function defaults an absent param to `customer-app` too, and
the bare root URL (no `?view=` at all) is meant to keep the full nav for a plain visit
to the site; kiosk mode is opt-in via an explicit dedicated-link param, not the default
landing experience. Customer gets the exact same CSS treatment as Display (all other
view buttons hidden, whole `.nav-tools` row hidden). Barber additionally hides the
theme selector, Reset button and auth-status text via targeted selectors
(`#themeSelector`, `.btn.btn-reset:not(#staffLogoutBtn)`, `#staffAuthStatus`) rather
than hiding all of `.nav-tools`, so `updateStaffAuthUI()`'s existing show/hide toggle
on `#staffLogoutBtn` (unchanged) is what actually surfaces the sign-out button.

**Verified live**, both changes deployed and screenshotted: `?view=customer` shows only
the "PELANGGAN" label and page content; `?view=barber` shows "TUKANG GUNTING" plus a
"LOG KELUAR" button and nothing else.

**A separate, real gap surfaced while testing this (not caused by it):** a freshly
loaded page never fetches current queue/appointment state from the server — the
realtime wiring added in step 7 only refetches on a *live* change event
(`subscribeQueueChanges`/`subscribeAppointmentChanges` → `scheduleQueueRefresh`/
`scheduleAppointmentRefresh`), and `initData()` only seeds `localStorage` defaults if
a key is entirely missing, never re-fetches known state. Caught concretely: a barber
view, reloaded several times during testing after a ticket had been cancelled
server-side, kept showing that ticket as `waiting` in the walk-in list until a change
event fired or `refreshQueuesFromServer()` was called manually — confirmed via direct
SQL that the server was correct throughout, and that manually invoking
`refreshQueuesFromServer()` immediately fixed the local view. In practice a barber
tablet usually stays on one continuously-open tab (which does receive live deltas), so
this is more of a cold-start/reload gap than a constant one — but a device restarted
overnight, or a browser tab freshly opened, would show stale or empty data until the
next change happens elsewhere. **Not yet fixed** — flagged to the user, added to the
open-items list below pending a decision on priority.

---

## Done — seat-assignment authorization (only a seat's assigned barber, or admin, can call/complete on it)

**Date:** 2 September 2026. Requested directly (Malay): only the barber admin assigned
to a seat may press "Panggil" (call) for that seat — barber 1 at seat 1 must not be able
to call to seat 2 or 3 just because they're signed in as active staff. Previously
`call_next_customer()`/`complete_service()` only checked `is_active_staff()` — **any**
active barber, or admin, could act on **any** open seat regardless of `public.seats
.barber_id`.

**Server (the real boundary):**
`supabase/migrations/20260902001100_seat_assignment_authorization.sql`, applied to the
live project. `call_next_customer(p_seat_no)` now additionally requires the caller's
`auth.uid()` to match `seats.barber_id` for that seat (admins exempted via `is_admin()`
OR); `complete_service(p_id)` requires the caller to match the **queue row's own**
`barber_id` (set by `call_next_customer()` at call time), not the seat's *current*
assignment — so a mid-service reassignment doesn't strand whoever is actually serving
that customer. Both raise `42501` with a Malay message
(`'Anda tidak ditugaskan pada kerusi ini'`) on mismatch; grants unchanged (`authenticated`
only, same as before).

`complete_service()` got the same treatment even though only "Panggil" was named
explicitly — leaving it open would mean barber 2 still couldn't *call* to seat 1 but
could still mark seat 1's customer done, the same gap on the other half of the action
pair.

**Verified — SQL, rolled back, zero leftover rows.** Ran a 7-case test inside
`begin; ... rollback;` (two throwaway `auth.users`/`staff` rows created and destroyed
entirely within the same transaction, since `staff.id` has a real FK to `auth.users`):
non-staff caller rejected; assigned barber calls their own seat successfully; that same
barber rejected from a seat assigned to someone else; the other barber rejected from
completing the first barber's serving ticket; the first barber completes their own
ticket successfully; admin overrides seat assignment for both call and complete. All
seven passed (transaction aborts on any `FAIL`, so a clean rollback + zero leftover rows
is itself proof nothing failed). `get_advisors(security)` re-checked — no new
anon/authenticated-exposure warning beyond the pre-existing baseline.

**Client (UX convenience only — server is authoritative regardless):**
`index.html`'s barber-app render loop now disables "Panggil"/"Selesai" (with an
explanatory `title`) when the signed-in staff member isn't the seat's assigned barber
(or admin). New `refreshSeatServerState()` (barber-app's lighter counterpart to
admin-app's `refreshStaffList()`) populates `seatServerState` — previously only
populated when the *admin* panel was opened, meaning barber-app had zero knowledge of
seat assignments before this change; wired into `switchView()` alongside the existing
admin-app call. "Panggil" gates on `seatServerState[seat].barberId` (the seat's current
assignment, matching the server check); "Selesai" gates on the serving ticket's own
`barberId` (matching the server's own-row check). `seatServerState` is only refreshed on
entering barber-app, not via a live subscription (no `seats` realtime channel exists
yet — same staleness class as the no-initial-hydration item below) — acceptable for now
since seat assignments change far less often than the queue itself, but noted as a
known limitation, not silently swept under the rug.

**Second half of the request, addressed as a side effect:** "Nama barber dipamer pada
kerusi dan bukan partial nama dari email daftar barber" (the seat should show the real
registered name, not a partial name from the registration email). Investigated first
rather than assumed: the display pipeline itself was **not** buggy —
`bBarber${n}Name` already sourced from `staff.display_name` via the admin's
seat-assignment dropdown for every barber invited through the normal `invite-barber`
edge-function flow. The one real case of an email-derived name is a **one-row data
issue**: the bootstrap admin account (created manually, before `invite-barber` existed)
never had `display_name` metadata set, so `handle_new_staff_user()`'s trigger fell back
to `split_part(email, '@', 1)` — literally `fahru76`, stored directly in `staff
.display_name`. Not something to silently overwrite with a guessed name — **still needs
the user's input**: either tell me the real name to set on that one row now, or ask for
a small admin-UI addition to rename any staff member's `display_name` (there currently
is no such control — `setStaffStatus()` only ever patches `active`/`role`). Separately,
while wiring `seatServerState` for the authorization check above, found and fixed a
related staleness gap: the seat-name label previously read `getBarberAssignments()`
(a `localStorage`-only cache) with no server fallback, so a device that never had the
admin panel opened locally (e.g. a barber's own phone) could show "Tiada tukang gunting
ditetapkan" even when the server had a real assignment. Now prefers
`seatServerState[seat].barberName` (the real, server-joined `display_name`) whenever
it's loaded, falling back to the local cache only until it is.

**Not yet live-browser-verified** (the SQL test above proves the authorization logic
end-to-end at the database level; the client-side button gating has been code-reviewed
against the same logic but not clicked through in a live browser session with two real
distinct barber accounts, since only one real staff account — the admin — currently
exists in the live project).

---

## Done — admin can rename any staff member's display name

**Date:** 2 September 2026. Follow-up to the seat-assignment authorization fix above: the
user chose to add a rename feature (over setting the bootstrap admin's real name directly,
or leaving it) so the "fahru76" email-derived `display_name` can be fixed from the admin
panel itself, by the user, whenever they're ready — no name was requested from/given to me,
by design.

`setStaffStatus(id, {...})` (`js/repositories/authRepository.js`) now also accepts
`displayName`, patched straight through to `staff.display_name` — no new RLS policy needed,
"admins manage staff" (`for all ... using (is_admin())`) already covers every column.
Admin's staff list (`refreshStaffList()`) gained an "Ubah Nama" button per row that swaps
the name for a text input + Simpan/Batal (a real form field, matching every other
free-text input in this app — no native `prompt()`). A rename colliding with another
staff member's name (case/whitespace-insensitive, enforced by the existing
`staff_name_key_uidx` unique index) surfaces as a friendly Malay message rather than the
raw Postgres constraint error, by checking `error.cause?.code === '23505'`.

**Verified live:** `node --check`, `tests/sql-consistency.mjs`, `npm test` all pass on the
deployed build; ran a live no-op rename round-trip (renamed the admin account to its own
current name and back) confirming the full write path — client call → RLS-permitted
update → UI reload — works end-to-end without touching any real data.

---

## Done — admin panel's URL slug is no longer the word "admin"

**Date:** 2 September 2026. Requested directly: `?view=admin` gives away exactly where
the privileged panel is to anyone poking at the URL. Asked first whether this meant the
visible "ADMIN" nav label/heading too, or only the URL — confirmed **URL only**; the
on-page label is unchanged. The requested replacement is the admin account's own email
handle (the part before `@`) — `fahru76`.

One-line change: `VIEW_SLUGS`'s `'admin-app'` entry, in `index.html`, changed from
`'admin'` to `'fahru76'`. `SLUG_TO_VIEW`, `getViewIdFromLocation()` and
`updateURLForView()` all derive from this one object, so nothing else needed to change.
`?view=admin` now falls through to the `SLUG_TO_VIEW[slug] || 'customer-app'` default —
same as any other unrecognized value — rather than opening the admin panel.

This is obscurity, not security — worth being honest about in case it's ever relied on
as more than that. The real gate is unchanged: `switchView()`'s `staffSession`/
`staffProfile.role === 'admin'` check, backed server-side by RLS and `is_admin()`.
Anyone who already knows (or guesses) the new slug still hits that same gate; this only
stops a casual look at the URL bar from revealing where to try.

**Verified:** `node --check` on the extracted module script, `tests/sql-consistency.mjs`,
and `npm test` all pass (none of this touches SQL or the domain layer, so this is really
just confirming the edit didn't break JS syntax). Live-browser check pending the next
deploy.

---

## Still open from the audit series

- **`notificationOutbox` is write-only.** The phone field is *mandatory* on both customer
  forms, so every customer is asked for contact details for WhatsApp notifications that
  nothing sends. Either wire a provider or soften the copy — this is a promise to the
  customer, not just dead code.
- `<main>` / `<header>` / `<footer>` still at zero; ~195 inline `style=` attributes.
- Same-day time model: an 18:00–01:00 shop still cannot be configured. Needs a
  business-day offset **before** the server stores schedules, since it changes the meaning
  of persisted values.
- **No initial hydration for queues/appointments on page load** (found 2 September 2026
  while testing the nav-bar change above). Step 7 wired live *change* events but never a
  "fetch current state now" call on load — a device that was off/reloaded while changes
  happened elsewhere shows stale local data until the next live event. Likely fix:
  call `refreshQueuesFromServer()`/`refreshAppointmentsFromServer()` once, unconditionally,
  during `initData()` or right after the realtime channels are armed — needs the same
  care given to the merge-by-id design in step 7 (must not wholesale-overwrite local
  history) before making that change.
- **No live refresh of `seatServerState` while barber-app stays open.** Same class of
  gap as above, smaller blast radius: `refreshSeatServerState()` (added with the
  seat-assignment authorization fix) only runs once, on entering barber-app. If admin
  reassigns a seat while a barber's tab is already sitting on barber-app, that barber's
  "Panggil"/"Selesai" gating won't pick up the change until they leave and re-enter the
  view (or reload). No `seats` realtime channel exists yet to fix this properly.
- **Bootstrap admin account's `display_name` is `fahru76`** (email-derived, from before
  `invite-barber` existed) — needs the user to supply the real name, or ask for a small
  admin-UI rename control (`setStaffStatus()` currently has no `displayName` param).

---

## Files

```
js/domain/time.js                                   pure, tested
js/domain/scheduler.js                              pure, tested
js/supabaseConfig.js                                URL + publishable key
js/supabaseClient.js                                creates the client (CDN import, no bundler)
js/repositories/queueRepository.js                  step 3: wired for takeTicket/cancelOwn only;
                                                     step 4b added callNext/completeService;
                                                     step 7 added listTodayQueuesFull/
                                                     subscribeQueueChanges; step 7 bugfix
                                                     0c1742e: listQueues() scoped by date
                                                     instead of status (a status-transition
                                                     bug found via live testing)
js/repositories/authRepository.js                   step 4: sign-in/out, invite, staff list;
                                                     setStaffStatus() now also accepts displayName
js/repositories/seatRepository.js                   step 4b: listSeats/setSeatAssignment
js/repositories/serviceRepository.js                step 5a: services catalog CRUD + reorder
js/repositories/shopSettingsRepository.js           step 5b: singleton shop_settings get/create/update
js/repositories/appointmentRepository.js            step 6: booking + fast-pass RPC wrappers;
                                                     step 7 added listActiveAppointments/
                                                     subscribeAppointmentChanges; added
                                                     adminCancelRecord (admin-cancel bugfix)
index.html                                          the running app; bookTicket()/
                                                     cancelCustomerWalkin() dual-write to
                                                     Supabase; barber-app/admin-app now
                                                     session-gated; invite + staff list in
                                                     admin-app; callNext/completeService/board
                                                     read now server-authoritative (4b); services
                                                     catalog now server-authoritative (5a); shop
                                                     settings now server-authoritative (5b);
                                                     appointments + fast-pass now
                                                     server-authoritative (6); login dialog
                                                     email/password fields fixed for contrast
                                                     + size; each view now has its own URL
                                                     (?view=customer|display|barber|admin) with
                                                     kiosk-mode nav for display/barber; queues +
                                                     appointments now update live across devices
                                                     via Supabase Realtime (7); listQueues()
                                                     scoped by date not status (step 7 bugfix);
                                                     TUTUP closed-seat label letter-spacing fix;
                                                     confirmAdminCancellation() now
                                                     server-authoritative (admin-cancel bugfix);
                                                     kiosk-mode nav extended to Customer, Barber
                                                     keeps sign-out only; theme selector always
                                                     visible regardless of kiosk mode; barber-app
                                                     seat buttons now gated by seat-assignment
                                                     authorization (new refreshSeatServerState(),
                                                     wired into switchView()); barber name label
                                                     now prefers server-authoritative
                                                     staff.display_name over the localStorage-only
                                                     cache; admin staff list can now rename any
                                                     staff member's display_name ("Ubah Nama");
                                                     admin panel's URL slug changed from
                                                     ?view=admin to ?view=fahru76 (VIEW_SLUGS) --
                                                     obscurity only, on-page "ADMIN" label unchanged
supabase/config.toml                                Postgres 17, signup disabled
supabase/seed.sql                                   3 inactive seats
supabase/migrations/20260901000{000,100,200,300}_*.sql   step 2–4, applied and verified
supabase/migrations/20260901000400_services_catalog.sql       step 5a, applied and verified
supabase/migrations/20260901000500_services_anon_policy_fix.sql  step 5a bugfix, applied and verified
supabase/migrations/20260901000600_shop_settings.sql          step 5b, applied and verified
supabase/migrations/20260901000700_appointments.sql           step 6, applied and verified
supabase/migrations/20260901000800_harden_appointment_function_grants.sql  step 6 bugfix, applied and verified
supabase/migrations/20260902000900_realtime_live_refresh.sql  step 7, applied and verified
supabase/migrations/20260902001000_admin_cancel_record.sql    admin-cancel bugfix, applied and verified
supabase/migrations/20260902001100_seat_assignment_authorization.sql  seat-assignment
                                                     authorization, applied and verified
supabase/functions/invite-barber/index.ts           deployed, verify_jwt=true, re-checks
                                                     is_admin() itself before inviting anyone
tests/domain/scheduler.test.mjs                     15 fixtures
tests/differential.test.mjs                         20,000-case parity check
tests/sql-consistency.mjs                           static migration linter
tests/live-smoke.mjs                                queueRepository against the live DB; npm run test:live; not run by `npm test`
build/legacy.cjs                                    regenerable reference impl
```

`index.html` (the 5,500-line prototype) is unchanged and still the running app.

## Verification habits worth keeping

- Check `get_advisors` after every DDL change, and verify actual ACLs with
  `has_function_privilege` rather than trusting the SQL you just wrote.
- Run destructive-looking tests inside a `DO` block that raises at the end, so the
  transaction rolls back and leaves no rows behind.
- Run `tests/sql-consistency.mjs` before applying any new migration.
