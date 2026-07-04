#!/usr/bin/env bash
set -uo pipefail

# Watch a PR's full lifecycle AND surface incoming review feedback — one script.
# Designed to run INSIDE the Monitor tool's `command` (persistent:true):
# each emitted line is surfaced as an event; the loop is silent while nothing
# changes and self-terminates on MERGED/CLOSED.
#
# Usage: watch-pr.sh <pr>   where <pr> is a PR number, full URL, or branch name
#   (the forms `gh pr view` accepts). `owner/repo#123` is NOT accepted — pass the
#   URL for another repo. The ref is validated up front; a bad one exits loudly
#   instead of letting the loop sleep on empty state.
#
# Event lines (emitted only when they first appear / change):
#   check <name>: <bucket> [@<completedAt>]  CI check flipped; the completedAt stamp
#                                            makes a same-bucket rerun show as a change
#   rebase: BEHIND — git pull --rebase origin <base> …   behind the PR's base branch
#   rebase: DIRTY  — git pull --rebase origin <base> …   merge conflicts with base
#   review <login>: <state> @<ts>          a reviewer just submitted
#   comments: <n>                          top-level (issue) comment count changed
#   review-comments: <n>                   inline review-thread comment count changed
#                                          (catches replies to existing threads)
#   reaction <CONTENT>: <n>                reaction on the PR BODY (Codex: EYES=👀 reviewing,
#                                          THUMBS_UP=👍 all-clear). Aggregate count — a human
#                                          reacting is indistinguishable from Codex (rare).
#   comment-reaction <CONTENT>: <n>        reaction on a top-level COMMENT — this is where
#                                          Codex acks an `@codex review` mention (👀) and
#                                          signals its all-clear (👍) when no review is posted.
#   ===== BEGIN PR FEEDBACK (<path>) =====  NEW review/comment: the full formatted
#     <formatted comment markdown>          comment markdown is printed inline (no
#   ===== END PR FEEDBACK =====             Read needed); <path> is the editable file
#   PR <num> finished: <state>             terminal; loop exits
#
# On any new review / comment / review-comment signal, this script runs the
# vendored comments.sh formatter and prints the formatted markdown straight to
# stdout so the caller reads the feedback inline — no second tool call. The file
# path in the BEGIN marker is where drafted replies get written back.

REF="${1:?usage: watch-pr.sh <pr-number|url|branch>}"

# Vendored comments.sh sits next to this script (self-contained; no plugin deps).
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMENTS="$DIR/comments.sh"

# Resolve the ref once → canonical number + owner/repo + URL. This is also the
# validation gate: an unresolvable ref (e.g. the unsupported `owner/repo#123`
# form) fails here instead of silently sleeping.
info=$(gh pr view "$REF" --json url,number 2>/dev/null || true)
if [[ -z "$info" ]]; then
  echo "watch-pr: cannot resolve PR ref '$REF' — pass a PR number, URL, or branch name"
  exit 1
fi
URL=$(jq -r '.url' <<<"$info")
NUM=$(jq -r '.number' <<<"$info")
if [[ "$URL" =~ github\.com/([^/]+)/([^/]+)/pull/[0-9]+ ]]; then
  SLUG="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
else
  echo "watch-pr: could not parse owner/repo from '$URL'"
  exit 1
fi

# Does the local checkout's `origin` point at the PR's base repo ($SLUG)? The
# rebase hint can only safely say `git pull --rebase origin <base>` when it does.
# For a fork PR (or a URL to another repo), origin is the wrong remote, so we tell
# the agent to rebase against the base repo explicitly instead. Computed once — the
# answer is stable, and a stable rebase line keeps the poll-to-poll diff stable.
origin_url=$(git remote get-url origin 2>/dev/null || echo "")
ORIGIN_IS_BASE=0
if [[ "$origin_url" =~ github\.com[:/]([^/]+)/([^/.]+) && "${BASH_REMATCH[1]}/${BASH_REMATCH[2]}" == "$SLUG" ]]; then
  ORIGIN_IS_BASE=1
fi

