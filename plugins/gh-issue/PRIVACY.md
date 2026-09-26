# Privacy policy: gh-issue

This policy describes the behavior of this plugin package. The plugin provides an explicitly invoked `/issue` skill; it does not install a background service or a hook that watches other activity.

## Information processed

When `/issue` is invoked, the host model receives the user's request as part of the normal agent session. The skill can also use permitted workspace reads and clarifying answers to draft the issue. It may ask follow-up questions when details are missing.

The skill directs the agent to run `gh issue create`. That command submits the resulting issue title, body, and any chosen labels to GitHub, using the repository and authentication already configured in the local GitHub CLI. User-provided text, answers, or relevant project details included in the issue therefore reach GitHub and are retained according to the destination repository's settings and GitHub's policies.

## Plugin storage and other destinations

The plugin contains no telemetry sender, plugin-owned server, or independent web-fetch behavior. It does not collect or store issue drafts itself. It does not read GitHub credentials; the installed `gh` CLI handles its own authentication. Apart from the GitHub issue creation described above, no other external destination is built into the skill.

The host agent's handling of prompts and workspace context is governed by the model and agent platform selected by the user. Review that provider's privacy terms before including confidential information in an issue or prompt.
