#!/usr/bin/env bash
set -euo pipefail

# Vendored copy of pr-comments/skills/comments/comments.sh — kept self-contained
# because Claude Code plugins have no dependency management. Keep in sync with the
# pr-comments original if that formatter changes.

# Fetch PR comments and format for LLM consumption
# Usage: fetch-pr-comments.sh [pr-url-or-ref] [output-file]
# Examples:
#   fetch-pr-comments.sh                              (auto-detect from current branch)
#   fetch-pr-comments.sh https://github.com/owner/repo/pull/123
#   fetch-pr-comments.sh owner/repo#123
#   fetch-pr-comments.sh 123  (uses current repo)

# Parse arguments
INCLUDE_RESOLVED=false
PR_REF=""
OUTPUT_FILE=""

for arg in "$@"; do
    case "$arg" in
        --include-resolved)
            INCLUDE_RESOLVED=true
            ;;
        *)
            if [[ -z "$PR_REF" ]]; then
                PR_REF="$arg"
            elif [[ -z "$OUTPUT_FILE" ]]; then
                OUTPUT_FILE="$arg"
            fi
            ;;
    esac
done

# If no output file specified, use temp path (set after parsing PR_NUMBER)
USE_TEMP_OUTPUT=false
if [[ -z "$OUTPUT_FILE" ]]; then
    USE_TEMP_OUTPUT=true
fi

# If no PR reference provided, try to detect from current branch
if [[ -z "$PR_REF" ]]; then
    echo "No PR specified, detecting from current branch..." >&2

    # Use gh to get PR associated with current branch
    PR_JSON=$(gh pr view --json number,headRepository 2>/dev/null || echo "")

    if [[ -z "$PR_JSON" || "$PR_JSON" == "null" ]]; then
        echo "Error: No PR found for current branch." >&2
        echo "" >&2
        echo "Usage: $0 [pr-url-or-ref] [output-file]" >&2
        echo "Examples:" >&2
        echo "  $0                                        # Auto-detect from current branch" >&2
        echo "  $0 https://github.com/owner/repo/pull/123" >&2
        echo "  $0 owner/repo#123" >&2
        echo "  $0 123" >&2
        exit 1
    fi

    PR_REF=$(echo "$PR_JSON" | jq -r '.number')
    echo "Found PR #$PR_REF for current branch" >&2
fi

# Parse PR reference to extract owner, repo, and PR number
parse_pr_ref() {
    local ref="$1"

    # Full URL: https://github.com/owner/repo/pull/123
    if [[ "$ref" =~ github\.com/([^/]+)/([^/]+)/pull/([0-9]+) ]]; then
        OWNER="${BASH_REMATCH[1]}"
        REPO="${BASH_REMATCH[2]}"
        PR_NUMBER="${BASH_REMATCH[3]}"
    # Short ref: owner/repo#123
    elif [[ "$ref" =~ ^([^/]+)/([^#]+)#([0-9]+)$ ]]; then
        OWNER="${BASH_REMATCH[1]}"
        REPO="${BASH_REMATCH[2]}"
        PR_NUMBER="${BASH_REMATCH[3]}"
    # Just PR number: 123 (use current repo)
    elif [[ "$ref" =~ ^[0-9]+$ ]]; then
        PR_NUMBER="$ref"
        # Get owner/repo from current git remote
        local remote_url
        remote_url=$(git remote get-url origin 2>/dev/null || echo "")
        if [[ -z "$remote_url" ]]; then
            echo "Error: No git remote found and no owner/repo specified" >&2
            exit 1
        fi
        if [[ "$remote_url" =~ github\.com[:/]([^/]+)/([^/.]+) ]]; then
            OWNER="${BASH_REMATCH[1]}"
            REPO="${BASH_REMATCH[2]}"
        else
            echo "Error: Could not parse owner/repo from git remote: $remote_url" >&2
            exit 1
        fi
    else
        echo "Error: Could not parse PR reference: $ref" >&2
        exit 1
    fi
}

parse_pr_ref "$PR_REF"

# Set output file path now that we have PR_NUMBER
if [[ "$USE_TEMP_OUTPUT" == "true" ]]; then
    TEMP_DIR="${TEMP:-${TMP:-/tmp}}"
    TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
    OUTPUT_FILE="${TEMP_DIR}/pr-comments-${PR_NUMBER}-${TIMESTAMP}.md"
fi

echo "Fetching comments for $OWNER/$REPO#$PR_NUMBER..." >&2

# Create temp files for parallel fetching
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Fetch all comment types in parallel. --slurp collapses every page into ONE
# array-of-arrays document; without it --paginate emits one JSON document per page
# and the jq filter below runs once per page, producing duplicate/partial markdown.
# flatten_arrays (in the jq) unwraps the array-of-arrays.
gh api "repos/$OWNER/$REPO/pulls/$PR_NUMBER/comments" --paginate --slurp > "$TMPDIR/inline.json" &
PID_INLINE=$!

gh api "repos/$OWNER/$REPO/issues/$PR_NUMBER/comments" --paginate --slurp > "$TMPDIR/issue.json" &
PID_ISSUE=$!

gh api "repos/$OWNER/$REPO/pulls/$PR_NUMBER/reviews" --paginate --slurp > "$TMPDIR/reviews.json" &
PID_REVIEWS=$!

# Fetch thread IDs via GraphQL (needed for resolving threads). --paginate walks
# past the 100-node cap (reviewThreads maxes at first:100 per page); each page is
# its own JSON document that the --slurpfile below gathers, and the jq concatenates
# the per-page node arrays.
gh api graphql --paginate \
  -f owner="$OWNER" -f repo="$REPO" -F pr="$PR_NUMBER" \
  -f query='
query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes {
              databaseId
            }
          }
        }
      }
    }
  }
}' > "$TMPDIR/threads.json" 2>/dev/null &
PID_THREADS=$!

