---
name: watch-pr
description: Watch a GitHub PR's full lifecycle through the hosted watch-pr MCP server, act on CI and rebase changes, and handle incoming review feedback until merge or closure.
argument-hint: "[pr-url-or-ref]"
---

# Watch a PR to green + merged

Use the hosted `watch-pr` MCP server for durable GitHub webhook ingestion and minute
reconciliation. Use the bundled `watch-pr-monitor.mjs` only for its read-only SSE feed.
MCP resource notifications may be useful hints, but they are never the wake-up or
correctness path.

## Preflight the MCP tools

Before resolving or watching a pull request, confirm that the root session's tool
inventory exposes all four required watch-pr MCP tools:

- `watch_pr`
- `open_pr_monitor`
- `get_pr`
- `unwatch_pr`

If any tool is unavailable, tell the user to authenticate the watch-pr MCP server with
`/mcp reauth plugin:watch-pr:watch-pr`, then stop and wait. Do not continue until the
root tool inventory exposes all four tools. Do not invoke Claude CLI, another client,
another MCP transport, or any polling path as a workaround.

## Root-session boundary

The root session that authored the pull request owns every action: calls to `get_pr`,
code edits, rebases, pushes, review replies, and cleanup. The watcher process and any
subagent hosting it are messengers only. They must never inspect or change the checkout,
call GitHub, call MCP tools, or act on a pull request event.

Run exactly one long-lived watcher for this PR in this root session. Keep that same
watcher alive through every intermediate event; never rearm it, start a recurring poll,
or launch a second watcher. The watcher naturally exits after printing a `merged` or
`closed` PR event.

Do not call `watch_pr`, `open_pr_monitor`, or `unwatch_pr` for this PR from a
second client that shares the same MCP credential. The backend watch scope is
shared by that credential, so another client's `unwatch_pr` revokes the root
watcher's capability. Do not report that a watcher is attached until the
harness returns its concrete process, Monitor, or agent identifier and that
same watcher emits the readiness record.

## Start watching

1. Resolve the pull request with `gh pr view`. If no argument was supplied, resolve the
   current branch:

   ```bash
   gh pr view --json number,url -q '"#\(.number) \(.url)"'
   ```

   For an explicit number, URL, or branch, pass it to `gh pr view`. Keep the full URL;
   its `/OWNER/REPOSITORY/pull/NUMBER` path supplies the MCP arguments without depending
   on the current checkout's remotes.

2. From the root session, call `watch_pr` with:
   - `repository`: `OWNER/REPOSITORY`
   - `number`: the pull-request number

3. From the root session, call `open_pr_monitor` with the same arguments. Parse its JSON
   result and retain `monitorUrl`. The URL is a read-only capability scoped to this OAuth
   session and PR. It expires 12 hours after first creation; repeated calls reuse the
   same URL and original deadline until expiry. It carries no GitHub credential and is
   safe to include in harness calls, process arguments, transcripts, and logs.

   If `terminalState` is already `merged` or `closed`, do not launch a watcher. Call
   `get_pr`, perform the matching terminal action below, and clean up with `unwatch_pr`.

4. Resolve `watch-pr-monitor.mjs` from the absolute directory containing this `SKILL.md`;
   do not search the checkout or assume the current working directory. Start exactly one
   watcher through the harness-native flow below, passing the URL directly:

   ```text
   node "<absolute skill directory>/watch-pr-monitor.mjs" "<monitorUrl>"
   ```

5. Classify each stdout line before acting:
   - The exact first line `watch-pr: ready` is startup readiness. It is not a PR event.
   - Every other nonterminal stdout line contains actionable event details inline. One
     watcher is scoped to one PR, so these lines omit a redundant PR/update prefix. Check
     failures include their URL; comments, reviews, and feedback include the changed body
     and GitHub URL. Act from this line without calling `get_pr`.
   - Routine check transitions and no-op webhook deliveries emit nothing. A check rerun
     produces one start line, immediate named failures or cancellations, and one terminal
     rollup after every pending check settles.
   - `PR <n> finished: MERGED` or `PR <n> finished: CLOSED` is terminal. Call `get_pr`
     once to reconcile final state before the terminal action below.

   The readiness record is emitted exactly once, including across SSE reconnects, and
   precedes every PR event. Use `get_pr` only for terminal reconciliation or when an
   inline detail explicitly lacks information needed to act. Use `list_pr_events` only
   to explain a transition.

## Start the harness watcher

### Claude Code

Create one persistent `Monitor` running the watcher command with `monitorUrl` as its
sole argument. Keep that Monitor active after intermediate updates. Treat
`watch-pr: ready` only as successful startup; each later nonterminal detail line or
`PR <n> finished: ...` line wakes the root session. Record the Monitor identifier for
explicit cancellation. Do not run the command in an ordinary background shell, create
a scheduled task, or replace the Monitor after an intermediate event.

### Codex

Call `spawn_agent` once to create one long-lived watcher subagent. Give it the watcher
path and `monitorUrl`, and instruct it exactly as follows:

```text
Run `node "<absolute skill directory>/watch-pr-monitor.mjs" "<monitorUrl>"` in the
foreground. Report the exact line `watch-pr: ready` to the root as startup readiness,
then continue reading the same process. For each nonterminal line after readiness,
immediately send the exact line to the root session through the parent-message channel,
continue reading the same process. For `PR <n> finished: MERGED` or
`PR <n> finished: CLOSED`, return the exact line to the root as the terminal result and
exit. If the process writes stderr or exits nonzero, send the error to the root and
exit. Do not call MCP or GitHub tools, inspect or modify files, rebase, push, reply,
poll, restart, or launch another watcher.
```

