#!/bin/sh
# SessionStart hook for memory-to-repo. Counterpart to the PreToolUse redirect:
# at the start of every session it (1) tells the agent to ignore the default
# machine-local auto-memory destination and use the repo's ./memory/ folder
# instead, and (2) surfaces the ./memory/MEMORY.md index up front — but only the
# memory *titles*, not the full one-line descriptions, to keep context lean.
# Mirrors how Claude Code normally injects the auto-memory MEMORY.md so the index
# is in context from turn one, but from the version-controlled, shared location.
#
# If ./memory/usage.jsonl exists (written by the /record-memory-usage command),
# the index is instead sorted descending by how many distinct past sessions
# actually Read each memory file, and the top 5 get their full index line
# (title + description) instead of just the title — so the memories this
# project reaches for most are the ones with the richest context up front.
cat >/dev/null   # drain the SessionStart payload on stdin; we don't read it

dir="${CLAUDE_PROJECT_DIR:-$PWD}"
mem="$dir/memory/MEMORY.md"
usage="$dir/memory/usage.jsonl"

reminder="Ignore the default auto-memory destination and use \`$dir/memory\` instead. Memories must be kept under version control."

if [ -f "$mem" ] && [ -s "$usage" ]; then
  # usage.jsonl lines look like: {"sessionId":"...","memoryFileName":"memory/foo.md"}
  # Count distinct (session, file) records per file — no jq needed, same
  # field-extraction style as memory-to-repo.sh's own JSON parsing.
  counts=$(grep -o '"memoryFileName"[[:space:]]*:[[:space:]]*"[^"]*"' "$usage" \
    | sed 's/.*:[[:space:]]*"//; s/"$//' \
    | sort | uniq -c)
  tab=$(printf '\t')

  # Attach each MEMORY.md index line to its usage count (0 if absent from
  # usage.jsonl), plus a tie-break key that preserves original MEMORY.md
  # order for equal counts, then sort descending by count.
  ranked=$(awk -v counts="$counts" -v OFS="$tab" '
    BEGIN {
      n = split(counts, lines, "\n")
      for (i = 1; i <= n; i++) {
        if (lines[i] == "") continue
        split(lines[i], f, " ")
        cnt[f[2]] = f[1] + 0
      }
    }
    /^- \[/ {
      idx++
      split($0, a, "[()]")
      file = a[2]
      c = (file in cnt) ? cnt[file] : 0
      print c, (1000000 - idx), $0
    }
  ' "$mem" | sort -t "$tab" -k1,1rn -k2,2rn | cut -f3-)

  titles=""
  i=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    i=$((i + 1))
    if [ "$i" -le 5 ]; then
      entry="$line"
    else
      entry=$(printf '%s\n' "$line" | sed -n 's/^- \[\([^]]*\)\](.*/- \1/p')
    fi
    titles="${titles:+$titles
}$entry"
  done <<EOF
$ranked
EOF

  reminder="$reminder

Memory index from $mem, sorted by usage — most-consulted-first (top 5 shown in full, read MEMORY.md for the rest):

$titles"
elif [ -f "$mem" ]; then
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
