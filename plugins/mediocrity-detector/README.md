![mediocrity-detector icon](icon.svg)

# mediocrity-detector plugin

[Documentation](https://go.vza.net/agent-plugins/mediocrity-detector/docs) · [Support](https://go.vza.net/agent-plugins/mediocrity-detector/support) · [Privacy](https://go.vza.net/agent-plugins/mediocrity-detector/privacy) · [Local privacy details](PRIVACY.md)

A Rust Stop hook that detects hedging language in the current turn ("for now", "good enough", "placeholder", "TODO", etc.) and asks the agent to explicitly report each assumption so the user can make a judgement call.

## Build

```
python3 hooks/build-hooks.py
```

## Codex and OpenCode support

Works in both. The `Stop` hook parses both Claude Code transcripts and Codex rollout logs, scanning the full final turn.

OpenCode runs the same binary when a session becomes idle and submits at most one synthetic corrective prompt, matching the original Stop-hook loop guard.

## Operations and data

The local Stop hook reads the transcript or rollout log supplied by Claude Code or Codex.
It scans the current turn's assistant text and supported file-edit content for a fixed
set of shortcut phrases and code markers. A match is returned to the host as a
stop-blocking reason.

In OpenCode, the plugin reads session messages through OpenCode's provided client,
creates a temporary local transcript for the same scanner, removes that temporary
directory, and may submit one corrective prompt to the session. Those API calls use the
configured OpenCode server, which may be remote. The plugin has no separate third-party
endpoint or telemetry sender; the host's normal model and transcript policies still
apply.
