---
name: gstack-entrepreneur-vendoring
description: How the gstack-entrepreneur plugin is vendored from upstream gstack, incl. base version, forks, and re-vendor mechanics
metadata:
  type: project
---

`plugins/gstack-entrepreneur/` is a hand-adapted, code-stripped distillation of Garry Tan's **gstack** (github.com/garrytan/gstack). It vendors 5 skills, each a self-contained `SKILL.md` (no build step, no `sections/`, no boilerplate). Charter: "entrepreneurship toolkit, no code, just thinking."

**Skill mapping (vendored ← upstream):**
- `office-hours` ← `office-hours`
- `ceo-review` ← `plan-ceo-review`
- `market-research` ← `design-consultation` (**fork**: took only the research methodology — three-layer synthesis + eureka detection — and dropped the entire design-system output half: typography/color/layout/HTML-CSS previews)
- `autoplan` ← `autoplan` (**fork**: vendored runs a *business* pipeline = ceo-review + market-research + product review; upstream now runs a *code-plan* pipeline CEO→Design→Eng→DX pulling in plan-eng-review/plan-devex-review/plan-design-review, which this plugin deliberately excludes)
- `codex` ← `codex` (keep the Codex CLI invocation; keep subject = strategy/ideas/plans, not code diffs)

**Original vendoring base:** upstream gstack **v0.13.1.0** (commit `7450b516`, 2026-03-28). First re-vendor done against **v1.58.5.0** (2026-06-25).

**Upstream build model (matters when re-vendoring):** the authored source is `SKILL.md.tmpl` + a `sections/` dir (e.g. `office-hours/sections/design-and-handoff.md`); the committed `SKILL.md` is a *built bundle* that inlines shared boilerplate (telemetry, update-check, model overlays, plan-status footer, gstack-config). Diff `.tmpl` + `sections/`, NOT the built `SKILL.md`, or the diff drowns in the boilerplate this plugin strips.

**Re-vendor procedure that worked:** unshallow the local gstack clone at `~/.claude/skills/gstack` (`git fetch --unshallow --filter=blob:none`), find the base-version commit, then per-skill compare base `.tmpl` → HEAD `.tmpl`+`sections/` and fold on-theme non-code methodology changes into the vendored file (one analysis subagent per skill works well). Strip: telemetry, session tracking, update checks, browse/gstack bins, gstack-config, contributor mode, plan-status footer, code-review sections, diagrams, CI/CD, git/deploy, security auditing, model-overlay boilerplate.

**Reassessment (v1.58.5.0):** only new upstream skill since v1.55 is `diagram` — off-charter (diagram-render utility, heavy gstack-infra deps). `spec` is the nearest borderline but produces executable/code specs. gstack is skills-only (no separate "commands"). Nothing new brought in.

Per repo `AGENTS.md`: bumping a plugin's code requires bumping its own `plugin.json` version (not the marketplace), and updating the README "All plugins" table only if a plugin is added/renamed/removed.
