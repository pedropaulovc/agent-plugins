# Privacy policy: omp-persist-system-prompt

## What the extension processes

This is an Oh My Pi extension, activated through the `omp.extensions` entry in the package's `package.json`. It listens for OMP session lifecycle, agent-start, and provider-request events. On a capture, it reads the current effective system-prompt string array and inspects only the following top-level provider payload keys: `instructions`, `system`, `systemInstruction`, `system_instruction`, `tools`, `toolConfig`, and `tool_config`. It recursively clones JSON-compatible values for the snapshot. It does not persist provider message arrays or ordinary conversation input from the provider payload.

## Storage and data destinations

The extension appends an `omp-system-prompt` custom entry containing the prompt and any nonempty selected provider context to the active OMP session branch via the OMP session manager. It deduplicates identical snapshots and keeps only an in-memory comparison cache while the session is active. It creates no separate file, makes no network request, and reads no credentials. The extension's custom session metadata is retained, exported, or synchronized according to the OMP host's own session-storage behavior; the extension does not control those policies.

System prompts and tool descriptions may contain private project instructions, user-provided context, or other sensitive text. Anyone with access to the OMP session transcript or its exports may be able to read the stored snapshot; it is not encrypted or redacted by this plugin. OMP's ordinary inference request also sends its prompt and provider context to whichever model provider the host is configured to use. The extension does not initiate an additional request to Anthropic or another provider. The Claude plugin manifest in this package does not register the OMP extension as a Claude hook or skill.
