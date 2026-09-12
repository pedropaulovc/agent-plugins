# watch-pr plugin

Provides the `/watch-pr` skill, an OAuth-authenticated connection to the hosted
[`watch-pr` MCP server](https://watch-pr.vza.net/mcp), and a dependency-free Node 22
SSE watcher that keeps the pull request attached to the root agent session that authored
it.

Before starting, the root tool inventory must expose `watch_pr`, `open_pr_monitor`,
`get_pr`, and `unwatch_pr`. If any is missing, ask the user to authenticate the server
with `/mcp reauth plugin:watch-pr:watch-pr`, then stop until all four tools are mounted.
Claude CLI, another MCP client or transport, and polling are not supported workarounds.

The server owns GitHub webhooks, minute reconciliation, durable snapshots, and durable
event cursors. For a nonterminal PR, after `watch_pr` the root session calls
`open_pr_monitor` and starts the one-shot `watch-pr-monitor.mjs mint [absolute-directory]`
helper. The helper reads the opaque read-only `monitorUrl` once from a private stdin
channel. On POSIX it atomically creates an owner-only `0600` capability file in the OS
temporary directory (or a supplied existing absolute directory outside the repository).
Windows rejects custom directories and uses only the per-user OS temporary directory. It
atomically creates each capability file with a protected DACL granting full control only to
the invoking user, verifies that DACL, and writes the URL before publishing the path; minting
fails closed if that setup cannot run. This excludes other unprivileged SIDs, but not same-user
processes or elevated Administrator, SYSTEM, or backup access. The reader canonicalizes the
path and rejects paths outside the canonical temporary directory and paths inside a repository.
The helper writes the URL and prints only the capability-free path. Feed stdin through a
harness-native process API with no PTY; never interpolate the URL into shell text or a
heredoc, or put it in arguments, environment variables, output, logs, messages,
repository files, or process names. Every harness
passes only this path to `watch-pr-monitor.mjs --url-file <capability-file>`. The watcher
reads and unlinks the file immediately, retaining the URL only in memory.

The watcher prints concise plain-text records:

1. After validating its first SSE response, it prints exactly `watch-pr: ready`. This
   one-time readiness line proves that an otherwise idle connection is healthy. It is
   not a PR event and must not trigger `get_pr`. Reconnects do not print it again.
2. For an intermediate PR event it prints `PR <n> updated: <changes>`, naming only the
   meaningful changed fields. If the changed-field list is empty, it names the GitHub
   event instead so a direct base-branch push still wakes the root.
3. For a terminal PR event it prints exactly `PR <n> finished: MERGED` or
   `PR <n> finished: CLOSED`.

Every PR-event line wakes the root, which calls `get_pr` for the current details. The
readiness line always precedes any PR event. Event delivery resumes from the last event
ID without duplicate output. The watcher stays alive through checks, reviews, feedback,
rebases, reruns, and other intermediate activity, then exits successfully after a
terminal line. It never receives GitHub credentials and never edits, rebases, pushes,
replies, or calls MCP tools.

Exactly one watcher is allowed per PR/root session. Harness integration must keep that
same watcher and distinguish readiness from PR events:

The root must retain the concrete Monitor, process, or agent identifier and observe
that watcher's readiness record before reporting it as attached. A second client using
the same MCP credential must not watch or unwatch the same PR: the credential shares
one backend watch scope, so its `unwatch_pr` revokes the root watcher's capability.

- **Claude Code:** one persistent `Monitor` receives only the capability-file path;
  `watch-pr: ready` marks startup, while each later `PR <n> ...` line wakes the root.
- **Codex:** one long-lived `spawn_agent` subagent receives only the capability-file
  path, runs the watcher in the foreground, reports `watch-pr: ready` without requesting
  `get_pr`, relays each intermediate `PR <n> updated: ...` line without exiting, and
  returns only for a terminal `PR <n> finished: ...` line or error.
- **Oh My Pi:** first run the `mint` helper as a short-lived hub process with `pty:false`
  and `progress:"off"`, feed its stdin privately, and retain its path-only output; then
  run one hub-managed persistent watcher with `progress:"wake"` and readiness regex
  `^watch-pr: ready$`. A hub start has no stdin at launch, so use its private send channel.
- **Other harnesses:** one long-lived subagent receives only the capability-file path
  and follows the same foreground-process and root-message contract. A harness that
  cannot deliver intermediate messages must fail
  clearly rather than fall back to polling, detached processes, or repeated launches.

Canceling a nonterminal watch always stops the harness watcher, deletes any unconsumed
capability file, and then calls `unwatch_pr`. A terminal PR event makes the watcher exit
naturally; the root calls
`get_pr`, performs terminal cleanup, and calls `unwatch_pr`.

Claude Code and Codex load the remote server from inline plugin manifest configuration.
The OpenCode adapter registers the same endpoint and `/watch-pr` command. For aggregate
OpenCode installs, preconfigure `mcp.watch-pr.enabled` as `false` to disable the hosted
connection; the adapter preserves an existing MCP entry. OAuth uses dynamic client
registration and GitHub authorization, while service detection remains read-only.
