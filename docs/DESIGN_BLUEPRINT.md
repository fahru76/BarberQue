# QueueCut — Modern Interface Blueprint

**Status:** proposal, not applied. `index.html` is untouched by this document.
**Author:** design direction (creative) + implementation plan (front-end architecture).
**Constraint that governs everything here:** functionality — logic and semantics — must not change. The theme mechanism is frozen.

---

## 0. The one finding that shapes this blueprint

`index.html` does not have one design system. It has **three, stacked**, each added on top of the last:

| Block | Lines | Self-description | `:root` at |
|---|---|---|---|
| 1 | 20–254 | (original, unnamed) | 39 |
| 2 | 255–877 | `QueueCut 7 — Quiet Precision visual system` | 257 |
| 3 | 878–1774 | `QueueCut 8 — Sleek-inspired visual phase (visual only)` | 880 |

Each block re-declares the same core tokens. Three `:root` blocks and three `[data-theme="light"]` blocks cascade, and the winner is decided by source order:

- Declared in **all three**: `--bg-color`, `--border-color`, `--border-light`, `--card-bg`, `--card-hover`, `--input-bg`, `--primary-color`, `--surface-color`, `--text-main`, `--text-muted`, `--ticket-gradient`
- Declared **only in block 2** (so block 2's value survives into block 3's world): `--danger`, `--ease`, `--info`, `--nav-border`, `--radius-sm`, `--success`, `--warning`
- Declared **only in block 3**: `--sleek-accent`, `--sleek-accent-soft`, `--sleek-accent-strong`
- `--surface-elevated` appears in blocks 2 and 3, never in block 1

`--warning: #c99a4b` at `:268` is the clearest example of why this matters. It is declared once, in block 2, never re-declared, and consumed by six elements (`:113`, `:114`, `:233`, `:1619`, `:1677`, `:1687`). Any attempt to "clean up tokens" by rewriting block 2 silently repaints the announcement panel, the weekly-closed calendar day, the hours notice, and the admin announcement border.

**Conclusion: the highest-value modernisation is not a new look. It is collapsing three systems into one without moving a single rendered pixel that shouldn't move.** The palette already in block 2/3 — warm near-black, gold, one functional orange — is genuinely current and worth keeping. It does not need replacing. It needs finishing.

---

## 1. Business analysis

**What QueueCut is.** A queue-and-appointment system for a single barbershop: Syam Barber Shop, Kerteh, Terengganu. Not a marketplace, not multi-tenant. One shop, one owner, a handful of barbers, a few chairs.

**What the software actually does.** Four jobs in one file:

1. **Take a walk-in ticket** and assign it to a seat with a capable barber.
2. **Book an appointment** into a slot, respecting hours, breaks, closed dates and advance limits.
3. **Run the floor** — call the next customer, track who is in which chair, mark work done.
4. **Report** — daily/monthly/yearly revenue and counts, per barber.

**Money.** Prices are integer sen (`price_sen`), displayed as RM. Revenue reporting reads straight off the ticket and appointment rows — which is exactly why the server recomputes price from the service catalogue rather than trusting the browser. That is a business rule, not a technical nicety.

**Operational constraints the interface must keep showing honestly:** shop open/closed, break windows, closed dates, weekly closures, max queue length, booking advance-days, seat count, and per-barber capability (a barber can only be given work they can perform).

**What the business actually needs from a redesign.** A customer who takes a number in under a minute. A TV that a person reads from four metres away in under three seconds. A barber who can call the next customer with one thumb while holding clippers. An owner who can find a setting, change it, save it, and trust it saved.

None of those are served by more visual novelty. All four are served by **clarity, hierarchy and honest state**.

---

## 2. Audience, per surface

Four surfaces, four audiences, four completely different jobs.

### 2.1 Customer — `#customer-app` (`?view=customer`, or bare root)

- **Who:** a person in or near the shop, on a phone, in Bahasa Melayu. Possibly elderly. Possibly in a hurry, possibly already annoyed at waiting.
- **Context of use:** one hand, poor light, intermittent signal, standing up.
- **Job to be done:** *get a place in the queue, and know when it's my turn.*
- **Wanted action (primary):** tap **AMBIL NOMBOR SEKARANG** (walk-in) or **SAHKAN TEMPAHAN** (booking).
- **Wanted action (secondary):** read my position and my seat.
- **Success measure:** one primary action completed without a single error message.
- **Design consequence:** single column, capped width, exactly one dominant button per mode, and the customer's own queue number as the largest thing on the screen once they hold a ticket.

### 2.2 Display — `#display-app` (`?view=display`)

- **Who:** nobody. It is a TV on a wall. The audience is a room.
- **Context of use:** 3–5 metres away, glanced at, no cursor, no touch, unattended for hours.
- **Job to be done:** *is my number up, and which chair?*
- **Wanted action:** none — zero interaction is the requirement.
- **Success measure:** a number is legible and locatable in under three seconds from across the shop.
- **Design consequence:** type size and contrast beat everything. No animation that delays a number appearing. No chrome. No controls.

