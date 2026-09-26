# Privacy policy: memory-to-repo

This plugin's hooks and usage scanner run locally; they do not make independent network requests or send data to the plugin author. The plugin can still expose selected information to the model host or to a Git remote through the workflows described below.

## Hook behavior

On a pre-tool event, the native hook receives the tool input from the host, checks path-bearing fields and shell-command targets for the default Claude Code and Codex machine-local memory paths, and returns a deny or updated-input response. It does not read the targeted file contents for this check. The `[force-memory]` escape hatch is removed from the approved tool input before the operation proceeds.

At session start, the hook reads the repository's `memory/MEMORY.md` and, when present, `memory/usage.jsonl`. It adds a bounded index of memory titles and descriptions to the agent's context. The host model therefore receives that index as session context. The hook does not automatically include every topic file's body, though the agent can read those files when needed.

## Memory audit and usage records

`/memory-audit` reads selected memory files and checks claims against repository files and Git history. Its read-only subagents receive the memory content assigned to them through the configured host harness. If the user confirms changes, the main agent may edit or remove memory files through normal workspace tools.

`/record-memory-usage` scans matching local Claude Code and Codex session JSONL files to identify reads of repository memory files. It parses those logs locally and writes distinct session IDs and memory filenames to `memory/usage.jsonl`; it does not copy full transcript contents into that file. When the file is first created, the script may also create or update the repository's `.gitattributes`. The usage log is stored in the project and can be shared with collaborators if committed or pushed, so it contains session identifiers and memory filenames that users should review before sharing.

## Provider and repository policies

Prompt and memory text added to the host's model context is handled according to the configured model provider's policies. Files in the project memory directory follow the repository's storage, access, and Git-hosting settings. Do not put secrets or machine-specific notes in shared repository memory unless that is intended.
