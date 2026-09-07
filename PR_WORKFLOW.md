# Pull request workflow

This repo ships a static browser app from `index.html`, backed by Supabase migrations and small ES modules. Keep `main` deployable and make every change through a short-lived branch + PR.

## One-time local setup

Install the GitHub CLI if you want PR commands from the terminal:

```bash
winget install --id GitHub.cli
```

Then authenticate:

```bash
gh auth login
```

## Daily flow

```bash
git checkout main
git pull --ff-only origin main
git checkout -b fix/short-description

# make changes
npm test

git status --short
git add <changed-files>
git commit -m "fix: short description"
git push -u origin HEAD
gh pr create --fill
```

Use these branch prefixes:

- `fix/` — bug fixes
- `feat/` — new behaviour
- `docs/` — documentation only
- `test/` — tests only
- `ci/` — GitHub Actions / workflow changes
- `refactor/` — code cleanup with no intended behaviour change

Use conventional commit messages:

```text
fix: correct queue refresh after cancellation
feat: add barber service specialty controls
docs: document Supabase live smoke test
ci: add pull request test workflow
```

## Required checks before opening or merging a PR

Always run:

```bash
npm test
```

This covers:

- `tests/domain/scheduler.test.mjs` — deterministic scheduler regressions
- `tests/differential.test.mjs` — parity against the legacy extracted scheduler
- `tests/sql-consistency.mjs` — static checks for Supabase migration consistency

Also run the live smoke test when changing Supabase repository modules, RPC names, column lists, RLS-sensitive SQL, or migrations:

```bash
npm run test:live
```

`test:live` hits the real Supabase project as the anon browser role and intentionally leaves one cancelled smoke-test row because anon has no delete policy.

## PR expectations

Every PR should include:

- Summary of user-visible change
- Test plan with actual commands run
- Screenshots for UI changes to `index.html`
- Risk / rollout notes for Supabase migrations or live-data changes

Keep PRs small. Prefer one feature/fix per PR, especially for `index.html`, because it is large and conflict-prone.

## Supabase change rules

- Add a new timestamped migration under `supabase/migrations/`; do not edit already-applied migrations unless the change has not been deployed anywhere.
- Preserve RLS and `security definer set search_path = public` on RPCs.
- Keep browser repository column lists aligned with grants and live smoke tests.
- For risky database changes, open the PR as a draft until local tests and any live verification pass.

## Merge policy

Recommended GitHub settings for this repo:

1. Protect `main`.
2. Require a pull request before merging.
3. Require the `Actionlint` and `Node tests` status checks.
4. Require branches to be up to date before merge.
5. Use squash merge and delete branches after merge.

After merge:

```bash
git checkout main
git pull --ff-only origin main
git branch -d <merged-branch>
```
