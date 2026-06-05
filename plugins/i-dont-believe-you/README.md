# i-dont-believe-you

**Experimental.** A `Stop` hook that calls your bluff.

When a turn ends, it pulls out only the assistant's own messages for that turn,
hands them to a fast model, and asks one question: *did you assert anything as
settled fact, finished work, or verified behavior without your own narration
showing you actually ran it, looked at it, or cited it?* If so, it blocks the stop
and feeds the offending claims back so you have to corroborate or downgrade them
before the turn can end.

It's the semantic cousin of [`mediocrity-detector`](../mediocrity-detector):
that one greps for hedging words; this one reads the substance and judges whether
each confident claim was *earned*.

## Why a script and not a plain `type: "prompt"` hook

A native prompt hook only receives the `Stop` payload — `transcript_path` plus
`last_assistant_message` — and has no tools, so it can't gather every assistant
message of a multi-message turn. The companion script
(`hooks/flag-uncorroborated.py`) does that parsing first, then runs the
prompt-based evaluation itself. So it *is* a prompt-driven decision; the script
exists only to feed the model the full turn instead of just the last line.

## How it works

1. `Stop` fires → `hooks/flag-uncorroborated.py` reads the payload on stdin.
2. It finds the last real (human-typed) user message and collects every assistant
   text message after it — the current turn, agent side only.
3. It fills `hooks/prompt.md` with those messages and sends it to a fast model
   via `claude -p --output-format json`.
4. The model returns `{"ok": bool, "reason": str}`. On `ok: false` the script
   emits `{"decision": "block", "reason": …}`, which continues the turn with the
   flagged claims as the next instruction.

The prompt is built from **real cases mined from past transcripts** where the user
caught the assistant red-handed — "did you test it" → *"You're right, I didn't
actually test it"*; "where did you get 230K req/sec" → *"I assumed per-second"*;
"where does it say there's replication?" → *"the diagram doesn't mention it"*. The
examples are what teach the model the shape of an uncorroborated claim.

## Safety

- **Fails open.** No `claude` on PATH, a timeout, or unparseable output → the turn
  stops normally. A diligence aid must never wedge the session.
- **No nag loops.** Skips when `stop_hook_active` is true (already continuing from
  a stop hook).
- **No recursion.** The child `claude -p` call runs with `IDBY_ACTIVE=1`, which
  makes this hook no-op on that nested session.

## Configuration

Environment variables:

| Var | Default | Effect |
|---|---|---|
| `IDBY_DISABLE` | unset | Set to anything to turn the hook off without uninstalling. |
| `IDBY_MODEL` | `claude-haiku-4-5-20251001` | Model used for the evaluation. |
| `IDBY_TIMEOUT` | `45` | Seconds allotted to the model call. |

## Cost & latency

Every turn that produces assistant text triggers one extra fast-model call
(~a second or two on Haiku). That's the price of the check — disable with
`IDBY_DISABLE` if you don't want it on a given session.
