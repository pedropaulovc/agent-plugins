# pedro-microblog plugin

A single cooked writing skill for Pedro Paulo Vezza Campos's microblog voice.
It is grounded in the observed English/Portuguese mix, cadence, punctuation,
technical specificity, dry humor, and authentic rough edges.

## Included

The installable payload is `skills/pedro-microblog-style/SKILL.md`. It gives
the model enough instruction to draft or edit posts for X, Threads, Mastodon,
and Bluesky without copying a corpus of private or deleted posts.

The guide is not a generic social-media template. It says when to use short
replies, fragments, links, Portuguese asides, blunt civic language, technical
nouns, and deliberate roughness. It fixes accidental errors by default and
only reproduces known typos when the user explicitly asks for archival
fidelity.

## Maintainer updates

The occasional account downloaders used to refresh the cooked guide live
outside the plugin under `tools/pedro-microblog/`. They are not registered as
skills or commands and are not needed when drafting. They use:

- X/Twitter `@pedrovc` with the token in `/tmp/twitterapi.env`;
- Threads `@pedropaulovc` through a headed persistent `playwright-cli` session;
- Mastodon `@pedrovc@mastodon.social`;
- Bluesky `pedro.vza.net`.

Generated archives and browser state stay outside the installable plugin.
Downloader results are source-index snapshots, not a guarantee of every
deleted, private, withheld, or historically unindexed post.

## License

MIT
