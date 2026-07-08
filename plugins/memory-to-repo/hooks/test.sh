#!/bin/sh
# Tests for memory-to-repo.sh. Run: sh plugins/memory-to-repo/hooks/test.sh
set -u
HOOK="$(dirname "$0")/memory-to-repo.sh"
fail=0

pass() { printf 'ok   - %s\n' "$1"; }
die()  { printf 'FAIL - %s\n' "$1"; fail=1; }

run() { printf '%s' "$1" | sh "$HOOK"; }

AUTO='/home/me/.claude/projects/-home-me-proj/memory/MEMORY.md'

# 1. Write to the auto-memory dir is denied.
out=$(run "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$AUTO\",\"content\":\"x\"}}")
echo "$out" | grep -q '"permissionDecision":"deny"' && pass "blocks Write to auto-memory" || die "expected deny, got: $out"

# 2. Write to the repo ./memory/ folder is allowed (no output).
out=$(run '{"tool_name":"Write","tool_input":{"file_path":"./memory/MEMORY.md","content":"x"}}')
[ -z "$out" ] && pass "allows repo ./memory/ writes" || die "repo memory blocked: $out"

# 3. Bash rm targeting auto-memory is denied.
out=$(run "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"rm $AUTO\"}}")
echo "$out" | grep -q '"permissionDecision":"deny"' && pass "blocks Bash rm of auto-memory" || die "expected deny, got: $out"

# 4. [force-memory] on the file_path is honored AND stripped.
out=$(run "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"[force-memory] $AUTO\",\"content\":\"secret\"}}")
echo "$out" | grep -q '"updatedInput"' || die "force-memory produced no updatedInput: $out"
stripped=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.file_path')
[ "$stripped" = "$AUTO" ] && pass "strips [force-memory] from file_path" || die "file_path not stripped clean: '$stripped'"
# additionalContext may still mention the marker when explaining the hatch, so
# check only the forwarded updatedInput.
printf '%s' "$out" | jq -e '.hookSpecificOutput.updatedInput | tostring | contains("[force-memory]")' >/dev/null 2>&1 \
  && die "marker leaked into updatedInput: $out" || pass "no marker left in updatedInput"
# content must be untouched
content=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.content')
[ "$content" = "secret" ] && pass "leaves content untouched" || die "content altered: '$content'"

# 5. [force-memory] on a Bash command is honored AND stripped.
out=$(run "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"rm $AUTO [force-memory]\"}}")
cmd=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.command')
[ "$cmd" = "rm $AUTO" ] && pass "strips [force-memory] from command" || die "command not stripped clean: '$cmd'"

# --- SessionStart hook ------------------------------------------------------
SS="$(dirname "$0")/session-start.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
ss() { CLAUDE_PROJECT_DIR="$tmp" sh "$SS" </dev/null; }

# 6. No repo MEMORY.md: emits the redirect reminder, no contents block.
out=$(ss)
ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext')
echo "$ctx" | grep -q "use \`$tmp/memory\` instead" && pass "SessionStart points at repo ./memory/" || die "redirect line missing: $ctx"
echo "$ctx" | grep -q '<system-reminder>' && pass "SessionStart wraps in system-reminder" || die "no system-reminder wrapper: $ctx"
echo "$ctx" | grep -q 'Contents of' && die "unexpected contents block with no MEMORY.md: $ctx" || pass "no contents block when MEMORY.md absent"

# 7. With a repo MEMORY.md: only memory titles are surfaced, not descriptions.
mkdir -p "$tmp/memory"
printf '# Index\n- [foo](foo.md) — bar baz\n' > "$tmp/memory/MEMORY.md"
out=$(ss)
ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext')
echo "$ctx" | grep -q "only titles shown" && pass "SessionStart explains titles-only" || die "titles-only note missing: $ctx"
echo "$ctx" | grep -q '^- foo$' && pass "SessionStart includes the memory title" || die "title missing: $ctx"
echo "$ctx" | grep -q 'bar baz' && die "description leaked into context: $ctx" || pass "drops the one-line description"
echo "$ctx" | grep -q 'foo.md' && die "link target leaked into context: $ctx" || pass "drops the link target"