### 2.3 Barber — `#barber-app` (`?view=barber`)

- **Who:** a working barber, mid-service, tablet propped at the station.
- **Context of use:** hands occupied, glancing down, one free thumb, noise, interruptions.
- **Job to be done:** *who's next for my chair, and mark this one finished.*
- **Wanted action (primary):** **call next** on my seat.
- **Wanted action (secondary):** **done** on my seat.
- **Success measure:** call-next is one tap, from the seat card, with no confirmation dialog.
- **Design consequence:** the seat cards are the only interactive element that matters. They must be large, unambiguous, and impossible to mis-tap.

### 2.4 Admin — `#admin-app` (`?view=<slug>`)

- **Who:** the owner, at a desk or on a phone, occasionally, with intent.
- **Context of use:** task-driven. They came to change one thing.
- **Job to be done:** *find the setting, change it, save it, see that it saved.*
- **Wanted action:** **save** — every section ends in a save.
- **Success measure:** the setting is findable from the sidebar in one click, and the saved state is visible without guessing.
- **Design consequence:** navigation is already built and is good (10 sections, reorderable). What is missing is **dirty/saved state** and consistent section anatomy.

---

## 3. The direction — "QueueCut 9: One System"

Two passes have already been applied to this file. A third pass that adds another layer would make the problem worse. **Phase 9 is a consolidation phase.**

**Named direction:** *Quiet Precision, completed.*

What that means concretely:

