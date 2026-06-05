#!/usr/bin/env python3
"""Stop hook: flag uncorroborated factual / completion / verification claims.

Strategy: trust but verify, the LLM way. mediocrity-detector greps for hedging
words; this is its semantic cousin — it parses the transcript, pulls out only the
*assistant's* messages from the turn that just ended, and asks a fast model whether
any claim was asserted as settled without the assistant's own narration showing it
ran / observed / inspected / cited anything. If so, it blocks the stop and feeds
the offending claims back so the assistant must corroborate or downgrade them.

The model evaluation is a single-turn prompt with real "caught red-handed"
examples (hooks/prompt.md) — the prompt-based-hook idea, but driven by a script so
the model can see *every* assistant message of the turn rather than just the last
one the native Stop payload exposes.

Fails OPEN: any error (no `claude` on PATH, timeout, bad JSON) exits 0 and lets the
turn stop. A diligence aid must never wedge the session.

Env knobs:
  IDBY_DISABLE   set to anything -> exit 0 (turn off without uninstalling)
  IDBY_ACTIVE    set internally on the child `claude -p` call -> recursion guard
  IDBY_MODEL     model id for the evaluation (default: claude-haiku-4-5-20251001)
  IDBY_TIMEOUT   seconds for the model call (default: 45)
"""
import json
import os
import re
import subprocess
import sys

DEFAULT_MODEL = "claude-haiku-4-5-20251001"


def bail():
    """Allow the stop. No output = no objection."""
    sys.exit(0)


def load_payload():
    try:
        return json.loads(sys.stdin.read())
    except Exception:
        bail()


def message_text(entry):
    """Concatenated text blocks of a message, or None. Flags tool_result content
    so callers can tell a typed user message from tool output."""
    msg = entry.get("message")
    if not isinstance(msg, dict):
        return None, False
    content = msg.get("content")
    if isinstance(content, str):
        return content, False
    if not isinstance(content, list):
        return None, False
    parts, has_tool_result = [], False
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            parts.append(block["text"])
        elif block.get("type") == "tool_result":
            has_tool_result = True
    return ("\n".join(parts) if parts else None), has_tool_result


def find_turn_start(entries):
    """Index just after the last real (human-typed) user message. Everything
    after it is the current turn. Mirrors mediocrity-detector: a real user
    message has string content, not a tool_result array."""
    for i in range(len(entries) - 1, -1, -1):
        e = entries[i]
        if e.get("type") != "user":
            continue
        msg = e.get("message")
        if isinstance(msg, dict) and isinstance(msg.get("content"), str):
            return i + 1
    return 0


def collect_agent_responses(transcript_path):
    try:
        with open(transcript_path, "r", errors="replace") as fh:
            entries = []
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except Exception:
                    continue
    except Exception:
        return []

    start = find_turn_start(entries)
    out = []
    for e in entries[start:]:
        if e.get("type") != "assistant":
            continue
        if e.get("isMeta"):
            continue
        text, _ = message_text(e)
        if text and text.strip():
            out.append(text.strip())
    return out


def build_prompt(agent_responses):
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "prompt.md"), "r") as fh:
        template = fh.read()
    joined = "\n\n--- message ---\n\n".join(agent_responses)
    return template.replace("<<<AGENT_RESPONSES>>>", joined)


def run_model(prompt):
    """Single-turn evaluation via headless Claude. Returns the model's text or
    None. IDBY_ACTIVE guards the child run from re-triggering this hook."""
    model = os.environ.get("IDBY_MODEL", DEFAULT_MODEL)
    try:
        timeout = int(os.environ.get("IDBY_TIMEOUT", "45"))
    except ValueError:
        timeout = 45

    env = dict(os.environ, IDBY_ACTIVE="1")
    try:
        proc = subprocess.run(
            ["claude", "-p", "--model", model, "--output-format", "json"],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
    except Exception:
        return None
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    try:
        envelope = json.loads(proc.stdout)
    except Exception:
        return None
    # --output-format json yields either a single result object or an array of
    # stream events ending in a {"type":"result", "result": "..."} entry.
    if isinstance(envelope, dict):
        result = envelope.get("result")
        return result if isinstance(result, str) else None
    if isinstance(envelope, list):
        for item in reversed(envelope):
            if isinstance(item, dict) and item.get("type") == "result" \
                    and isinstance(item.get("result"), str):
                return item["result"]
    return None


def parse_decision(text):
    """Pull {"ok":bool,"reason":str} out of the model's text. Tolerates code
    fences and surrounding prose. Returns (ok, reason) or None on failure."""
    if not text:
        return None
    candidate = text.strip()
    fence = re.search(r"\{.*\}", candidate, re.DOTALL)
    if fence:
        candidate = fence.group(0)
    try:
        obj = json.loads(candidate)
    except Exception:
        return None
    if not isinstance(obj, dict) or "ok" not in obj:
        return None
    return bool(obj["ok"]), str(obj.get("reason", "")).strip()


def main():
    if os.environ.get("IDBY_DISABLE") or os.environ.get("IDBY_ACTIVE"):
        bail()

    payload = load_payload()

    # Already continuing because of a Stop hook — let it stop (avoid nag loops).
    if payload.get("stop_hook_active") is True:
        bail()

    transcript_path = payload.get("transcript_path")
    if not isinstance(transcript_path, str):
        bail()

    responses = collect_agent_responses(transcript_path)
    if not responses:
        bail()

    decision = parse_decision(run_model(build_prompt(responses)))
    if decision is None:
        bail()  # fail open

    ok, reason = decision
    if ok or not reason:
        bail()

    block_reason = (
        "i-dont-believe-you flagged claims this turn that aren't corroborated by "
        "your own narration:\n\n"
        f"{reason}\n\n"
        "Before stopping: for each, either back it up (run it and report what you "
        "saw, show the artifact, or cite the source) or explicitly relabel it as an "
        "unverified assumption so the user can decide. Do not simply re-assert it."
    )
    print(json.dumps({"decision": "block", "reason": block_reason}))
    sys.exit(0)


if __name__ == "__main__":
    main()