prev=""
while true; do
  # -R pins every poll to the PR's own repo, so a URL to another repo still works.
  meta=$(gh pr view "$NUM" -R "$SLUG" --json state,mergeStateStatus,baseRefName,reviews,reactionGroups,comments 2>/dev/null || echo '{}')
  state=$(jq -r '.state // ""' <<<"$meta")
  checks=$(gh pr checks "$NUM" -R "$SLUG" --json name,bucket,completedAt 2>/dev/null || echo '[]')
  # Inline review-thread comments are pull review comments — separate from issue
  # comments and not always tied to a new submitted review. Track their count so a
  # reply to an existing thread still trips the feedback fetch.
  rc=$(gh api --paginate "repos/$SLUG/pulls/$NUM/comments" --jq '.[].id' 2>/dev/null | wc -l | tr -d ' ')
  # Reactions on top-level comments — Codex acks an `@codex review` mention (👀)
  # and posts its all-clear (👍) on the comment, not the PR body. Normalize the
  # API's lowercase keys to the same CONTENT names gh uses for PR-body reactions.
  creact=$(gh api --paginate --slurp "repos/$SLUG/issues/$NUM/comments" --jq '
    [.[][]? | (.reactions? // {}) | to_entries[]
      | select(.key | test("^([+-]1|eyes|laugh|hooray|confused|heart|rocket)$"))
      | select(.value > 0)]
    | group_by(.key)
    | map({k: .[0].key, n: (map(.value) | add)})[]
    | "comment-reaction \({"+1":"THUMBS_UP","-1":"THUMBS_DOWN","eyes":"EYES","laugh":"LAUGH","hooray":"HOORAY","confused":"CONFUSED","heart":"HEART","rocket":"ROCKET"}[.k] // .k): \(.n)"
  ' 2>/dev/null || true)
  # Count of UNRESOLVED review threads. A reviewer re-opening/un-resolving a thread
  # without a new reply changes no comment count ($rc) or review/reaction line, so
  # without this signal the newly-active feedback would stay hidden until some
  # unrelated event. --paginate keeps it correct past 100 threads.
  ur=$(gh api graphql --paginate \
    -f owner="${SLUG%/*}" -f repo="${SLUG#*/}" -F pr="$NUM" -f query='
query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved }
      }
    }
  }
}' --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)' 2>/dev/null | wc -l | tr -d ' ')

  cur=$( {
    jq -r '.[] | "check \(.name): \(.bucket)" + (if (.completedAt // "") != "" then " @\(.completedAt)" else "" end)' <<<"$checks"
    jq -r --arg slug "$SLUG" --arg ob "$ORIGIN_IS_BASE" 'select(.mergeStateStatus=="BEHIND" or .mergeStateStatus=="DIRTY") | "rebase: \(.mergeStateStatus) — " + (if $ob=="1" then "git pull --rebase origin \(.baseRefName)" else "base is \($slug):\(.baseRefName); local origin ≠ base repo — rebase against the base remote, not origin" end) + " (BEHIND=fast-forward, DIRTY=resolve conflicts)"' <<<"$meta"
    jq -r '.reviews[] | "review \(.author.login): \(.state) @\(.submittedAt)"' <<<"$meta"
    jq -r '"comments: \(.comments | length)"' <<<"$meta"
    [[ "$rc" =~ ^[0-9]+$ ]] && echo "review-comments: $rc"
    [[ "$ur" =~ ^[0-9]+$ ]] && echo "unresolved-threads: $ur"
    jq -r '.reactionGroups[]? | select(.users.totalCount>0) | "reaction \(.content): \(.users.totalCount)"' <<<"$meta"
    [[ -n "$creact" ]] && echo "$creact"
  } | sort )

  diff_lines=$(comm -13 <(echo "$prev") <(echo "$cur"))
  advance=1
  if [[ -n "$diff_lines" ]]; then
    echo "$diff_lines"
    # A new review / comment / unresolved-thread signal means fresh feedback — fetch
    # + format the active comments and print them inline. First poll (prev empty)
    # always trips this via the count lines, so open threads are fetched once on
    # startup. Stay silent when there are none active.
    if grep -qE '^(review |comments: |review-comments: |unresolved-threads: )' <<<"$diff_lines"; then
      path=$(bash "$COMMENTS" "$URL" 2>/dev/null || true)
      # On Git Bash the formatter emits a Windows path (cygpath -w); convert it
      # back to POSIX for the -f/grep/cat reads below, else the check silently fails.
      command -v cygpath &>/dev/null && [[ -n "$path" ]] && path=$(cygpath -u "$path")

      # The formatter now aborts (non-zero, no file) on a transient gh/API/jq
      # failure rather than emit partial data. Surface it and HOLD prev, so the same
      # signal re-trips the fetch next poll instead of being silently marked seen.
      if [[ -z "$path" || ! -f "$path" ]]; then
        echo "watch-pr: comment formatter failed — will retry next poll"
        advance=0
      fi

      if [[ "$advance" == 1 ]]; then
        active=$(grep -m1 '^active_comments:' "$path" | grep -oE '[0-9]+' || echo 0)
        # Print when there are active threads/comments OR a body-only review summary
        # (comments.sh emits <review-summary> only for reviews with a non-empty body,
        # which don't count toward active_comments).
        if [[ "${active:-0}" -gt 0 ]] || grep -q '<review-summary' "$path"; then
          echo "===== BEGIN PR FEEDBACK ($path) ====="
          cat "$path"
          echo "===== END PR FEEDBACK ====="
        fi
      fi
    fi
  fi
  [[ "$advance" == 1 ]] && prev=$cur

  if [[ "$state" =~ ^(MERGED|CLOSED)$ ]]; then
    [[ "$state" == "MERGED" ]] && { echo "merged — running git fetch"; git fetch --all --prune; }
    break
  fi
  sleep 30
done
echo "PR $NUM finished: $state"
