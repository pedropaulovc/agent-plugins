---
name: m
description: Reset current worktree to origin/main. Tears down agent state (task list, scheduled timers, teammates, subagents, monitors, loops, background jobs), cleans stale branches, resets to main, and runs npm install on all worktrees. Pass --force to discard everything without asking.
disable-model-invocation: true
allowed-tools: Bash, AskUserQuestion, TodoWrite, TaskStop, TaskOutput, Monitor
---

# Reset worktree to origin/main

Reset the current worktree branch to origin/main **and** tear down all in-flight agent
state so the session starts from a clean slate.

## Force mode

If `--force` was passed (e.g. `/m --force`), run the whole flow without stopping for
confirmation:

- Discard all agent state below without asking.
- Discard all uncommitted, untracked, **and** git-ignored files without asking — use
  `git clean -fdx .` in place of the gentler clean in step 4, and skip the
  uncommitted-changes guard in step 2 (the reset and clean will discard them).

Without `--force`, keep the confirmation behaviour described in each step.

## 1. Tear down agent state

Clear each of the following. Then **positively validate that each list is actually
empty — do not assume the clear succeeded, re-query and confirm**. If a list still has
entries after a clear, retry the clear and re-check; if something still cannot be
cleared, report it to the user rather than continuing silently.

- **Task list**: clear the todo list, then re-read it and confirm it reports zero items.
- **Scheduled timers**: cancel every scheduled check-in / `send_later` timer, then list
  remaining timers and confirm none remain.
- **Teammates**: dismiss any teammate agents, then list teammates and confirm the roster
  is empty.
- **Subagents**: stop every running or background subagent (`TaskStop`), then list
  running tasks and confirm none remain.
- **Monitors**: stop any active `Monitor` watchers, then confirm none are active.
- **Loops**: cancel any recurring `/loop` tasks and background loops, then confirm none
  remain.
- **Background jobs**: kill any active background shell job, then confirm the job list is
  empty.

## 2. Check for uncommitted changes

Run `git status` to see if there are any staged or unstaged changes. If there are
uncommitted changes, stop and inform the user — they need to commit or stash these
changes first. (Skip this guard in `--force` mode.)

## 3. Check for untracked files

Run `git status` to list any untracked files. If untracked files exist:

- Analyze each untracked file to determine if it's throwaway code (temp files, test
  outputs, build artifacts, etc.) or potentially important work.
- If you're uncertain about any file, use AskUserQuestion to ask the user whether each
  uncertain file should be deleted or kept.
- Only proceed with cleanup if the user confirms all untracked files can be deleted.

(In `--force` mode, skip these questions — everything is discarded in step 5.)

## 4. Run git clean

If the user confirms cleanup (or if all untracked files are clearly throwaway), run
`git clean -df` from the root of the repository to remove untracked files and
directories.

In `--force` mode, run `git clean -fdx .` instead to also remove git-ignored files.

## 5. Reset state

Run the m.sh script located next to this SKILL.md file:

```bash
bash "$(find ~/.claude -path '*/worktree-reset/skills/m/m.sh' 2>/dev/null | head -1)"
```

Report the final status to the user when complete, including confirmation that every
agent-state list in step 1 was validated empty.
