# pr-comments plugin

![pr-comments plugin icon](icon.svg)

The explicit `/comments` skill retrieves pull-request feedback from GitHub and formats it as Markdown for the coding agent to review. It fetches inline review comments, top-level issue comments, review summaries, and GraphQL review-thread status with the authenticated GitHub CLI (`gh`). It can use a supplied PR URL/reference, the current branch, or the current repository's `origin` remote.

## Review and reply workflow

By default, the generated Markdown shows active review threads; pass `--include-resolved` to include resolved ones. The skill asks the agent to summarize feedback, discuss proposed replies or code changes with the user, and only continue after agreement. The fetch script only reads GitHub. A separate `reply.sh` can post an inline reply or top-level comment, add a reaction, or resolve a review thread; the skill may also direct the agent to make agreed code changes and commit/push them. Those actions are not performed by the fetch step.

The fetch script writes a Markdown file that contains GitHub comments and diff context. By default it remains in the system temporary directory (`TMPDIR`, `TEMP`, `TMP`, or `/tmp`); a temporary working directory holding raw API responses is removed on exit. Use the printed path to inspect or delete the generated file.

## Data handling

The scripts use the user's existing `gh` authentication and send GitHub API requests only when run. Retrieved PR content is returned as tool output and loaded into the assistant's context; replies, reactions, and thread resolutions are sent to GitHub only when `reply.sh` is invoked. The plugin does not include GitHub credentials.

- [Documentation](https://go.vza.net/agent-plugins/pr-comments/docs)
- [Support](https://go.vza.net/agent-plugins/pr-comments/support)
- [Privacy policy](PRIVACY.md) · [Online privacy policy](https://go.vza.net/agent-plugins/pr-comments/privacy)
