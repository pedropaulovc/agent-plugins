# Privacy

This notice covers the plugin client and the data flows documented for the hosted `watch-pr` service. It cannot establish the service's complete access controls, retention periods, or deletion practices because the service implementation and its storage policy are not part of this plugin directory. Contact [support](https://go.vza.net/agent-plugins/watch-pr/support) for service-specific questions.

## Agent input and hosted service

Claude Code handles your prompts and any project context under its own service settings and privacy terms. When the `/watch-pr` workflow identifies a pull request, it sends the repository identifier and pull-request number to the OAuth-authenticated MCP service at `https://watch-pr.vza.net/mcp`. The service uses its GitHub connection to provide pull-request lifecycle updates. The documented event data includes branch/ref and commit information, pull-request state, check names/statuses/URLs, and comment, review, and feedback details such as author, body, identifiers, and file/line ranges. The service documentation describes webhook ingestion, minute reconciliation, durable snapshots, and event cursors; this repository does not specify how long those service-side records are retained.

The service returns a read-only `monitorUrl` scoped to the OAuth session and pull request. It expires 12 hours after first creation and contains no GitHub credential, but it is an access-bearing capability and should be protected. The bundled Node process receives that URL as a command-line argument, reads its server-sent event feed, and prints event details to stdout (and connection errors to stderr). Harnesses may capture process arguments and output in transcripts or logs.

The monitor process does not call GitHub or edit a checkout. Separately, the skill instructs the root agent to use the local GitHub CLI and repository tools to inspect code, edit or rebase, push changes, reply to reviews, and resolve threads when appropriate. Those actions use the user's configured GitHub authentication and send the corresponding requests or content to GitHub.

## Local data and third parties

The watcher keeps its current feed cursor in process memory and reports received event details through its output; this plugin does not define additional local transcript retention. GitHub and Anthropic handle information sent to them under their applicable policies. The hosted `watch-pr` service's exact OAuth scopes, data-retention schedule, and deletion behavior are not specified in this repository; do not infer them from the plugin client.

## Links

- [Documentation](https://go.vza.net/agent-plugins/watch-pr/docs)
- [Support](https://go.vza.net/agent-plugins/watch-pr/support)
- [Privacy page](https://go.vza.net/agent-plugins/watch-pr/privacy)
