#!/bin/sh
input=$(cat)

# Escape hatch: the agent put [force-memory] in the tool call — let it through.
# Reserved for genuinely machine-specific / secret / non-shareable notes that
# do NOT belong in version control; not a routine bypass of the redirect below.
echo "$input" | grep -q '\[force-memory\]' && exit 0

# Decode JSON string escapes (\" -> space) before extracting fields. Without
# this, a double-quoted path inside a Bash command — e.g.
#   {"command":"rm \"~/.claude/projects/x/memory/MEMORY.md\""}
# truncates at the first escaped quote and the delete/rename slips through. We
# only read path/command fields below (never file content), so collapsing
# escaped quotes is safe and cannot leak file text into the match.
decoded=$(printf '%s' "$input" | sed 's/\\"/ /g')

# Pull only the path-bearing fields out of the tool input. We deliberately do
# NOT scan file content (file_text / new_string), so writing docs that merely
# *mention* the auto-memory path is never blocked — only operations whose target
# path is the auto-memory directory are.
#   - Write/Edit/MultiEdit/NotebookEdit -> file_path
#   - Read / Grep / Glob / ListDir      -> file_path (and legacy "path")
#   - Bash                              -> command (covers rm/mv, and PowerShell
#                                          Remove-Item/Move-Item, which run through
#                                          the Bash tool — there is no separate
#                                          PowerShell tool to match)
file_path=$(printf '%s' "$decoded" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//')
path=$(printf '%s' "$decoded" | grep -o '"path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//')
command=$(printf '%s' "$decoded" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//')

candidates="$file_path
$path
$command"

# Match the default machine-local auto-memory directory and nothing else:
#   ~/.claude/projects/<slug>/memory/...   (POSIX and Windows backslash forms)
# Requiring the trailing "memory" segment keeps us from matching transcript_path
# (~/.claude/projects/<slug>/<uuid>.jsonl), which lives under the same projects
# dir but has no memory segment.
#
# NOTE: this anchors to the DEFAULT location only. A custom auto-memory store set
# via the autoMemoryDirectory setting (e.g. ~/my-memory-dir) is NOT auto-detected
# — we deliberately do not match a bare ".../memory" segment, since that would
# also block the repo's own ./memory/ folder, which is the redirect target. If
# you relocate auto memory, extend the pattern below to include that path.
echo "$candidates" | grep -qiE '\.claude[\\/]+projects[\\/]+[^\\/]+[\\/]+memory([\\/"]|$|[[:space:]])' || exit 0

printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked: this targets the machine-local auto-memory directory (~/.claude/projects/<slug>/memory/). It is NOT tracked in git and NOT shared across users, machines, or cloud sessions, so anything stored there is invisible to teammates and lost on a fresh checkout.\n\nMake the EXACT same change in the repository ./memory/ folder instead (relative to the repo root), then commit it so the knowledge is version-controlled and shared with everyone:\n- Create / Update: write the same file under ./memory/ with identical content (e.g. ./memory/MEMORY.md, ./memory/debugging.md).\n- Read: read the corresponding file under ./memory/ instead.\n- Delete / Rename: do it under ./memory/.\nCreate ./memory/ if it does not exist, and keep ./memory/MEMORY.md as the index, mirroring the auto-memory layout.\n\nEscape hatch: if a note is genuinely machine-specific, secret, or otherwise must NOT be shared, add [force-memory] to the tool call to bypass this block. Do not use it to avoid the redirect above."}}'
