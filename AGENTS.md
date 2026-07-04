## Plugins

- Any changes to plugin code must also bump the plugin's version in its `plugin.json`, NOT the marketplace version.
- When adding a new plugin (or renaming/removing one), also update the "All plugins" table in `README.md` to keep it in sync with `.claude-plugin/marketplace.json`. Skip this only if the user explicitly says so.
- When bumping the **superpowers** plugin version, also run:
  ```
  python3 plugins/superpowers/hooks/build-hooks.py
  ```
  This bakes the current `skills/using-superpowers/SKILL.md` into `hooks/hooks.json`.
- When bumping any Rust-hook plugin version (**windows-bash-guard**, **unrelated-issue-detector**, **mediocrity-detector**), also rebuild the hook binary:
  ```
  python3 plugins/<plugin>/hooks/build-hooks.py
  ```
  Cross-compiles the Rust binary for Linux x86_64 and Windows x86_64.