# Wait for every fetch — abort if any fails. Bash `wait` with multiple PIDs
# returns only the LAST PID's status, so a failed earlier fetch would be masked
# under `set -e`, leaving the formatter to run on empty/partial JSON. The GraphQL
# thread fetch is included: it is the sole source of isResolved/thread IDs, so on
# its failure resolved threads would render as active with `unknown` IDs — worse
# than failing, since it sends the agent back to already-settled feedback.
for pid in $PID_INLINE $PID_ISSUE $PID_REVIEWS $PID_THREADS; do
    wait "$pid" || { echo "Error: a GitHub API fetch failed" >&2; exit 1; }
done

# Get current timestamp
FETCHED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# reply.sh sits next to this script; embed its path in the generated commands so the
# markdown carries no hand-escaped gh/GraphQL (the source of past quoting bugs).
REPLY_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/reply.sh"

# Process with jq and generate markdown
jq -r --arg owner "$OWNER" \
      --arg repo "$REPO" \
      --arg pr "$PR_NUMBER" \
      --arg reply "$REPLY_SH" \
      --arg fetched_at "$FETCHED_AT" \
      --arg include_resolved "$INCLUDE_RESOLVED" \
      --slurpfile issue "$TMPDIR/issue.json" \
      --slurpfile reviews "$TMPDIR/reviews.json" \
      --slurpfile threads "$TMPDIR/threads.json" '
# Codex ends every review/comment body with a "Useful? React with 👍 / 👎." trailer
# (optionally preceded by a `---` separator). It is pure noise here — the reply flow
# already covers reactions in its own instructions — so trim it before rendering a body.
# NB: keep this whole jq program free of the apostrophe character — it is a
# single-quoted shell string, so a bare one closes the quote and corrupts the
# program (jq: "Top-level program not given").
def strip_codex_trailer:
    sub("\\n+[-\\s]*Useful\\? React with[^\\n]*[ \\t]*$"; "");

# Helper function to escape for blockquote
def blockquote:
    strip_codex_trailer | split("\n") | map("> " + .) | join("\n");

# Helper function to get short diff context
def short_diff:
    split("\n") | last(10) | join("\n");

# Flatten arrays (gh api --paginate may return array of arrays)
def flatten_arrays:
    if type == "array" then
        if length > 0 and (.[0] | type) == "array" then
            flatten
        else
            .
        end
    else
        [.]
    end;

