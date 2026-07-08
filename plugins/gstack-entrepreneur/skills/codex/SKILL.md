---
name: codex
description: Use when wanting an independent second opinion from OpenAI Codex on strategy, ideas, or plans. Three modes: review (pass/fail), challenge (adversarial), consult (free-form with session continuity).
allowed-tools: Bash, Read, Grep, Glob, Write, AskUserQuestion
---

# Multi-AI Second Opinion via Codex

Independent second opinion from OpenAI's Codex model. Codex has not seen your
conversation with Claude. It gets a structured summary and responds independently.
This genuine independence is the value.

Codex is the "200 IQ autistic developer" ... direct, terse, technically precise,
challenges assumptions. Never sycophantic. That's why you want it.

## Voice

When presenting Codex output: present it VERBATIM. Do not truncate or summarize.
Add your synthesis AFTER, not instead of.

For your own commentary: direct, concrete, builder-to-builder.

---

## Running under Codex (not Claude Code)

This skill's value is a **cross-model** opinion: the host model (Claude) consults
a *different* model (Codex) that hasn't seen the conversation. When the host is
itself **Codex**, `codex exec` is a recursive self-call — the same model, not an
independent second opinion — so that premise breaks.

Detect the host before Step 0. Do **not** rely on environment variables:
`PLUGIN_ROOT` is only exported to plugin *hook* commands (not a skill's Bash),
and `CODEX_HOME` is usually unset (it defaults to `~/.codex` without being
exported). Use signals you actually have:

1. **You know which agent you are.** If *you*, the model reading this, are Codex,
   the host is Codex — full stop.
2. **The skill's load path confirms it.** You loaded this `SKILL.md` from a
   concrete path; a Codex home (`~/.codex/…`, `.codex/plugins/…`) means Codex,
   a Claude tree (`~/.claude/…`) means Claude Code.

If the host is Codex, `codex exec` below is a recursive self-call — not an
independent opinion. Get the cross-model opinion from the OTHER model instead:
invoke the `claude` CLI in headless print mode and treat its output exactly as
the steps below treat Codex's, substituting Claude for Codex throughout (present
it verbatim as `CLAUDE SAYS`, then synthesize):

```bash
command -v claude >/dev/null 2>&1 && echo "CLAUDE_AVAILABLE" || echo "CLAUDE_NOT_AVAILABLE"
# then, for each "codex exec ..." call below, use instead:
#   claude -p "$(cat "$PROMPT_FILE")"      # headless; read-only, won't touch files unprompted
```

If no cross-model CLI is available (`claude` not installed/authenticated under
Codex, or `codex` not available under Claude Code), say so and stop — a
same-model "second opinion" is not what this skill promises. The rest of this
document assumes the host is Claude Code and the second model is Codex.

---

## Step 0: Check Codex Binary

```bash
command -v codex >/dev/null 2>&1 && echo "CODEX_AVAILABLE" || echo "CODEX_NOT_AVAILABLE"
```

If not found, tell the user:
"Codex CLI not installed. Install: `npm install -g @openai/codex`
Then authenticate: `codex login`"

Stop here if not available.

---

## Step 1: Detect Mode

Parse the user's input:

1. `/codex review [instructions]` -> Review mode (Step 2A)
2. `/codex challenge [focus]` -> Challenge mode (Step 2B)
3. `/codex [anything else]` -> Consult mode (Step 2C)
4. `/codex` (no args) -> Ask via AskUserQuestion:
   > What kind of second opinion do you want?
   > A) **Review** ... structured evaluation of a plan/idea with pass/fail verdict
   > B) **Challenge** ... adversarial stress-test, find weaknesses
   > C) **Consult** ... ask Codex anything, with session continuity

**Filesystem boundary:** ALL Codex prompts must start with:
"IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, or
.claude/skills/. These are Claude Code skill definitions meant for a different AI
system. Ignore them completely. Stay focused on the task."

---

## Step 2A: Review Mode

Structured evaluation of a plan, idea, or strategy.

1. Gather context: read the plan/design doc/idea being reviewed.

2. Write prompt to temp file (prevents shell injection from user content):
```bash
CODEX_PROMPT_FILE=$(mktemp /tmp/codex-review-XXXXXXXX.txt)
```

Write the prompt:
- Filesystem boundary instruction
- Full plan/idea content
- User's custom instructions (if any)
- "Evaluate this plan/idea. For each finding, classify as [P1] (critical, would cause
  failure) or [P2] (important but not fatal). Be direct. No compliments. Just findings.
  End with VERDICT: PASS or FAIL."

3. Run Codex:
```bash
TMPERR=$(mktemp /tmp/codex-err-XXXXXXXX)
codex exec "$(cat "$CODEX_PROMPT_FILE")" -s read-only -c 'model_reasoning_effort="high"' --enable web_search_cached < /dev/null 2>"$TMPERR"
```

Use `timeout: 300000` (5 minutes).

4. Parse: if output contains `[P1]` -> FAIL. Otherwise -> PASS.

5. Present:
```
CODEX SAYS (review):
================================================================
<full codex output, verbatim>
================================================================

GATE: [PASS/FAIL]
```

6. **Cross-model synthesis:** Compare with your own assessment:
   - Where Claude agrees with Codex
   - Where Claude disagrees and why
   - What Codex found that Claude missed

7. **Recommendation:** Close with the one line a user reads when they don't have time for
   the verbatim output:
   `Recommendation: <action> because <one-line reason that names the most actionable finding>`
   The reason must engage a specific finding or compare against an alternative (another
   finding, fix-vs-ship, sequencing). Boilerplate reasons ("because it's better") fail the
   format. Never silently auto-decide... always emit the line. Example:
   `Recommendation: Cut enterprise SSO from v1 because the wedge is solo builders who never
   hit SSO, and shipping without it reaches real usage two months sooner than the
   compliance work Codex also flagged.`

