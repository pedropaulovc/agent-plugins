# unrelated-issue-detector plugin

A Rust Stop hook that detects when the agent dismisses unrelated issues found during development and prompts investigation.

## Build

```
python3 hooks/build-hooks.py
```

## Codex and OpenCode support

Works in both. The `Stop` hook parses both Claude Code transcripts and Codex rollout logs.

OpenCode runs the same detector on `session.idle` and submits one synthetic corrective prompt when it finds an unsupported dismissal.