# Process inline comments
. as $inline_raw |
($issue[0] // []) | flatten_arrays as $issue_comments |
($reviews[0] // []) | flatten_arrays as $reviews_list |
($inline_raw // []) | flatten_arrays as $inline_comments |

# Build thread ID lookup from GraphQL data (comment databaseId -> {id, isResolved}).
# --paginate yields one document per page; $threads (slurpfile) holds them all, so
# concatenate the per-page node arrays before indexing.
(([$threads[] | .data.repository.pullRequest.reviewThreads.nodes // []] | add // []) |
  map({key: (.comments.nodes[0].databaseId | tostring), value: {id: .id, isResolved: .isResolved}}) |
  from_entries) as $thread_lookup |

# Separate root comments from replies for threading
($inline_comments | map(select(.in_reply_to_id == null))) as $all_root_comments |
([$inline_comments[] | select(.in_reply_to_id)] | group_by(.in_reply_to_id) | map({key: (.[0].in_reply_to_id | tostring), value: .}) | from_entries) as $replies_by_parent |

# Filter root comments based on include_resolved flag
(if $include_resolved == "true" then
    $all_root_comments
else
    [$all_root_comments[] | select($thread_lookup[(.id | tostring)].isResolved != true)]
end) as $root_comments |

# Count comments (use GraphQL isResolved for thread status)
($all_root_comments | length) as $total_thread_count |
($root_comments | length) as $shown_thread_count |
($issue_comments | length) as $issue_count |
([$all_root_comments[] | select($thread_lookup[(.id | tostring)].isResolved == true)] | length) as $resolved_count |
($total_thread_count + $issue_count) as $total_count |
($total_count - $resolved_count) as $active_count |

# Build frontmatter
"---
pr_number: \($pr)
repo: \($owner)/\($repo)
url: https://github.com/\($owner)/\($repo)/pull/\($pr)
fetched_at: \($fetched_at)
include_resolved: \($include_resolved)
total_comments: \($total_count)
active_comments: \($active_count)
resolved_comments: \($resolved_count)
shown_threads: \($shown_thread_count)
---

# PR #\($pr) Comments - \($owner)/\($repo)

## How to Reply

`reply.sh` appends a harness signature (Claude Code or Codex), silences output, and (with `--resolve`) resolves the comment thread — no thread ID needed:
- **Inline reply**: `bash \($reply) \($owner)/\($repo)#\($pr) --comment <COMMENT_ID> --body \"<reply>\"` (add `--resolve` to close its thread)
- **Top-level comment**: `bash \($reply) \($owner)/\($repo)#\($pr) --issue --body \"<reply>\"`
- **Resolve thread by ID**: `bash \($reply) \($owner)/\($repo)#\($pr) --resolve-thread <THREAD_ID>`
- **React**: add `--thumbs-up` (👍) / `--thumbs-down` (👎) to a `--comment` call; skip when it adds nothing.

---

## REVIEW SUMMARIES
" +

# Add review summaries (sorted by submitted_at ascending). Hide a summary once its
# review is fully settled — every inline thread it opened is resolved — so addressed
# reviews stop sending the agent back to already-closed feedback. A review with no
# inline comments (a bare approval or standalone summary) has nothing to resolve, so
# it is always shown. --include-resolved shows every summary regardless.
([$reviews_list[] | select(.body != null and .body != "") |
    . as $rev |
    ([$all_root_comments[] | select(.pull_request_review_id == $rev.id)]) as $rev_roots |
    ([$rev_roots[] | select($thread_lookup[(.id | tostring)].isResolved != true)] | length) as $rev_unresolved |
    select($include_resolved == "true" or ($rev_roots | length) == 0 or $rev_unresolved > 0)
  ] | sort_by(.submitted_at) |
    if length > 0 then
        map("<review-summary id=\"review-\(.id)\" author=\"\(.user.login)\" created=\"\(.submitted_at)\">
| ID | Type | Source | Created |
|----|----|----|--------|
| `review-\(.id)` | PR Review | \(.user.login) | \(.submitted_at) |

**Body:**
\(.body | strip_codex_trailer | gsub("\n"; "\n> ") | "> " + .)
</review-summary>") | join("\n---\n\n")
    else
        "_No review summaries with body text._"
    end
) +

"

---

## REVIEW THREADS
" +

# Add inline comments (threaded, sorted by created_at ascending)
(if ($root_comments | length) > 0 then
    [($root_comments | sort_by(.created_at)) | to_entries[] |
        .key as $idx |
        .value as $c |
        ($c.line // $c.original_line // "?") as $end_line |
        ($c.start_line // $end_line) as $start_line |
        (if $start_line == $end_line then "\($end_line)" else "\($start_line)-\($end_line)" end) as $lines |
        ($thread_lookup[($c.id | tostring)] // {id: "unknown", isResolved: false}) as $thread_info |
        ($thread_info.id) as $thread_id |
        (if $thread_info.isResolved then "resolved" else "active" end) as $state |
        ($replies_by_parent[($c.id | tostring)] // []) as $replies |
        "
<review-thread id=\"\($thread_id)\" created=\"\($c.created_at)\">
### Thread \($idx + 1)
| Field | Value |
|-------|-------|
| **ID** | `\($c.id)` |
| **Thread ID** | `\($thread_id)` |
| **State** | `\($state)` |
| **File** | `\($c.path)` |
| **Lines** | \($lines) |
| **Author** | \($c.user.login)\(if $c.user.type == "Bot" then " (Bot)" else "" end) |
| **Created** | \($c.created_at) |

**Code Context (`\($c.path):\($lines)`):**
```diff
\($c.diff_hunk | split("\n") | .[-10:] | join("\n"))
```

<comment id=\"\($c.id)\" author=\"\($c.user.login)\">
\($c.body | blockquote)
</comment>" +

# Add suggestion if present
(if ($c.body | test("```suggestion")) then "

**Suggestion:** _(see comment body above)_"
else ""
end) +

# Add replies
(if ($replies | length) > 0 then
    "\n\n**Replies:**\n" +
    ([$replies[] |
        "<reply id=\"\(.id)\" author=\"\(.user.login)\">\n> **\(.user.login)**: \(.body | strip_codex_trailer | gsub("\n"; "\n> "))\n</reply>"
    ] | join("\n"))
else ""
end) +
"
</review-thread>

---"
    ] | join("\n")
else
    "_No inline review comments._"
end) +

"

## PR COMMENTS
" +

# Add issue comments (sorted by created_at ascending)
(if ($issue_comments | length) > 0 then
    [($issue_comments | sort_by(.created_at)) | to_entries[] |
        .key as $idx |
        .value as $c |
        "
<pr-comment id=\"\($c.id)\" author=\"\($c.user.login)\" created=\"\($c.created_at)\">
### Comment \($idx + 1 + ($inline_comments | length))
| Field | Value |
|-------|-------|
| **ID** | `\($c.id)` |
| **State** | `active` |
| **Author** | \($c.user.login)\(if $c.user.type == "Bot" then " (Bot)" else "" end) |
| **Created** | \($c.created_at) |

**Content:**
\($c.body | blockquote)
</pr-comment>

---"
    ] | join("\n")
else
    "_No top-level comments._"
end) +

"

## SUMMARY FOR LLM PROCESSING

**Total comments:** \($total_count) (\($active_count) active, \($resolved_count) resolved)" +
(if $include_resolved == "true" then "
**Showing:** All threads (including resolved)"
else "
**Showing:** Active threads only (\($resolved_count) resolved threads filtered out)"
end) + "

**Reply / resolve** with the `reply.sh` wrapper (signature + output silencing built in):
```bash
# Reply to an inline review comment
bash \($reply) \($owner)/\($repo)#\($pr) --comment COMMENT_ID --body \"Your response here\"

# Reply and resolve the comment thread in one call (no thread ID needed)
bash \($reply) \($owner)/\($repo)#\($pr) --comment COMMENT_ID --body \"Your response here\" --resolve

# Optional: add a 👍/👎 reaction to a comment (append to any --comment call, or use alone)
bash \($reply) \($owner)/\($repo)#\($pr) --comment COMMENT_ID --body \"Your response here\" --thumbs-up

# Post a new top-level comment
bash \($reply) \($owner)/\($repo)#\($pr) --issue --body \"Your comment here\"

# Resolve a thread directly by its node ID
bash \($reply) \($owner)/\($repo)#\($pr) --resolve-thread THREAD_ID
```
"
' "$TMPDIR/inline.json" | tr -d '\r' > "$OUTPUT_FILE"

# Count results
INLINE_COUNT=$(jq 'if type == "array" then (if length > 0 and (.[0] | type) == "array" then flatten else . end) | length else 0 end' "$TMPDIR/inline.json")
ISSUE_COUNT=$(jq 'if type == "array" then (if length > 0 and (.[0] | type) == "array" then flatten else . end) | length else 0 end' "$TMPDIR/issue.json")
REVIEW_COUNT=$(jq 'if type == "array" then (if length > 0 and (.[0] | type) == "array" then flatten else . end) | length else 0 end' "$TMPDIR/reviews.json")

echo "Written to $OUTPUT_FILE:" >&2
echo "  - $INLINE_COUNT inline review comments" >&2
echo "  - $ISSUE_COUNT top-level comments" >&2
echo "  - $REVIEW_COUNT reviews" >&2

# Output the file path to stdout for LLM consumption
# Convert to Windows path if cygpath is available (Git Bash on Windows)
if command -v cygpath &>/dev/null; then
    cygpath -w "$OUTPUT_FILE"
else
    echo "$OUTPUT_FILE"
fi