**Adopt**
- **Warm near-black + one gold + one functional orange.** Already present and current. Gold (`--primary-color`) is the identity; orange (`--sleek-accent: #ff671d`) is the *signal* — live, urgent, primary-action. Keep them apart: gold for brand and structure, orange for "this is the thing to press" and "this is happening now."
- **Layered soft elevation instead of heavy borders.** Block 3 already does this (`--shadow-sm`, `--shadow-lg`, `surface-elevated` mixes). Finish it — one elevation scale, used consistently.
- **Generous radii, used as a scale.** `--radius-sm/md/lg` exist. Standardise and actually use all three rather than per-component magic numbers.
- **Large, tight-tracked numerals** for queue numbers and ticket numbers. Already in place and correct — this is the single best decision in the current file.
- **Motion as feedback only.** Two durations, one easing curve (`--ease` already exists), and honour `prefers-reduced-motion` (already present at `:826` and `:1553` — extend, don't rebuild).
- **Content-first hierarchy.** H1/H2 for the shop's own name, H3 for section titles, no decorative eyebrow text.

**Reject, deliberately**
- **Glassmorphism / heavy backdrop-blur.** Destroys legibility at TV distance and costs battery on the tablets.
- **Neumorphism.** Low contrast. Wrong for an audience that includes older customers in poor light.
- **Skeleton shimmer.** It reads as "broken" on a TV nobody is touching. Prefer a simple, honest loading label.
- **Urgency dark-patterns.** A barbershop queue is already stressful. The interface should reduce it, not amplify it.
- **Any new decorative gradient, illustration or icon set.** Nothing here earns its bytes.

---

## 4. Design system — the target

### 4.1 One token layer

Collapse `:root` and `[data-theme="light"]` so each token is declared **exactly twice** — once dark, once light — in one block, at the top of block 1 or at the head of block 2. Keep the names already in use (`--primary-color`, `--surface-elevated`, `--sleek-accent`, `--warning`, …) so no consumer has to change.

**Non-negotiable:** token *values* that other elements already depend on must not be re-pointed. `--warning` is the known landmine. Any token whose value is reused by an unrelated component is frozen until its consumers are enumerated.

### 4.2 Type

Fonts actually loaded (`:19`): **Cormorant Garamond** (500, 600) and **Manrope** (400, 500, 600, 700). Nothing else.

- **`'Oswald'`** — referenced 10× in source, never loaded. The heading rule that requests it (`:74`) is overridden by `:337` (Manrope, same specificity, later). It is dead weight, not a rendering bug.
- **`'Inter'`** — referenced 2×, never loaded. `body` (`:73`) is overridden by `:311`. Whether the *form-control* reference at `:100` is also overridden is **not yet confirmed** and is being measured in the bug hunt, not assumed.

**Target:** one body face (Manrope), one display face (Cormorant Garamond, customer hero only), zero references to unloaded families. A font stack that names a font nobody loads is a latent bug that surfaces the day someone "fixes" the cascade.

### 4.3 Scales to define

| Scale | Values | Notes |
|---|---|---|
| Radius | `--radius-sm` 10px · `--radius-md` 16–18px · `--radius-lg` 24–28px | already declared, standardise the drift |
| Elevation | `--shadow-sm` (resting card) · `--shadow-lg` (modal/overlay) | two levels is enough; a third only if needed |
| Motion | 150ms (state change) · 250–350ms (entrance) · `--ease` | feedback, never decoration |
| Spacing | 4 · 8 · 12 · 16 · 24 · 32 · 48 | replace ad-hoc margins |
| Breakpoints | 680 · 768 · 900 (existing) | keep — do not add a fourth |

### 4.4 Component states — the real gap

The file has good default and hover states. What is largely missing is the *unhappy path*:

- **loading** — nothing in the codebase uses `aria-busy`, `is-loading`, or a spinner (0 occurrences). Every Supabase fetch currently renders an empty container until data lands.
- **empty** — a few exist (`.service-empty-state`), most lists have none.
- **error** — phone validation exists; broader failure states do not.
- **disabled** — exists and is correct (`:85`).

Closing this is the single biggest perceived-quality win available, and it is **additive CSS + existing state toggles**, not new logic.

### 4.5 Accessibility baseline

Present and healthy: `aria-label` (47), `aria-selected` (17), `role="tab"` (13), `aria-live` (11), a real tablist pattern with arrow-key navigation (`initTablistArrowNav`), titled iframes (2/2), and a visible `:focus-visible` ring (`:1079`).

Two concrete gaps:
- **`<img>` without `alt`** — 2 of 6.
- **No `aria-busy`** anywhere, which is the same gap as 4.4 seen from the screen-reader side.

---

## 5. Per-page action map

| Surface | Audience | The one action | What must never happen |
|---|---|---|---|
| Customer | person on a phone | submit the ticket / booking | more than one primary button visible at once |
| Display | the room | *(none — read only)* | any control, any scroll, any delay before a number shows |
| Barber | working barber | call next / mark done on my seat | a confirmation dialog between tap and result |
| Admin | owner | save a setting | losing focus or scroll position on save |

---

## 6. Implementation phases

Each phase is independently revertible. No phase touches markup IDs, class names the JS reads, or any handler.

**Phase 0 — Consolidation (no intended visual change).**
Deduplicate the three `:root` / `[data-theme]` token blocks into one. Delete the `'Oswald'` and `'Inter'` references that can never resolve. Enumerate every consumer before moving any token value.
*Verification:* rendered output must be byte-comparable in both themes at 3 viewports.

**Phase 1 — Token completion.**
Fill the radius/spacing/elevation/motion scales and replace ad-hoc values with them, one surface at a time.

**Phase 2 — State coverage.**
Add loading / empty / error treatments for every asynchronous container, driven by state that already exists in the JS. No new fetches, no new logic.

**Phase 3 — Per-surface refinement.**
Customer (hierarchy + one dominant CTA per mode), Display (distance legibility), Barber (tap-target and zero-confirmation), Admin (dirty/saved state, uniform section anatomy).

**Phase 4 — Accessibility polish.**
Missing `alt`, `aria-busy`, contrast audit on the orange-on-warm-black accent.

---

## 7. Guardrails — frozen, do not touch

These are not preferences. They are load-bearing.

1. **Theme mechanism.** `applyTheme()` (`:4799`), `changeTheme()` (`:4845`), the init call (`:5509`), the inline `color-scheme` on `<html>` (`:2`), the `<meta name="color-scheme">` (`:18`), and every `color-scheme` declaration (`:37`, `:38`, `:1112`, `:1124`, `:1125`). A prior device-level failure on Samsung Internet light mode is why this is frozen.
2. **JS read surface.** 119 `onclick`, 29 `onchange`, 5 `onsubmit`, and the `data-*` hooks (`data-view`, `data-admin-section`, `data-service-id`, `data-staff-id`, `data-editor-command`, …). Renaming any of these breaks behaviour silently.
3. **307 functions** in the classic script. No renames in a design phase.
4. **Token values with unrelated consumers** (`--warning` is the documented one). Enumerate before re-pointing.
5. **Kiosk-mode rules** (`body.kiosk-*`) and the `?view=` routing contract.
6. **No new runtime dependency.** No framework, no icon library, no CSS preprocessor. This file has no build step and must keep none.

---

## 8. Verification protocol

Every phase, in this order:

1. `npm test` — real exit code, read **without a pipe** (`npm test | tail` reports `tail`'s status).
2. Byte-compare `index.html` against the expected blob before and after.
3. Serve over HTTP (not `file://` — ES modules are blocked by origin `null` and the app never boots) and probe the live DOM for computed values, at 1440 / 820 / 390.
4. Render both themes and inspect.
5. Samsung Internet light-mode check is a **device-level** step and cannot be automated from here — flag it, don't fake it.

---

## 9. What this blueprint deliberately does not do

- It does not propose a new colour palette. The existing one is good.
- It does not propose new markup, new components, or new JavaScript.
- It does not propose a framework, build step, or dependency.
- It does not touch the theme mechanism.

The file already looks like 2026. It behaves like three different products stacked on top of each other. **Making it feel like one product is the work.**