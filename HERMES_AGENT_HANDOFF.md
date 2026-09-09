# Handoff to Hermes Agent — working the same repo as Claude (Cowork)

## Why this file exists

Fahru uses more than one AI agent on this exact project: Claude (this Cowork session)
and Hermes Agent (connected via direct API), and Codex has also worked here before (see
`CODEX_HANDOFF_LIGHT_THEME.md` for an example). There is **no branch isolation and no
staging environment** — every push to `main` deploys live via GitHub Pages within
seconds, and every Supabase migration applies straight to the one production database.
This file exists so an agent joining an already-in-progress, actively co-maintained
project doesn't duplicate, collide with, or silently overwrite work another agent just
did.

## Identity — the one repo, the one database

- **GitHub**: `fahru76/BarberQue`, default (only) branch `main` — no staging branch.
- **Live site**: `https://fahru76.github.io/BarberQue/` — GitHub Pages auto-deploys
  `main` on every push. There is no CI gate and no review step: a push *is* a deploy.
- **Supabase project ref**: `cojaebzxrtyvxrnadiuv` — production, the only environment
  (no separate dev/staging project).
- **Frontend**: single-file `index.html` (~8,000 lines, no build step) plus a small set
  of ES modules under `js/` (Supabase repositories, extracted domain logic).
- **Backend**: Supabase (Postgres + Auth + Realtime + RLS). Migrations are tracked as
  files under `supabase/migrations/`, applied both to the file (for history) and to the
  live project.

## Read these first, in this order

1. **`README.md`** — the extracted pure domain layer (scheduling logic) and its test
   suite.
2. **`HANDOFF.md`** — the full project history, step by step, and the canonical
   current-status tracker (for what is finished and what is still open).
3. **`QUEUECUT_HANDOVER.md`** — the open roadmap. Item 6 (closing-time warning) is now
   **done — shipped to `main` 2026-09-07** via PR #1 (see `HANDOFF.md`'s "Done — item 6"
   entry for detail). Item 7 (cross-platform install script) is still proposal-level only
   and gated on Fahru confirming there's a real second shop to build it for — don't start
   it without confirming with Fahru first.
4. **`HERMES_AGENT_HANDOFF.md`** (this file), for the coordination protocol below.

## Live synchronization snapshot (for any AI agent about to execute code)

- **Canonical source of truth for status:** `HANDOFF.md`.
- **Secondary roadmap view:** `QUEUECUT_HANDOVER.md`.
- **Session start command:** `git log --oneline -n 3 && git status --short --branch && printf "\n--- open/remaining status ---\n" && grep -nE "## Still open|## Done —|Status:" HANDOFF.md QUEUECUT_HANDOVER.md HERMES_AGENT_HANDOFF.md`
- **Last handoff sync commit:** `fbbaa92` (public.seats made the single source of
  truth for seat/barber state, closing the duplicate-active-seat display bug -- see
  HANDOFF.md's matching entry).
- **Remaining unfinished work at a glance (as of this commit):**
  - `notificationOutbox` is write-only in `index.html` (phone collected, WhatsApp promise
    not yet wired).
  - Bootstrap admin account display name still defaults to `fahru76` (manual rename action
    pending).
  - No `<footer>` exists in `index.html`.
  - Item 7 (cross-platform install script for another shop) in
    `QUEUECUT_HANDOVER.md` remains proposal-level and blocked on Fahru's confirmation.
- **Sync rule:** any AI agent touching code must append a new `## Done — ...` entry to
  `HANDOFF.md` and then run through this section again before finishing.

## Current state as of this handoff

- `main` is at commit `fbbaa92`
  (`fix: make public.seats the single source of truth for seat/barber state`),
  2026-09-09. Don't trust this hash if it's been a while: run `git log --oneline -n 3`
  for the current head.
- Most recent migration: `supabase/migrations/20260908143140_one_seat_per_barber_global.sql`
  — replaces the earlier partial index (`seats_one_active_seat_per_barber_uidx`, scoped
  to `where active`) with `seats_one_seat_per_barber_uidx`, unique on
  `seats(barber_id) where barber_id is not null` -- NO active-state condition, so a
  barber can be tied to at most one seat slot at all, active or inactive. Already
  applied to the live project — confirmed via `get_advisors` (no new findings) and a
  pre-apply query against the live `seats` table (no barber_id was already shared
  across two seats at apply time).
- What Claude (Cowork) built and shipped this session (chronological; full detail in
  `HANDOFF.md`'s matching "Done — ..." sections):
  1. Barber-specific per-service duration overrides (admin-configured per staff member,
     feeding into live wait-time math via `call_next_customer()`).
  2. An optional pagi/petang/malam session gate on same-day online booking — admin sets
     two cut-off times in Panel Admin; today's date only, tomorrow and later
     unaffected. Shipped via `feat/booking-session-gate` -> PR #3 -> squash-merged at
     `32cc290`.
  3. Fixed the booking calendar silently dropping user taps during background realtime
     refresh (DOM-diff-guard on `renderVisualCalendar()`/`renderAdminVisualCalendar()`,
     same pattern as the existing `operationalTimeOptionsSignature` guard). Shipped
     directly to `main` at `e0dd062`.
  4. Blocked the same barber from being assigned to two ACTIVE seats at once (client
     validation in `saveBarberAssignments()` + a partial DB unique index). Shipped
     directly to `main` at `d665805`.
  5. Fahru's follow-up, unsatisfied with #4: replaced it with a simpler, stricter rule
     -- a barber can be tied to at most ONE seat, active or inactive, full stop. Each
     seat's barber dropdown now live-filters out any name already picked on a
     different seat (structural prevention, not after-the-fact validation), backed by
     the global DB unique index above. Shipped directly to `main` at `4aa34a2`.
  6. Proactive admin warnings before the shop is left with zero active seats: a
     confirm dialog before closing the last active seat, a persistent Panel Admin
     banner, and a clearer customer-facing booking message. Shipped at `db13276`.
  7. Barber name shown on each seat's toggle button in Panel Admin (not just the
     barber-app view), hidden again once that seat is closed. Shipped at `8fe361a`
     and `87a6622`.
  8. Chased a duplicate-active-seat-with-same-barber display bug through two
     render-time heal attempts (`a4f824d`, `5f6afe0`) before Fahru's Incognito test
     proved it wasn't stale cache -- root cause was `toggleSeatStatus()`/
     `saveBarberAssignments()` writing to `localStorage` first and pushing to
     `public.seats` as a fire-and-forget side call that could silently fail.
  9. Fixed it at the source: `public.seats` is now the single source of truth end to
     end -- both admin actions `await` the server write and only commit locally on
     success, and a new `reconcileLocalSeatStateFromServer()` keeps `localStorage` in
     lockstep with the server on every boot, action, and realtime push. The two
     render-time heals from #8 were removed as redundant. Shipped directly to `main`
     at `fbbaa92`. Full detail in HANDOFF.md's matching "Done -- duplicate-active-seat"
     entry.
- What the previous agent built (4 commits, already live before this session's work):
  the Panel Admin left sidebar became a reorderable list (drag or up/down arrows); on
  mobile it's now a dropdown with its own card-list style (not a shrunk copy of the
  desktop sidebar); and the sidebar order now syncs across devices via `shop_settings`
  instead of being stuck in whichever browser's `localStorage` last touched it.

If your task touches `index.html`'s `admin-app` section, the Panel Admin sidebar
(`ADMIN_SECTIONS`, `renderAdminSidebar()`, `getAdminSectionOrder()` and friends),
`js/repositories/shopSettingsRepository.js`, or `supabase/migrations/` — fetch these
fresh before editing. Don't work from an earlier cached read; another agent (or Fahru,
or a future you) may have already changed them.

