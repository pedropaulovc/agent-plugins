# Privacy policy — dsh-context-details

This plugin runs entirely inside the local DeepSeek Harness process and the browser page it serves. It makes no network requests, uses no third-party services, and adds no telemetry or analytics.

## What it reads

- The current Session's own event log, already stored by the harness, to price tool schemas and skill catalog entries.
- The `contextPressure` and `contextBreakdown` projections the harness already computes, for the ring, percentage, and category rows.

## What it stores

The plugin registers a session projection named `contextDetails`. Its state is the list of tool names and skill names with their heuristic token counts, and it is cached by the harness's existing session-projection cache alongside the harness's other projection state. The plugin adds no storage of its own and sends nothing outside the machine.

## What it does not do

- No conversation content, prompts, or tool results are copied into a separate store.
- The browser UI renders names and counts only; it adds no third-party scripts or styles.
- Uninstalling the plugin removes its projection from the composition; the cached rows for that key are then simply unused.

Tool and skill names can still reveal project structure, and the harness's ordinary model provider and telemetry settings apply to the Session as usual.
