## Plugins

- Any changes to plugin code must also bump the plugin's version in its `plugin.json`, NOT the marketplace version. Plugins that also ship a `.codex-plugin/plugin.json` (all except `no-fetch`) must keep that manifest's `version` in sync with `.claude-plugin/plugin.json`.
- When adding, renaming, or removing a plugin, update the "All plugins" table in `README.md` and both marketplace files: `.claude-plugin/marketplace.json` for Claude Code and `.agents/plugins/marketplace.json` for Codex. Omit `no-fetch` from the Codex marketplace. Skip these updates only if the user explicitly says so.
- A skill marked `disable-model-invocation: true` in Claude Code must also ship `skills/<name>/agents/openai.yaml` with `policy.allow_implicit_invocation: false` when the plugin is exposed to Codex. Codex ignores the Claude frontmatter and enables implicit invocation by default. This rule currently applies to `worktree-reset/reset`, `gh-issue/issue`, and `pr-comments/comments`.
- When bumping the `superpowers` plugin version, also run:
  ```
  python3 plugins/superpowers/hooks/build-hooks.py
  ```
  This bakes the current `skills/using-superpowers/SKILL.md` into `hooks/hooks.json`.
- When bumping any Rust hook plugin version (`windows-bash-guard`, `unrelated-issue-detector`, `mediocrity-detector`, `command-chain-separator`, `playwright-cli-headed`, or `memory-to-repo`), also rebuild the hook binary:
  ```
  python3 plugins/<plugin>/hooks/build-hooks.py
  ```
  Cross-compiles the Rust binary for Linux x86_64 and Windows x86_64.

## Documentation boundaries

- Keep `README.md` focused on installation, user-visible behavior, and the plugin inventory.
- Put maintainer-only design constraints and implementation details in this file or the affected plugin's documentation.
- Keep the brief descriptions in the "All plugins" table consistent with the detailed behavior below.
- `no-fetch` is absent from the Codex marketplace because Codex exposes web access through a hosted `web_search` tool that hooks cannot intercept.

## Plugin implementation notes

### Stop hooks

- `mediocrity-detector` is a Rust `Stop` hook. It scans the current turn for hedging, blocks the stop, and asks the agent to report each assumption explicitly.
- `unrelated-issue-detector` is a Rust `Stop` hook. It detects dismissals of findings as unrelated or pre-existing, blocks the stop, and asks for evidence for each dismissal.

### SolidWorks

- `developing-solidworks` is the direct SolidWorks .NET COM API workflow skill in this collection.
- Many SolidWorks methods accept 10 to 30 positional `bool`, `int`, or `double` arguments. The skill requires named arguments because a changed Boolean can silently alter behavior.
- Preserve its documentation-first workflow, offline API references, COM interop patterns, and guidance for known failures such as `FeatureCut4` returning null, failed extrusions, and faulty geometry detection.
- `/download-solidworks-docs` downloads the offline API documentation into the skill directory.
- `developing-solidworks-mcp` provides structured XMLDoc search, catalog browsing, and type, enum, example, and guide retrieval. Users should install it instead of `developing-solidworks` when they need structured lookup. The two plugins should not be installed together.

### Alt text

- `alt-text` favors the information a post would lose without the image over exhaustive visual description.
- Preserve its platform limits: Bluesky 2,000 characters, Mastodon 1,500, X 1,000, and LinkedIn 120.
- Transcribe visible text such as memes, post screenshots, and chart labels. Lead with the takeaway for charts.
- Do not infer identity from appearance or add editorial judgments such as "beautiful" or "stunning."

### OMP persistence

- `omp-persist-system-prompt` stores each distinct effective system prompt and provider tool context as hidden custom session metadata for transcript indexing.

### Interactive authentication tooling

- `onepassword` establishes the interactive `op` session through tmux when service-account authentication fails.
