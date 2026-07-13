# mediocrity-detector plugin

A Rust Stop hook that detects hedging language in the current turn ("for now", "good enough", "placeholder", "TODO", etc.) and asks the agent to explicitly report each assumption so the user can make a judgement call.

## Build

```
python3 hooks/build-hooks.py
```

## Codex and OpenCode support

Works in both. The `Stop` hook parses both Claude Code transcripts and Codex rollout logs, scanning the full final turn.

OpenCode runs the same binary when a session becomes idle and submits at most one synthetic corrective prompt, matching the original Stop-hook loop guard.
