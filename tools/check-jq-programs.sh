#!/usr/bin/env bash
# Guards the jq program embedded in each PR-comment formatter against issue #44.
#
# Each formatter embeds a large jq program as a SINGLE-QUOTED shell string. A bare
# apostrophe anywhere inside it closes that quote mid-program: the shell re-parses the
# rest, jq receives a mangled program, and the formatter dies with a jq compile error on
# every poll. The file carries a warning about this, but nothing enforced it.
#
# This check extracts the single-quoted region by its content markers (not line numbers,
# so it survives edits that move the block) and fails if any apostrophe appears inside —
# i.e. before the intended closing quote. It also compile-checks the program with jq to
# catch ordinary jq syntax slips.
set -euo pipefail

FILES=(
  plugins/watch-pr/skills/watch-pr/comments.sh
  plugins/pr-comments/skills/comments/comments.sh
)

# The program opens with a lone `'` at the end of this line and closes with the `'` that
# begins the CLOSE_MARKER line.
OPEN_MARKER='--slurpfile threads "$TMPDIR/threads.json" '\'''
CLOSE_MARKER=''\'' "$TMPDIR/inline.json"'

fail=0
for f in "${FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "FAIL: missing $f" >&2
    fail=1
    continue
  fi

  program=$(awk -v startm="$OPEN_MARKER" -v endm="$CLOSE_MARKER" '
    index($0, endm) { inprog=0 }
    inprog { print }
    index($0, startm) { inprog=1 }
  ' "$f")

  if [[ -z "$program" ]]; then
    echo "FAIL: could not locate embedded jq program in $f" >&2
    fail=1
    continue
  fi

  # Check 1 (issue #44): a bare apostrophe inside the single-quoted string breaks it.
  offenders=$(grep -n "'" <<< "$program" || true)
  if [[ -n "$offenders" ]]; then
    echo "FAIL: apostrophe inside the single-quoted jq program in $f (breaks the shell quote):" >&2
    sed 's/^/  /' <<< "$offenders" >&2
    fail=1
    continue
  fi

  # Check 2: the program is valid jq. jq compiles before reading input, so a compile
  # error surfaces regardless of data shape; a runtime error on dummy data is fine.
  empty=$(mktemp); echo '[]' > "$empty"
  jq -rn \
     --arg owner o --arg repo r --arg pr 1 --arg reply reply.sh \
     --arg fetched_at t --arg include_resolved false \
     --slurpfile issue "$empty" --slurpfile reviews "$empty" \
     --slurpfile threads "$empty" \
     "$program" >/dev/null 2>jq_err || true
  if grep -qi 'compile error\|syntax error' jq_err; then
    echo "FAIL: embedded jq program in $f does not compile:" >&2
    sed 's/^/  /' jq_err >&2
    fail=1
  else
    echo "OK:   $f"
  fi
  rm -f "$empty" jq_err
done

exit $fail
