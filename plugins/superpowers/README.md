# Superpowers
![Superpowers workflow icon](icon.svg)

Superpowers is a software-development methodology for coding agents, built from
composable skills and bootstrap instructions that ask the model to use them when relevant.

For Claude Code, this plugin provides skills and local scripts that guide the agent
through development workflows. When invoked, those instructions may direct Claude to
inspect or edit project files, run local commands, or use subagents through the tools
available to the session.

[Documentation](https://go.vza.net/agent-plugins/superpowers/docs) · [Support](https://go.vza.net/agent-plugins/superpowers/support) · [Privacy](https://go.vza.net/agent-plugins/superpowers/privacy) · [Local privacy notice](PRIVACY.md)


## We're Hiring!

We're hiring someone to help out full time with Superpowers community and code work. 
You can read about the job at https://primeradiant.com/jobs/superpowers-community-engineer/
If this sounds like someone you know, definitely send them our way.

## Quickstart

Give your agent Superpowers: [Claude Code](#claude-code), [Antigravity](#antigravity), [Codex App](#codex-app), [Codex CLI](#codex-cli), [Cursor](#cursor), [Factory Droid](#factory-droid), [GitHub Copilot CLI](#github-copilot-cli), [Kimi Code](#kimi-code), [OpenCode](#opencode), [Pi](#pi).

## How it works

In Claude Code, a `SessionStart` hook provides bootstrap instructions and the other
skills are instruction files the model may invoke when relevant. The agent may ask
clarifying questions, draft a design for your review, and prepare an implementation plan
with TDD, YAGNI, and DRY guidance.

For independent plan tasks, when subagent support is available and appropriate, the agent
may use subagent-driven development with review steps. Otherwise, it can follow the
executing-plans workflow with batches and human checkpoints. These are model-directed
procedures, not guaranteed automation or a promise of autonomous duration.

## Commercial Services

If you're using Superpowers in enterprise and could benefit from commercial support, additional tooling, or managed spending, please don't hesitate to drop us a line at sales@primeradiant.com.

## Installation

Installation differs by harness. If you use more than one, install Superpowers separately for each one.

### Claude Code

Superpowers is available via the [official Claude plugin marketplace](https://claude.com/plugins/superpowers)

#### Official Marketplace

- Install the plugin from Anthropic's official marketplace:

  ```bash
  /plugin install superpowers@claude-plugins-official
  ```

#### Superpowers Marketplace

The Superpowers marketplace provides Superpowers and some other related plugins for Claude Code.

- Register the marketplace:

  ```bash
  /plugin marketplace add obra/superpowers-marketplace
  ```

- Install the plugin from this marketplace:

  ```bash
  /plugin install superpowers@superpowers-marketplace
  ```

### Antigravity

Install Superpowers as a plugin from this repository:

```bash
agy plugin install https://github.com/obra/superpowers
```

Antigravity runs the plugin's session-start hook, so Superpowers is active from
the first message. Reinstall with the same command to update.

### Codex App

Superpowers is available via the [official Codex plugin marketplace](https://github.com/openai/plugins).

- In the Codex app, click on Plugins in the sidebar.
- You should see `Superpowers` in the Coding section.
- Click the `+` next to Superpowers and follow the prompts.

### Codex CLI

Superpowers is available via the [official Codex plugin marketplace](https://github.com/openai/plugins).

- Open the plugin search interface:

  ```bash
  /plugins
  ```

- Search for Superpowers:

  ```bash
  superpowers
  ```

- Select `Install Plugin`.

### Cursor

- In Cursor Agent chat, install from marketplace:

  ```text
  /add-plugin superpowers
  ```

- Or search for "superpowers" in the plugin marketplace.

### Factory Droid

- Register the marketplace:

  ```bash
  droid plugin marketplace add https://github.com/obra/superpowers
  ```

- Install the plugin:

  ```bash
  droid plugin install superpowers@superpowers
  ```

### GitHub Copilot CLI

- Register the marketplace:

  ```bash
  copilot plugin marketplace add obra/superpowers-marketplace
  ```

- Install the plugin:

  ```bash
  copilot plugin install superpowers@superpowers-marketplace
  ```

### Kimi Code

Superpowers is available in Kimi Code's plugin marketplace.

- Open Kimi Code's plugin manager:

  ```text
  /plugins
  ```

- Go to `Marketplace` > `Superpowers` and install it.

- Or install directly from this repository:

  ```text
  /plugins install https://github.com/obra/superpowers
  ```

- Detailed docs: [docs/README.kimi.md](docs/README.kimi.md)

### OpenCode

OpenCode uses its own plugin install; install Superpowers separately even if you
already use it in another harness.

- Tell OpenCode:

  ```
  Fetch and follow instructions from https://raw.githubusercontent.com/obra/superpowers/refs/heads/main/.opencode/INSTALL.md
  ```

- Detailed docs: [docs/README.opencode.md](docs/README.opencode.md)

### Pi

Install Superpowers as a Pi package from this repository:

```bash
pi install git:github.com/obra/superpowers
```

For local development, run Pi with this checkout loaded as a temporary package:

```bash
pi -e /path/to/superpowers
```

The Pi package loads the Superpowers skills and a small extension that injects the `using-superpowers` bootstrap at session startup and again after compaction. Pi has native skills, so no compatibility `Skill` tool is required. Subagent and task-list tools remain optional Pi companion packages.

## The Basic Workflow

1. **brainstorming** - When a design discussion is useful, asks questions, explores alternatives, and presents a design for review. Implementation follows user approval; for visual comparisons, the local companion is offered and starts only after the user accepts.

2. **using-git-worktrees** - When isolation is useful, the skill asks for consent unless the user already stated a preference. It can use native worktree support or Git worktrees; working in place is also an option.

3. **writing-plans** - With an approved design, guides the agent to create bite-sized tasks (2-5 minutes) with file paths and verification steps.

4. **subagent-driven-development** or **executing-plans** - For independent tasks and supported harnesses, the agent may delegate work with review steps. Otherwise, it can execute the plan in batches with human checkpoints.

5. **test-driven-development** - Guides the RED-GREEN-REFACTOR cycle: write a failing test, verify the failure, make the smallest change, and verify it passes. Commit choices are handled by the plan/branch workflow rather than required for each TDD cycle.

6. **requesting-code-review** - Guides review of changes against the plan and reports findings by severity; important or critical findings should be addressed before continuing.

7. **finishing-a-development-branch** - Guides verification and presents merge/PR/keep/discard options. Worktree cleanup depends on that choice: merge/discard clean up; PR/keep preserve the worktree.

**In Claude Code, the SessionStart bootstrap asks the agent to check for relevant skills.** Skill invocation and tool actions depend on the model, available harness features, and permissions; they are not enforced gates.

## What's Inside

### Skills Library

**Testing**
- **test-driven-development** - RED-GREEN-REFACTOR cycle (includes testing anti-patterns reference)

**Debugging**
- **systematic-debugging** - 4-phase root cause process (includes root-cause-tracing, defense-in-depth, condition-based-waiting techniques)
- **verification-before-completion** - Ensure it's actually fixed

**Collaboration** 
- **brainstorming** - Socratic design refinement
- **writing-plans** - Detailed implementation plans
- **executing-plans** - Batch execution with checkpoints
- **dispatching-parallel-agents** - Concurrent subagent workflows
- **requesting-code-review** - Pre-review checklist
- **receiving-code-review** - Responding to feedback
- **using-git-worktrees** - Parallel development branches
- **finishing-a-development-branch** - Merge/PR decision workflow
- **subagent-driven-development** - Fast iteration with two-stage review (spec compliance, then code quality)

**Meta**
- **writing-skills** - Create new skills following best practices (includes testing methodology)
- **using-superpowers** - Introduction to the skills system

## Philosophy

- **Test-Driven Development** - Write tests first, always
- **Systematic over ad-hoc** - Process over guessing
- **Complexity reduction** - Simplicity as primary goal
- **Evidence over claims** - Verify before declaring success

Read [the original release announcement](https://blog.fsck.com/2025/10/09/superpowers/).

## Contributing

The general contribution process for Superpowers is below. Keep in mind that we don't generally accept contributions of new skills and that any updates to skills must work across all of the coding agents we support.

1. Fork the repository
2. Switch to the 'dev' branch
3. Create a branch for your work
4. Follow the `writing-skills` skill for creating and testing new and modified skills
5. Submit a PR, being sure to fill in the pull request template.

Skill-behavior tests use the drill eval harness from [superpowers-evals](https://github.com/prime-radiant-inc/superpowers-evals/), cloned into `evals/` — see `evals/README.md` for setup. Plugin-infrastructure tests live at `tests/` and run via the relevant `run-*.sh` or `npm test`.

See `skills/writing-skills/SKILL.md` for the complete guide.

## Updating

Superpowers updates are somewhat coding-agent dependent, but are often automatic.

## License

MIT License - see LICENSE file for details

## Optional visual companion and data handling

Claude Code handles prompts and project context under its own service settings and
privacy terms. Superpowers skills can guide Claude to use local shell/Git tools, inspect
or edit project files, and launch subagents; those actions use the harness and any
services configured or approved for the session.

The brainstorming visual companion is optional; the skill offers it only for a useful
visual comparison and starts it after the user accepts. It runs a local HTTP/WebSocket
server and serves screens written to a local session directory. With `--project-dir`,
screens and state are kept under `<project>/.superpowers/brainstorm/<session>/`; without
it, they are stored under `/tmp/brainstorm-<session>/` and the session directory is
removed when the server is stopped. A new screen clears the local event file. The server
binds to loopback by default; if configured for a network-reachable address, hosts that
can reach it and obtain the session URL/key may access it.

The companion URL contains a session key and may appear in process arguments, local
startup output, and agent transcripts. Treat it as sensitive and avoid sharing it.

The browser sends selected choice text and metadata to the local server, which logs
events and stores choice events locally. The page may also request the Prime Radiant
logo from
`https://primeradiant.com/brand/superpowers-visual-brainstorming-logo.png?v=<version>`.
This image URL includes the companion's resolved Superpowers version, not prompt or
project text; the remote host may receive ordinary request metadata. Set
`SUPERPOWERS_DISABLE_TELEMETRY=1`, `DISABLE_TELEMETRY=1`, or
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` to suppress the image request only; the
local companion still works. The repository does not specify the image host's logging
or retention practices.

The skills also contain ordinary external links and a reference document with remote
image markup. Opening a link or rendering that document may cause the client to request
those resources; this is separate from the companion's versioned logo request.

## Community

Superpowers is built by [Jesse Vincent](https://blog.fsck.com) and the rest of the folks at [Prime Radiant](https://primeradiant.com).

- **Discord**: [Join us](https://discord.gg/35wsABTejz) for community support, questions, and sharing what you're building with Superpowers
- **Issues**: https://github.com/obra/superpowers/issues
- **Release announcements**: [Sign up](https://primeradiant.com/superpowers/) to get notified about new versions
