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
event cursors. After `watch_pr`, the root session calls `open_pr_monitor` and passes its
opaque read-only `monitorUrl` only to
`skills/watch-pr/watch-pr-monitor.mjs`. The capability must never appear in output,
repository files, or process names.

The watcher has two stdout record kinds:

1. After validating its first SSE response, it prints exactly
   `{"type":"ready","terminalState":"watching"}`. This one-time readiness record proves
   that an otherwise idle connection is healthy. It is not a PR event and must not
   trigger `get_pr`. Reconnects do not print it again.
2. It then prints one compact JSON line per PR event. Each PR-event line wakes the root,
   which calls `get_pr`; the compact payload itself is not an action source.

The readiness record always precedes any PR event. PR-event delivery resumes from the
last event ID without duplicate output. The watcher stays alive through checks, reviews,
feedback, rebases, reruns, and other intermediate activity, then exits successfully
after a `merged` or `closed` PR event. It never receives GitHub credentials and never
edits, rebases, pushes, replies, or calls MCP tools.

Exactly one watcher is allowed per PR/root session. Harness integration must keep that
same watcher and distinguish readiness from PR events:

The root must retain the concrete Monitor, process, or agent identifier and observe
that watcher's readiness record before reporting it as attached. A second client using
the same MCP credential must not watch or unwatch the same PR: the credential shares
one backend watch scope, so its `unwatch_pr` revokes the root watcher's capability.

- **Claude Code:** one persistent `Monitor`; readiness marks startup, while each later
  PR-event line wakes the root.
- **Codex:** one long-lived `spawn_agent` subagent runs the watcher in the foreground,
  reports readiness without requesting `get_pr`, relays each intermediate PR event
  without exiting, and returns only at merge, closure, or error.
- **Oh My Pi:** one hub-managed persistent process started with `hub(op: "start")`,
  `progress: "wake"`, and readiness regex
  `^\{"type":"ready","terminalState":"watching"\}$`; asynchronous Bash is not used.
- **Other harnesses:** one long-lived subagent follows the same foreground-process and
  root-message contract. A harness that cannot deliver intermediate messages must fail
  clearly rather than fall back to polling, detached processes, or repeated launches.

Canceling a nonterminal watch always stops the harness watcher first and then calls
`unwatch_pr`. A terminal PR event makes the watcher exit naturally; the root calls
`get_pr`, performs terminal cleanup, and calls `unwatch_pr`.

Claude Code and Codex load the remote server from inline plugin manifest configuration.
The OpenCode adapter registers the same endpoint and `/watch-pr` command. For aggregate
OpenCode installs, preconfigure `mcp.watch-pr.enabled` as `false` to disable the hosted
connection; the adapter preserves an existing MCP entry. OAuth uses dynamic client
registration and GitHub authorization, while service detection remains read-only.
