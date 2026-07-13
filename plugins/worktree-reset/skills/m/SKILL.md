---
name: m
description: Reset current worktree to origin/main. Tears down agent state (task list, scheduled timers, teammates, subagents, monitors, loops, background jobs), cleans stale branches, resets to main, and runs npm install on all worktrees. Pass --force to discard everything without asking.
disable-model-invocation: true
allowed-tools: Bash, AskUserQuestion, TaskCreate, TaskList, TaskGet, TaskUpdate, TaskStop, TaskOutput, Monitor, Agent, SendMessage, CronList, CronDelete, unsubscribe_pr_activity
---

# Reset worktree to origin/main

Reset the current worktree branch to origin/main **and** tear down all in-flight agent
state so the session starts from a clean slate.

## Force mode

If `--force` was passed (e.g. `/m --force`), run the whole flow without stopping for
confirmation:

- Discard all agent state below without asking.
- Discard all uncommitted, untracked, **and** git-ignored files without asking — use
  `git clean -fdx .` in place of the gentler clean in step 5, and skip the
  uncommitted-changes guard in step 3 (the reset and clean will discard them).
- Drop all stashes without asking (`git stash clear` in step 4).

Without `--force`, keep the confirmation behaviour described in each step.

## 1. Tear down agent state

> **Under Codex or OpenCode:** the primitives below (task list, scheduled timers, teammates,
> subagents, monitors, `/loop`, PR-activity subscriptions) are Claude Code
> concepts with no equivalent — the listed tools (`TaskStop`, `Monitor`,
> `CronDelete`, `unsubscribe_pr_activity`, …) do not exist there. In a Codex or OpenCode
> session, **skip this section entirely** except for **Background jobs** (stop any
> background terminals via the harness's mechanism, e.g. `/stop`), and proceed to
> the git steps below — the worktree reset + dep reinstall is the portable core.

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
- **PR activity subscriptions**: unsubscribe from every watched PR
  (`unsubscribe_pr_activity`) so the session stops waking on GitHub webhook events, then
  confirm no subscriptions remain.

## 2. Abort any in-progress git operation

A half-finished operation will block the checkout/reset in step 6, so clear it first.
For each of the following, abort only if one is actually in progress (each command is a
no-op / harmless failure otherwise):

```bash
git rebase --abort 2>/dev/null || true
git merge --abort 2>/dev/null || true
git cherry-pick --abort 2>/dev/null || true
git am --abort 2>/dev/null || true
```

Also remove a stale lock left by a crashed git process if (and only if) no git process
is running: `rm -f .git/index.lock`.

## 3. Check for uncommitted changes

Run `git status` to see if there are any staged or unstaged changes. If there are
uncommitted changes, stop and inform the user — they need to commit or stash these
changes first. (Skip this guard in `--force` mode.)

## 4. Check for untracked files and stashes

Run `git status` to list any untracked files. If untracked files exist:

- Analyze each untracked file to determine if it's throwaway code (temp files, test
  outputs, build artifacts, etc.) or potentially important work.
- If you're uncertain about any file, use AskUserQuestion to ask the user whether each
  uncertain file should be deleted or kept.
- Only proceed with cleanup if the user confirms all untracked files can be deleted.

Also run `git stash list`. A `git reset --hard` does **not** clear stashes, so report any
that exist and let the user decide whether to keep them.

(In `--force` mode, skip these questions — everything is discarded in step 5, and run
`git stash clear` to drop all stashes.)

## 5. Run git clean

If the user confirms cleanup (or if all untracked files are clearly throwaway), run
`git clean -df` from the root of the repository to remove untracked files and
directories.

In `--force` mode, run `git clean -fdx .` instead to also remove git-ignored files.

## 6. Reset state

Prune bookkeeping for worktrees whose directories are gone, then run the `m.sh` script
that sits in this skill's own directory (right next to this `SKILL.md`). You already know
that directory's absolute path — it's where you loaded this file from — so invoke the
script by that path directly. Do **not** search for it with `find`; that scans all of
`~/.claude` and can match a stale or differently-installed copy.

```bash
git worktree prune
bash "<absolute path of the directory containing this SKILL.md>/m.sh"
```

Report the final status to the user when complete, including confirmation that every
agent-state list in step 1 was validated empty.
