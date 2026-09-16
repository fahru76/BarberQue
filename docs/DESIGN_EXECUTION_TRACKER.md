# QueueCut — Design Execution Tracker

**Companion to `docs/DESIGN_BLUEPRINT.md` (commit `3cf1e7c`).** The blueprint is
the analysis; this is the runnable plan. Blueprint sections are referenced, not
restated.

**Status legend:** `DONE` · `WIP` · `TODO` · `BLOCKED`
**Priority:** `P0` foundation · `P1` visible quality · `P2` polish

**Frozen throughout (blueprint §7):** theme mechanism (`applyTheme`/`changeTheme`/
`color-scheme`), JS read surface (`onclick`/`onchange`/`onsubmit`/`data-*`),
function names, kiosk rules, `?view=` routing, no new runtime dependency.

Baseline at tracker creation: `npm test` exit 0 · `index.html` blob 586,865 bytes
(`git cat-file -s`) · 9,221 lines.

---

## Phase 0 — Token consolidation (no intended visual change) — `P0`

Merge the three `:root` / `[data-theme="light"]` pairs (blocks 1/2/3 at
`:39/57`, `:257/284`, `:880/903`) into one pair, preserving the *winning* value
of every token. Remove `'Oswald'` / `'Inter'` references. No consumer changes.

| # | Item | Owner | Status | Notes |
|---|---|---|---|---|
| 0.1 | In-repo DOM fingerprint harness | Fahru | DONE | `tests/dom/fingerprint.mjs` — 6 runs (2 themes × 3 viewports), SHA-256 of a document-wide computed-style snapshot, hash computed in Node |
| 0.2 | Capture baseline hash (before) | Fahru | TODO | `node tests/dom/fingerprint.mjs --out .fingerprint-before.json` |
| 0.3 | Enumerate token winners + consumers | Fahru | TODO | Per `frontend-static-audit/references/design-token-ownership.md`. `--warning` is the documented landmine (`:268`, consumed at `:113`,`:114`,`:233`,`:1619`,`:1677`,`:1687`) |
| 0.4 | Collapse to one `:root` + one `[data-theme="light"]` | Fahru | TODO | Values only move; no value is re-pointed |
| 0.5 | Remove unloaded `'Oswald'` / `'Inter'` refs | Fahru | DONE | Landed in `5346c23` before this tracker |
| 0.6 | Re-capture hash (after) and diff | Fahru | TODO | All 6 hashes must be identical to 0.2 |

**Gate:** 6/6 hashes identical before↔after, `npm test` exit 0 read without a pipe.
**Revert:** single commit; `git revert <sha>`.

---

## Phase 1 — Token scales — `P1`

Fill radius / elevation / motion / spacing and replace ad-hoc values.

| # | Item | Owner | Status | Notes |
|---|---|---|---|---|
| 1.1 | Radius: standardise on `--radius-sm/md/lg` | Fahru | TODO | `--radius-sm` (`:278`) declared, zero consumers — wire it or drop it deliberately |
| 1.2 | Elevation: `--shadow-sm` / `--shadow-lg` only | Fahru | TODO | Two levels; no third unless a real case appears |
| 1.3 | Motion: 150ms state / 250–350ms entrance, `--ease` | Fahru | TODO | Extend the existing `prefers-reduced-motion` rules (`:826`, `:1553`) |
| 1.4 | Spacing: 4·8·12·16·24·32·48 | Fahru | TODO | Per-surface, one surface per commit |

---

## Phase 2 — State coverage — `P1`

Loading / empty / error for asynchronous containers, driven by state that
already exists. **No new fetches, no new logic.**

| # | Item | Owner | Status | Notes |
|---|---|---|---|---|
| 2.1 | Customer service picker loading state | Fahru | DONE | `241bc77`. `.catalog-loading-state` (`:1781`), `catalogLoadsInFlight`/`catalogHasResolvedOnce`, `aria-busy`, `load` safety net. Verified by `probe-loading.cjs` 15/15, 3 scenarios |
| 2.2 | Staff list first-paint loading state | Fahru | DONE | `refreshStaffList()` (`:3466`) — first-paint only, `aria-busy` cleared in `finally` |
| 2.3 | Queue/appointment lists: gate the `Tiada…` fallback behind a resolved flag | Fahru | TODO | `updateUI()` (`:8702`) renders `'Tiada …'` from localStorage at boot (`:9215`) before `onStaffAuthChange` (`:3240`) hydrates via `refreshQueuesFromServer()` (`:9271` region). Pattern to reuse: `catalogHasResolvedOnce`. Affected fallbacks: `:8922`, `:8926`, `:8953`, `:8960`, `:8972`, `:8980` |
| 2.4 | Admin services empty state | Fahru | TODO | `:9018` — already an honest empty state; verify it is not shown pre-hydration |
| 2.5 | Error states for the queue/appointment refresh paths | Fahru | TODO | Currently `console.warn` only (`:9170`, `:9182`) — deliberate "never surface a missed live refresh"; leave unless a user-visible failure is shown |

**Gate:** each item verified by a probe scenario, `npm test` exit 0, zero page errors.

---

## Phase 3 — Per-surface refinement — `P1`

| # | Item | Owner | Status | Notes |
|---|---|---|---|---|
| 3.1 | Customer: one dominant CTA per mode | Fahru | TODO | Blueprint §5: never two primary buttons visible at once |
| 3.2 | Display: distance legibility audit | Fahru | TODO | 3s read at 3–5 m; no animation that delays a number |
| 3.3 | Barber: tap-target + zero-confirmation | Fahru | TODO | Call-next is one tap from the seat card |
| 3.4 | Admin: dirty/saved state | Fahru | TODO | Blueprint §2.4 — the real gap is *saved* feedback, not navigation |

---

## Phase 4 — Accessibility polish — `P2`

| # | Item | Owner | Status | Notes |
|---|---|---|---|---|
| 4.1 | `aria-busy` coverage on remaining async containers | Fahru | TODO | Follows from Phase 2 |
| 4.2 | Contrast audit on `--sleek-accent` orange on warm black | Fahru | TODO | Measure, don't eyeball |
| 4.3 | `<img>` alt — 4/4 present | Fahru | DONE | Confirmed in bug hunt #2 (`3cf1e7c`) |

---

## Bug hunt log

| # | Date | Commit | Result |
|---|---|---|---|
| 1 | 2026-09-16 | `3cf1e7c` | 0 dup ids, 0 dup functions, 0 dangling aria/for, 0 form-scoped type-less buttons, 4/4 img alt. Leftovers: dead `customerHeaderEyebrow`, `'Oswald'`/`'Inter'` (both fixed in `5346c23`), no loading state |
| 2 | after Phase 4 | — | Run per `frontend-static-audit`: validate every checker against a known-good and known-bad input first; read every hit at its source line; report real / artifact / accepted separately |

---

## Verification protocol (every phase)

1. `npm test` — real exit code, read **without a pipe**.
2. `node tests/dom/fingerprint.mjs` — 6 hashes; compare against the phase baseline.
3. Probe the live DOM for the specific state under test (MutationObserver, not a single sample).
4. Samsung Internet light-mode is a **device-level** check and cannot be automated here — flag it, never fake it.
| 