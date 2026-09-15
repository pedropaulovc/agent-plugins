---
name: autoplan
description: Use when you want to run a full review pipeline automatically. Runs strategy review, market analysis, and product review in sequence with auto-decisions. Surfaces only taste decisions for human approval.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, WebSearch, AskUserQuestion, Task
---

# Auto-Review Pipeline

Reads the CEO review, market research, and product review skills and runs them
sequentially at full depth. Auto-decides mechanical choices using 6 decision principles.
Taste decisions and challenges to your direction queue up and surface once, at the final
approval gate.

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
not the other way around. **Exception:** if both models flag the change as a market or
feasibility risk (not a preference), the AskUserQuestion framing says so explicitly and is
appropriately urgent... the user still decides.

A clearly wrong premise is also a User Challenge. It queues; it never stops the run.

---

## Conflict Resolution Across Phases

Later phases will contradict earlier ones. That is the pipeline working. Resolve in this
order:

1. **Evidence beats assertion.** If market research finds data that kills a CEO-phase
   premise, the data wins. Amend the premise, log the amendment, note which finding did it.
2. **Two phases, same concern, independently ... that is a theme.** Promote it to P1 and
   flag it as a high-confidence signal at the gate. Do not average the two phases into a
   mild version of the concern.
3. **A conflict that changes the user's stated direction is a User Challenge,** not a
   taste decision. Queue it with both phases' reasoning.
4. **Everything else is a taste decision.** Take the later phase's recommendation, record
   the earlier position and why you set it aside, surface it at the gate.

Never silently drop an earlier phase's finding. Superseded findings stay in the record
with the reason they were superseded.

---

## Sequential Execution ... MANDATORY

**CEO Review -> Market Research -> Product Review**

Product review runs LAST, always. It reviews the brief as amended by the two phases before
it, so the gate always sees the final state.

Keep ONE phase active. Close it by completing these gates in order:

1. Load that phase's skill methodology in full, plus the findings the prior phase wrote.
2. Run the phase's own analysis at full depth, auto-deciding as you go.
3. Run the second opinion, consume its output, then finish the primary review.
4. Write every output, amendment, and decision row into the working doc.
5. Append the completion summary to the working doc as a line starting with
   `Phase N complete.`, then send the same summary as a standalone message starting with
   that marker. The written marker is what a resumed run looks for, so a summary that
   only existed in the conversation does not close the phase. Only then touch the next
   phase.

A missing gate means the phase is still open, even if a reviewer finished. Never draft a
later phase's review early. A heading is not a finding and a promise is not an output.

Pending is not unavailable. Running short on room, or disliking what a phase found, never
licenses skipping a second opinion or a required section. Report what actually ran.

### Resuming an interrupted run

Every decision a phase makes lands in the working doc before that phase closes, so a run
survives losing the conversation. To resume:

1. Re-read the working doc. Find the last `Phase N complete.` marker.
2. Re-read the skill methodology for the phase after it.
3. Continue there. Never re-run a closed phase, never re-ask a logged decision.
4. If a phase's outputs are half written, that phase is still open. Redo it from gate 1.

---

## What "Auto-Decide" Means

Replace user judgment with the 6 principles. Analysis depth stays the same.

**Default resolution: the recommended option.** Every question a loaded skill would ask
resolves to its recommended option, and mode selections take that skill's default for the
context. The 6 principles break ties and cover questions with no recommendation. When a
principle argues against the recommended option, take the recommendation anyway and log a
taste decision.

**You MUST still:**
- Read the actual context each section references
- Produce every output the section requires (tables, maps, registries)
- Identify every issue the section is built to catch
- Decide each issue using the principles
- Log each decision before moving on

**You MUST NOT:**
- Compress a review section into a table row
- Write "no issues found" without showing what you examined
- Skip a section as "not applicable" without stating what you checked and why
- Substitute a summary for a required output. A sentence about positioning is not the
  positioning map.

"No issues found" is valid only after the analysis, with one or two sentences on what you
examined and why nothing was flagged. "Skipped" is never valid.

**One exception class ... never auto-decided:** User Challenges, including clearly wrong
premises queued in Phase 1. They surface at the final gate, never as a mid-run stop. The
user is interrupted exactly once. The user always has context the models lack.

---

## The Independent Second Opinion

Every phase runs one. It is a subagent dispatched through the host harness with the
Task tool, never a shell-out to another vendor's CLI.

