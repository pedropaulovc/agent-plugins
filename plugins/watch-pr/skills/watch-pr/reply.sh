#!/usr/bin/env bash
set -euo pipefail

# Vendored copy of pr-comments/skills/comments/reply.sh — kept self-contained
# because Claude Code plugins have no dependency management. Keep in sync with the
# pr-comments original if that wrapper changes.
#
# Reply to and/or resolve PR review feedback — a thin, escaping-free wrapper around
# the `gh api` calls the comments formatter used to emit as raw text. Keeping the
# GraphQL resolve mutation inside a script (not hand-escaped in generated markdown)
# removes the whole class of quoting bugs, and `--resolve` resolves a comment's
# thread WITHOUT the caller ever handling a thread node ID.
#
# Usage:
#   reply.sh <pr> --comment <COMMENT_ID> --body <text> [--resolve] [--thumbs-up|--thumbs-down]
#       Reply to an inline review comment; with --resolve, also resolve its thread;
#       with --thumbs-up/--thumbs-down, also react 👍/👎 to that comment.
#   reply.sh <pr> --comment <COMMENT_ID> --resolve
#       Resolve the comment's thread without replying.
#   reply.sh <pr> --comment <COMMENT_ID> --thumbs-up
#       React 👍 (or 👎 with --thumbs-down) to a comment without replying.
#   reply.sh <pr> --issue --body <text>
#       Post a new top-level (issue) comment.
#   reply.sh <pr> --resolve-thread <THREAD_ID>
#       Resolve a thread directly by its GraphQL node ID.
#
# <pr> is a PR URL, `owner/repo#123`, or a bare number (uses the current repo) —
# the same forms the comments formatter accepts. A harness-appropriate signature
# is appended to every body and all API output is silenced automatically.

