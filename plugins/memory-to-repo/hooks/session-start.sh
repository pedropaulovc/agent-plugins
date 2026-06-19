#!/bin/sh
# SessionStart hook for memory-to-repo. Counterpart to the PreToolUse redirect:
# at the start of every session it (1) tells the agent to ignore the default
# machine-local auto-memory destination and use the repo's ./memory/ folder
# instead, and (2) surfaces the ./memory/MEMORY.md index up front — but only the
# memory *titles*, not the full one-line descriptions, to keep context lean.
# Mirrors how Claude Code normally injects the auto-memory MEMORY.md so the index
# is in context from turn one, but from the version-controlled, shared location.
cat >/dev/null   # drain the SessionStart payload on stdin; we don't read it

dir="${CLAUDE_PROJECT_DIR:-$PWD}"
mem="$dir/memory/MEMORY.md"

reminder="Ignore the default auto-memory destination and use \`$dir/memory\` instead. Memories must be kept under version control."

if [ -f "$mem" ]; then
  # MEMORY.md index lines look like:
  #   - [Title](file.md) — one-line description
  # Emit just "- Title" per line; for the full contents read MEMORY.md.
  titles=$(sed -n 's/^- \[\([^]]*\)\](.*/- \1/p' "$mem")
  reminder="$reminder

Memory titles from $mem (only titles shown; read MEMORY.md for full contents):

$titles"
fi

context="<system-reminder>
$reminder
</system-reminder>"

# SessionStart adds the hook's additionalContext (or, lacking jq, raw stdout) to
# the session context. jq -Rs safely JSON-encodes arbitrary MEMORY.md content.
if command -v jq >/dev/null 2>&1; then
  printf '%s' "$context" | jq -Rs '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:.}}'
else
  printf '%s\n' "$context"
fi
