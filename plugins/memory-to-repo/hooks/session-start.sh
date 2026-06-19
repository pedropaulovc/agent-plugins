#!/bin/sh
# SessionStart hook for memory-to-repo. Counterpart to the PreToolUse redirect:
# at the start of every session it (1) tells the agent to ignore the default
# machine-local auto-memory destination and use the repo's ./memory/ folder
# instead, and (2) surfaces ./memory/MEMORY.md up front — mirroring how Claude
# Code normally injects the auto-memory MEMORY.md so the index is in context
# from turn one, but from the version-controlled, shared location.
cat >/dev/null   # drain the SessionStart payload on stdin; we don't read it

dir="${CLAUDE_PROJECT_DIR:-$PWD}"
mem="$dir/memory/MEMORY.md"

reminder="Ignore the default auto-memory destination and use \`$dir/memory\` instead. Memories must be kept under version control."

if [ -f "$mem" ]; then
  reminder="$reminder

Contents of $mem (project's auto-memory, persists across conversations):

$(cat "$mem")"
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
