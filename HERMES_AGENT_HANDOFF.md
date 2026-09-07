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
2. **`HANDOFF.md`** — the full project history, step by step, including a **"Design
   decisions already made — don't relitigate these"** section. Read that section before
   proposing a different architecture for something already decided (e.g. individual
   barber accounts vs. shared login, `price_sen integer` not float, no DELETE policy
   anywhere, phone write-only for anon, claim-token-based customer cancellation).
3. **`QUEUECUT_HANDOVER.md`** — the open roadmap. Item 6 (closing-time warning) is now
   **done — shipped to `main` 2026-09-07** via PR #1 (see `HANDOFF.md`'s "Done — item 6"
   entry for detail). Item 7 (cross-platform install script) is still proposal-level only
   and gated on Fahru confirming there's a real second shop to build it for — don't start
   it without confirming with Fahru first.
4. **This file**, for the coordination protocol below.

## Current state as of this handoff

- `main` is at commit `9e0dce3` (merge of Fahru's local docs/CI commits with the item 6
  PR merge commit), 2026-09-07.
- Most recent migration unchanged since the previous handoff entry below: still
  `supabase/migrations/20260907011800_admin_sidebar_order.sql`. Item 6 (see next bullet)
  needed no schema/migration change.
- What Claude (Cowork) just built and shipped this session: item 6 from
  `QUEUECUT_HANDOVER.md` — a proactive "kedai akan tutup" (closing soon) banner for the
  walk-in queue, plus a "TEMPAH UNTUK ESOK" (book for tomorrow) button, plus an upgrade
  to `bookTicket()`'s existing dead-end rejection to also offer the next-day jump.
  `index.html` only, no schema change. Full detail in `HANDOFF.md`'s "Done — item 6"
  section. Shipped via `feat/item-6-closing-soon-warning` -> PR #1 -> merged by Fahru ->
  synced to `main` and pushed. PR branch deleted.
- What the previous agent built (4 commits, already live before this session): the Panel
  Admin left sidebar became a reorderable list (drag or up/down arrows); on mobile it's
  now a dropdown with its own card-list style (not a shrunk copy of the desktop
  sidebar); and the sidebar order now syncs across devices via `shop_settings` instead
  of being stuck in whichever browser's `localStorage` last touched it.

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
