# worktree-reset plugin
![Worktree reset icon](icon.svg)

Provides the explicit `/reset` skill (`$reset` in Codex). This is a breaking rename from
the former `/m` and `$m` entry points; no compatibility alias remains. Harness-specific
agent-state teardown lives in sibling instruction files, and the shared `reset.py`
implementation owns the complete repository flow and dependency installation.

Arguments:

- `--confirm` removes the reviewed untracked files after the user approves the safety
  report.
- `--force` discards tracked, untracked, ignored, and repository-wide stashed changes
  without confirmation, deletes stale local branches, removes every linked worktree when
  run from the primary worktree, and warns before removing linked worktrees with
  uncommitted changes or detached links whose commits may become unreachable. It resets
  `main` there to `origin/main`. It refuses linked-worktree invocations because rerunning
  from the primary would delete every linked worktree, refuses bare repositories without a
  primary worktree, and refuses removal while a Git operation is active in a linked
  worktree. In force mode it recursively synchronizes submodules with forced checkout and
  reports failure instead of success when the root worktree or any submodule remains dirty
  or out of sync.
- `--all` also rebases each linked worktree onto `origin/main` and installs its dependencies in normal mode.

## Reset operations and data flow

The script inspects local Git status, branches, stashes, and worktree metadata. In normal mode it preserves tracked changes and stashes, asks for approval before deleting listed untracked files, fetches/prunes the configured remote, and checks out `main` at `origin/main`. `--all` additionally rebases every linked worktree onto `origin/main`; `--force` is destructive and verifies the primary worktree and submodules after cleanup.

When the checkout contains the relevant files, it runs `npm install`, `go mod download`, or `uv sync --locked`. Git, submodule, and package-manager commands may fetch from the remotes and registries configured by that checkout; this plugin does not hard-code those destinations. The skill also stops its own watch-pr monitors and calls the hosted watch-pr service's `unwatch_pr` tool for their PRs. Watches are scoped by MCP credential and PR, not by client session: another session using the same credential to watch that PR loses its watch too.

## Harness support

Shared reset safety, arguments, and script-invocation rules live in `SKILL.md`; sibling
files describe harness-specific teardown and user-interaction APIs. Claude Code reads
`claude.md`. If the current system context mentions `omp://`, Oh My Pi is running and reads
`omp.md` instead. Codex and OpenCode read their respective files and skip Claude-only
state tools while handling background terminals through their own harness mechanisms.

## Plugin resources

[Documentation](https://go.vza.net/agent-plugins/worktree-reset/docs) · [Support](https://go.vza.net/agent-plugins/worktree-reset/support) · [Privacy](https://go.vza.net/agent-plugins/worktree-reset/privacy) · [Local privacy notice](PRIVACY.md)
