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

- `$ARGUMENTS` (optional): The PR URL (e.g., `https://github.com/owner/repo/pull/123`) or PR reference (e.g., `owner/repo#123` or just `123` if in a repo). If not provided, automatically detects the PR from the current git branch.
- `--include-resolved` (optional): Include resolved threads in the output. By default, only active (unresolved) threads are exported.

## Instructions

1. Run the comments.sh script to gather and format the comments. The script is located next to this SKILL.md file:

```bash
bash "$(find ~/.claude -path '*/pr-comments/skills/comments/comments.sh' 2>/dev/null | head -1)" $ARGUMENTS
```

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
   3. Send the replies to the comments in GitHub, use the gh command available in the markdown file
   4. Ask the user if they agree to resolve the open threads, if so, execute the resolve thread command