**Pick the reviewer deliberately.** If the harness lets you choose the agent type and
model per dispatch, send the reviewer to a different model family than the one running
this pipeline. That is what makes the read genuinely independent. If it does not, you
still get fresh context and no conversation bias, which is worth having, but say in the
consensus table that the reviewer was same-family and discount its agreement.

**Brief it clean.** Send the plan text and the phase brief. Do not send your running
review, your draft findings, or the earlier phases' conclusions unless the phase says to.
A reviewer fed your conclusions returns your conclusions.

**Require a position.** The reviewer closes with
`RECOMMENDATION: [action] because [specific reason]`. No objection is a valid verdict
only with a stated reason. A refusal, an empty response, a summary with no position, or
a dispatch failure is a missing second opinion, not a pass. Tag the phase
`[single-voice]`, record why, and continue on the primary review. Unavailable is never
agreement.

**Weigh it.** Agreement from a same-family reviewer is weak evidence. Disagreement is
strong evidence either way. CONFIRMED requires two voices; a missing voice is N/A, never
CONFIRMED. A critical raised by one voice alone is still flagged.

---

## Phase 0: Intake

1. Read the existing design doc, plan, or project documentation, and the user's stated
   goals and context.
2. If no design doc exists, offer `office-hours` first:
   > "No design doc found. `office-hours` creates one through structured brainstorming.
   > Want to run that first, or proceed with what we have?"
   If the user proceeds anyway, there is no file to amend and no restore point. Say so,
   and write the run's output to a new doc instead of amending one.
3. **Restore point.** Once an input doc exists and before amending it, copy it verbatim
   to `<doc>.pre-autoplan.md` next to it. Tell the user the path. To re-run from
   scratch, copy that file back over the input doc.
4. Announce the run:
   > "Here's what I'm working with: [one-paragraph summary]. Restore point: [path, or
   > 'none, writing to a new doc']. Running CEO review, then market research, then
   > product review, with auto-decisions. I'll come back to you once, at the end."

---

## Phase 1: CEO Review (Strategy & Scope)

Follow the `ceo-review` skill methodology at full depth.

**Override rules:**
- Mode selection: **SELECTIVE EXPANSION** (hold scope, cherry-pick expansions)
- Premises: accept reasonable ones (P6). A clearly wrong premise is not a mid-run stop.
  Queue it as a gate item: what the plan assumes, why it looks wrong, and what proceeding
  on it anyway would cost.
- Alternatives: pick highest completeness (P1). Tied -> pick simplest (P5). Top two
  close -> TASTE DECISION.
- Scope expansion: in blast radius + quick -> approve (P2). Outside -> defer with a
  reason (P3). Duplicates -> reject (P4). Borderline -> TASTE DECISION.
- Independent second opinion: always run (P6), adversarially briefed. See The Independent
  Second Opinion.
- If both the review and the second opinion agree the user's stated direction should
  change (merge, split, add, remove) -> USER CHALLENGE (never auto-decided).

**Second opinion brief for this phase:**

> You are a founder advising a founder on this plan. Challenge the foundations. Are the
> premises stated or just assumed, and which of them could be wrong? Is this the right
> problem to solve, or is there a reframing worth 10x? What alternatives were dismissed
> too fast? What market or competitive risk is unaddressed? Which scope decision will
> look foolish in six months? For each finding: what is wrong, severity
> (critical / high / medium), and the fix. Be adversarial. No compliments.

Send the plan text with the brief. Do not send the running review... the second opinion
stays independent in Phase 1. If it is unavailable, say so, tag the phase
`[single-voice]`, and continue with the primary review. Unavailable is never agreement.

**Consensus table (produce it, one row per dimension):**

| Dimension | Primary | Second opinion | Consensus |
|-----------|---------|----------------|-----------|
| 1. Premises valid? | | | |
| 2. Right problem to solve? | | | |
| 3. Scope calibration correct? | | | |
| 4. Alternatives explored enough? | | | |
| 5. Market and competitive risk covered? | | | |
| 6. Six-month trajectory sound? | | | |

CONFIRMED requires both voices. A missing second opinion is N/A, never CONFIRMED.
Disagreements become taste decisions. A critical finding from one voice is flagged
regardless of the other.