# Attribute the reply to the harness actually running this script, rather than
# hardcoding "Claude Code". Plugins install under the harness home — Codex uses
# ~/.codex (or $CODEX_HOME) and sets PLUGIN_ROOT into that tree; Claude Code uses
# ~/.claude. Fall back to a neutral signature when neither is detectable (e.g. a
# source checkout).
case "${BASH_SOURCE[0]:-$0}:${PLUGIN_ROOT:-}:${CODEX_HOME:-}" in
    *.codex/*|*/.codex:*)  SIGNATURE=$'\n\n-- 🤖 [Codex](https://developers.openai.com/codex)' ;;
    *.claude/*)            SIGNATURE=$'\n\n-- 🤖 [Claude Code](https://claude.ai/claude-code)' ;;
    *)                     SIGNATURE=$'\n\n-- 🤖 automated reply' ;;
esac

PR_REF=""
COMMENT_ID=""
ISSUE=false
BODY=""
HAVE_BODY=false
RESOLVE=false
RESOLVE_THREAD_ID=""
REACTION=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --comment)        COMMENT_ID="$2"; shift 2 ;;
        --issue)          ISSUE=true; shift ;;
        --body)           BODY="$2"; HAVE_BODY=true; shift 2 ;;
        --resolve)        RESOLVE=true; shift ;;
        --resolve-thread) RESOLVE_THREAD_ID="$2"; shift 2 ;;
        --thumbs-up)      REACTION="+1"; shift ;;
        --thumbs-down)    REACTION="-1"; shift ;;
        -h|--help)        awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; started=1; next} started{exit}' "$0"; exit 0 ;;
        -*)               echo "Error: unknown flag: $1" >&2; exit 1 ;;
        *)
            if [[ -z "$PR_REF" ]]; then
                PR_REF="$1"; shift
            else
                echo "Error: unexpected argument: $1" >&2; exit 1
            fi
            ;;
    esac
done

if [[ -z "$PR_REF" ]]; then
    echo "Error: no PR specified. See: $0 --help" >&2
    exit 1
fi

# Parse PR reference to extract owner, repo, and PR number (kept in sync with
# comments.sh's parse_pr_ref).
parse_pr_ref() {
    local ref="$1"
    if [[ "$ref" =~ github\.com/([^/]+)/([^/]+)/pull/([0-9]+) ]]; then
        OWNER="${BASH_REMATCH[1]}"; REPO="${BASH_REMATCH[2]}"; PR_NUMBER="${BASH_REMATCH[3]}"
    elif [[ "$ref" =~ ^([^/]+)/([^#]+)#([0-9]+)$ ]]; then
        OWNER="${BASH_REMATCH[1]}"; REPO="${BASH_REMATCH[2]}"; PR_NUMBER="${BASH_REMATCH[3]}"
    elif [[ "$ref" =~ ^[0-9]+$ ]]; then
        PR_NUMBER="$ref"
        local remote_url
        remote_url=$(git remote get-url origin 2>/dev/null || echo "")
        if [[ "$remote_url" =~ github\.com[:/]([^/]+)/([^/.]+) ]]; then
            OWNER="${BASH_REMATCH[1]}"; REPO="${BASH_REMATCH[2]}"
        else
            echo "Error: could not parse owner/repo from git remote: $remote_url" >&2; exit 1
        fi
    else
        echo "Error: could not parse PR reference: $ref" >&2; exit 1
    fi
}
parse_pr_ref "$PR_REF"

# Resolve a review thread by its GraphQL node ID.
resolve_thread() {
    local tid="$1"
    gh api graphql -f query='
mutation($tid: ID!) {
  resolveReviewThread(input: {threadId: $tid}) { thread { isResolved } }
}' -f tid="$tid" >/dev/null
    echo "resolved thread $tid" >&2
}

# Find the thread node ID that contains a given comment databaseId (matches root
# comments and replies, so either works). Paginated past the 100-thread cap.
thread_id_for_comment() {
    local cid="$1"
    gh api graphql --paginate \
        -f owner="$OWNER" -f repo="$REPO" -F pr="$PR_NUMBER" -f query='
query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id comments(first: 100) { nodes { databaseId } } }
      }
    }
  }
}' 2>/dev/null \
      | jq -r --argjson cid "$cid" '
          (.data.repository.pullRequest.reviewThreads.nodes // [])[]
          | select(any((.comments.nodes // [])[]; .databaseId == $cid))
          | .id' \
      | head -1
}

# --- Reply, if a body was given ---------------------------------------------
if [[ "$HAVE_BODY" == true ]]; then
    body="${BODY}${SIGNATURE}"
    if [[ -n "$COMMENT_ID" ]]; then
        gh api "repos/$OWNER/$REPO/pulls/$PR_NUMBER/comments/$COMMENT_ID/replies" \
            -f body="$body" >/dev/null
        echo "replied to comment $COMMENT_ID" >&2
    elif [[ "$ISSUE" == true ]]; then
        gh api "repos/$OWNER/$REPO/issues/$PR_NUMBER/comments" \
            -f body="$body" >/dev/null
        echo "posted top-level comment on PR #$PR_NUMBER" >&2
    else
        echo "Error: --body needs --comment <ID> or --issue" >&2; exit 1
    fi
fi

# --- React, if requested -----------------------------------------------------
if [[ -n "$REACTION" ]]; then
    if [[ -z "$COMMENT_ID" ]]; then
        echo "Error: --thumbs-up/--thumbs-down needs --comment <ID>" >&2
        exit 1
    fi
    gh api "repos/$OWNER/$REPO/pulls/comments/$COMMENT_ID/reactions" \
        -f content="$REACTION" >/dev/null
    echo "reacted $REACTION to comment $COMMENT_ID" >&2
fi

# --- Resolve, if requested ---------------------------------------------------
if [[ "$RESOLVE" == true ]]; then
    if [[ -z "$COMMENT_ID" ]]; then
        echo "Error: --resolve needs --comment <ID> (or use --resolve-thread <THREAD_ID>)" >&2
        exit 1
    fi
    # `|| true` so a transient lookup failure surfaces our own message rather than
    # a raw pipe/jq error from `set -e` mid-substitution.
    tid=$(thread_id_for_comment "$COMMENT_ID" || true)
    if [[ -z "$tid" ]]; then
        echo "Error: no review thread found for comment $COMMENT_ID (or a transient API error)." >&2
        # The reply already landed — steer the retry to resolve-only so it isn't re-posted.
        [[ "$HAVE_BODY" == true ]] && echo "Note: the reply WAS posted — retry with just: --comment $COMMENT_ID --resolve" >&2
        exit 1
    fi
    resolve_thread "$tid"
fi

if [[ -n "$RESOLVE_THREAD_ID" ]]; then
    resolve_thread "$RESOLVE_THREAD_ID"
fi

if [[ "$HAVE_BODY" == false && "$RESOLVE" == false && -z "$RESOLVE_THREAD_ID" && -z "$REACTION" ]]; then
    echo "Error: nothing to do — pass --body, --resolve, --resolve-thread, or --thumbs-up/--thumbs-down. See: $0 --help" >&2
    exit 1
fi
