# Privacy policy: gstack-entrepreneur

This plugin contains four model-instruction skills and a small OpenCode command-registration plugin. It does not install a background service, run a bundled research client, or send usage telemetry.

## Information processed

When a skill is used, the configured host model processes the user's prompt and any project documents the agent reads through host tools. `/office-hours` can write a design document; `/ceo-review` can read or update a plan; `/market-research` can write a research brief after the user approves it; `/autoplan` can make a pre-review restore copy and update a working document. These files are written through the host's local workspace tools. They may be shared later if the user commits or otherwise syncs them.

The research skills use the host's `WebSearch` integration. Search terms are sent to the search provider, and returned web results or pages are processed by the configured tools and model. The skills ask for generalized category terms rather than a confidential product name or stealth idea unless the user explicitly permits that disclosure. A user should still review proposed queries and avoid sharing sensitive material without consent.

Independent reviews use the host harness's subagent mechanism, not another vendor's command-line client. The relevant plan text and phase brief sent to a reviewer are available to the model or models selected by that harness.

## Plugin storage and other destinations

The plugin has no plugin-managed database, transcript store, analytics, or direct network client. Search providers, model providers, subagents, and web sources used by the host may receive the information described above under their own terms. The plugin author does not receive that information through this package. Check the privacy terms for the host and integrations you configure before using proprietary plans or ideas.
