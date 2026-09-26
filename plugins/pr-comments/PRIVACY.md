# Privacy policy: pr-comments

## What the plugin does

The plugin provides an explicit skill plus shell scripts. `comments.sh` uses the locally installed GitHub CLI (`gh`) to fetch pull-request review comments, top-level comments, review summaries, and GraphQL thread status, then writes Markdown for the coding agent. `reply.sh` can post replies or top-level comments, add reactions, and resolve review threads when invoked. The scripts do not contain a GitHub token.

## Information and destinations

- **Claude input and tool results:** The user's request and the fetched Markdown are passed through the ordinary coding-agent conversation. In Claude, prompts and tool outputs are handled by Anthropic under the user's normal service and account settings; other hosts/providers follow their own normal data practices. Fetched content can include reviewer names, comment text, code paths, diff snippets, timestamps, and GitHub IDs.
- **GitHub reads:** When `comments.sh` runs, `gh` makes authenticated REST and GraphQL requests to GitHub for the selected pull request. It uses the user's existing `gh` authentication. If no PR is supplied, the script may inspect the current branch with `gh pr view`; for a bare PR number it reads the current `origin` remote to determine repository identity.
- **Local files:** Raw API-response files are placed in a temporary working directory and removed on script exit. The generated Markdown file is not removed automatically: by default it is written under `TMPDIR`, `TEMP`, `TMP`, or `/tmp` with the PR number and timestamp in its name; the caller may instead provide an output path. That Markdown contains fetched review material and should be handled accordingly.
- **GitHub writes:** When `reply.sh` is invoked, it sends the chosen reply text to GitHub; it can also send a reaction or a thread-resolution mutation. The skill directs the agent to perform agreed replies only after user agreement. It may also direct the agent to make code changes and commit and push them after agreement; those Git operations use the project's ordinary Git configuration and remote, outside these scripts.

This plugin does not make GitHub requests until its scripts are run, and it does not send fetched data to a destination other than the assistant context and GitHub actions described above. It does not control GitHub, Anthropic, the configured model provider, or Git remote retention and access policies.
