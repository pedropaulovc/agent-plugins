---
name: watch-pr
description: Watch a GitHub PR's full lifecycle (CI, rebase state, reviews, reactions, merge) and act on each change — investigate red CI, rebase when behind, and hand incoming review comments to the comments flow for reply drafting. Use after opening a PR or when babysitting one to green + merged.
argument-hint: "[pr-url-or-ref]"
allowed-tools: Bash, Read, Edit, AskUserQuestion, Monitor
---

# Watch a PR to green + merged

Babysit a pull request end to end with a single script: `watch-pr.py` watches the
lifecycle AND, whenever fresh feedback lands, fetches + formats the active comments
itself (via the vendored sibling `comments.sh`). It emits **one compact `feedback …`
line per newly active or reopened inline thread** and a `→ full bodies …: <path>`
pointer only when the formatted document changes. Top-level comment and body-review
summaries stay in the file instead of being emitted inline, and unchanged feedback
is not re-emitted.

CI check churn is coalesced: a pending wave produces one `checks: rerun started …`
event, newly observed failures stay immediate and named, and the wave ends with one
`checks: all terminal …` summary. Routine pending, pass, skipping, and cancel
transitions are not emitted one per check.

## Arguments

- PR ref (optional): a PR number, full URL, or branch name — the forms
  `gh pr view` accepts. (`owner/repo#123` is **not** accepted; pass the URL for a
  PR in another repo.) In Claude Code this arrives as `$ARGUMENTS`; under **Codex
  or OpenCode** take the ref from the user's prompt. If
  none is given, auto-detects the PR from the current branch. The script validates
  the ref up front and exits loudly on a bad one.
- `--stall-timeout <duration>` (optional): emit a stall notification after this much
  time without a new event, then once per additional quiet interval. Defaults to
  `1h`; accepts a positive integer plus `s`, `m`, `h`, or `d` (for example,
  `30m`, `2h`, or `1d`). Under OpenCode, pass the same value as the `watch_pr`
  tool's `stallTimeout` argument.

## Instructions

### 1. Resolve the PR

If the user gave no PR ref (i.e. `$ARGUMENTS` is empty under Claude Code, or the
prompt named none under Codex/OpenCode), resolve the current branch's PR:

```bash
gh pr view --json number,url -q '"#\(.number) \(.url)"'
```

If that fails, there is no PR for this branch — stop and tell the user (offer to
open one). Otherwise carry the **URL** forward (not just the number) and pass it as
`<PR>` in step 2: `watch-pr.py` resolves a bare number against the local `gh` repo,
which can miss or mis-target a PR when the branch's PR lives in another repo (e.g. a
fork checkout), whereas the URL is unambiguous.

The watch loop fetches once on startup, so any threads already open when you start
arrive as `feedback …` lines in the first poll (silent if none are active). Existing
pending checks arrive as one aggregate rerun-start event rather than one line each.

### 2. Launch the watch

**Under OpenCode:** call the `watch_pr` tool with `action: "start"` and the
resolved PR URL/ref. The plugin owns the background process and sends each batch
of changed event lines back into this session automatically. Do not launch the
script through `bash`, do not poll it, and do not start a second watcher. Use
`watch_pr` with `action: "status"` or `action: "stop"` to inspect or cancel it.
After starting it, skip the rest of this step and continue with the event table.

**Under Claude Code:** launch the watch inside the Monitor tool.