**Mandatory outputs:**
- Premise assessment naming each premise, with queued challenges (not "premises accepted")
- Scope decisions (in / out / deferred), each with the principle that decided it
- "NOT in scope" section with rationale
- "What already exists" section
- Strategic threats and leverage points
- Consensus table
- Decision audit entries
- Actionable items in the task shape (see Phase 4)

**Close the phase** (append to the working doc, then send as a message):

> **Phase 1 complete.** Second opinion: [N concerns / unavailable].
> Consensus: [X/6 confirmed, Y disagreements queued for the gate].
> Premise challenges queued: [N]. Passing to Phase 2.

Do not begin Phase 2 until every Phase 1 output is written to the working doc. Queued
premise challenges travel to the gate; they never pause the run here.

---

## Phase 2: Market Research

Follow the `market-research` skill methodology at full depth.

**Handoff from Phase 1:** carry the CEO phase's premises, wedge, and open questions into
the research brief so the search targets what the strategy actually depends on. Give
prior-phase findings to the second opinion only. The primary research pass stays
independent so it can contradict Phase 1 cleanly.

**Override rules:**
- Research depth: Full landscape search + deep dive on top 3-5 (P1)
- Three-layer synthesis: mandatory, never skip Layer 3 (P1)
- Positioning map: always produce (P1)
- Independent second opinion: always run (P6) on the synthesis. See The Independent
  Second Opinion. This is the one phase that briefs the reviewer with prior-phase
  findings: give it the Phase 1 conclusions and ask where the landscape read is
  wrong: which competitor is underrated, which gap is a graveyard rather than an opening,
  which positioning claim the evidence does not carry.
- If research contradicts a CEO-phase finding, resolve it with the precedence ladder in
  Conflict Resolution Across Phases. Amend the premise and log which finding did it.

**Mandatory outputs:**
- Competitive landscape (5-10 competitors)
- Three-layer synthesis
- Positioning map
- Strategic recommendations
- Premise amendments, each naming the evidence that forced it
- Decision audit entries
- Actionable items in the task shape (see Phase 4)

**Close the phase** (append to the working doc, then send as a message):

> **Phase 2 complete.** Competitors mapped: [N]. Second opinion: [N concerns /
> unavailable]. Premises amended by evidence: [N]. Conflicts with Phase 1: [N, each
> resolved or queued]. Passing to Phase 3.

---

## Phase 3: Product Review

Synthesize CEO review + market research into product recommendations. This phase runs
last and reviews the brief as amended, so read the amendments, not the original.

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

### 3.5: Second Opinion on the Final Brief
Run the independent second opinion once more, adversarially briefed, on the brief as
amended by all three phases, not on the original. Ask: given this plan, what is the most
likely reason it fails commercially in the next year, and what would you cut or add
first? This is the last independent read before the gate, so a disagreement here is a
taste decision at minimum, and a User Challenge if it matches the primary review on
changing the user's stated direction.

### 3.6: Reconciliation
Walk every open conflict between phases, including the one above, and close it using the
precedence ladder. Name each conflict, the two positions, the resolution, and what it
changed. Any conflict that rewrites the user's stated direction becomes a User Challenge
instead of a resolution.

**Mandatory outputs:**
- PMF assessment
- User journey
- Risk map
- Prioritized feature and initiative list
- Reconciliation log
- Second opinion verdict on the final brief (or noted unavailable)
- Decision audit entries
- Actionable items in the task shape (see Phase 4)

**Close the phase** (append to the working doc, then send as a message):

> **Phase 3 complete.** PMF verdict: [one line]. Conflicts reconciled: [N].
> User challenges queued: [N]. Taste decisions queued: [N]. Moving to the gate.

---

## Decision Audit Trail

After each auto-decision, append a row to the working doc with Edit. Write it as you go,
not at the end, so the trail survives losing the conversation:

| # | Phase | Decision | Classification | Principle | Rationale | Rejected Alternative |
|---|-------|----------|----------------|-----------|-----------|---------------------|

`Classification` is one of: mechanical, taste, or user-challenge.

---

## Pre-Gate Verification

Before presenting the gate, check the working doc for each output. This catches a phase
that produced a heading instead of a finding.

**Phase 1 (CEO):**
- [ ] Premise assessment naming specific premises
- [ ] Every applicable section has findings or an explicit "examined X, nothing flagged"
- [ ] "NOT in scope" and "What already exists" sections written
- [ ] Strategic threats and leverage points written
- [ ] Consensus table produced (or second opinion noted unavailable)

