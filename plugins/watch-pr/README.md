# watch-pr plugin

Provides the `/watch-pr` skill: babysit a GitHub PR to green + merged.

A single script (`watch-pr.sh`) runs inside the **Monitor** tool and diffs PR state every 30s, emitting one line per change — CI `check`, `rebase` state (BEHIND/DIRTY), `review`, `comments`, `reaction` (Codex 👀→👍), and terminal `finished`. The `SKILL.md` maps each event to an action: investigate red CI, `git pull --rebase` when behind, and — when new feedback lands — drive the reply-drafting flow.

On new feedback the script fetches + formats the active comments itself and prints them **inline in the Monitor stdout** (no extra tool call). It fetches once on startup and stays silent when there are no active comments. Self-terminates on MERGED/CLOSED.

Self-contained: it ships a vendored copy of the comment formatter (`comments.sh`, alongside `watch-pr.sh`), so it works without any other plugin installed. That copy is kept in sync with the `pr-comments` plugin's original.
