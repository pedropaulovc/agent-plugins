# watch-pr plugin

Provides the `/watch-pr` skill: babysit a GitHub PR to green + merged.

A single script (`watch-pr.py`) runs through Claude Code's **Monitor** tool, OpenCode's event-driven plugin bridge, or a background terminal fallback. It diffs PR state every 30s, emitting one line per change — CI `check`, `rebase` state (BEHIND/DIRTY), `review`, `comments`, `reaction` (Codex 👀→👍), unresolved-comment deltas, and terminal `finished`. The `SKILL.md` maps each event to an action: investigate red CI, `git pull --rebase` when behind, and — when feedback changes — open the generated file for reply drafting.

On new or reopened inline threads the script emits **one compact `feedback …` line per thread** plus a pointer to the full markdown file. Top-level comment and body-review summaries are deliberately not emitted inline. The pointer and thread lines are deduplicated against unchanged formatter output, so a later feedback trigger does not repeat old content. It fetches once on startup and re-fetches when review/comment state changes or unresolved threads are added. Self-terminates on MERGED/CLOSED.

Self-contained: it ships a vendored copy of the comment formatter (`comments.sh`, alongside `watch-pr.py`), so it works without any other plugin installed. That copy is kept in sync with the `pr-comments` plugin's original.

## Codex and OpenCode support

Works in both. Codex has no `Monitor` tool, so under Codex the same `watch-pr.py` runs as a background terminal and you poll its output; the event lines, `feedback …` lines, and reply flow are identical.

OpenCode exposes `/watch-pr` and a native `watch_pr` tool. The plugin owns the
watcher process and batches its stdout into synthetic `promptAsync` events, so
the originating session wakes and reacts without polling. The same tool supports
`status` and `stop` actions.
