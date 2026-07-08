---
name: memory-audit
description: Audit the repo ./memory/ store for staleness — fan out read-only subagents (one per memory) to check each fact against the current repo state and git history, then bubble up drop/amend recommendations.
---

# Memory audit: prune stale repo memory

You are auditing the repository's version-controlled memory store — the `./memory/`
folder that the **memory-to-repo** plugin redirects all auto-memory into. Each
`./memory/*.md` file holds one fact/note with frontmatter (`name`, `description`,
`metadata.type`) and a body; `./memory/MEMORY.md` is the index, one line per
memory in the form `- [Title](file.md) — hook`.

Your job: find memories that no longer match reality (the code today, the git
history, or their own internal consistency), and decide whether each should be
kept, amended, or dropped.

## Gather context first

The memory directory is `./memory/` under the repository root (your current
working directory). Before auditing, run these to build context:

- Run `date +%F` to get today's date.
- Run `ls -1 memory/*.md 2>/dev/null | grep -v '/MEMORY\.md$'` to list the memory
  files to audit (the index `MEMORY.md` is excluded — it is regenerated, not
  audited). If there are none, say so and stop.
- Run `cat memory/MEMORY.md` to read the current index.

## What to do

### 1. Scope
If the user named specific files or globs, restrict the audit to those (still
under `memory/`). Otherwise audit **every** `memory/*.md` except `MEMORY.md`. If
there are no memory files, say so and stop.

### 2. Fan out — one read-only subagent per memory
Dispatch parallel subagents — one per memory file (Codex subagents may require
enabling via `/experimental`); if subagent dispatch is unavailable, evaluate each
memory inline instead, one at a time. For each memory file spawn one subagent with:
- A read-only role — it can read files and run `git`, but cannot Edit/Write, so it
  can never mutate a memory while judging it. (In Claude Code this maps to
  `subagent_type: Explore`.)
- A cheap model where the harness supports it — these are well-scoped checks. (In
  Claude Code this maps to `model: haiku`; use a read-only, cheap model.)

One subagent per file (never batch several memories into one) so each evaluation
stays focused and the fan-out runs concurrently. Fill the template below in for
each file.

#### Subagent prompt template
```
You are a read-only memory staleness auditor. Evaluate ONE memory file against the
current repository. You CANNOT and MUST NOT modify anything — return findings only.

Memory file: <PATH>
Repo root: <REPO_ROOT>
Today's date: <YYYY-MM-DD>

Steps:
1. Read the memory file in full (frontmatter + body).
2. Extract every concrete, checkable claim: file paths, function/symbol names,
   flags, commands, config keys, versions, dates, decisions, "we do X" statements,
   and any [[links]] to other memories.
3. Verify each claim against the CURRENT repo state AND git history:
   - Current state: read the referenced files/symbols (Read/Grep/Glob). Does the
     thing still exist? Does it still behave as the memory describes?
   - History: `git log`, `git log -p`, `git log --oneline -- <path>`, `git blame`
     to detect a referenced thing being renamed, moved, removed, or a decision
     reversed. Cite the commit (short SHA + subject) responsible.
   - A relative date ("yesterday", "last week", "recently") with no absolute
     anchor is a staleness smell — flag it.
   - A [[link]] to a memory not present in the store is a smell.
4. Decide one STATUS for the whole file.

Return EXACTLY these fields, concisely:
- FILE: <path>
- STATUS: FRESH | STALE | CONTRADICTED | UNVERIFIABLE
    FRESH        = every checkable claim still matches the repo.
    STALE        = references something renamed/moved/removed, or an unanchored
                   relative date, or otherwise out of date but not actively wrong.
    CONTRADICTED = a claim is now FALSE; the repo/git history shows the opposite.
    UNVERIFIABLE = claims are about things outside this repo (user prefs, external
                   services) that git cannot confirm. Say so; do NOT guess.
- EVIDENCE: bullet list. For each problem claim, quote it then cite the file
  line or commit (short SHA + subject) that proves the issue. If FRESH, say what
  you verified.
- RECOMMENDATION: KEEP | AMEND | DROP, one line why.
    AMEND is for MECHANICAL, objective fixes only (relative→absolute dates, a
    plainly renamed/moved reference) — give the EXACT replacement text, and never
    drop a fact without a replacement (supersede it, preserve source attribution).
    If the memory records a decision/preference and the code contradicts it, report
    STATUS: CONTRADICTED but note the code may have DRIFTED from intent — do NOT
    assume the memory is the wrong side. That is for a human to confirm.
```

### 3. Collect and decide (you, the main agent, own this)
When all subagents return, build a summary table:
`file | status | recommendation | one-line reason`.

**When in doubt, raise it — don't act silently.** Anything you are not confident
about goes to the user for confirmation rather than an automatic edit. In
particular, surface every `CONTRADICTED` finding and any important-looking
`UNVERIFIABLE` claim, with the evidence and your proposed action, and let the user
decide. Then act on each:

- **FRESH** → leave untouched.
- **AMEND** → apply only **mechanical, objective** fixes in place: convert relative
  dates to absolute, fix a reference that was plainly renamed or moved. **Never
  delete a fact without a replacement** — supersede it and preserve source
  attribution. If the summary changed, update the file's `description` frontmatter
  and its `MEMORY.md` index line to match.
- **CONTRADICTED** → **do not silently rewrite the memory to match the code.** A
  contradiction can mean the memory is out of date *or* that the code has drifted
  from a recorded decision/preference — rewriting it to "the new truth" would
  launder an accidental regression into remembered fact and erase the original
  intent. Surface it to the user with the evidence and a proposed correction, and
  let them choose: update the memory, fix the code, or keep it as-is.
- **DROP** → dropping deletes shared, committed knowledge for the whole team.
  Do **not** delete unilaterally. Present these to the user with the evidence and
  get confirmation before removing the file and its `MEMORY.md` line.
- **UNVERIFIABLE** → keep. Raise the ones that look important (e.g. a stated
  decision or preference you cannot confirm from the repo) to the user so they can
  confirm the claim still holds.

### 4. Re-sync the index
After any change, make `memory/MEMORY.md` match the files on disk: every memory
has exactly one `- [Title](file.md) — hook` line, dropped memories have none, and
amended summaries are reflected. Keep it lean.

### 5. Report
Print the final summary table and a short list of what you changed (amended)
versus what you raised for the user to decide (contradicted, drops, important
unverifiable claims) versus left alone.
