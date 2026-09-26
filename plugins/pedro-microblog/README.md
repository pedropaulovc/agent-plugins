# pedro-microblog plugin

![Pedro Microblog plugin icon](icon.svg)

This plugin provides a writing-style skill for drafting or editing Pedro Paulo Vezza Campos's microblog posts for X, Threads, Mastodon, and Bluesky. Its static guide describes observed language, cadence, punctuation, technical specificity, and dry humor; it is not a social-media publishing integration.

## Included behavior

The installable payload is `skills/pedro-microblog-style/SKILL.md`. It tells the model to use the user's current facts and intent, avoid invented claims, and return ready-to-paste copy. It explicitly says not to fetch social accounts while drafting. The plugin has no posting actions, platform API credentials, or automatic account fetchers. Separate maintainer downloaders are outside this plugin and are not run when the skill is used.

The style guide is distilled text, not a shipped corpus of posts. It preserves the possibility of rough phrasing but does not direct the model to force typos into new copy; archival imitation requires an explicit user request.

## Maintainer updates

Account downloaders used to refresh the cooked guide live outside this plugin under `tools/pedro-microblog/`. They are not registered skills or commands, are not needed for drafting, and have separate data flows. Generated archives and browser state are also outside the installable plugin.

## Privacy and support

When used in Claude, the user's prompt and any supplied draft or background are processed by Anthropic as part of the normal Claude request. The plugin itself contains no account fetch, publishing, or external-network behavior, and it does not send content to X, Threads, Mastodon, or Bluesky.

- [Documentation](https://go.vza.net/agent-plugins/pedro-microblog/docs)
- [Support](https://go.vza.net/agent-plugins/pedro-microblog/support)
- [Privacy policy](PRIVACY.md) · [Online privacy policy](https://go.vza.net/agent-plugins/pedro-microblog/privacy)

## License

MIT
