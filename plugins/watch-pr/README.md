# watch-pr plugin

Provides the `/watch-pr` skill: babysit a GitHub PR to green + merged.

A single script (`watch-pr.sh`) runs inside the **Monitor** tool and diffs PR state every 30s, emitting one line per change — CI `check`, `rebase` state (BEHIND/DIRTY), `review`, `comments`, `reaction` (Codex 👀→👍), and terminal `finished`. The `SKILL.md` maps each event to an action: investigate red CI, `git pull --rebase` when behind, and — when new feedback lands — drive the reply-drafting flow.

On new feedback the script fetches + formats the active comments itself and emits **one compact `feedback …` line per active thread** (id / location / author / title) plus a pointer to the full markdown file — line-oriented so Monitor never truncates it. It fetches once on startup, stays silent when there are no active comments, and re-fetches only when unresolved threads *increase* (a decrease just means threads got resolved). Self-terminates on MERGED/CLOSED.

Self-contained: it ships a vendored copy of the comment formatter (`comments.sh`, alongside `watch-pr.sh`), so it works without any other plugin installed. That copy is kept in sync with the `pr-comments` plugin's original.

## Codex support

Works in both. Codex has no `Monitor` tool, so under Codex the same `watch-pr.sh` runs as a background terminal and you poll its output; the event lines, `feedback …` lines, and reply flow are identical.
