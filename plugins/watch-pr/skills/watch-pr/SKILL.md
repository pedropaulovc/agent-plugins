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
   result and retain the opaque `monitorUrl`. It is a read-only bearer capability for
   this OAuth session and PR: never print it, include it in a subagent message visible
   outside the harness, save it in the repository, use it in a process name, or send it
   anywhere except the bundled watcher command.

   If `terminalState` is already `merged` or `closed`, do not launch a watcher. Call
   `get_pr`, perform the matching terminal action below, and clean up with `unwatch_pr`.

4. Resolve `watch-pr-monitor.mjs` from the absolute directory containing this `SKILL.md`;
   do not search the checkout or assume the current working directory. Start the command
   below using exactly one harness-native flow from the next section:

   ```text
   node "<absolute skill directory>/watch-pr-monitor.mjs" "<monitorUrl>"
   ```

5. Classify each stdout JSON line before acting:
   - The exact first line `{"type":"ready","terminalState":"watching"}` is the readiness
     record. It means the first SSE response was validated and an otherwise idle watcher
     is healthy. It is not a PR event, does not describe a PR state change, and must not
     trigger `get_pr`.
   - Every later line is a compact PR event. For each PR event, the root session calls
     `get_pr` in brief mode and handles the resulting lifecycle lines.

   The readiness record is emitted exactly once, including across SSE reconnects, and
   precedes any PR event. Use `list_pr_events` only to explain a transition. Use `get_pr`
   with `mode: "full"` when bodies, thread IDs, URLs, or exact snapshot fields are
   needed. Do not act from the compact watcher payload alone.

## Start the harness watcher

### Claude Code

Create one persistent `Monitor` running the watcher command. Keep that Monitor active
after intermediate lines. Treat the readiness record only as successful startup; each
later PR-event line must wake the root session, which calls `get_pr`. Do not run the
command in an ordinary background shell, create a scheduled task, or replace the
Monitor after an intermediate event. Record the Monitor identifier for explicit
cancellation.

### Codex

Call `spawn_agent` once to create one long-lived watcher subagent. Give it the monitor
URL only inside this private task and instruct it exactly as follows:

```text
Run `node "<absolute skill directory>/watch-pr-monitor.mjs" "<monitorUrl>"` in the
foreground. The exact JSON line {"type":"ready","terminalState":"watching"} is startup
readiness, not a PR event: report readiness to the root without calling or requesting
get_pr, then continue reading the same process. For each later stdout JSON line with
terminalState `watching`, immediately send the exact line to the root session through
the parent-message channel, then continue reading the same process. For a later line
with terminalState `merged` or `closed`, return the exact line to the root as the
terminal result and exit. If the process writes stderr or exits nonzero, send the error
to the root and exit. Do not call MCP or GitHub tools, inspect or modify files, rebase,
push, reply, poll, restart, or launch another watcher.
```

Retain the agent identifier. Do not close it or treat readiness or an intermediate
message as its result. The root reacts only to PR-event messages and leaves the same
subagent running until the terminal result or explicit cancellation.

### Oh My Pi

Start one hub-managed persistent process with `hub(op: "start")`. Use a capability-free,
unique name and pass the monitor URL only as the watcher argument:

```text
hub(
  op: "start",
  name: "watch-pr-<owner>-<repository>-<number>",
  application: "node",
  args: ["<absolute skill directory>/watch-pr-monitor.mjs", "<monitorUrl>"],
  ready: {
    log: "^\\{\"type\":\"ready\",\"terminalState\":\"watching\"\\}$",
    timeout: 60
  },
  progress: "wake"
)
```

Retain the process name for cancellation. The matching line establishes readiness and
must not trigger `get_pr`. Keep the same process running; every later PR-event line
wakes the root session, which calls `get_pr`. Do not use asynchronous Bash, `hub wait`,
job polling, a second process, or a restart after intermediate events.

### Other or uncertain harnesses

Spawn exactly one long-lived subagent with the same foreground-command and messaging
contract shown for Codex. It must distinguish the one readiness record from later PR
events: readiness reports successful startup without triggering `get_pr`; intermediate
PR events are sent to the root while the same process continues; only a terminal PR
event or error ends the subagent. If the harness cannot keep a subagent alive and
deliver its messages to the root, report that the required watch cannot be established
rather than substituting polling, a detached shell, MCP notifications, or repeated
watcher launches.

## Act on lifecycle lines

| Line | Action |
|---|---|
| `PR <n>: <state> [DRAFT]` | Record the current lifecycle state and whether review is still blocked by draft status. |
| `head: <ref>@<sha>` | If the SHA changed, inspect the new commit and restarted checks before acting on earlier results. |
| `mergeable: <yes\|no> (<state>)` | Treat `BEHIND` and `DIRTY` through the rebase actions below; other states are informational. |
| `reviews: <n>` | Read full output when the count changed; `0` explicitly means no reviews. |
| `check <name>: pending` | Informational; wait for a later update. |
| `check <name>: pass`, `skipping`, or `cancel` | Record the terminal result. A canceled required check still needs investigation. |
| `check <name>: fail` | Open the check URL from `get_pr` full output, inspect its logs, fix the cause, commit, and push. |
| `rebase: BEHIND` | Rebase the head branch onto the PR's base branch and push. |
| `rebase: DIRTY` | Rebase, resolve every conflict, and force-push the feature branch with `--force-with-lease`. |
| `review <login>: <state>` | Read `get_pr` full output; handle any substantive review body or unresolved thread. |
| `comments: <n>` or `review-comments: <n>` | Read full output when the count changed; ignore comments authored by the authenticated user. |
| `feedback [<thread>] <file>:<lines> @<author> <title>` | Read the matching unresolved thread and comment body from full output, inspect the named code, then fix or reply. |
| `reaction <kind>: <n>` or `comment-reaction <kind>: <n>` | Informational aggregate only. Read full comments/reviews before attributing a reaction to a reviewer or treating it as a verdict. |
| PR event with `terminalState: "merged"` | Call `get_pr`, call `unwatch_pr`, fetch/prune the local repository when applicable, and report completion. The watcher exits on its own. |
| PR event with `terminalState: "closed"` | Call `get_pr`, call `unwatch_pr`, and report that the PR closed without merging. The watcher exits on its own. |

## Handle review feedback

For each active thread in `get_pr` full output:

1. Read the entire thread and relevant local diff/code. Decide whether the finding is
   correct; do not blindly accept reviewer claims.
2. Make and verify pertinent code changes. Keep unresolved design disagreements open;
   resolve settled threads after replying.
3. Push the fix. This restarts checks and produces later feed events.
4. Reply through `gh` using the comment and thread IDs from full output. Use the
   repository's comments skill when available; otherwise use GitHub's REST reply
   endpoint and GraphQL `resolveReviewThread` mutation directly.

Continue until the watcher reports merge or closure. Passing checks is intermediate;
later reviews, rebases, reruns, and merge events remain part of the same lifecycle.

## Cancel or handle watcher failure

If the user cancels before a terminal event, first stop the exact harness watcher:
stop the Claude Monitor, interrupt and close the Codex/generic subagent, or call
`hub(op: "stop", name: "<recorded process name>")` for Oh My Pi. Confirm that process
has ended, then call `unwatch_pr`. Never leave a detached process holding the monitor
capability.

A permanent watcher error is not an invitation to rearm. Report its stderr to the root,
stop/close its harness container, call `unwatch_pr` when possible, and do not launch a
replacement watcher in this session.
