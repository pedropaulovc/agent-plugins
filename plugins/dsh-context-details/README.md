# dsh-context-details plugin

![Context Details plugin icon](icon.svg)

This package provides a DeepSeek Harness (DSH) profile bundle that replaces the composer's context usage menu with the same ring and percentage, extended with per-item token estimates. It is loaded through the `dsh` field in `package.json`; the Claude and Codex plugin manifests describe the package for those marketplaces but do not register a hook or skill, so installing them alone does not run the plugin in Claude Code or Codex.

## What the menu shows

- The shipped header: percentage used, `~used / window`, and the three-segment bar.
- The shipped three category rows: system prompt, tool definitions, and messages.
- **Tool definitions** — one row per model-visible tool schema with its estimated token cost, largest first, plus the item count and subtotal.
- **Skills** — one row per entry of the newest available-skills catalog with its estimated token cost, largest first, plus the item count and subtotal.

Both detail lists scroll independently, so a session with dozens of tools keeps a bounded menu. The panel labels the category rows as heuristic estimates; the header total is provider-reported and is not expected to equal their sum.

## How the figures are computed

The Host half registers one client-visible session projection, `contextDetails`, folding the durable session log:

- `request/header` events supply the tool schemas of the newest request. The aggregate is `ceil(JSON.stringify(tools).length / 4) + 4` — exactly the number the shipped breakdown shows for tool definitions — and it is split across the tools with the largest-remainder method, so the per-tool rows sum to the aggregate instead of drifting from rounding.
- `user/message` events whose source is the skill catalog supply the advertised skills. Each entry is priced by the exact `- \`name\`: description` line it renders as, with the catalog frame's escaping applied.
- A replacement whose cited source events include the catalog clears the skill rows until the next catalog is published, so a compacted session does not keep advertising skills that left the surface. Surface order, not sequence order, defines a replacement range, and the Session contract requires every shadowed node to be cited.

Both lists use the four-characters-per-token heuristic the rest of the harness uses, so the figures are comparisons rather than provider billing.

## Replacement strategy and limits

The shipped meter lives inside `dsh-client-ui-conversation` and exposes no plugin slot, so this bundle registers its meter in `conversation.composer.dock` and hides the shipped one: it looks for a dock button with `aria-haspopup="dialog"` whose text is a bare percentage, never one of its own (marked with `data-context-details-trigger`), hides that control's dock-level container, and restores it when the plugin unloads. The sweep only touches its own composer dock, never hides the slot outlet's `data-slot` anchor, and skips any container that also holds a second control, so a future layout that groups controls cannot take them down with the meter. A `MutationObserver` re-applies the hide if React replaces the node. If the shipped marker changes, the failure mode is a duplicate ring, never a hidden control.

The replacement is installed in the composer dock only, so the new-session hero and the rest of the composer keep the shipped layout. When the Host projection is unavailable, the panel degrades to exactly the shipped menu.

## Install

DSH loads plugins as profile bundles:

1. Clone this repository.
2. In DSH, open **Settings → Plugins → Add plugin** and enter the absolute path to `plugins/dsh-context-details`.
3. Remove it from the same page to return to the shipped menu.

The install also works through the agent-facing `plugin_manager` tool with `install_bundle` and the same path. Client code reloads through DSH's client HMR; host-side changes need an app restart to load a fresh module generation.

## Data handling

The plugin reads the active session log already in the harness and renders counts locally; it makes no network requests and adds no telemetry. See [PRIVACY.md](PRIVACY.md).

## Development

The projection contract tests run with Node alone:

```bash
node --test plugins/dsh-context-details/tests/context-details.test.mjs
```

Maintainer notes:

- Keep `package.json`, `.claude-plugin/plugin.json`, and `.codex-plugin/plugin.json` at the same version; CI compares all three.
- Do not install a second copy of this plugin into one DSH profile. Each instance registers its own meter, so two copies render two rings; the earlier install must be removed first.
- The projection's `stateVersion` starts at `1`; bump it whenever the folded state shape or semantics change, so cached rows refold instead of being reused.

- [Plugin source](index.js) — Host projection
- [Client source](client.js) — meter and panel
- [Documentation](https://github.com/pedropaulovc/agent-plugins/tree/main/plugins/dsh-context-details)
- [Privacy policy](PRIVACY.md)
