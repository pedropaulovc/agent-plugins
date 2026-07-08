## Plugins

- Any changes to plugin code must also bump the plugin's version in its `plugin.json`, NOT the marketplace version. Plugins that also ship a `.codex-plugin/plugin.json` (all except `no-fetch`) must keep that manifest's `version` in sync with `.claude-plugin/plugin.json`.
- When adding a new plugin (or renaming/removing one), also update the "All plugins" table in `README.md` and BOTH marketplace files — `.claude-plugin/marketplace.json` (Claude Code) and `.agents/plugins/marketplace.json` (Codex; omit `no-fetch`) — to keep them in sync. Skip this only if the user explicitly says so.
- When bumping the **superpowers** plugin version, also run:
  ```
  python3 plugins/superpowers/hooks/build-hooks.py
  ```
  This bakes the current `skills/using-superpowers/SKILL.md` into `hooks/hooks.json`.
- When bumping any Rust-hook plugin version (**windows-bash-guard**, **unrelated-issue-detector**, **mediocrity-detector**, **command-chain-separator**, **playwright-cli-headed**), also rebuild the hook binary:
  ```
  python3 plugins/<plugin>/hooks/build-hooks.py
  ```
  Cross-compiles the Rust binary for Linux x86_64 and Windows x86_64.