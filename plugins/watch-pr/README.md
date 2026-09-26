# watch-pr plugin
![Pull request watcher icon](icon.svg)

Provides the `/watch-pr` skill, an OAuth-authenticated connection to the hosted
[`watch-pr` MCP server](https://watch-pr.vza.net/mcp), and a dependency-free Node 22
SSE monitor. The root agent starts one monitor for the pull request; the bundled script
reads its event feed and keeps the PR lifecycle attached to that agent session.

The root tool inventory must expose `watch_pr`, `get_pr`, and
`unwatch_pr`. If any tool is missing, authenticate the server with
`/mcp reauth plugin:watch-pr:watch-pr`. Claude CLI, another MCP client, and polling are
not supported substitutes.

The hosted service is documented as handling GitHub webhooks, minute reconciliation,
durable snapshots, and event cursors. A `watch_pr` call returns a read-only
`monitor.monitorUrl` scoped to the OAuth session and pull request. It expires 12 hours
after first creation and contains no GitHub credential, but it is still an access-bearing
capability: protect it. It may appear in process arguments, transcripts, and logs.

The script is bundled beside the skill. Resolve its absolute path from the installed
skill directory and pass the URL directly:

```text
node "<absolute skill directory>/watch-pr-monitor.mjs" "<monitorUrl>"
```

The watcher prints:

1. Formatted blocks of actionable event details. One watcher is scoped to one PR, so
   intermediate output omits a redundant PR/update prefix. Comment, review, and feedback
   headers keep their IDs; feedback keeps its file and line range. Visible Markdown
   bodies retain their line breaks, and continuation lines start with `│ `.
2. Lifecycle and overflow records such as head/base/rebase changes, PR state, review
   thread changes, deletions, and `+N more checks` or `+N more changes` when details are
   bounded or need snapshot reconciliation.
3. `PR <n> finished: MERGED|CLOSED` before a terminal feed exits.

Startup and idle feeds are silent. Permanent connection failures go to stderr and
terminate the process. Sustained transient failures emit one stderr warning per outage
while retries continue, so silence alone does not prove that the feed is connected.

Routine check completions and no-op webhook deliveries stay silent. A CI rerun emits one
`checks: <name> -> <status>` record per affected check, each on its own physical line:
start records, immediate named failures or cancellations, and terminal records
after pending checks settle. Comment deltas carry the changed comment itself, so a root
agent does not have to fetch and search a PR snapshot containing older comments.

The local watcher is a read-only messenger: it does not inspect or modify the checkout,
call GitHub, or call MCP tools. Separately, the `/watch-pr` skill directs the root agent
to use the user's GitHub CLI credentials and repository tools to inspect code, make
changes, rebase or push, reply to reviews, and resolve threads when appropriate. Those
agent actions send the corresponding requests and content to GitHub. `get_pr` is used
for final reconciliation, after a cursorless gap, or when an event lacks required context.

Run at most one active watcher for each PR and shared MCP credential, not one per client;
another client using that credential can cancel this watch by calling `unwatch_pr`:

- Claude Code uses one persistent `Monitor`.
- Codex and other agent harnesses use one long-lived watcher subagent.
- Oh My Pi uses one `hub(op: "start")` process with `monitorUrl` as the script's only
  argument. No readiness pattern is required because an idle watcher emits nothing.

Prefer retaining the same watcher through intermediate events. Before replacing it,
confirm the old process is stopped. Local launch errors can reuse a still-valid URL.
For HTTP 401, 403, or 404, preserve the last event ID in `cursor` on a new URL from
`watch_pr`; remove `cursor` if the ID is empty. The skill bounds that recovery to two
replacements. Do not rearm after other permanent HTTP errors. After a cursorless gap,
reconcile once with `get_pr`. Never run duplicate watchers or substitute recurring polling.

Claude Code and Codex load the remote server from the inline plugin manifest. The
OpenCode adapter registers the same endpoint and `/watch-pr` command. Aggregate
OpenCode installs can set `mcp.watch-pr.enabled` to `false`; the adapter preserves an
existing MCP entry.

## Data handling

The hosted MCP calls use the repository identifier and PR number; the service returns
GitHub lifecycle data such as refs and commit IDs, check names/statuses/URLs, and
comment, review, and feedback details. The `monitorUrl` is passed to the local Node
process as an argument, and feed content is printed to its output, which an agent
harness may capture in transcripts or logs. The workflow's local `gh` and repository
actions are separate from the read-only monitor. The backend's exact retention and
deletion rules are not defined in this plugin directory.

## Plugin resources

[Documentation](https://go.vza.net/agent-plugins/watch-pr/docs) · [Support](https://go.vza.net/agent-plugins/watch-pr/support) · [Privacy](https://go.vza.net/agent-plugins/watch-pr/privacy) · [Local privacy notice](PRIVACY.md)
