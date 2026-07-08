---
name: watch-pr
description: Watch a GitHub PR's full lifecycle (CI, rebase state, reviews, reactions, merge) and act on each change — investigate red CI, rebase when behind, and hand incoming review comments to the comments flow for reply drafting. Use after opening a PR or when babysitting one to green + merged.
argument-hint: "[pr-url-or-ref]"
allowed-tools: Bash, Read, Edit, AskUserQuestion, Monitor
---

# Watch a PR to green + merged

Babysit a pull request end to end with a single script: `watch-pr.sh` watches the
lifecycle AND, whenever fresh feedback lands, fetches + formats the active comments
itself (via the vendored sibling `comments.sh`) and emits **one compact `feedback …`
line per active thread** (id / location / author / title) followed by a `→ full
bodies …: <path>` pointer. You react to its event lines; when `feedback …` lines
appear, you open `<path>` for the threads you will act on and drive the reply flow.

## Arguments

- PR ref (optional): a PR number, full URL, or branch name — the forms
  `gh pr view` accepts. (`owner/repo#123` is **not** accepted; pass the URL for a
  PR in another repo.) In Claude Code this arrives as `$ARGUMENTS`; under **Codex**
  there is no argument substitution, so take the ref from the user's prompt. If
  none is given, auto-detects the PR from the current branch. The script validates
  the ref up front and exits loudly on a bad one.

## Instructions

### 1. Resolve the PR

If the user gave no PR ref (i.e. `$ARGUMENTS` is empty under Claude Code, or the
prompt named none under Codex), resolve the current branch's PR:

```bash
gh pr view --json number,url -q '"#\(.number) \(.url)"'
```

If that fails, there is no PR for this branch — stop and tell the user (offer to
open one). Otherwise carry the **URL** forward (not just the number) and pass it as
`<PR>` in step 2: `watch-pr.sh` resolves a bare number against the local `gh` repo,
which can miss or mis-target a PR when the branch's PR lives in another repo (e.g. a
fork checkout), whereas the URL is unambiguous.

The watch loop fetches once on startup, so any threads already open when you start
arrive as `feedback …` lines in the first poll (silent if none are active).

### 2. Launch the watch inside the Monitor tool

Run `watch-pr.sh <PR>` **as the Monitor tool's `command`** with `persistent: true`
(PR lifecycles can take hours — no timeout). Use the `watch-pr.sh` that sits **in
this skill's own directory** — right next to this `SKILL.md`, whose absolute path
you already know (it's where you loaded this file from) — and put that path
directly in the command. Do NOT use Bash `run_in_background` + a separate Monitor,
and do **not** locate the script with `find ~/.claude ~/.codex … | head -1`: that
scans every cached install and can launch a stale copy from an older plugin
version instead of the one next to this `SKILL.md`.

```
Monitor:
  persistent: true
  description: "PR <PR> lifecycle"
  command: bash "<this skill's directory>/watch-pr.sh" <PR>
```

The loop diffs state each poll and emits **one line per change**, staying silent
while the PR just waits for auto-merge. It self-terminates on MERGED/CLOSED — you
never stop it manually.

**Under Codex (no `Monitor` tool):** Codex has no persistent Monitor primitive,
so run the *same* `watch-pr.sh <PR>` as a **background terminal** instead
(`unified_exec` / the harness's background-shell mechanism — not a blocking
foreground call). The script's stdout is identical; poll it with `/ps` (or read
the background terminal's captured output) and act on each new line exactly as in
the table below. Everything else — the event lines, the `feedback …` lines, the
reply flow — is harness-agnostic. Do **not** foreground the script; it
runs until MERGED/CLOSED.

### 3. Act on each emitted event line

| Event line | What it means | Action |
|---|---|---|
| `check <name>: pending` | a CI check started/re-ran | note it; wait for the terminal bucket |
| `check <name>: fail [@<ts>]` (or `failure`) | CI went red | investigate the failure (`gh run view`/logs), propose a fix, and — with the user's ok — push it; the next `check … pending → pass/fail` line confirms the re-run (the `@<completedAt>` stamp makes a same-bucket rerun show as a change) |
| `check <name>: pass [@<ts>]` (or `success`) | CI went green | nothing to do |
| `rebase: BEHIND — git pull --rebase origin <base> …` | branch fell behind the PR's **base** branch | run the emitted command (fast-forwards cleanly), then push |
| `rebase: DIRTY — git pull --rebase origin <base> …` | merge conflicts with the base branch | run the emitted command, resolve conflicts during the rebase, then force-push with `--force-with-lease` |
| `review <login>: <state> @<ts>` | a reviewer just submitted | `feedback …` lines follow with the active comments → **step 4** |
| `comments: <n>` | top-level (issue) comment count changed | same — `feedback …` lines follow → **step 4** |
| `review-comments: <n>` | inline review-thread comment count changed (e.g. a reply to an existing thread) | same — `feedback …` lines follow → **step 4** |
| `unresolved-threads: <n>` | count of unresolved review threads changed | informational only; a fetch (→ `feedback …` lines) fires **only when the count increases** — a decrease just means threads got resolved (often your own `--resolve`), never new feedback |
| `feedback [<id>] <file>:<lines> @<author> <title>` (or `feedback comment […]` / `feedback review […]`) … `→ full bodies + code context: <path>` | one compact line per active thread/comment/review summary, plus the file path | **go to step 4**: `<id>` is the comment id for `reply.sh`; open `<path>` for full bodies + diff context on the threads you will act on, and to write drafts into |
| `reaction EYES: 1` (👀) | Codex acked a **push**-triggered review on the PR body, reviewing | informational — wait for its verdict |
| `reaction THUMBS_UP: 1` (👍) | Codex finished a push-triggered review, found **nothing** | informational — its all-clear (when it *does* find something it posts a review → `review …` + `feedback …` lines → step 4) |
| `comment-reaction EYES: 1` (👀) | Codex acked an **`@codex review`** mention on a comment, reviewing | informational — wait for its verdict |
| `comment-reaction THUMBS_UP: 1` (👍) | Codex finished an at-mention review, found **nothing** | informational — its all-clear for the mention (no review object is posted in this case) |
| `PR <PR> finished: MERGED` | merged (loop ran `git fetch --all --prune`) | done — confirm to the user |
| `PR <PR> finished: CLOSED` | closed without merging | done — confirm to the user |

### 4. Handle incoming review comments

When `feedback …` lines land, each is one active thread/comment (id / location /
author / title) — enough to triage at a glance. `Read` `<path>` (the markdown file
the script wrote) for the full bodies + diff context of the threads you will act on;
edit that same file to stash drafts. Then follow the `comments` skill's flow:
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

Then return to watching — the Monitor loop is still running and will keep emitting
new events until the PR reaches MERGED/CLOSED.

## Notes

- One script does both jobs: the watch loop drives `comments.sh` internally, so you
  only ever launch `watch-pr.sh` — the feedback arrives as compact `feedback …` lines
  in stdout, and you `Read` the pointed-to file only for threads you act on.
- The 👀→👍 sequence is the clean-review path for Codex (auto-reviews every push).
- Force-pushes on this feature branch use `--force-with-lease`; no confirmation needed.
- Set the PR to auto-merge when appropriate per your workflow, then let the loop
  run silently until it reports `finished: MERGED`.
