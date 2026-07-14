---
name: codex-rollout-format
description: How Codex CLI session rollouts (~/.codex/sessions) are structured — for parsing them in record-memory-usage.ts
metadata:
  type: reference
---

Codex CLI writes one JSONL "rollout" per session under `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` (or `$CODEX_HOME/sessions`). Each line is `{type, payload, timestamp}`.

- Session identity: the first line is `type: "session_meta"` with `payload.session_id` (also `payload.id`) and `payload.cwd` (absolute project dir). Filter sessions by cwd against `git worktree list`.
- Tool calls appear as `response_item` entries with `payload.type` of either `function_call` (has `payload.name` + JSON `payload.arguments`) or `custom_tool_call` (has `payload.name` + a JS-source `payload.input` string like `const r = await tools.shell_command({command:"..."})`).
- **Codex has no Read tool** — file reads are shell commands (`cat`, `sed`, `rg`, `Get-Content`). Writes go through `apply_patch` (its own tool name, and also embedded as `const patch = "*** Begin Patch..."` inside `exec` custom_tool_call inputs — no `cmd`/`command` arg, so they're skippable).
- Shell tool names vary by version/OS: WSL/newer use `custom_tool_call` name `exec` invoking `tools.exec_command({cmd:...})`; **Windows uses `function_call` name `shell_command`** and `exec` inputs calling `tools.shell_command({command:"..."})` (a PowerShell string). Also seen: `wait`, `write_stdin`, `web__run`, `update_plan`.
- The command string lives in a `cmd` or `command` field. For `custom_tool_call` inputs (JS, not JSON), extract with regex `/"?(?:cmd|command)"?\s*:\s*"((?:\\.|[^"\\])*)"/g` — this scopes to the actual command and trims the trailing `","workdir":...` JSON that would otherwise bleed into the last path token.

Do NOT scan `message`/`agent_message`/`user_message` (agent text, AGENTS.md, compaction summaries) or `*_output` entries — those hold prose and file contents, not commands. See `plugins/memory-to-repo/scripts/record-memory-usage.ts`.
