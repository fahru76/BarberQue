# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Customer** — on a phone, one hand, intermittent connectivity, possibly standing in poor light. Joins the walk-in queue or books an appointment, then needs to know it worked, their position, estimated wait, and which seat. Anonymous: ownership is by claim token, not an account.
- **Barber** — on a tablet at the chair, hands occupied, repeating fast. Sees the next eligible customer for their assigned seat, calls them, marks service done. One deliberate tap must produce one authorized transition.
- **Admin / owner** — desktop or phone, task-driven. Configures operating hours, closures, staff, seats, services, announcements, fast-pass decisions, menu order, and reads reports. Needs visible dirty/saved state and server-confirmed saves.
- **Display (shop TV)** — unattended, read-only, 3–5 metres away. Shows who is being served and at which seat.

## Product Purpose

C-Cutz Barber (internal product name: QueueCut / BarberQue) is a single-shop queue and appointment operating system for a barbershop in Kerteh, Terengganu, Malaysia (shop-local time Asia/Kuala_Lumpur). It replaces a localStorage prototype with a Supabase-backed system so every device converges on the same queue. Success: every accepted ticket or appointment is a real server row, no fake success states, and staff actions are authorized server-side.

## Positioning

A queue that stays truthful: walk-ins and appointments share one capacity model on client and server, seats are assigned to barbers with capability rules, and overnight operating hours that cross midnight are handled correctly. Correctness outranks polish.

## Operating Context

- Four surfaces on one codebase: customer, display, barber, admin.
- Customers are anonymous; staff authenticate via Supabase Auth with role- and seat-based authorization (RLS plus guarded RPCs).
- Realtime sync across devices; the TV display must stay stable and legible in a shop environment.
- Frontend is a raw static page (`index.html` plus `js/`), no build step. Production domain: https://c-cutzbarber.my (www redirects to apex), hosted on Vercel; previously GitHub Pages.

## Capabilities and Constraints

- Walk-in queue, appointments, seat scheduling and wait estimates, fast-pass, services catalogue with server-validated duration and price, barber capability and specialty assignment, shop settings, closures, announcements, reports.
- Server state is authoritative; local browser state is only a cache. Cancellation is never shown as successful until the server confirms.
- Domain logic lives in `js/domain/` (pure, tested); changes must not alter business behavior, database contracts, or security boundaries.
- Languages: Bahasa Melayu and English, both required on customer-facing screens.
- Currently one shop; multi-shop is possible later but undecided, so shop name, branding, and configuration should stay swappable rather than hard-coded.

## Brand Commitments

Customer-facing name: **C-Cutz Barber** (confirmed). The PRD and older docs say Syam Barber Shop and QueueCut; treat those as internal or legacy names unless told otherwise. No logo or brand assets confirmed yet.

## Evidence on Hand

Product requirements: `docs/QUEUECUT_PRD.md`. Design plan and tracker: `docs/DESIGN_BLUEPRINT.md`, `docs/DESIGN_EXECUTION_TRACKER.md`. Roadmap and status: `QUEUECUT_HANDOVER.md`, `HANDOFF.md`. No real testimonials, customer counts, or photography have been provided; do not fabricate them.

## Product Principles

1. Truth over polish: never show a success state the server has not confirmed.
2. One tap, one authorized action, especially for barbers at the chair.
3. Each surface is built for its real situation: phone one-handed, tablet with busy hands, TV at distance, admin desk.
4. Preserve business behavior and security boundaries when changing the interface.
5. Keep shop identity and language configurable, not hard-coded.

## Accessibility & Inclusion

Accessibility is a stated goal of the modernization (responsive, accessible UI). Known open items from the project's component audit include toggle state semantics, phone-validation error text, tabs pattern, and hand-built dialogs. Bilingual (BM/EN) support is required.
