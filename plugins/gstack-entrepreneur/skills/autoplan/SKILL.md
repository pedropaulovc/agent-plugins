---
name: autoplan
description: Use when you want to run a full review pipeline automatically. Runs strategy review, market analysis, and product review in sequence with auto-decisions. Surfaces only taste decisions for human approval.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, WebSearch, AskUserQuestion
---

# Auto-Review Pipeline

Reads the CEO review, market research, and product review skills and runs them
sequentially. Auto-decides mechanical choices using 6 decision principles. Surfaces
taste decisions at a final approval gate.

## Voice

Direct, concrete, sharp. Builder talking to a builder. Never corporate, never academic.

**Writing rules:**
- No em dashes. Use commas, periods, or "..." instead.
- No AI vocabulary: delve, crucial, robust, comprehensive, nuanced, etc.
- Short paragraphs. Punchy standalone sentences.
- End with what to do.

## AskUserQuestion Format

1. **Re-ground:** State the project and current task.
2. **Simplify:** Plain English.
3. **Recommend:** `RECOMMENDATION: Choose [X] because [one-line reason]`
4. **Options:** Lettered: `A) ... B) ... C) ...`

---

## The 6 Decision Principles

When auto-deciding, apply these in order:

1. **Choose completeness** ... Do the whole thing. Shortcuts cost more later.
2. **Boil lakes** ... If it's in the blast radius and takes less than a day, fix it.
3. **Pragmatic** ... If two approaches solve the same problem, pick the cleaner one.
4. **DRY** ... Duplicates existing work? Reject.
5. **Explicit over clever** ... Obvious approach beats elegant abstraction.
6. **Bias toward action** ... Decide and move. Perfect analysis is worse than good action.

**Conflict resolution:**
- CEO phase prioritizes P1 (completeness) + P2 (boil lakes)
- Market phase prioritizes P5 (explicit) + P3 (pragmatic)
- Product phase prioritizes P5 (explicit) + P1 (completeness)

---

## Decision Classification

Every decision falls into one of two categories:

- **Mechanical:** One right answer given the principles. Auto-decide silently.
- **Taste:** Reasonable people disagree. Auto-decide but surface at the final gate.

Taste decisions come from three sources:
1. **Close approaches** ... top 2 are both viable
2. **Borderline scope** ... ambiguous whether to include or defer
3. **Cross-model disagreements** ... second opinion raises a valid counter-point

**User Challenge** ... a fourth, qualitatively different category. When both the primary
review and the cross-model second opinion agree the user's stated direction should change
(merge, split, add, or remove features or workflows the user specified), that is a User
Challenge. It is **NEVER auto-decided.** It goes to the final gate with richer context
than a taste decision:
- **What the user said:** their original direction
- **What both models recommend:** the change
- **Why:** the models' reasoning
- **What context we might be missing:** explicit acknowledgment of blind spots
- **If we're wrong, the cost is:** what happens if the user's original direction was right

The user's original direction is the default. The models must make the case for change,
not the other way around. **Exception:** if both models flag the change as a security or
feasibility risk (not a preference), the AskUserQuestion framing says so explicitly and is
appropriately urgent... the user still decides.

---

## What "Auto-Decide" Means

Replace user judgment with the 6 principles. Analysis depth stays the same.

- Read the actual context each section references
- Produce every output required
- Identify every issue
- Decide using principles
- Log each decision

Never compress a review section to a summary. "No issues found" is valid only after
analysis. "Skipped" is never valid.

**Two exceptions ... never auto-decided:**
1. Premises (Phase 1) ... require human judgment about what problem to solve.
2. User Challenges ... when both models agree the user's stated direction should change.
   The user always has context the models lack. See Decision Classification above.

---

## Sequential Execution ... MANDATORY

**CEO Review -> Market Research -> Product Review**

Each phase completes before the next begins. Later phases build on earlier findings.

---

## Phase 0: Intake

1. Read any existing design doc, plan, or project documentation.
2. Read the user's stated goals and context.
3. If no design doc exists, offer `/office-hours` first:
   > "No design doc found. `/office-hours` creates one through structured brainstorming.
   > Want to run that first, or proceed with what we have?"

---

## Phase 1: CEO Review (Strategy & Scope)

Follow the `ceo-review` skill methodology at full depth.

**Override rules:**
- Mode selection: **SELECTIVE EXPANSION** (hold scope, cherry-pick expansions)
- Premises: Accept reasonable ones (P6). Challenge clearly wrong ones.
  **GATE: Present premises to user for confirmation.** This is the ONE human gate.
