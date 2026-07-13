# OpenCode support

Every plugin in this repository is published as its own npm package. The repository
root is also a Git-backed aggregate package that exports all 16 plugins.

OpenCode 1.17.18 or newer is required. The adapters register bundled skill directories
through the live `skills.paths` config and rely on in-place `tool.execute.before`
argument mutation behavior from that runtime line.

## Install one plugin

Use OpenCode's package installer and the plugin name from the README table:

```bash
opencode plugin --global @pedropaulovc/watch-pr
```

`--global` writes to the global OpenCode config. Omit it to install the plugin only
for the current project. Restart OpenCode after installation.

You can also add packages directly to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@pedropaulovc/alt-text",
    "@pedropaulovc/memory-to-repo"
  ]
}
```

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

## Local development

To test unpublished changes, clone this repository and reference one or more
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
