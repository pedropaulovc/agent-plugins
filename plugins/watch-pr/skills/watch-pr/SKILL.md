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
inventory exposes all three required watch-pr MCP tools:

- `watch_pr`
- `get_pr`
- `unwatch_pr`

If any tool is unavailable, tell the user to authenticate the watch-pr MCP server with
`/mcp reauth plugin:watch-pr:watch-pr`, then stop and wait. Do not continue until the
root tool inventory exposes all three tools. Do not invoke Claude CLI, another client,
another MCP transport, or any polling path as a workaround.

## Root-session boundary

The root session that authored the pull request owns every action: calls to `get_pr`,
code edits, rebases, pushes, review replies, and cleanup. The watcher process and any
subagent hosting it are messengers only. They must never inspect or change the checkout,
call GitHub, call MCP tools, or act on a pull request event.

Run one active watcher for this PR in the root session. Prefer keeping it through every
intermediate event. Replace it only when it has exited, failed, or can no longer continue
and lifecycle monitoring is still needed. Before starting a replacement, confirm the old
watcher is stopped and preserve its last event ID when one exists. Never run two watchers
for the same PR or substitute recurring polling.

Do not call `watch_pr` or `unwatch_pr` for this PR from a
second client that shares the same MCP credential. The backend watch scope is
shared by that credential, so another client's `unwatch_pr` revokes the root
watcher's capability. Report only that the watcher process started once the harness
returns its concrete process, Monitor, or agent identifier; silence does not prove the
SSE connection is healthy. Permanent connection errors terminate the process on stderr.
Sustained transient failures emit a bounded stderr warning while retries continue.

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

   The single call subscribes and opens the monitor capability. Parse its JSON result
   and retain `monitor.monitorUrl`. The URL is a read-only capability scoped to this
   OAuth session and PR. It expires 12 hours after first creation; repeated calls reuse
   the same URL and original deadline while it remains valid, then mint a new capability
   after expiry. It carries no GitHub credential and is safe to include in harness calls,
   process arguments, transcripts, and logs.

   If the result has no `monitor` object, the server predates the merged tool; stop and
   report instead of launching a watcher. If `monitor.terminalState` is already `merged`
   or `closed`, do not launch a watcher. Call `get_pr`, perform the matching terminal
   action below, and clean up with `unwatch_pr`.

3. Resolve `watch-pr-monitor.mjs` from the absolute directory containing this `SKILL.md`;
   do not search the checkout or assume the current working directory. Start exactly one
   watcher through the harness-native flow below, passing the URL directly:

   ```text
   node "<absolute skill directory>/watch-pr-monitor.mjs" "<monitorUrl>"
   ```

4. Classify each stdout record:
   - The watcher emits nothing for startup or an idle feed. Silence is not a PR event.
   - Every nonterminal output begins with actionable event details. One watcher is scoped
     to one PR, so the output omits a redundant PR/update prefix. Comment, review, and
     feedback bodies retain their original Markdown lines; every continuation line starts
     with `│ ` and therefore cannot be mistaken for a watcher record. Check failures
     include their URL; comment and review headers include their IDs, while feedback also
     includes the file and start/end lines. Their redundant GitHub URLs are omitted.
     Act from this output without calling `get_pr`.
   - Routine check transitions and no-op webhook deliveries emit nothing. A check rerun
     produces one start record per pending check, immediate named failures or
     cancellations, and a terminal record per check after every pending check settles.
     Each check status is its own physical line.
   - `PR <n> finished: MERGED` or `PR <n> finished: CLOSED` is terminal. Call `get_pr`
     once to reconcile final state before the terminal action below.

   Use `get_pr` only for terminal reconciliation, after a cursorless monitoring gap, or
   when an inline detail explicitly lacks information needed to act. Use
   `list_pr_events` only to explain a transition.

## Start the harness watcher

### Claude Code

Create one persistent `Monitor` running the watcher command with `monitorUrl` as its
sole argument. Keep that Monitor active after intermediate updates. An idle watcher
prints nothing; each nonterminal output block or `PR <n> finished: ...` line wakes the
root session. Record the Monitor identifier for explicit cancellation. If the process
exits, inspect its stderr and let the root session decide whether rearming is necessary.
Do not run the command in an ordinary background shell or create a scheduled task.
Before creating a replacement Monitor, stop the recorded Monitor and confirm it ended.

### Codex

Call `spawn_agent` once to create one long-lived watcher subagent. Give it the watcher
path and `monitorUrl`, and instruct it exactly as follows:

```text
Run `node "<absolute skill directory>/watch-pr-monitor.mjs" "<monitorUrl>"` in the
foreground. The process emits nothing while the feed is idle. For each nonterminal
stdout line, immediately send the exact line to the root session through the
parent-message channel. Lines beginning with `│ ` continue the preceding comment,
review, or feedback body and are never standalone watcher records. Continue reading
the same process. For `PR <n> finished: MERGED` or `PR <n> finished: CLOSED`, return
the exact line to the root as the terminal result and exit. If stderr starts with
`watch-pr monitor: still reconnecting`, send that nonfatal warning to the root and
continue reading the same process. For any other stderr output or a nonzero exit, send
the error and last stdout event to the root and exit.
Do not call MCP or GitHub tools, inspect or modify files, rebase, push, reply, poll,
restart, or launch another watcher; the root session decides recovery.
```

Retain the agent identifier. Do not close it or treat silence or an intermediate
message as its result. The root acts directly from intermediate detail lines and leaves
the same subagent running until the terminal result, process failure, or explicit
cancellation.
Before spawning a replacement, confirm the recorded watcher agent and its child process
have ended.