## Coordination protocol (you connect via API directly, not a local clone)

There's no working tree keeping you automatically in sync, and no branch isolation to
absorb a mistake. Treat every read as a snapshot that can already be stale by the time
you write:

1. **Before editing a file via the GitHub Contents API**, `GET` it immediately
   beforehand and use the `sha` from *that* response in your `PUT` — never reuse a `sha`
   from an earlier read. A 409/422 sha-mismatch means another agent changed the file
   since you last read it: re-`GET`, re-apply your change on top of the new content,
   never force-overwrite.
2. **Before pushing to `main`**, check the latest commit first. If it's moved since you
   last looked, re-read whatever files your change touches before writing.
3. **Before applying a new Supabase migration**, list existing migrations first
   (Management API `GET /v1/projects/{ref}/database/migrations`, or equivalent) so you
   don't create a duplicate or conflicting column/table. Migrations here are additive
   only — no destructive `DROP`, no rewriting existing migration files, no destroying
   existing shop data merely to simplify a change (see `HANDOFF.md`'s design-decisions
   section).
4. **After a change**, write a commit message that explains *why*, not just *what* —
   every commit in this repo's history does this. It's how the next agent (Claude, you,
   or whoever comes after) reconstructs intent without a live conversation to ask.
5. **Log what you did in `HANDOFF.md`**, appended as a new `## Done — ...` section in
   the same style as the existing ones (short rationale, what changed, what's still
   open) — that file is the single running project log every agent reads first. Only
   create a separate dedicated handoff file (like `CODEX_HANDOFF_LIGHT_THEME.md`) for a
   long, narrow, back-and-forth investigation on one specific issue, and even then link
   back into `HANDOFF.md`.
6. **Never** commit `.env`, secrets, or the Supabase `service_role` key anywhere
   client-reachable — same rule for every agent working here.

## Verification expected before calling something done

Carried over from `HANDOFF.md`'s "Verification habits worth keeping" — apply the same
bar:

- Run `npm test` (23 domain fixtures + a 20,000-comparison differential harness) before
  and after touching `js/domain/` or `js/repositories/`.
- Run `node tests/sql-consistency.mjs` before applying any new migration.
- Check Supabase `get_advisors` (security) after any DDL change.
- This is a live app real customers use. Verify against the actual deployed site
  (`fahru76.github.io/BarberQue`) — GitHub Pages can serve a stale cached copy for a
  minute or two after a push, so re-fetch with a cache-busting query string if a check
  right after deploy doesn't show your change yet — not just local/static reasoning,
  before reporting something as fixed.