Run `watch-pr.py <PR> [--stall-timeout <duration>]` **as the Monitor tool's `command`** with `persistent: true`
(PR lifecycles can take hours — no timeout). Use the `watch-pr.py` that sits **in
this skill's own directory** — right next to this `SKILL.md`, whose absolute path
you already know (it's where you loaded this file from) — and put that path
directly in the command. Do NOT use Bash `run_in_background` + a separate Monitor,
and do **not** locate the script with `find ~/.claude ~/.codex ~/.cache/opencode … | head -1`: that
scans every cached install and can launch a stale copy from an older plugin
version instead of the one next to this `SKILL.md`.

```
Monitor (macOS/Linux):
  persistent: true
  description: "PR <PR> lifecycle"
  command: python3 "<this skill's directory>/watch-pr.py" <PR> [--stall-timeout <duration>]

Monitor (Windows):
  persistent: true
  description: "PR <PR> lifecycle"
  command: py "<this skill's directory>/watch-pr.py" <PR> [--stall-timeout <duration>]
```
The loop diffs state each poll and emits **one line per actionable change**, plus
aggregate events for CI check waves, staying silent while the PR just waits for
auto-merge. It self-terminates on MERGED/CLOSED — you never stop it manually.

**Under Codex (no `Monitor` tool):** start `python3 watch-pr.py <PR> [--stall-timeout <duration>]`
(or `py watch-pr.py <PR> [--stall-timeout <duration>]` on Windows) as a
**persistent background terminal** using the harness's background-terminal
mechanism (`unified_exec`, or its equivalent). Stream that terminal's stdout as
it is produced and react to every new watcher event exactly as in the table
below. Keep the watcher attached to that persistent terminal until it reports
`MERGED` or `CLOSED`; do not detach it with `Start-Process`, redirect stdout to a
file, or run it in the foreground. Everything else — the event lines, the
feedback path, and the reply flow — is harness-agnostic.

**On Windows:** run the watcher and its Git commands in Git Bash from Git for
Windows, or in Bash paired with another Windows-local Git installation. Do **not**
launch it through WSL Bash: WSL uses a separate Git executable, filesystem paths,
credentials, and process environment from the Windows harness that owns the
plugin and background terminal. The watcher applies the same rule to the
`comments.sh` it spawns — it looks up Git for Windows' bash rather than the `bash`
first on `PATH`, which is usually WSL's and would write the formatted comments into
a filesystem the watcher cannot read back. Set `WATCH_PR_BASH` to an explicit
bash path if Git lives somewhere unusual.

### 3. Act on each emitted event line

| Event line | What it means | Action |
|---|---|---|
| `checks: rerun started (pending: <names>)` | one or more checks are pending at startup or a new rerun wave has begun; the GitHub zero-date sentinel is omitted | informational — wait for the all-terminal summary; individual pending/pass/skipping/cancel transitions stay silent |
| `check <name>: fail [@<ts>]` (or `failure`) | a named check is newly failing, or a failing run changed | investigate the failure (`gh run view`/logs), propose a fix, and — with the user's ok — push it; the next aggregate terminal event confirms the wave |
| `checks: all terminal (pass: <n>, fail: <n>, skipping: <n>, cancel: <n>)` | the observed pending wave has no pending checks left; `skipping` means GitHub intentionally did not run a check, and `cancel` means it was canceled | informational — use the counts to assess the wave; no per-check action is needed |
| `rebase: BEHIND — git pull --rebase origin <base> …` | branch fell behind the PR's **base** branch | run the emitted command (fast-forwards cleanly), then push |
| `rebase: DIRTY — git pull --rebase origin <base> …` | merge conflicts with the base branch | run the emitted command, resolve conflicts during the rebase, then force-push with `--force-with-lease` |
| `review <login>: <state> @<ts>` | a reviewer just submitted | if a feedback path follows, open it; review summaries are not emitted inline |
| `comments: <n>` | top-level (issue) comment count changed | if a feedback path follows, open it; top-level comments are not emitted inline |
| `review-comments: <n>` | inline review-comment count changed | if a feedback path follows, open it; unchanged feedback is not re-emitted |
| `unresolved-comments: <delta> (unresolved: <n>)` | unresolved review-thread IDs changed; `<delta>` contains additions/removals such as `+2`, `-1`, or `+1 -1` | a positive delta triggers a formatter fetch; a negative-only delta is informational |
| `feedback [<id>] <file>:<lines> @<author> <title>` | one newly active or reopened inline thread | open the next `→ full bodies …: <path>` pointer for its full context and reply command |
| `→ full bodies + code context: <path>` | the formatted feedback document changed | open `<path>`; the pointer is suppressed when the document is unchanged |
| `reaction EYES: 1` (👀) | Codex acked a **push**-triggered review on the PR body, reviewing | informational — wait for its verdict |
| `reaction THUMBS_UP: 1` (👍) | Codex finished a push-triggered review, found **nothing** | informational — its all-clear (when it *does* find something it posts a review → `review …` + a feedback path → step 4) |
| `comment-reaction EYES: 1` (👀) | Codex acked an **`@codex review`** mention on a comment, reviewing | informational — wait for its verdict |
| `comment-reaction THUMBS_UP: 1` (👍) | Codex finished an at-mention review, found **nothing** | informational — its all-clear for the mention (no review object is posted in this case) |
| `stall: no new events for <duration> — watcher still running` | the watcher is healthy, but the PR emitted no new event lines for the configured timeout (`1h` by default) | informational — continue waiting; another line appears after each additional quiet interval |
| `PR <PR> finished: MERGED` | merged (loop ran `git fetch --all --prune`) | done — confirm to the user |
| `PR <PR> finished: CLOSED` | closed without merging | done — confirm to the user |

### 4. Handle incoming review comments

When a `feedback …` line or feedback-path event lands, open the pointed-to
markdown file for the full bodies + diff context of the threads you will act on;
edit that same file to stash drafts. Bare `feedback [<id>]` lines identify newly
active or reopened inline threads. Top-level comments and body-review summaries
are intentionally not echoed into the monitor event stream, so their full content
is available only in the pointed-to file. Then follow the `comments` skill's flow:
for each open comment, reflect on whether it's pertinent,
draft a reply (confirm with the user on any real design/coding decision), write
draft replies + needed code changes into the markdown file, and present them. Once
the user agrees: make the code changes, commit and push (which restarts CI — the
watch loop will surface the new `check …` lines), send the replies with the
`reply.sh` commands in the markdown (reply + resolve settled threads in one call via
`--comment <ID> --body "…" --resolve`), leaving pending discussions open (unresolved
debate or a design call awaiting a decision). Optionally add `--thumbs-up`/`--thumbs-down`
to a `--comment` reply to react 👍/👎 to that comment — a quick acknowledgement when it
helps, never required.

Then return to watching — the loop remains active and emits new events until the PR
reaches MERGED/CLOSED.

## Notes

- One script does both jobs: the watch loop drives `comments.sh` internally, so you
  only ever launch `watch-pr.py` — the watcher emits compact lines only for inline
  unresolved-thread changes and points to the full document when its content changes.
- CI check waves use one rerun-start event, immediate named failures, and one
  all-terminal count; `skipping` means intentionally not run and `cancel` means canceled.
- The 👀→👍 sequence is the clean-review path for Codex (auto-reviews every push).
- Force-pushes on this feature branch use `--force-with-lease`; no confirmation needed.
- Do not merge or enable auto-merge until the user explicitly confirms; otherwise let
  the loop run silently until it reports `finished: MERGED`.