### Oh My Pi

Start one hub-managed persistent process with a capability-free unique name:

```text
hub(
  op: "start",
  name: "watch-pr-<owner>-<repository>-<number>",
  application: "node",
  args: ["<absolute skill directory>/watch-pr-monitor.mjs", "<monitorUrl>"],
  progress: "wake"
)
```

Retain the process name for cancellation. Initial silence is normal; every actionable
or terminal line wakes the root. If the process exits, use its captured stderr and last
event ID to decide whether to fix the launch, refresh the capability, or stop watching.
Do not use asynchronous Bash, recurring `hub wait`, job polling, or a second process
while the current watcher is running.
Before restarting this name, stop any live process under it and confirm termination.

### Other or uncertain harnesses

Spawn one long-lived subagent with the direct-URL foreground command and messaging
contract shown for Codex. It must remain alive during idle periods and deliver stdout,
stderr, and process exit to the root. If the harness cannot keep a subagent alive and
deliver its messages, report that the required watch cannot be established rather than
substituting polling or a detached shell.

## Act on lifecycle lines

| Line | Action |
|---|---|
| `head: <ref>@<sha>` | Inspect the new commit and restarted checks before acting on earlier results. |
| `base: <old> -> <new>` | Re-evaluate the branch and merge target before pushing or merging. |
| `rebase: BEHIND` | Rebase the head branch onto the PR's base branch and push. |
| `rebase: DIRTY` | Rebase, resolve every conflict, and force-push the feature branch with `--force-with-lease`. |
| `rebase: <other-state>` | Record that the prior behind/conflict condition cleared; continue with checks and review. |
| `PR state: <OPEN\|CLOSED> [DRAFT]` | Record the lifecycle or draft transition; a `DRAFT` suffix still blocks review. |
| `checks: <name> -> pending` | Informational; wait for that check's result or an immediate failure. Every check arrives on its own line. |
| `checks: <name> -> pass` \| `checks: <name> -> skipping` | Record the terminal result for that check; no action. |
| `checks: <name> -> fail <url>` | Open the URL, inspect logs, fix the cause, commit, and push. |
| `checks: <name> -> cancel <url>` | Investigate whether the canceled check is required or should be rerun. |
| `comment #<id> @<author>: <body>` | Read the full body inline, including any `│ ` continuation lines; decide whether it requires action, then use the comment ID to reply when needed. |
| `review #<id> @<author> <state>: <body>` | Handle the verdict and full body directly, including any `│ ` continuation lines; use the review ID when a reply is needed. |
| `feedback [<thread>] #<comment-id> <file>:<start>[-<end>] @<author>: <body>` | Inspect the named code and all `│ ` continuation lines, then fix or reply using the IDs. `[-]` means GitHub did not return a thread ID. |
| `thread <id>: reopened\|resolved` | Re-opened feedback requires action; record resolved feedback without another snapshot fetch. |
| `comment\|review\|feedback ... deleted` | Record that the referenced feedback was removed; do not act on its stale text. |
| `+<n> more checks` | The server bounded a large check wave; call `get_pr` once for the omitted check states. |
| `+<n> more changes` | Non-body details exceeded the safety bound or a body required snapshot reconciliation; call `get_pr` once for the omitted details. |
| `PR <n> finished: MERGED` | Call `get_pr`, call `unwatch_pr`, fetch/prune the local repository when applicable, and report completion. The watcher exits on its own. |
| `PR <n> finished: CLOSED` | Call `get_pr`, call `unwatch_pr`, and report that the PR closed without merging. The watcher exits on its own. |

## Handle review feedback

For each inline `comment`, `review`, or `feedback` detail:

1. Read the supplied body and relevant local diff/code. Decide whether the finding is
   correct; do not blindly accept reviewer claims.
2. Make and verify pertinent code changes. Keep unresolved design disagreements open;
   resolve settled threads after replying.
3. Push the fix. This restarts checks and produces later feed events.
4. Reply through `gh` using the comment, review, and thread identifiers already in the
   event output. Use the repository's comments skill when available; otherwise use
   GitHub's REST reply endpoint and GraphQL `resolveReviewThread` mutation directly.

Continue until the watcher reports merge or closure. Passing checks is intermediate;
later reviews, rebases, reruns, and merge events remain part of the same lifecycle.

## Cancel, renew, or handle watcher failure

If the user cancels before a terminal event, stop the exact harness watcher: stop the
Claude Monitor, interrupt and close the Codex/generic subagent, or call
`hub(op: "stop", name: "<recorded process name>")` for Oh My Pi. Confirm that process
has ended, then call `unwatch_pr`.

When a watcher fails, confirm that process has exited or stop it before deciding whether
to rearm. Diagnose the concrete failure instead of retrying blindly:

- For a local launch error, fix the cause and reuse the monitor URL if it remains valid.
- For HTTP 401, 403, or 404, call `watch_pr` again, replace the returned
  `monitor.monitorUrl`'s `cursor` query parameter with the reported last event ID
  (remove `cursor` when that ID is empty), then start one replacement watcher with the
  URL as its only argument.
- If that replacement fails the same way, call `watch_pr` once more and start one more
  replacement rebuilt the same way; if it fails again, stop watching and report instead
  of retrying.
- For any other permanent HTTP error, do not rearm; report it and call `unwatch_pr`.
- After a gap with no cursor, call `get_pr` once to reconcile current state.
- If monitoring is no longer useful or recovery is unsafe, call `unwatch_pr`.

Never leave the old process running, start duplicate watchers, or replace monitoring
with recurring polling.