# 8. With usage.jsonl present: index is sorted by usage descending. All 7
# entries here are short enough to fit the description budget whole, so all
# get the full line (title + description) -- the budget logic (tested below)
# only starts trimming once content actually threatens the additionalContext
# cap, not at a fixed rank cutoff.
cat > "$tmp/memory/MEMORY.md" << 'MD'
# Index
- [Alpha](alpha.md) — alpha desc
- [Bravo](bravo.md) — bravo desc
- [Charlie](charlie.md) — charlie desc
- [Delta](delta.md) — delta desc
- [Echo](echo.md) — echo desc
- [Foxtrot](foxtrot.md) — foxtrot desc
- [Golf](golf.md) — golf desc
MD
cat > "$tmp/memory/usage.jsonl" << 'JSONL'
{"sessionId":"s1","memoryFileName":"foxtrot.md"}
{"sessionId":"s2","memoryFileName":"foxtrot.md"}
{"sessionId":"s3","memoryFileName":"foxtrot.md"}
{"sessionId":"s1","memoryFileName":"alpha.md"}
{"sessionId":"s2","memoryFileName":"alpha.md"}
{"sessionId":"s1","memoryFileName":"charlie.md"}
JSONL
out=$(ss)
ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext')
order=$(echo "$ctx" | grep -E '^- ')
expected="- [Foxtrot](foxtrot.md) — foxtrot desc
- [Alpha](alpha.md) — alpha desc
- [Charlie](charlie.md) — charlie desc
- [Bravo](bravo.md) — bravo desc
- [Delta](delta.md) — delta desc
- [Echo](echo.md) — echo desc
- [Golf](golf.md) — golf desc"
[ "$order" = "$expected" ] && pass "sorts by usage, all entries fit so all stay full" || die "ranked order mismatch: $order"
rm -f "$tmp/memory/usage.jsonl"

# 9. usage.jsonl present but empty: behaves like no usage.jsonl (falls back,
# doesn't crash on an empty counts extraction).
: > "$tmp/memory/usage.jsonl"
out=$(ss)
ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext')
echo "$ctx" | grep -q "only titles shown" && pass "empty usage.jsonl falls back to titles-only" || die "empty usage.jsonl mishandled: $ctx"
rm -f "$tmp/memory/usage.jsonl"

# 9b. Regression for a Codex-caught bug: many very short titles in the plain
# title-only fallback (no usage.jsonl) used to blow the additionalContext cap
# because the budget check counted each title's own bytes but not the
# newline joining it to the next one -- 3,000 one-character titles produced
# 11,384 bytes despite the 1,500-byte safety margin.
: > "$tmp/memory/MEMORY.md"
i=1
while [ "$i" -le 3000 ]; do
  printf -- '- [A](a%d.md) — d\n' "$i" >> "$tmp/memory/MEMORY.md"
  i=$((i + 1))
done
out=$(ss)
ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext')
ctx_len=$(printf '%s' "$ctx" | wc -c)
[ "$ctx_len" -lt 10000 ] && pass "many-short-titles fallback stays under the 10k cap ($ctx_len bytes)" || die "exceeded cap: $ctx_len bytes"

# 10. A store much larger than the additionalContext cap: the top 3 always
# keep a description (ellipsis-truncated if one is oversized), the rest
# degrade to title-only, and anything that still doesn't fit is folded into a
# trailing "N omitted" count instead of the harness silently truncating the
# JSON mid-entry. Exact byte counts vary with $tmp's path length, so these
# assert budget invariants rather than an exact transcript.
: > "$tmp/memory/MEMORY.md"
huge=$(printf 'X%.0s' $(seq 1 5000))
printf -- '- [Huge](huge.md) — %s\n' "$huge" >> "$tmp/memory/MEMORY.md"
i=2
while [ "$i" -le 900 ]; do
  printf -- '- [Mem%d](mem%d.md) — description number %d with some padding text to add up\n' "$i" "$i" "$i" >> "$tmp/memory/MEMORY.md"
  i=$((i + 1))
done
: > "$tmp/memory/usage.jsonl"
s=1
while [ "$s" -le 999 ]; do
  printf '{"sessionId":"h%d","memoryFileName":"huge.md"}\n' "$s" >> "$tmp/memory/usage.jsonl"
  s=$((s + 1))
done
i=2
while [ "$i" -le 900 ]; do
  reps=$((900 - i))
  s=1
  while [ "$s" -le "$reps" ]; do
    printf '{"sessionId":"s%d-%d","memoryFileName":"mem%d.md"}\n' "$i" "$s" "$i" >> "$tmp/memory/usage.jsonl"
    s=$((s + 1))
  done
  i=$((i + 1))
done
out=$(ss)
ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext')
ctx_len=$(printf '%s' "$ctx" | wc -c)
[ "$ctx_len" -lt 10000 ] && pass "large store stays under the 10k additionalContext cap ($ctx_len bytes)" || die "exceeded cap: $ctx_len bytes"
printf '%s' "$out" | jq -e . >/dev/null 2>&1 && pass "large-store output is valid JSON" || die "invalid JSON output"
described=$(printf '%s\n' "$ctx" | grep -c '^- \[')
[ "$described" -ge 3 ] && pass "at least 3 entries keep a full description ($described)" || die "fewer than 3 described entries: $described"
printf '%s\n' "$ctx" | grep -q '^- \[Huge\](huge.md) — X*…$' && pass "oversized top entry is ellipsis-truncated" || die "huge entry not truncated as expected"
printf '%s\n' "$ctx" | grep -qE '^…and [0-9]{1,} more memories omitted' && pass "overflow beyond the title budget is counted, not dropped silently" || die "no omitted-count line found"
rm -f "$tmp/memory/usage.jsonl"

exit $fail
