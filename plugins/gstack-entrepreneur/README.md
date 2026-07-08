# gstack-entrepreneur

Entrepreneurship toolkit adapted from [gstack](https://github.com/garrytan/gstack), Garry Tan's AI engineering workflow framework. Stripped of all coding tooling. Keeps the pure methodology: YC-style questioning, CEO cognitive patterns, competitive research, and multi-AI second opinions.

**Who this is for:**
- Founders validating ideas before writing code
- Product people exploring market fit
- Anyone who wants structured thinking about what to build and why

## Skills

| Skill | Your specialist | What they do |
|-------|----------------|--------------|
| `/office-hours` | **YC Office Hours** | Six forcing questions that reframe your product before anything gets built. Pushes back on your framing, challenges premises, generates alternatives. Startup mode for real businesses, builder mode for side projects. Writes a design doc. |
| `/ceo-review` | **CEO / Founder** | Rethink the problem. 18 cognitive patterns from Bezos, Munger, Grove, Horowitz, Altman, Jobs, Chesky. Four modes: Expansion, Selective Expansion, Hold Scope, Reduction. |
| `/market-research` | **Product Strategist** | Competitive landscape research with three-layer synthesis: what everyone knows, what's trending, and what first-principles reasoning reveals they're all getting wrong. |
| `/autoplan` | **Review Pipeline** | Runs CEO review, market research, and product review sequentially. Auto-decides mechanical choices using 6 decision principles. Surfaces only taste decisions for your approval. |
| `/codex` | **Second Opinion** | Independent review from OpenAI Codex. Three modes: structured review (pass/fail), adversarial challenge (find weaknesses), and free-form consultation with session continuity. |

## The flow

**Think -> Challenge -> Research -> Decide**

Each skill feeds into the next. `/office-hours` writes a design doc that `/ceo-review` reads. `/market-research` validates (or invalidates) the positioning. `/autoplan` runs the whole pipeline automatically. `/codex` gives you an independent second opinion at any point.

## Quick start

1. Install this plugin
2. Run `/office-hours` with your idea
3. Run `/ceo-review` on the design doc it produces
4. Run `/market-research` to validate the space
5. Or just run `/autoplan` and let it do all three

## What was kept from gstack

- **`/office-hours`** methodology: six forcing questions (Demand Reality, Status Quo, Desperate Specificity, Narrowest Wedge, Observation & Surprise, Future-Fit), anti-sycophancy rules, pushback patterns, startup/builder modes, landscape awareness, premise challenges, cross-model second opinions, founder signal synthesis
- **`/plan-ceo-review`** cognitive patterns: all 18 mental models (classification instinct, paranoid scanning, inversion reflex, focus as subtraction, speed calibration, proxy skepticism, temporal depth, and more)
- **`/design-consultation`** research methodology: three-layer synthesis (tried-and-true, new-and-popular, first-principles), eureka detection
- **`/autoplan`** decision framework: 6 decision principles, mechanical vs taste classification, sequential pipeline with final approval gate
- **`/codex`** multi-AI integration: review, challenge, and consult modes with cross-model synthesis

## What was stripped

All engineering tooling boilerplate: telemetry, session tracking, update checks, browse binary, gstack-config, contributor mode, plan status footer, gstack analytics, code review sections, test diagrams, architecture diagrams, CI/CD integration, git operations, security auditing.

## Attribution

Based on [gstack](https://github.com/garrytan/gstack) by [Garry Tan](https://x.com/garrytan). MIT License.

## Codex support

Works in both. The `codex` second-opinion skill is explicit-only and cross-model: under Claude Code it consults Codex; under Codex (where `codex exec` would be a recursive self-call) it consults the `claude` CLI instead, or stops if no cross-model CLI is available.