**Phase 2 (Market):**
- [ ] 5-10 competitors with real evidence, not guesses
- [ ] All three synthesis layers, Layer 3 included
- [ ] Positioning map produced
- [ ] Premise amendments logged with their evidence
- [ ] Second opinion on the synthesis ran (or noted unavailable)

**Phase 3 (Product):**
- [ ] PMF assessment, user journey, risk map
- [ ] Prioritized list with the leverage pick named
- [ ] Reconciliation log covering every open cross-phase conflict
- [ ] Second opinion on the final amended brief ran (or noted unavailable)

**Cross-phase:**
- [ ] Cross-phase themes section written
- [ ] Audit trail has at least one row per auto-decision

If anything is missing, go back and produce it. Two attempts maximum. Still missing after
that, go to the gate and say which items are incomplete. Do not loop.

---

## Phase 4: Final Approval Gate

### Aggregate the task list first

Each phase emits its actionable items in one shape so they can merge:

`[P1|P2|P3] [area] title ... surfaced by [phase], from [finding], effort [S|M|L]`

Then:
1. Collect every item from all three phases.
2. Dedupe exact matches on (area, title). Keep the highest priority of the duplicates and
   name both phases that raised it. Two phases raising the same item independently is
   signal, so promote it.
3. Mark superseded items as superseded, with the finding that replaced them. Do not
   delete them.
4. Sort by priority (P1 first), then by phase order (CEO, market, product).
5. Render as a checklist. If a phase produced no items, say so by name instead of leaving
   a blank.

### Then STOP and present to user via AskUserQuestion

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
>  [If market or feasibility risk: "Both models flag this as a real risk, not just a
>  preference."]
>  Your call... your original direction stands unless you explicitly change it.}
> {Skip this whole section if there are 0 user challenges.}
>
> ### Your Choices (taste decisions)
> {each taste decision with recommendation, principle, and one line on what picking the
>  other option changes downstream}
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
> {concerns that showed up in 2+ phases independently, marked high-confidence}
> {If none: "No cross-phase themes... each phase's concerns were distinct."}
>
> ### Deferred
> {items deferred, each with its reason}
>
> ### Next Actions (aggregated across phases)
> {the aggregated checklist}
>
> ### The Assignment
> {one concrete action}

**Cognitive load management:**
- 0 user challenges: drop that section
- 0 taste decisions: drop that section
- 1-7 taste decisions: flat list
- 8+: group by phase and warn: "This plan had unusually high ambiguity ([N] taste
  decisions). Review carefully."

**Options:**
- A) Approve as-is
- B) Approve with overrides (specify which taste decisions to change)
- B2) Approve with user challenge responses (accept or reject each challenge)
- C) Interrogate (ask about a specific decision)
- D) Revise (re-run affected phases, max 3 cycles)
- E) Reject (start over)

**Option handling:**
- A: stamp the working doc APPROVED with the decision counts and the assignment.
- B: ask which overrides, apply them, re-present the gate.
- B2: walk the challenges one at a time. Rejected -> note that the user's direction
  stands, change nothing. Accepted -> amend the brief for that challenge, including a
  premise change that reshapes scope, then re-run the product phase on the amended brief
  and re-present. Counts against the same 3-cycle cap as D.
- C: answer freeform, re-present the gate.
- D: make the changes, re-run the affected phases (premises or scope -> 1, competitive
  evidence -> 2, prioritization or PMF -> 3). Re-running any earlier phase re-runs the
  product phase after it, because the gate always reviews the final brief. Max 3 cycles.
- E: start over from the restore point. If the run had no input doc, there is no restore
  point: discard the generated doc instead and say that is what you did.

---

## Important Rules

- **Never abort.** Respect the user's choice to run the pipeline. Surface taste
  decisions, never redirect to an interactive review.
- **One gate.** The only non-auto-decided AskUserQuestions surface at the final gate:
  taste decisions and User Challenges, including premise challenges queued in Phase 1.
  Everything else resolves to the recommended option, so the run never stops mid-flight.
- **Log every decision.** No silent auto-decisions. Every choice gets a row.
- **Write as you go.** A phase closes only when its outputs are in the working doc. That
  is what makes an interrupted run resumable.
- **Full depth means full depth.** Do not compress sections. Fewer than three sentences
  on a review section means you are compressing.
- **Sequential order.** CEO -> Market -> Product, product last.
- **The assignment is mandatory.** End with a concrete action.
