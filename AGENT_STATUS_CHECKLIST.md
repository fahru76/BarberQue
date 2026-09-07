# AGENT_STATUS_CHECKLIST

Use this checklist at session start when an AI agent is about to read/modify code.

## One-liner sync command

Run from repo root:

```bash
git log --oneline -n 3 && git status --short --branch && printf "\n--- open/remaining status ---\n" && grep -nE "## Still open|## Done —|Status:" HANDOFF.md QUEUECUT_HANDOVER.md HERMES_AGENT_HANDOFF.md
```

## Manual quick check

1. Open `HANDOFF.md` first (canonical status + done items).
2. Open `QUEUECUT_HANDOVER.md` next (roadmap + proposal/blocked items).
3. Open `HERMES_AGENT_HANDOFF.md` for coordination protocol.
4. Confirm no conflicting edits between these before touching files.
5. After code changes, append a new `## Done — ...` entry to `HANDOFF.md`.
6. Re-run the one-liner and ensure the new entry is present.

## Required before edits (pre-commit reminder)

- **Run this command before any code edit in this session:**

  ```bash
  git log --oneline -n 3 && git status --short --branch && printf "\n--- open/remaining status ---\n" && grep -nE "## Still open|## Done —|Status:" HANDOFF.md QUEUECUT_HANDOVER.md HERMES_AGENT_HANDOFF.md
  ```

- Optional shell alias style (paste into shell startup file, e.g. `~/.bashrc`, then run `agent-sync` whenever you start):

  ```bash
  alias agent-sync='git log --oneline -n 3 && git status --short --branch && printf "\\n--- open/remaining status ---\\n" && grep -nE "## Still open|## Done —|Status:" HANDOFF.md QUEUECUT_HANDOVER.md HERMES_AGENT_HANDOFF.md'

  agent-sync
  ```

- In `AGENTS.md`, `CLAUDE.md`, or your chat runbook: treat this as mandatory, not optional.
