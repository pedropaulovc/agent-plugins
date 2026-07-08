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
# actually Read each memory file, and the most-used entries get their full
# index line (title + description) instead of just the title — so the
# memories this project reaches for most are the ones with the richest
# context up front. See the budget block below for how much and how many.
cat >/dev/null   # drain the SessionStart payload on stdin; we don't read it

dir="${CLAUDE_PROJECT_DIR:-$PWD}"
mem="$dir/memory/MEMORY.md"
usage="$dir/memory/usage.jsonl"

reminder="Ignore the default auto-memory destination and use \`$dir/memory\` instead. Memories must be kept under version control."

# Claude Code's SessionStart additionalContext is capped at 10,000 characters
# (https://code.claude.com/docs/en/hooks) — content past that is swapped for a
# file preview + path, not a clean cut, which could sever this list mid-entry.
# Auto memory's own MEMORY.md load uses a similar idea (first 200 lines or
# 25KB, whichever comes first): a fixed, predictable budget beats a cutoff
# imposed after the fact. safety_margin covers jq's JSON-escaping overhead
# (mainly newlines -> \n) plus slop; lengths below are counted in bytes via
# `wc -c`/`cut -b` for consistency, which for UTF-8 content is a conservative
# (i.e. never-exceeds) proxy for the character-based cap, since every
# multi-byte character is >= 1 byte.
hard_cap=10000
safety_margin=1500
min_described=3
desc_share_pct=30

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

  header="

Memory index from $mem, sorted by usage — most-consulted-first:

"
  prefix_len=$(printf '%s%s' "$reminder" "$header" | wc -c)
  total_budget=$((hard_cap - safety_margin - prefix_len))
  [ "$total_budget" -lt 200 ] && total_budget=200
  desc_budget=$((total_budget * desc_share_pct / 100))

  # Walk ranked entries in order: the top `min_described` always get their
  # full index line (title + description), ellipsis-truncated to fit only if
  # desc_budget is too tight to hold them whole. Once that budget is spent,
  # remaining entries fall back to title-only, spending whatever of
  # total_budget the descriptions didn't use. If even titles overrun what's
  # left, the rest are dropped and counted in a trailing "N omitted" line
  # rather than silently disappearing.
  body=""
  desc_used=0
  n_described=0
  title_used=0
  omitted=0
  phase=desc
  while IFS= read -r line; do
    [ -z "$line" ] && continue

    if [ "$phase" = desc ]; then
      # +1 for the newline that joins this entry to the growing body — wc -c
      # on the bare line doesn't count it, and left uncounted across enough
      # entries it can push the real output past total_budget.
      line_len=$(printf '%s' "$line" | wc -c)
      line_len=$((line_len + 1))
      if [ "$n_described" -lt "$min_described" ] || [ $((desc_used + line_len)) -le "$desc_budget" ]; then
        if [ $((desc_used + line_len)) -gt "$desc_budget" ]; then
          remaining=$((desc_budget - desc_used))
          [ "$remaining" -lt 20 ] && remaining=20
          line="$(printf '%s' "$line" | cut -b "1-$remaining" | iconv -f utf-8 -t utf-8 -c)…"
          line_len=$(printf '%s' "$line" | wc -c)
          line_len=$((line_len + 1))
        fi
        body="${body:+$body
}$line"
        desc_used=$((desc_used + line_len))
        n_described=$((n_described + 1))
        continue
      fi
      phase=title
      title_budget=$((total_budget - desc_used))
      [ "$title_budget" -lt 0 ] && title_budget=0
    fi

    title=$(printf '%s\n' "$line" | sed -n 's/^- \[\([^]]*\)\](.*/- \1/p')
    title_len=$(printf '%s' "$title" | wc -c)
    title_len=$((title_len + 1))
    if [ "$omitted" -eq 0 ] && [ $((title_used + title_len)) -le "$title_budget" ]; then
      body="${body:+$body
}$title"
      title_used=$((title_used + title_len))
    else
      omitted=$((omitted + 1))
    fi
  done <<EOF
$ranked
EOF
  [ "$omitted" -gt 0 ] && body="$body

…and $omitted more memories omitted (see $mem for the full index)"

  reminder="$reminder$header$body"
elif [ -f "$mem" ]; then
  # MEMORY.md index lines look like:
  #   - [Title](file.md) — one-line description
  # Emit just "- Title" per line; for the full contents read MEMORY.md.
  header="

Memory titles from $mem (only titles shown; read MEMORY.md for full contents):

"
  prefix_len=$(printf '%s%s' "$reminder" "$header" | wc -c)
  total_budget=$((hard_cap - safety_margin - prefix_len))
  [ "$total_budget" -lt 200 ] && total_budget=200

  body=""
  title_used=0
  omitted=0
  while IFS= read -r title; do
    [ -z "$title" ] && continue
    # +1 for the newline that joins this entry to the growing body (see the
    # matching comment in the ranked branch above).
    title_len=$(printf '%s' "$title" | wc -c)
    title_len=$((title_len + 1))
    if [ "$omitted" -eq 0 ] && [ $((title_used + title_len)) -le "$total_budget" ]; then
      body="${body:+$body
}$title"
      title_used=$((title_used + title_len))
    else
      omitted=$((omitted + 1))
    fi
  done <<EOF
$(sed -n 's/^- \[\([^]]*\)\](.*/- \1/p' "$mem")
EOF
  [ "$omitted" -gt 0 ] && body="$body

…and $omitted more memories omitted (see $mem for the full index)"

  reminder="$reminder$header$body"
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
