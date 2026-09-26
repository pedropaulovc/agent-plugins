# Privacy

This notice describes Superpowers' Claude Code integration and its optional brainstorming companion. It does not replace the privacy terms of Claude Code, Anthropic, or services used by tools that the agent runs.

## Prompts, project context, and tools

Claude Code's `SessionStart` hook emits static Superpowers bootstrap instructions; it does not read the user's prompt or project files. The other skills are instructions consumed by Claude when the model chooses to invoke them. They may guide Claude to inspect or edit project files, run local shell or Git commands, use subagents, or ask the user questions. Any prompts and project context sent through Claude Code are handled under Claude Code's service settings and policies. Commands or integrations that Claude runs may send data to their configured remotes or services; Superpowers does not define those destinations or policies.

## Optional visual companion

The brainstorming visual companion starts only when the workflow considers a visual comparison useful and the user accepts it. It runs a local Node HTTP/WebSocket server, normally bound to `127.0.0.1`, and serves HTML screens from a local session directory. With `--project-dir`, screens and state are stored under `<project>/.superpowers/brainstorm/<session>/`; without it, they are stored under `/tmp/brainstorm-<session>/`. When stopped, temporary `/tmp` sessions are removed; project-local mockups are retained for later reference. Server startup and session files are created with owner-only permissions and may include the session key.

The browser sends click/choice events to the local server over WebSocket. An event can include the selected text, choice value, element ID, and timestamp. The server prints event data to its local output and appends choice events to the local state file; a new screen clears the event file. These mockups and interactions are not uploaded by the companion server to Prime Radiant. The session URL contains a key that grants access to the local screens and event channel; treat it as sensitive because it may appear in process arguments, startup output, or agent transcripts. If `BRAINSTORM_HOST` is changed from loopback to a network-reachable address, hosts that can reach the server and obtain the key may access it.

When the companion page is rendered, it requests the Prime Radiant logo image from `https://primeradiant.com/brand/superpowers-visual-brainstorming-logo.png?v=<version>`. The query contains the Superpowers version resolved by the companion; the image request does not include prompt or project text and is sent without a referrer. The remote host may receive ordinary web-request metadata such as the browser's source IP and request headers; this repository does not specify its logging or retention. Set `SUPERPOWERS_DISABLE_TELEMETRY=1`, `DISABLE_TELEMETRY=1`, or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` to suppress this image request. These flags do not disable the local visual companion.

Other skill/reference documents contain outbound links and at least one remote image reference (`skills/writing-skills/anthropic-best-practices.md`). The hook and companion server do not fetch those reference assets; a client that opens or renders the document may request them.

## Links

- [Documentation](https://go.vza.net/agent-plugins/superpowers/docs)
- [Support](https://go.vza.net/agent-plugins/superpowers/support)
- [Privacy page](https://go.vza.net/agent-plugins/superpowers/privacy)
