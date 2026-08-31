# QueueCut — domain layer

Pure business logic extracted from the single-file prototype. No DOM, no storage,
no wall clock: every time-dependent input arrives as a parameter. That is what lets
these run under test, and what will let the server reuse them unchanged.

## Layout

```
js/domain/time.js        shop-local time helpers (Asia/Kuala_Lumpur)
js/domain/scheduler.js   seat scheduling, wait estimates, slot availability
tests/domain/            regression fixtures, one per bug found in the audit series
tests/differential.test.mjs   proves parity with the prototype's inline version
build/legacy.cjs         auto-extracted reference implementation (not shipped)
```

## Tests

```
npm test
```

**`tests/domain/scheduler.test.mjs`** — 15 fixtures. Each is a real bug, named by the
audit round it came from, so a future regression is traceable to what it broke.

**`tests/differential.test.mjs`** — 20,000 comparisons against the prototype's original
functions on randomised inputs (varying seat counts, closed seats, break configurations,
malformed timestamps, zero durations, fast-pass mixes). This is the extraction's safety
net: it proves the move changed no behaviour. Keep it until the prototype is retired,
then delete it along with `build/legacy.cjs`.

## Regenerating the reference

`build/legacy.cjs` is extracted from the prototype by brace-matching the named functions
and stubbing the globals they read. Regenerate it if the prototype changes before the
migration completes.

## Notes

- `BREAK_POLICY` is `'finish_in_progress'`: a barber completes the customer in the chair,
  then breaks. The `'pause_and_resume'` branch is retained but unreachable by default —
  some shops genuinely stop work, and that decision should stay explicit.
- `buildOccupancyIntervals` returns queue-record intervals only. Appointments occupy seats
  in the simulation but are not returned, which is what stops `isSlotAvailable` from
  double-counting them.
- A seat closed while occupied keeps its serving interval but stays out of `seatNumbers`,
  so existing occupancy is tracked while no new customer is scheduled onto it.
