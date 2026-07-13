# alt-text plugin

Provides the `alt-text` skill: writes alt text for images about to be posted on social media (Twitter/X, Bluesky, Instagram, LinkedIn, Mastodon, Threads, Facebook), following accessibility best practices on length, detail, and tone.

**Why:** default AI alt text fails by being exhaustive but pointless — "A young woman with long brown hair wearing a denim jacket stands in front of a beige wall holding a coffee cup..." That's not alt text, that's a deposition. The skill reframes every image around the question *"if this image disappeared, what would the post lose?"* and writes accordingly.

**What it bakes in:**
- Platform character budgets (Bluesky 2,000, Mastodon 1,500, X/Twitter 1,000, LinkedIn 120, Instagram ~125 visible) with a 1,000-character default that fits everywhere except LinkedIn/Instagram
- Mandatory transcription of any text visible in the image — memes, tweet screenshots, chart labels, slide titles
- Takeaway-first phrasing for charts and data viz
- Anti-patterns to avoid: "Image of…" prefixes, hedging ("appears to be"), editorializing ("beautiful", "stunning"), assigning identity from appearance, SEO keywords/hashtags
- Person-description rules: don't infer gender/race/age, describe expression not inferred emotion, name known people only when the post identifies them
- Per-image-type guidance: screenshots of text, memes, charts, selfies, group photos, art, product shots, photos with embedded text

**Triggers on:** the user sharing an image with requests like "alt text", "alt", "image description", "a11y description", "screen reader description", or posting/sharing phrasing like "for my Bluesky post" or "about to tweet this" — even when the request is minimal (just "alt?").

**Does not trigger on:** requests to understand an image for the user themselves ("what's in this picture?") or requests for visible captions rather than alt text.

## Codex and OpenCode support

Works in Claude Code, Codex, and OpenCode — a plain instruction skill with no harness-specific behavior. OpenCode also exposes `/alt-text`.
