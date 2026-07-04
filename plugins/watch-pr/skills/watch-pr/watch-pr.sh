#!/usr/bin/env bash
set -uo pipefail

# Watch a PR's full lifecycle AND surface incoming review feedback — one script.
# Designed to run INSIDE the Monitor tool's `command` (persistent:true):
# each emitted line is surfaced as an event; the loop is silent while nothing
# changes and self-terminates on MERGED/CLOSED.
#
# Usage: watch-pr.sh <pr-number-or-ref>   (ref forms: 123 | owner/repo#123 | full URL)
#
# Event lines (emitted only when they first appear / change):
#   check <name>: <bucket>                 CI check flipped (pending|pass|fail|...)
#   rebase: BEHIND — git pull --rebase …   branch fell behind main (fast-forward)
#   rebase: DIRTY  — git pull --rebase …   merge conflicts; resolve during rebase
#   review <login>: <state> @<ts>          a reviewer just submitted
#   comments: <n>                          top-level comment count changed
#   reaction <CONTENT>: <n>                reaction on the PR body (Codex: EYES=👀 reviewing, THUMBS_UP=👍 all-clear)
#   ===== BEGIN PR FEEDBACK (<path>) =====  NEW review/comment: the full formatted
#     <formatted comment markdown>          comment markdown is printed inline (no
#   ===== END PR FEEDBACK =====             Read needed); <path> is the editable file
#   PR <pr> finished: <state>              terminal; loop exits
#
# On any new `review …` or changed `comments:` line, this script itself runs the
# sibling comments.sh formatter and prints the formatted markdown straight to
# stdout so the caller reads the feedback inline — no second tool call. The file
# path in the BEGIN marker is where drafted replies get written back.

PR="${1:?usage: watch-pr.sh <pr-number-or-ref>}"

# Vendored comments.sh sits next to this script (self-contained; no plugin deps).
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMENTS="$DIR/comments.sh"

prev=""
while true; do
  state=$(gh pr view "$PR" --json state -q .state 2>/dev/null || echo "")
  meta=$(gh pr view "$PR" --json mergeStateStatus,reviews,reactionGroups,comments 2>/dev/null || echo '{}')
  s=$(gh pr checks "$PR" --json name,bucket 2>/dev/null || echo '[]')
  cur=$( {
    jq -r '.[] | "check \(.name): \(.bucket)"' <<<"$s"
    jq -r 'select(.mergeStateStatus=="BEHIND" or .mergeStateStatus=="DIRTY") | "rebase: \(.mergeStateStatus) — git pull --rebase origin main (BEHIND=fast-forward, DIRTY=resolve conflicts)"' <<<"$meta"
    jq -r '.reviews[] | "review \(.author.login): \(.state) @\(.submittedAt)"' <<<"$meta"
    jq -r '"comments: \(.comments | length)"' <<<"$meta"
    jq -r '.reactionGroups[]? | select(.users.totalCount>0) | "reaction \(.content): \(.users.totalCount)"' <<<"$meta"
  } | sort )

  diff_lines=$(comm -13 <(echo "$prev") <(echo "$cur"))
  if [[ -n "$diff_lines" ]]; then
    echo "$diff_lines"
    # A new review submission or a changed top-level comment count means fresh
    # feedback — fetch + format the active comments and point the caller at them.
    # First poll (prev empty) always trips this via the `comments:` line, so open
    # threads are fetched once on startup. Stay silent when there are none active.
    if grep -qE '^(review |comments: )' <<<"$diff_lines"; then
      path=$(bash "$COMMENTS" "$PR" 2>/dev/null || true)
      if [[ -n "$path" && -f "$path" ]]; then
        active=$(grep -m1 '^active_comments:' "$path" | grep -oE '[0-9]+' || echo 0)
        if [[ "${active:-0}" -gt 0 ]]; then
          echo "===== BEGIN PR FEEDBACK ($path) ====="
          cat "$path"
          echo "===== END PR FEEDBACK ====="
        fi
      fi
    fi
  fi
  prev=$cur

  if [[ "$state" =~ ^(MERGED|CLOSED)$ ]]; then
    [[ "$state" == "MERGED" ]] && { echo "merged — running git fetch"; git fetch --all --prune; }
    break
  fi
  sleep 30
done
echo "PR $PR finished: $state"
