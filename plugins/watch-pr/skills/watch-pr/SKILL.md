---
name: watch-pr
description: Watch a GitHub PR's full lifecycle (CI, rebase state, reviews, reactions, merge) and act on each change — investigate red CI, rebase when behind, and hand incoming review comments to the comments flow for reply drafting. Use after opening a PR or when babysitting one to green + merged.
argument-hint: "[pr-url-or-ref]"
allowed-tools: Bash, Read, Edit, AskUserQuestion, Monitor
---

# Watch a PR to green + merged

Babysit a pull request end to end with a single script: `watch-pr.sh` watches the
lifecycle AND, whenever fresh feedback lands, fetches + formats the active comments
itself (via the vendored sibling `comments.sh`) and prints the formatted markdown
**inline in the Monitor stdout** — no follow-up `Read`. You react to its event
lines; when a `BEGIN PR FEEDBACK` block appears, you drive the reply flow.

## Arguments

- `$ARGUMENTS` (optional): PR URL, `owner/repo#123`, or bare `123`. If omitted,
  auto-detects the PR from the current branch (`gh pr view --json number`).

## Instructions

### 1. Resolve the PR

If `$ARGUMENTS` is empty, resolve the current branch's PR:

```bash
gh pr view --json number,url -q '"#\(.number) \(.url)"'
```

If that fails, there is no PR for this branch — stop and tell the user (offer to
open one). Otherwise note the PR number for the rest of the flow.

The watch loop fetches once on startup, so any threads already open when you start
arrive as a `BEGIN PR FEEDBACK` block in the first poll (silent if none are active).

### 2. Launch the watch inside the Monitor tool

Run `watch-pr.sh <PR>` **as the Monitor tool's `command`** with `persistent: true`
(PR lifecycles can take hours — no timeout). Put the script path directly in the
command; do NOT use Bash `run_in_background` + a separate Monitor.

```
Monitor:
  persistent: true
  description: "PR <PR> lifecycle"
  command: bash "$(find ~/.claude -path '*/watch-pr/skills/watch-pr/watch-pr.sh' 2>/dev/null | head -1)" <PR>
```

The loop diffs state each poll and emits **one line per change**, staying silent
while the PR just waits for auto-merge. It self-terminates on MERGED/CLOSED — you
never stop it manually.

### 3. Act on each emitted event line

| Event line | What it means | Action |
|---|---|---|
| `check <name>: pending` | a CI check started/re-ran | note it; wait for the terminal bucket |
| `check <name>: fail` (or `failure`) | CI went red | investigate the failure (`gh run view`/logs), propose a fix, and — with the user's ok — push it; the next `check … pending → pass/fail` line confirms the re-run |
| `check <name>: pass` (or `success`) | CI went green | nothing to do |
| `rebase: BEHIND …` | branch fell behind `main` | `git pull --rebase origin main` (fast-forwards cleanly), then push |
| `rebase: DIRTY …` | merge conflicts with `main` | `git pull --rebase origin main`, resolve conflicts during the rebase, then force-push with `--force-with-lease` |
| `review <login>: <state> @<ts>` | a reviewer just submitted | a `BEGIN PR FEEDBACK` block follows with the comments inline → **step 4** |
| `comments: <n>` | top-level comment count changed | same — a `BEGIN PR FEEDBACK` block follows → **step 4** |
| `===== BEGIN PR FEEDBACK (<path>) =====` … `===== END PR FEEDBACK =====` | the active comments, already fetched + formatted, printed inline | **go to step 4**: handle the feedback from the block; `<path>` is the file to write drafts into |
| `reaction EYES: 1` (👀) | Codex acknowledged the push, reviewing | informational — wait for its verdict |
| `reaction THUMBS_UP: 1` (👍) | Codex finished, found **nothing** | informational — its all-clear (when it *does* find something it posts a review → `review …` + a `BEGIN PR FEEDBACK` block → step 4) |
| `PR <PR> finished: MERGED` | merged (loop ran `git fetch --all --prune`) | done — confirm to the user |
| `PR <PR> finished: CLOSED` | closed without merging | done — confirm to the user |

### 4. Handle incoming review comments

When a `BEGIN PR FEEDBACK` block lands, the active comments are already in front of
you inline — no `Read` needed. `<path>` in the marker is the markdown file the
script wrote (edit it to stash drafts). Then follow the `comments` skill's flow:
for each open comment, reflect on whether it's pertinent,
draft a reply (confirm with the user on any real design/coding decision), write
draft replies + needed code changes into the markdown file, and present them. Once
the user agrees: make the code changes, commit and push (which restarts CI — the
watch loop will surface the new `check …` lines), send the replies with the `gh`
commands in the markdown, then auto-resolve threads whose issue is settled (the
requested change is made, or the reply conclusively closes the point) and leave
pending discussions open (unresolved debate or a design call awaiting a decision).

Then return to watching — the Monitor loop is still running and will keep emitting
new events until the PR reaches MERGED/CLOSED.

## Notes

- One script does both jobs: the watch loop drives `comments.sh` internally, so you
  only ever launch `watch-pr.sh` — the feedback arrives inline in stdout, no `Read`.
- The 👀→👍 sequence is the clean-review path for Codex (auto-reviews every push).
- Force-pushes on this feature branch use `--force-with-lease`; no confirmation needed.
- Set the PR to auto-merge when appropriate per your workflow, then let the loop
  run silently until it reports `finished: MERGED`.
