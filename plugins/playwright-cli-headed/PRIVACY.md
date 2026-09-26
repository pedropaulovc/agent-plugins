# Privacy policy: playwright-cli-headed

## What the plugin does

The plugin registers a local PreToolUse command hook for Bash and PowerShell tool events. The bundled binary reads the event JSON from standard input and checks the tool name, command, and, when available, the description and Codex permission mode. It does not start Playwright or inspect browser profiles, cookies, page contents, or screenshots.

## Information and destinations

- **Hook input:** The coding-agent host supplies the current tool event. When a matching command needs rewriting, the hook returns the original tool input with its command changed, plus hook context, to that same host. It does not store the event or send it to an external endpoint. Tool commands may themselves contain sensitive values; the hook does not redact them.
- **Claude and model-provider processing:** Prompts and tool calls/results are handled by Anthropic as part of the ordinary Claude session. With another host or model provider, its normal data practices apply. The hook adds no separate model API request.
- **Browser traffic:** The hook makes no network requests. If the host subsequently executes the rewritten `playwright-cli open` command, Playwright may connect to the URL and other resources specified by that command. That browser traffic is caused by the user's requested command, not by this hook.

The plugin contains no browser credentials or telemetry service. Its local hook behavior does not change the host's ordinary handling of prompts, tool events, or browser activity.