- Scope expansion: In blast radius + quick -> approve (P2). Outside -> defer.
  Duplicates -> reject (P4). Borderline -> TASTE DECISION.
- Cross-model second opinion: Always run (P6).
- If both the review and the second opinion agree the user's stated direction should
  change (merge, split, add, remove) -> USER CHALLENGE (never auto-decided).

**Mandatory outputs:**
- Reviewed premises (confirmed by user)
- Scope decisions (in/out/deferred)
- Strategic threats identified
- Leverage points
- "NOT in scope" section
- Decision audit entries

Phase 1 complete before Phase 2 begins.

---

## Phase 2: Market Research

Follow the `market-research` skill methodology at full depth.

**Override rules:**
- Research depth: Full landscape search + deep dive on top 3-5 (P1)
- Three-layer synthesis: mandatory, never skip Layer 3 (P1)
- Positioning map: always produce (P1)
- If research contradicts CEO review findings, flag it as a TASTE DECISION

**Mandatory outputs:**
- Competitive landscape (5-10 competitors)
- Three-layer synthesis
- Positioning map
- Strategic recommendations
- Decision audit entries

Phase 2 complete before Phase 3 begins.

---

## Phase 3: Product Review

Synthesize CEO review + market research into product recommendations.

**Review sections:**

### 3.1: Product-Market Fit Assessment
- Does the proposed product match a real market gap?
- Is the wedge narrow enough?
- Does the positioning differentiate?
- Are table stakes covered?

### 3.2: User Journey Analysis
- Who is the first user?
- What's their current workaround?
- What's the switch trigger?
- What's the retention hook?
- What's the expansion path?

### 3.3: Risk Map
- Market risks (timing, competition, regulation)
- Product risks (complexity, adoption, retention)
- Execution risks (resources, timeline, dependencies)

### 3.4: Prioritization
Apply leverage obsession: what's the one thing that makes everything else easier?
- Must-have (table stakes)
- Should-have (differentiators)
- Nice-to-have (delight)
- Cut (distractions)

**Mandatory outputs:**
- PMF assessment
- User journey
- Risk map
- Prioritized feature/initiative list
- Decision audit entries

---

## Decision Audit Trail

After each auto-decision, append:

| # | Phase | Decision | Classification | Principle | Rationale | Rejected Alternative |
|---|-------|----------|----------------|-----------|-----------|---------------------|

`Classification` is one of: mechanical, taste, or user-challenge.

---

## Phase 4: Final Approval Gate

STOP and present to user via AskUserQuestion:

> ## Auto-Review Complete
>
> **Decisions Made:** [N] total ([M] auto-decided, [K] taste choices, [J] user challenges)
>
> ### User Challenges (both models disagree with your stated direction)
> {For each: **Challenge [N]: [title]** (from [phase])
>  You said: [original direction]
>  Both models recommend: [the change]
>  Why: [reasoning]
>  What we might be missing: [blind spots]
>  If we're wrong, the cost is: [downside of changing]
>  [If security/feasibility: "Both models flag this as a security/feasibility risk, not
>  just a preference."]
>  Your call... your original direction stands unless you explicitly change it.}
> {Skip this whole section if there are 0 user challenges.}
>
> ### Your Choices (taste decisions)
> {each taste decision with recommendation + principle}
>
> ### Auto-Decided
> [M] mechanical decisions [see audit trail]
>
> ### Key Findings
> - CEO Review: {1-2 sentence summary}
> - Market Research: {1-2 sentence summary}
> - Product Review: {1-2 sentence summary}
>
> ### Cross-Phase Themes
> {concerns that span 2+ phases}
>
> ### The Assignment
> {one concrete action}

**Options:**
- A) Approve as-is
- B) Approve with overrides (specify which taste decisions to change)
- B2) Approve with user challenge responses (accept or reject each challenge)
- C) Interrogate (ask about a specific decision)
- D) Revise (re-run affected phases, max 3 cycles)
- E) Reject (start over)

---

## Important Rules

- **Never abort.** Respect the user's choice to run /autoplan.
- **Two gates.** The only non-auto-decided AskUserQuestions during execution are (1)
  premise confirmation in Phase 1, and (2) User Challenges... when both models agree the
  user's stated direction should change. Everything else is auto-decided using the 6
  principles.
- **Log every decision.** No silent auto-decisions.
- **Full depth means full depth.** Do not compress sections.
- **Sequential order.** CEO -> Market -> Product.
- **The assignment is mandatory.** End with a concrete action.
