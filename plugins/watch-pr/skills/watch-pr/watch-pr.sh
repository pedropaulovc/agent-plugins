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
#   review <login>: <state> @<ts>          a reviewer just submitted (the current gh
#                                          user's own reviews are filtered out)
#   comments: <n>                          top-level (issue) comment count changed —
#                                          counts OTHER users only, so a reply you post
#                                          doesn't bounce back as an event
#   review-comments: <n>                   inline review-thread comment count changed
#                                          (catches replies to existing threads; excludes
#                                          the current gh user's own replies)
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

# The current gh user — reviews and comments it authored are OUR own actions (a
# reply we just posted, a review we left), so we drop them from the count/review
# signals below. Otherwise posting a reply immediately bounces back as an event and
# re-trips the feedback fetch on our own message. Empty (gh offline) → no filtering,
# same behaviour as before. Reactions stay unfiltered: the API's summary counts
# don't name the reactor, so we can't attribute a 👍 without a per-comment lookup.
ME=$(gh api user --jq '.login' 2>/dev/null || echo "")

prev=""
while true; do
  # -R pins every poll to the PR's own repo, so a URL to another repo still works.
  meta=$(gh pr view "$NUM" -R "$SLUG" --json state,mergeStateStatus,baseRefName,reviews,reactionGroups,comments 2>/dev/null || echo '{}')
  state=$(jq -r '.state // ""' <<<"$meta")
  checks=$(gh pr checks "$NUM" -R "$SLUG" --json name,bucket,completedAt 2>/dev/null || echo '[]')
  # Inline review-thread comments are pull review comments — separate from issue
  # comments and not always tied to a new submitted review. Track their count so a
  # reply to an existing thread still trips the feedback fetch.
  rc=$(gh api --paginate "repos/$SLUG/pulls/$NUM/comments" 2>/dev/null \
        | jq -r --arg me "$ME" '.[] | select(.user.login != $me) | .id' 2>/dev/null | wc -l | tr -d ' ')
  # Reactions on top-level comments — Codex acks an `@codex review` mention (👀)
  # and posts its all-clear (👍) on the comment, not the PR body. We EXCLUDE the
  # current gh user's own reactions so a 👍 we add via reply.sh --thumbs-up doesn't
  # masquerade as Codex's all-clear. The comments listing only carries a reaction
  # *summary* (counts, no reactor), so we first find comments that have any reaction,
  # then fetch each one's reaction list (which names the user) and re-aggregate.
  # Normalize the API's lowercase keys to the CONTENT names gh uses for PR-body reactions.
  reacted_ids=$(gh api --paginate "repos/$SLUG/issues/$NUM/comments" \
      --jq '.[] | select((.reactions.total_count // 0) > 0) | .id' 2>/dev/null || true)
  creact=$(
    for cid in $reacted_ids; do
      gh api --paginate "repos/$SLUG/issues/comments/$cid/reactions" 2>/dev/null \
        | jq -r --arg me "$ME" '.[] | select(.user.login != $me) | .content'
    done | jq -rRn '
      [inputs] | group_by(.) | map({k: .[0], n: length})[]
      | "comment-reaction \({"+1":"THUMBS_UP","-1":"THUMBS_DOWN","eyes":"EYES","laugh":"LAUGH","hooray":"HOORAY","confused":"CONFUSED","heart":"HEART","rocket":"ROCKET"}[.k] // .k): \(.n)"
    ' 2>/dev/null || true
  )
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
    jq -r --arg me "$ME" '.reviews[] | select(.author.login != $me) | "review \(.author.login): \(.state) @\(.submittedAt)"' <<<"$meta"
    jq -r --arg me "$ME" '"comments: \([.comments[] | select(.author.login != $me)] | length)"' <<<"$meta"
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
      # comments.sh prints a Windows path on Git Bash (cygpath -w), a POSIX path
      # elsewhere. Keep BOTH: $display_path is what the agent sees in the BEGIN
      # marker — its Read/Edit tools want the native Windows path, not the
      # /tmp/… POSIX form, which they can't open. $path is the POSIX form used
      # for the -f/grep/cat reads below, which run in this Git Bash and would
      # fail on a `C:\…` string.
      display_path=$(bash "$COMMENTS" "$URL" 2>/dev/null || true)
      path="$display_path"
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
          echo "===== BEGIN PR FEEDBACK ($display_path) ====="
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
