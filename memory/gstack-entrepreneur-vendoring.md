---
name: gstack-entrepreneur-vendoring
description: How the gstack-entrepreneur plugin is vendored from upstream gstack, incl. base version, forks, and re-vendor mechanics
metadata:
  type: project
---

`plugins/gstack-entrepreneur/` is a hand-adapted, code-stripped distillation of Garry Tan's **gstack** (github.com/garrytan/gstack). It vendors 4 skills, each a self-contained `SKILL.md` (no build step, no `sections/`, no boilerplate). Charter: "entrepreneurship toolkit, no code, just thinking."

**Skill mapping (vendored ← upstream):**
- `office-hours` ← `office-hours`
- `ceo-review` ← `plan-ceo-review`
- `market-research` ← `design-consultation` (**fork**: took only the research methodology — three-layer synthesis + eureka detection — and dropped the entire design-system output half: typography/color/layout/HTML-CSS previews)
- `autoplan` ← `autoplan` (**fork**: vendored runs a *business* pipeline = ceo-review + market-research + product review; upstream runs a *code-plan* pipeline CEO→Design→Eng→DX pulling in plan-eng-review/plan-devex-review/plan-design-review, which this plugin deliberately excludes)

**Removed (v0.3.0):** the `codex` skill (← upstream `codex`) shelled out to `codex exec` for a cross-model second opinion. Superseded by harnesses that let you pick the agent type and model per subagent dispatch (Oh My Pi, Claude Code subagent types), which is strictly better: no second CLI, no auth, no recursive-self-call detection. Its methodology was folded into `office-hours` Phase 3.5, `ceo-review` Step 8, and a new `autoplan` "The Independent Second Opinion" section — adversarial brief, `RECOMMENDATION: [action] because [reason]` close, "a refusal is never completion", weigh same-family agreement less, CONFIRMED requires two voices. Each dispatch site tells the model to select a different model family when the harness exposes that control.

**Vendoring bases:** originally upstream **v0.13.1.0** (`7450b516`, 2026-03-28). Re-vendored against **v1.58.5.0** (`11de390`, 2026-06-25), then **v1.87.0.0** (`4a3c6a8`, 2026-09-14).

**Upstream build model (matters when re-vendoring):** the authored source is `SKILL.md.tmpl` + a `sections/` dir (e.g. `office-hours/sections/design-and-handoff.md`); the committed `SKILL.md` is a *built bundle* that inlines shared boilerplate (telemetry, update-check, model overlays, plan-status footer, gstack-config). Diff `.tmpl` + `sections/`, NOT the built `SKILL.md`, or the diff drowns in the boilerplate this plugin strips.

**Re-vendor procedure that worked:** unshallow the local gstack clone at `~/.claude/skills/gstack` (`git fetch --unshallow --filter=blob:none`), find the base-version commit, then per-skill compare base `.tmpl` → HEAD `.tmpl`+`sections/` and fold on-theme non-code methodology changes into the vendored file (one analysis subagent per skill works well). Strip: telemetry, session tracking, update checks, browse/gstack bins, gstack-config, contributor mode, plan-status footer, code-review sections, diagrams, CI/CD, git/deploy, security auditing, model-overlay boilerplate.

**Reassessment (v1.87.0.0):** upstream added exactly one new skill directory since v1.58.5.0 — `claude-code/` (v1.86.0.0, "route outside reviews by harness"). On-theme in purpose (mirror of `codex` for non-Claude hosts) but not vendorable: every mode shells `bin/gstack-claude-code` and imports `lib/outside-review-result.ts`, and review/challenge are `git diff` code review. Rejected; moot anyway after the `codex` removal. A full sweep of the other 47 non-vendored skills at HEAD found 0 on-charter and 2 borderline (`plan-design-review`, `plan-devex-review`); closest miss is `plan-design-review`, whose surviving core largely duplicates `autoplan` Phase 3 and `market-research`. `spec` re-checked, still files GitHub issues and spawns worktree agents. Nothing new brought in. Also note the v1.58→v1.87 `sections/` explosion is mostly verbatim extraction from `SKILL.md.tmpl`: office-hours' two new section files were byte-identical moves.

Per repo `AGENTS.md`: bumping a plugin's code requires bumping its own `plugin.json` version (not the marketplace), and updating the README "All plugins" table only if a plugin is added/renamed/removed.
