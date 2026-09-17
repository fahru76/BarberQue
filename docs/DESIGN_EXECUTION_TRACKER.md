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
| 0.2 | Capture baseline hash (before) | Fahru | DONE | `.fingerprint-before.json` sha256 `522e48ba…35c246`; 6/6 written, dark≠light holds |
| 0.3 | Enumerate token winners + consumers | Fahru | DONE | 27 tokens. Block 1 100% shadowed (dead). Dark winners: 20 from block 3, 7 from block 2 (`--danger`/`--success`/`--info`/`--warning`/`--nav-border`/`--radius-sm`/`--ease`). Light: 4 from block 2. `--warning` confirmed declared ONLY at `:268`, never overridden in light |
| 0.4 | Collapse to one `:root` + one `[data-theme="light"]` | Fahru | DONE | Atomic line-based script (not hand patches): deleted block 1 (fully shadowed) + block 2 pair, folded block 2's unshadowed tokens into block 3. CRLF preserved. 9222→9151 lines, diff 11+/82- |
| 0.5 | Remove unloaded `'Oswald'` / `'Inter'` refs | Fahru | DONE | Landed in `5346c23` before this tracker |
| 0.6 | Re-capture hash (after) and diff | Fahru | DONE | **GATE PASS 6/6 identical** — tokenHash + styleHash + elements all match before↔after |

**Gate:** 6/6 hashes identical before↔after, `npm test` exit 0 read without a pipe.
**Revert:** single commit; `git revert <sha>`.

---

## Phase 1 — Token scales — `P1`

Fill radius / elevation / motion / spacing and replace ad-hoc values.

| # | Item | Owner | Status | Notes |
|---|---|---|---|---|
| 1.1 | Radius: standardise on `--radius-sm/md/lg` | Fahru | DONE | Closed in four steps: `a607da9` (9 literal `10px` → token, no-op), `1da39df` (31 dead decls deleted, fingerprint 6/6 identical), then the scale decision: declared 10/18/28 did not match the file's actual clustering (~8/~14/~22) — panels were rounder than the cards beside them and 75 sites bypassed tokens. **Redefined to `--radius-sm 8px / --radius-md 14px / --radius-lg 22px` and migrated all 75 raw single-value radii** (37→sm, 32→md, 6→lg); 87 total token consumers, 0 single-value px radii left except intentionally-raw pills (`50%`/`99px`/`999px`), the `3px` legend swatch, the bare `0`, and the two rich-editor corner shorthands (verified intact by literal grep after the script's own counter proved broken). Deliberate visual change: fingerprint 6/6 moved (both token hashes), npm test exit 0, CRLF preserved |
| 1.2 | Elevation: `--shadow-sm` / `--shadow-lg` only | Fahru | WIP | **Dead-site removal DONE (`f3d3b7e`): 13 superseded `box-shadow` decls deleted — cascade-verified no-op, fingerprint 6/6 identical, npm test exit 0, occurrences 49→36.** Remaining: 22 LIVE raw shadows, of which only ~8 are true drop shadows. The rest are focus rings (×4), `inset` hairlines (×4), drag indicators (×3), `none` resets (×4) and the autofill-backdrop hack (×2) — **not elevation, not token candidates**. The ~8 real ones are mostly branded orange glows (`0 8px 24px rgba(255,103,29,.20)` on `.btn-action`, `.brand-monogram`) with no token to map onto; adding an accent-shadow token is a VISUAL decision |
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
| 4.2 | Contrast audit on `--sleek-accent` orange on warm black | Fahru | DONE | Measured then fixed (`94b6ce2`). `.btn-action` is 12.48px/700 → NOT large text → 4.5:1 threshold; it failed in **both** themes (dark 2.23, light 3.48). The light gradient **spanned the WCAG dead-zone band** (lum 0.18333–0.20287) so no foreground-only fix existed — verified by scoring 6 candidates. Fixed: light `--sleek-accent #e95414 → #bf3f0b` (worst 3.48 → 4.89), `.btn-action`/`.brand-monogram` → `var(--on-primary)` (dark 6.42 / light 4.89), dropped the unpassable `#ff9952` hover stop, `.specialty-star.active` `#fff → #11130f` (2.19 → 7.78). Blast radius checked first: 35 `--sleek-accent` consumers, only 3 put text on it. Fingerprint 6/6 moved (dark `tok SAME` / light `tok DIFF` — correct: only light tokens changed). npm test exit 0. **Remaining: `--warning` `#c99a4b` is declared once with no light override, and the `[A]` alpha-background rows the auditor flags are unverified** |
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