# playwright-cli-headed plugin

![playwright-cli-headed plugin icon](icon.svg)

This plugin registers a PreToolUse hook for Bash and PowerShell calls. A bundled native hook program reads the harness's JSON tool event from stdin and inspects the tool name, command, and (when present) description and permission mode. It does not launch the browser or run `playwright-cli` itself.

## What it changes

For a literal `playwright-cli ... open ...` command without `--headed`, the hook inserts `--headed` after the `open` token and returns the changed tool input to the coding-agent host. It also adds a reminder recommending `playwright-cli resize 1600 900` for consistent screenshots. The `[no-rewrite]` marker in a tool description suppresses the insertion but not the reminder. Other executables such as `npx playwright` are not matched.

Claude Code and OpenCode apply the rewrite through their hook integrations. Codex only rewrites when its permission mode already skips approval (`bypassPermissions` or `dontAsk`); otherwise it stays inert rather than approving a changed command. The plugin bundles Linux x86_64 and Windows x86_64 hook binaries and includes Rust source.

## Data handling

The hook only processes the current tool event and returns hook output to the host; it has no browser-storage access, does not retain the event, and makes no network requests. The rewritten command still runs through the host's normal tool flow, and any website navigation or network activity comes from that requested `playwright-cli` command, not from this hook. Tool commands can contain sensitive text; the host handles them under its ordinary model and tool policies.

- [Documentation](https://go.vza.net/agent-plugins/playwright-cli-headed/docs)
- [Support](https://go.vza.net/agent-plugins/playwright-cli-headed/support)
- [Privacy policy](PRIVACY.md) · [Online privacy policy](https://go.vza.net/agent-plugins/playwright-cli-headed/privacy)