Retain the agent identifier. Do not close it or treat readiness or an intermediate
message as its result. The root acts directly from intermediate detail lines and leaves
the same subagent running until the terminal result or explicit cancellation.

### Oh My Pi

Start one hub-managed persistent process with a capability-free unique name:

```text
hub(
  op: "start",
  name: "watch-pr-<owner>-<repository>-<number>",
  application: "node",
  args: ["<absolute skill directory>/watch-pr-monitor.mjs", "<monitorUrl>"],
  ready: {
    log: "^watch-pr: ready(?:\\r?\\n|$)",
    timeout: 60
  },
  progress: "wake"
)
```

Retain the process name for cancellation. The readiness match must not trigger
`get_pr`. Keep the same process running; every later actionable or terminal line wakes
the root. Do not use asynchronous Bash, recurring `hub wait`, job polling, a second
process, or a restart after intermediate events.

### Other or uncertain harnesses

Spawn exactly one long-lived subagent with the direct-URL foreground command and
messaging contract shown for Codex. It must distinguish the one readiness line from
later PR events and remain alive through intermediate updates. If the harness cannot
keep a subagent alive and deliver its messages to the root, report that the required
watch cannot be established rather than substituting polling, a detached shell, MCP
notifications, or repeated watcher launches.

## Act on lifecycle lines

| Line | Action |
|---|---|
| `head: <ref>@<sha>` | Inspect the new commit and restarted checks before acting on earlier results. |
| `base: <old> -> <new>` | Re-evaluate the branch and merge target before pushing or merging. |
| `rebase: BEHIND` | Rebase the head branch onto the PR's base branch and push. |
| `rebase: DIRTY` | Rebase, resolve every conflict, and force-push the feature branch with `--force-with-lease`. |
| `rebase: <other-state>` | Record that the prior behind/conflict condition cleared; continue with checks and review. |
| `PR state: <OPEN\|CLOSED> [DRAFT]` | Record the lifecycle or draft transition; a `DRAFT` suffix still blocks review. |
| `checks: rerun started (pending: ...)` | Informational; wait for the rollup or an immediate failure. |
| `checks: pending (...)` | Reconciliation state: named checks are still running. |
| `check <name>: fail <url>` | Open the URL, inspect logs, fix the cause, commit, and push. |
| `check <name>: cancel <url>` | Investigate whether the canceled check is required or should be rerun. |
| `checks: all terminal (...)` | Confirm every required check passed; investigate nonzero fail or cancel counts. |
| `comment #<id> @<author> <url>: <body>` | Read the body inline, decide whether it requires action, then reply at the URL when needed. |
| `review #<id> @<author> <state> <url>: <body>` | Handle the verdict and body directly; do not fetch the complete PR merely to locate it. |
| `feedback [<thread>] #<comment-id> <file>:<lines> @<author> <url>: <body>` | Inspect the named code, fix or reply, and use the IDs when replying or resolving the thread. `[-]` means GitHub did not return a thread ID. |
| `thread <id>: reopened\|resolved` | Re-opened feedback requires action; record resolved feedback without another snapshot fetch. |
| `comment\|review\|feedback ... deleted` | Record that the referenced feedback was removed; do not act on its stale text. |
| `+<n> more changes` | The event exceeded its safety bound; call `get_pr` once to reconcile the omitted details. |
| `PR <n> finished: MERGED` | Call `get_pr`, call `unwatch_pr`, fetch/prune the local repository when applicable, and report completion. The watcher exits on its own. |
| `PR <n> finished: CLOSED` | Call `get_pr`, call `unwatch_pr`, and report that the PR closed without merging. The watcher exits on its own. |

## Handle review feedback

For each inline `comment`, `review`, or `feedback` detail:

1. Read the supplied body and relevant local diff/code. Decide whether the finding is
   correct; do not blindly accept reviewer claims.
2. Make and verify pertinent code changes. Keep unresolved design disagreements open;
   resolve settled threads after replying.
3. Push the fix. This restarts checks and produces later feed events.
4. Reply through `gh` using the comment, review, thread, and URL identifiers already in
   the event line. Use the repository's comments skill when available; otherwise use
   GitHub's REST reply endpoint and GraphQL `resolveReviewThread` mutation directly.

Continue until the watcher reports merge or closure. Passing checks is intermediate;
later reviews, rebases, reruns, and merge events remain part of the same lifecycle.

## Cancel, renew, or handle watcher failure

If the user cancels before a terminal event, stop the exact harness watcher: stop the
Claude Monitor, interrupt and close the Codex/generic subagent, or call
`hub(op: "stop", name: "<recorded process name>")` for Oh My Pi. Confirm that process
has ended, then call `unwatch_pr`.

A permanent watcher error is not an invitation to poll. Stop or close its harness
container. For HTTP 401, 403, or 404 after a previously ready connection, the error
includes the last event ID. Call `open_pr_monitor` once, replace its URL's `cursor`
query parameter with that ID (or remove `cursor` when the ID is empty), then start one
replacement watcher. This replays changes that landed during renewal. For a rejection
before readiness or another permanent error, call `unwatch_pr` when possible and report
the error instead of launching a replacement.
