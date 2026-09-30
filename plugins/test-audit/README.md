# test-audit — draft

Version `0.1.0-draft.1`. This standalone skill combines OpenClaw's test-value/campaign discipline and gstack's assertion-oracle review in an original, portable procedure. It does not import gstack runtime code or dependencies and is not marked ready for production cleanup.

Invoke `/test-audit` in Claude Code/OpenCode or `$test-audit` in Codex. Specify the checkout, focused or full scope, and an external report directory. For example: “Full report-only test audit of this checkout; save timestamped Markdown and JSON in the sibling audit-reports directory.” The skill is explicit-only in Claude/Codex and available as an OpenCode command.

**Report-only is the default.** A full sweep inventories every first-party test and owned QA/proof case, gives each declaration an evidence-backed verdict or unresolved row, and reconciles the raw candidate universe plus fixed declarations/parameter rows before any verdict grouping. Reports distinguish static coverage, resolved review, runtime proof, and full-sweep completion. Audit workers remain parse-only. Any authorized execution first passes host-safety inspection and uses owned scratch or demonstrably redirected writes; unsafe execution is not-run, not pass. Reports use Windows-safe filenames outside the audited checkout.

Deletion/fix/consolidation proposals are not edit permission. Cutover requires explicit owner-boundary authorization, complete retirement cards, migrated keeper coverage, safe scratch validation, and independent preservation review. Repository restrictions on source-text tests override generic static-contract retention. The skill never authorizes a SOLIDWORKS seat or host actions.

- [Procedure](skills/test-audit/SKILL.md)
- [Report field contract](skills/test-audit/REPORT.md)

## Source attribution

Original synthesis informed by these pinned sources, not a vendored copy:

- OpenClaw, commit `80930af448ebabc84174146b56bc106d37fab3b4`: [test-audit skill](https://github.com/openclaw/openclaw/blob/80930af448ebabc84174146b56bc106d37fab3b4/.agents/skills/test-audit/SKILL.md) and [CAMPAIGN](https://github.com/openclaw/openclaw/blob/80930af448ebabc84174146b56bc106d37fab3b4/.agents/skills/test-audit/CAMPAIGN.md).
- gstack, commit `96764e80a641e28141ec8297223768029f5bf483`: [template](https://github.com/garrytan/gstack/blob/96764e80a641e28141ec8297223768029f5bf483/test-audit/SKILL.md.tmpl) and [expanded skill](https://github.com/garrytan/gstack/blob/96764e80a641e28141ec8297223768029f5bf483/test-audit/SKILL.md).

No upstream command recipes are required. Detect the repository's runners, analysis tools and platform instead.
