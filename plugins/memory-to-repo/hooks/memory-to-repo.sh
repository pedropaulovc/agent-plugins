#!/bin/sh
input=$(cat)

# Escape hatch: the agent put [force-memory] in the tool call — let it through.
# Reserved for genuinely machine-specific / secret / non-shareable notes that
# do NOT belong in version control; not a routine bypass of the redirect below.
echo "$input" | grep -q '\[force-memory\]' && exit 0

# Pull only the path-bearing fields out of the tool input. We deliberately do
# NOT scan file content (file_text / new_string), so writing docs that merely
# *mention* the auto-memory path is never blocked — only operations whose target
# path is the auto-memory directory are.
#   - Write/Edit/MultiEdit/NotebookEdit -> file_path
#   - Read                              -> file_path (and legacy "path")
#   - Bash                              -> command
file_path=$(echo "$input" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//')
path=$(echo "$input" | grep -o '"path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//')
command=$(echo "$input" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//')

candidates="$file_path
$path
$command"

# Match the machine-local auto-memory directory and nothing else:
#   ~/.claude/projects/<slug>/memory/...   (POSIX and Windows backslash forms)
# Custom locations set via the autoMemoryDirectory setting are also caught if
# they keep a ".../memory" segment. Requiring the trailing "memory" segment
# keeps us from matching transcript_path (~/.claude/projects/<slug>/<uuid>.jsonl),
# which lives under the same projects dir but has no memory segment.
echo "$candidates" | grep -qiE '\.claude[\\/]+projects[\\/]+[^\\/]+[\\/]+memory([\\/"]|$|[[:space:]])' || exit 0

printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked: this targets the machine-local auto-memory directory (~/.claude/projects/<slug>/memory/). It is NOT tracked in git and NOT shared across users, machines, or cloud sessions, so anything stored there is invisible to teammates and lost on a fresh checkout.\n\nMake the EXACT same change in the repository ./memory/ folder instead (relative to the repo root), then commit it so the knowledge is version-controlled and shared with everyone:\n- Create / Update: write the same file under ./memory/ with identical content (e.g. ./memory/MEMORY.md, ./memory/debugging.md).\n- Read: read the corresponding file under ./memory/ instead.\n- Delete / Rename: do it under ./memory/.\nCreate ./memory/ if it does not exist, and keep ./memory/MEMORY.md as the index, mirroring the auto-memory layout.\n\nEscape hatch: if a note is genuinely machine-specific, secret, or otherwise must NOT be shared, add [force-memory] to the tool call to bypass this block. Do not use it to avoid the redirect above."}}'
