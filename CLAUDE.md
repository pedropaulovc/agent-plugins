## Plugins

- Any changes to plugin code must also bump the plugin's version in its `plugin.json`, NOT the marketplace version.
- When bumping the **superpowers** plugin version, also run:
  ```
  python3 plugins/superpowers/hooks/build-hooks.py
  ```
  This bakes the current `skills/using-superpowers/SKILL.md` into `hooks/hooks.json`.
- When bumping any Rust-hook plugin version (**windows-bash-guard**, **unrelated-issue-detector**, **mediocrity-detector**, **powershell-autofix**), also rebuild the hook binary:
  ```
  python3 plugins/<plugin>/hooks/build-hooks.py
  ```
  Cross-compiles the Rust binary for Linux x86_64 and Windows x86_64.