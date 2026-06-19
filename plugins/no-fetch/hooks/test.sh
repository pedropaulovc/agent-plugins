#!/bin/sh
# Tests for no-fetch.sh. Run: sh plugins/no-fetch/hooks/test.sh
set -u
HOOK="$(dirname "$0")/no-fetch.sh"
fail=0

pass() { printf 'ok   - %s\n' "$1"; }
die()  { printf 'FAIL - %s\n' "$1"; fail=1; }

run() { printf '%s' "$1" | sh "$HOOK"; }

# 1. Non-WebFetch tool is ignored entirely (no output).
out=$(run '{"tool_name":"Bash","tool_input":{"command":"ls"}}')
[ -z "$out" ] && pass "ignores non-WebFetch tools" || die "non-WebFetch produced output: $out"

# 2. A plain blocked URL is denied.
out=$(run '{"tool_name":"WebFetch","tool_input":{"url":"https://example.com","prompt":"read it"}}')
echo "$out" | grep -q '"decision":"block"' && pass "blocks plain WebFetch" || die "expected block, got: $out"

# 3. Exclusion-list URLs pass without a block.
out=$(run '{"tool_name":"WebFetch","tool_input":{"url":"https://github.com/foo/bar","prompt":"x"}}')
[ -z "$out" ] && pass "allows github.com (exclusion)" || die "github.com not allowed: $out"
out=$(run '{"tool_name":"WebFetch","tool_input":{"url":"https://docs.anthropic.com/x","prompt":"x"}}')
[ -z "$out" ] && pass "allows anthropic.com (exclusion)" || die "anthropic.com not allowed: $out"

# 4. [force-fetch] in the url is honored AND stripped from the request.
out=$(run '{"tool_name":"WebFetch","tool_input":{"url":"https://blocked.example [force-fetch]","prompt":"read"}}')
echo "$out" | grep -q '"updatedInput"' || die "force-fetch produced no updatedInput: $out"
stripped_url=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.url')
[ "$stripped_url" = "https://blocked.example" ] && pass "strips [force-fetch] from url" || die "url not stripped clean: '$stripped_url'"
# The marker must be gone from the forwarded input (additionalContext may still
# mention it when explaining the hatch, so check only updatedInput).
printf '%s' "$out" | jq -e '.hookSpecificOutput.updatedInput | tostring | contains("[force-fetch]")' >/dev/null 2>&1 \
  && die "marker leaked into updatedInput: $out" || pass "no marker left in updatedInput"

# 5. [force-fetch] adjacent (no space) is also stripped.
out=$(run '{"tool_name":"WebFetch","tool_input":{"url":"https://blocked.example[force-fetch]","prompt":"x"}}')
stripped_url=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.url')
[ "$stripped_url" = "https://blocked.example" ] && pass "strips adjacent [force-fetch]" || die "adjacent not stripped: '$stripped_url'"

exit $fail
