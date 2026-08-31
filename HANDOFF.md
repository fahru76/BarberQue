# QueueCut — migration handoff

Paste this into Cowork along with the project files to pick up where the chat left off.

**Date:** 31 August 2026
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

**Not yet done:** a live browser click-through (add/edit/toggle/delete a service against
the deployed site) — planned next, same push-to-`main`-and-test-live approach as step 4b,
pending a fresh GitHub token from the user (the previous one was single-use, meant to be
revoked after the step 4b push).

## Then, still to do

5b. Shop settings (~15 localStorage keys) — needs a load-once-cache design decision
    before starting (many are read synchronously today).
6. Appointments (26 functions) — tangled with the still-open `isVip`/`fastPassApproved`/
   `approvedAt`/`revokedAt` schema gap; needs that resolved first.
7. Realtime subscriptions replacing the `storage` event listener:
   ```js
   supabase.channel('queue-changes')
     .on('postgres_changes', { event: '*', schema: 'public', table: 'queues' }, () => updateUI())
     .subscribe();
   ```
   This is what makes the TV screen update when the barber presses "Selesai" on a tablet —
   behaviour that does not exist today.

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

---

## Files

```
js/domain/time.js                                   pure, tested
js/domain/scheduler.js                              pure, tested
js/supabaseConfig.js                                URL + publishable key
js/supabaseClient.js                                creates the client (CDN import, no bundler)
js/repositories/queueRepository.js                  step 3: wired for takeTicket/cancelOwn only;
                                                     step 4b added callNext/completeService
js/repositories/authRepository.js                   step 4: sign-in/out, invite, staff list
js/repositories/seatRepository.js                   step 4b: listSeats/setSeatAssignment
js/repositories/serviceRepository.js                step 5a: services catalog CRUD + reorder
index.html                                          the running app; bookTicket()/
                                                     cancelCustomerWalkin() dual-write to
                                                     Supabase; barber-app/admin-app now
                                                     session-gated; invite + staff list in
                                                     admin-app; callNext/completeService/board
                                                     read now server-authoritative (4b); services
                                                     catalog now server-authoritative (5a)
supabase/config.toml                                Postgres 17, signup disabled
supabase/seed.sql                                   3 inactive seats
supabase/migrations/20260901000{000,100,200,300}_*.sql   step 2–4, applied and verified
supabase/migrations/20260901000400_services_catalog.sql       step 5a, applied and verified
supabase/migrations/20260901000500_services_anon_policy_fix.sql  step 5a bugfix, applied and verified
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
