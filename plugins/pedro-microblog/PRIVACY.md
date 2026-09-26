# Privacy policy: pedro-microblog

## What the plugin does

The plugin ships a static writing-style skill and an OpenCode adapter that adds the skill directory to the host configuration. The skill drafts or edits post text from the user's prompt and supplied context. It instructs the model not to fetch social accounts and does not publish content.

## Information and destinations

When used in Claude, the user's prompts, draft text, and contextual details are part of the ordinary Claude request and are processed by Anthropic under the user's normal service and account settings. With another coding-agent host, those inputs and generated responses follow that host's and configured model provider's normal data practices.

The plugin itself makes no network requests, accesses no platform credentials, and sends no text to X, Threads, Mastodon, or Bluesky. It contains a distilled style guide rather than an archive of posts. Separate maintainer downloaders mentioned in the README are outside this plugin and are not loaded or invoked by the drafting skill; their data handling is not covered by this policy. Any later copying or posting of generated text is a separate user action.
