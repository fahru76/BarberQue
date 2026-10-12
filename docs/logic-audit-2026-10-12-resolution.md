# Logic audit fixes — 2026-10-12

Implemented the eight findings and both low-severity items from the attached audit.

| Finding | Resolution |
| --- | --- |
| 1, 8 | `take_walkin_ticket` validates shop state, operating hours, current duty, waiting walk-in limit and bounded inputs under a shared booking-date lock. The database mints the number and catalogue label/price/duration in the same transaction. Anon table insert/select and public counter access are revoked, including column grants. |
| 2 | Future dates use `shop_settings.seat_count`. Today counts active chairs with an active assigned staff member and duty for this business date; rest does not close booking capacity. Page uses the same planned/live distinction. |
| 3 | Server refresh replaces the locally retained scope, preserving matching local ownership metadata. Queue rendering uses memory if storage writes fail. Historical reports are never persisted in browser storage. |
| 4 | Admin and own summaries load server reports; export details come from the same report scope. Inactive/deleted staff sales retain their stored barber name. Reports use Malaysia business dates, including overnight tails. Missing reports show loading/error text rather than zero sales. |
| 5 | Past same-business-day starts are rejected. Check-in requires today's business date. |
| 6 | Self service restrictions API is revoked. Dispatch ignores capability and specialty; estimates follow unrestricted dispatch. Per-barber duration overrides remain. |
| 7 | Shared service validation triggers enforce target, style/basic, bald/facial and single-basic rules; reject unknown/inactive IDs and build canonical snapshots for bookings too. Check-in retains the agreed booking snapshot. |
| Low items | Hours use business date and walk-in numbering rolls back with failed insertion. |

## Validation

- `npm run test:audit`: replay all migrations in PGlite (Postgres), with Supabase Auth/Realtime/Storage stubs; 13 database scenarios and 6 client checks.
- `npm test`: existing scheduler, differential and SQL consistency/grant checks.
- Client checks compile inline scripts, test storage failure, prune 20,000 historical rows, and verify RPC payloads and booking capacity.
- Edge live-refresh browser check: no page errors, stale row removed from storage and screen, and no horizontal overflow on the tested desktop surface.

## Deployment

Apply `supabase/migrations/20261012151733_logic_audit_fixes.sql` before publishing the updated `index.html` and `js/repositories/queueRepository.js`. Old pages using direct inserts will need refreshing after the migration. No production database migration or site deployment was performed by this task.

Future capacity is configured chair count; it is not a staff roster. Set the count to the number of chairs normally staffed for advance bookings.

Publication integration: based on GitHub main at 7ddb6c6. Preserves customer passes, language switching and rest triggers. Both next-customer and specific-ticket calls ignore hidden service restrictions. Server summary totals remain authoritative; export details are paginated beyond the API row cap.
