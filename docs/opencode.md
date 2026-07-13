# OpenCode support

Every plugin in this repository has an OpenCode entry point. The repository root is
also an aggregate package that exports all 16 plugins.

## Install all plugins

Add the Git-backed package to the `plugin` array in your global or project
`opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "agent-plugins@git+https://github.com/pedropaulovc/agent-plugins.git"
  ]
}
```

Restart OpenCode. Git-backed packages are cached by OpenCode, so clear the matching
entry under `~/.cache/opencode/node_modules/` when testing an unpublished update.

## Install selected plugins

For a selective development install, clone this repository and reference one or more
plugin package directories with absolute `file:` specs:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "alt-text@file:///absolute/path/to/agent-plugins/plugins/alt-text",
    "memory-to-repo@file:///absolute/path/to/agent-plugins/plugins/memory-to-repo"
  ]
}
```

Each plugin directory contains its own `package.json` and
`.opencode/plugins/<name>.js` entry point.

## Compatibility mapping

| Plugin shape | OpenCode integration |
|---|---|
| Skills | Registers the plugin's `skills/` directory through the `config` hook |
| Slash commands | Registers an OpenCode command that loads the equivalent skill |
| `PreToolUse` rewrite | Mutates `output.args` in `tool.execute.before` |
| `PreToolUse` deny | Throws from `tool.execute.before` with the existing reason |
| Advisory hook context | Appends the notice to tool output in `tool.execute.after` |
| `SessionStart` context | Adds the existing generated memory context to the system prompt |
| `Stop` detector | Scans the completed turn on `session.idle` and submits one synthetic corrective prompt |
| PR monitor | Runs `watch-pr.sh` in the plugin and sends batched stdout events to the originating session with `promptAsync` |

The Rust-hook plugins ship Linux x86_64 and Windows x86_64 binaries. On other native
platforms their adapters fail open. Skill-only plugins work anywhere OpenCode runs.

OpenCode ignores Claude-only skill frontmatter such as `allowed-tools` and
`disable-model-invocation`. Explicit-only skills retain that requirement in their
instructions, but OpenCode cannot currently hide a skill from automatic selection
while also leaving it available for explicit invocation.