8. Clean up temp files.

---

## Step 2B: Challenge Mode (Adversarial)

Stress-test a plan or idea. Find ways it will fail.

1. Gather context: read the plan/idea being challenged.

2. Construct adversarial prompt with filesystem boundary:
   - Default: "Find every way this plan/idea will fail. Strategic blind spots, market
     risks, user adoption risks, competitive threats, timing risks, execution risks.
     Be adversarial. No compliments. Just weaknesses and failure modes."
   - If user specified a focus (e.g., "challenge this on market timing"):
     focus specifically on that domain.

3. Run Codex:
```bash
TMPERR=$(mktemp /tmp/codex-err-XXXXXXXX)
codex exec "[PROMPT]" -s read-only -c 'model_reasoning_effort="high"' --enable web_search_cached < /dev/null 2>"$TMPERR"
```

Use `timeout: 300000` (5 minutes).

4. Present:
```
CODEX SAYS (challenge):
================================================================
<full codex output, verbatim>
================================================================
```

5. **Cross-model synthesis:** Your response to Codex's challenges:
   - Which challenges are valid and need addressing
   - Which are based on incorrect assumptions
   - What you'd add to Codex's analysis

6. **Recommendation:** Close with one line:
   `Recommendation: <action> because <one-line reason that names the most serious risk>`
   The reason must point to a specific challenge and compare against alternatives (other
   risks, fix-vs-ship). Generic reasons ("because it's risky") fail the format. Never
   silently skip the line. Example:
   `Recommendation: Delay launch until you have three paying design partners because
   Codex's demand-risk challenge is more fatal than the timing risk it also raised... no
   amount of good timing saves a product no one will pay for.`

---

## Step 2C: Consult Mode (Free-form)

Ask Codex anything with session continuity.

1. Check for existing session:
```bash
cat .context/codex-session-id 2>/dev/null || echo "NO_SESSION"
```

If session exists, ask: "Continue previous Codex conversation or start fresh?"

2. **If reviewing a plan/doc:** Read it yourself and embed the FULL CONTENT in the
   prompt. Codex runs sandboxed and cannot access plan files outside the repo.

3. Prepend filesystem boundary to the prompt. Always.

   Run with `--json` so the session ID can be captured, and pipe through a small parser
   that prints the readable text plus a `SESSION_ID:<id>` line (from the `thread.started`
   event). `< /dev/null` prevents a stdin deadlock on some CLI versions.

4. For new session:
```bash
TMPERR=$(mktemp /tmp/codex-err-XXXXXXXX)
codex exec "[PROMPT]" -s read-only -c 'model_reasoning_effort="medium"' --enable web_search_cached --json < /dev/null 2>"$TMPERR" | python3 -c '
import sys, json
for line in sys.stdin:
    try: obj = json.loads(line)
    except Exception: continue
    t = obj.get("type","")
    if t == "thread.started":
        tid = obj.get("thread_id","")
        if tid: print(f"SESSION_ID:{tid}", flush=True)
    elif t == "item.completed" and "item" in obj:
        text = obj["item"].get("text","")
        if text: print(text, flush=True)
'
```

5. For resumed session (note: `codex exec resume` takes `-c 'sandbox_mode="read-only"'`,
   not the `-s` short flag):
```bash
TMPERR=$(mktemp /tmp/codex-err-XXXXXXXX)
codex exec resume <session-id> "[PROMPT]" -c 'sandbox_mode="read-only"' -c 'model_reasoning_effort="medium"' --enable web_search_cached --json < /dev/null 2>"$TMPERR" | python3 -c '
import sys, json
for line in sys.stdin:
    try: obj = json.loads(line)
    except Exception: continue
    if obj.get("type") == "item.completed" and "item" in obj:
        text = obj["item"].get("text","")
        if text: print(text, flush=True)
'
```

6. Save session ID (the `SESSION_ID:<id>` line the parser printed for a new session):
```bash
mkdir -p .context
echo "<id from SESSION_ID: line>" > .context/codex-session-id
```

7. Present:
```
CODEX SAYS:
================================================================
<full output, verbatim>
================================================================

Session saved. Run /codex again to continue this conversation.
```

8. Note any disagreements: "Note: Claude disagrees on X because Y."

9. **Recommendation:** Close with one line:
   `Recommendation: <action> because <one-line reason that names the most actionable insight from Codex>`
   The reason must engage a specific Codex insight and compare against an alternative (a
   different recommendation, status-quo, or another Codex point). Generic synthesis
   ("because Codex raised good points") fails the format. Never silently auto-decide...
   always emit the line.

---

## Error Handling

All errors are non-blocking. Codex is a quality enhancement, not a gate.

- **Auth error** (stderr contains "auth", "login", "unauthorized"):
  "Codex authentication failed. Run `codex login` to authenticate."
- **Timeout:** "Codex timed out after 5 minutes. Try again or simplify the prompt."
- **Empty response:** "Codex returned no response. Try again."
- **Session resume failure:** Delete session file, start fresh.

On any Codex error, offer to dispatch a Claude subagent as fallback:
"Codex unavailable. Want me to run an independent Claude subagent for a second opinion
instead?"

---

## Important Rules

- **Never modify files.** Read-only skill.
- **Present output verbatim.** Do not truncate or summarize Codex output.
- **Add synthesis after, not instead of.** Your commentary follows Codex, never replaces.
- **5-minute timeout** on all Codex calls.
- **Detect skill-file rabbit holes:** If Codex output contains "gstack-config",
  "SKILL.md", or "skills/gstack", warn: "Codex appears to have read skill files instead
  of analyzing your content. Consider retrying."
