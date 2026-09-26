# alt-text plugin

![Alt Text plugin icon](./icon.svg)

Provides the `alt-text` skill: writes alt text for images about to be posted on social media (Twitter/X, Bluesky, Instagram, LinkedIn, Mastodon, Threads, Facebook), following accessibility best practices on length, detail, and tone.

**Why:** default AI alt text fails by being exhaustive but pointless — "A young woman with long brown hair wearing a denim jacket stands in front of a beige wall holding a coffee cup..." That's not alt text, that's a deposition. The skill reframes every image around the question *"if this image disappeared, what would the post lose?"* and writes accordingly.

**What it bakes in:**
- Platform character guidance includes Bluesky (2,000), Mastodon (1,500), X/Twitter (1,000), LinkedIn (120), and Instagram (~125 visible); it aims for roughly 1,000 characters by default, recommends shorter text for LinkedIn/Instagram, and does not specify Threads or Facebook limits
- Mandatory transcription of any text visible in the image — memes, tweet screenshots, chart labels, slide titles
- Takeaway-first phrasing for charts and data viz
- Anti-patterns to avoid: "Image of…" prefixes, hedging ("appears to be"), editorializing ("beautiful", "stunning"), assigning identity from appearance, SEO keywords/hashtags
- Person-description rules: avoid inferring gender, race, age, or other identity attributes unless relevant to the post or supplied by the user; describe observable expression rather than inferred emotion; name public figures or people identified by the post when relevant
- Per-image-type guidance covers text screenshots, memes, charts, selfies and portraits, group photos, landscapes, food, art, products, multi-panel images, and animals

**Triggers on:** the user sharing an image with requests like "alt text", "alt", "image description", "a11y description", "screen reader description", or posting/sharing phrasing like "for my Bluesky post" or "about to tweet this" — even when the request is minimal (just "alt?").

**Does not trigger on:** requests to understand an image for the user themselves ("what's in this picture?") or requests for visible captions rather than alt text.

## Codex and OpenCode support

Works in Claude Code, Codex, and OpenCode — a plain instruction skill with no harness-specific behavior. OpenCode also exposes `/alt-text`.

## Data handling

This plugin provides instructions, not an image-processing or publishing service. In Claude Code, the image and any post text or platform details you share are sent to Claude as part of the conversation; Claude handles them under the privacy and retention controls for your account. The skill returns suggested alt text in that conversation and does not post it. Posting through other tools or social networks is a separate action governed by those services.

## Documentation and support

- [Documentation](https://go.vza.net/agent-plugins/alt-text/docs)
- [Support](https://go.vza.net/agent-plugins/alt-text/support)
- [Privacy policy](https://go.vza.net/agent-plugins/alt-text/privacy)
