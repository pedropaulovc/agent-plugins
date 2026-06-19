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

exit $fail
