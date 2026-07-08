---
name: comments
description: Fetch active (unresolved) PR comments from GitHub and format them for LLM consumption. Use when user wants to review, respond to, or address PR feedback.
argument-hint: "[pr-url-or-ref] [--include-resolved]"
disable-model-invocation: true
allowed-tools: Bash, Read, Edit, AskUserQuestion
---

# Fetch PR Comments for LLM Consumption

Fetch active (unresolved) comments from a GitHub Pull Request and format them for LLM processing. Use `--include-resolved` to also include resolved threads.

## Arguments

- PR ref (optional): The PR URL (e.g., `https://github.com/owner/repo/pull/123`) or PR reference (e.g., `owner/repo#123` or just `123` if in a repo). In Claude Code this is `$ARGUMENTS`; under Codex, take it from the user's prompt (see step 1). If not provided, automatically detects the PR from the current git branch.
- `--include-resolved` (optional): Include resolved threads in the output. By default, only active (unresolved) threads are exported.

## Instructions

1. Determine the target PR reference from the user's request — a PR URL, `owner/repo#123`, or a bare number. In **Claude Code** it arrives via `$ARGUMENTS` (the harness substitutes it). Under **Codex** there is no argument substitution, so read the ref the user gave in their prompt. Then run the `comments.sh` script that sits **in this skill's own directory** — right next to this `SKILL.md`. You already know that directory's absolute path (it's where you loaded this file from), so invoke the script by that path directly. Pass the ref as a **single quoted argument** — omit it entirely only when the user gave none, to auto-detect the PR from the current branch:

Also pass `--include-resolved` as its own argument whenever the user asked to include resolved threads (it can appear with or without a PR ref); omit it otherwise.

```bash
# with an explicit ref:
bash "<this skill's directory>/comments.sh" "<pr-url-or-ref>"
# no ref → auto-detect from the current branch:
bash "<this skill's directory>/comments.sh"
# include resolved threads too (with or without a ref):
bash "<this skill's directory>/comments.sh" "<pr-url-or-ref>" --include-resolved
```

Do **not** locate the script with `find ~/.claude ~/.codex … | head -1`: that scans every cached install and can execute a stale copy from an older plugin version instead of the one next to this `SKILL.md`. Do **not** pass a literal `$ARGUMENTS` under Codex either — an unset shell variable expands to empty and silently auto-detects the wrong PR, and it drops flags like `--include-resolved`.

2. The script outputs the path to the generated markdown file on stdout. Capture this path and read the file contents.

3. Summarize for the user:
   - How many comments were fetched (active vs resolved, and how many are shown)
   - The main themes/issues raised in the active comments

4. For each one of the open comments:
   1. Reflect if the comment is pertinent
   2. Think about what will be your reply. If there are multiple alternatives or it involves some deep design or coding decision, confirm first with the user
   3. Update the markdown file you received with your draft reply and, if needed, what code changes need to happen. Do not publish the comments.
   4. Present them to the user and debate with the user if replies and code changes are accurate.

5. Once you reach agreement with the user
   1. Make any code changes you agreed to
   2. Commit and push them
   3. Send the replies to the comments in GitHub with the `reply.sh` commands from the "How to Reply" section of the markdown file (it appends the signature and silences output)
   4. Resolve threads automatically where the issue is settled — you made the requested change, or your reply conclusively answers/closes the point. Reply and resolve in one call with `reply.sh … --comment <ID> --body "…" --resolve` (no thread ID needed). Keep open any thread that is still a pending discussion — an unresolved debate, a design decision awaiting a call, or anything needing further back-and-forth. Tell the user which threads you resolved and which you left open, and why.
