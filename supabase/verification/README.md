# Live verification

Two SQL checks that must run against the **real** project, not a local
Postgres, because what they test only exists on a live instance: the auth
schema, the applied function bodies, and the behaviour of a `security definer`
RPC that reads `auth.uid()`.

`npm test` cannot cover either of these. `sql-consistency.mjs` and
`sql-grant-consistency.mjs` check the *source* — structure, grants, delimiters.
They parse SQL text; they never execute it. A predicate can be structurally
perfect and semantically backwards, which is precisely what happened here: the
capability gate read `service_ids && v_capability` (overlap) where the column's
contract required `service_ids <@ v_capability` (subset), and every static check
in the repo stayed green through three separate migrations that shipped the
wrong operator.

## Running them

There is no local Supabase CLI, no `psql`, and no local credential in this
repo — the project's `SUPABASE_ACCESS_TOKEN` exists only as a GitHub Actions
secret. So these run through the **Management API**, dispatched by
`.github/workflows/verify-capability-gate.yml`:

```bash
gh workflow run verify-capability-gate.yml -f mode=schema-shape
gh workflow run verify-capability-gate.yml -f mode=capability-gate -f confirm=RUN
```

Then:

```bash
gh run watch
```

## `schema_shape.sql` — read-only, no approval gate

Sent with `read_only: true`, so the server refuses anything that is not a
`SELECT`. It reports one row: `ok` plus a `problems` array. It asserts the
**applied** schema, not the source tree:

- `staff.capability_service_ids` / `staff.specialty_service_ids` exist
- the `staff_specialty_subset_of_capability` constraint exists
- `queues.service_ids` exists
- `call_next_customer()`'s deployed body contains `service_ids <@ v_capability`
  and does **not** contain `service_ids && v_capability`
- `list_today_queues_full()` and `list_active_appointments()` return
  `TABLE(...)` rather than `SETOF <table>`, do not name `claim_token` in their
  result type, and still name the columns the client mappers actually read
  (`barber_name`, `appt_date`)

That operator check is the important one. It reads `pg_get_functiondef()` on
the live function, so it fails if the migration was never applied — and it
fails if a later migration reverts the operator, which no static check would
notice.

## `capability_gate.sql` — behavioural, approval-gated

Sent with `read_only: false`, because it inserts fixtures. It runs as one
`do` block inside the request's own transaction and ends in
`raise exception 'PASSED'`, so the transaction aborts and **nothing persists**.

Four scenarios, each with exactly one waiting ticket so the result is
unambiguous:

| # | Barber capability | Waiting ticket | Expected |
|---|---|---|---|
| A | `['skin-fade']` | `['skin-fade','perm']` | raises `P0002` — the only ticket is outside capability |
| B | `['skin-fade']` | `['skin-fade']` | returns it — single-service still works |
| C | `['perm']` | `NULL` | returns it — NULL stays "unknown, compatible" |
| D | `NULL` (unrestricted) | `['skin-fade','perm']` | returns it — unrestricted path intact |

Scenario A is the regression test for the actual bug. Under the old `&&`
predicate it returns the multi-service ticket and marks it `serving`; under
`<@` it raises. Scenarios B–D are the guard against over-correcting: a fix
that made the gate too strict would fail B, C, or D.

Each scenario drives the real RPC with `set_config('request.jwt.claims', ...)`
so `auth.uid()` resolves to the fixture barber, then asserts the returned row's
`id`, `status`, `seat_no` and `barber_id` — not just "it didn't error".

### Reading the result

The check **passes when the API returns an error whose message contains
`PASSED`** — that is the deliberate abort, not a failure.

| Response | Meaning |
|---|---|
| error, message contains `PASSED` | all four scenarios held; transaction rolled back |
| error, any other message | an assertion failed, or fixture setup broke — the message says which |
| HTTP 2xx | the block never reached its `raise`; treat as a failure |

The workflow then issues a second, read-only query counting rows with an `id`
like `VR-%` and fails if it is not zero, so "rollback-safe" is verified rather
than asserted.

### Live rows are parked, not ignored

`call_next_customer()` selects from all waiting rows and refuses a seat that is
already serving, so a real ticket would be picked ahead of a fixture and every
assertion would read as a false failure. The block therefore parks any
pre-existing `waiting` row, and any `serving` row at seats 1–4, inside its own
transaction before the scenarios run. All of that rolls back with everything
else — the closing read-only `count(*)` of `VR-%` rows is what confirms it.

### The one fragile part

The fixture inserts into `auth.users`, because `public.staff.id` has a foreign
key to it. That is the only piece coupled to Supabase's own auth schema: if a
future Supabase release adds a `NOT NULL` column with no default to
`auth.users`, the insert fails and the check reports the exact Postgres error.
That is a loud failure, not a silent one, and it is the correct place for the
coupling to surface.