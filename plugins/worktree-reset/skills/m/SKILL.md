---
name: m
description: Reset current worktree to origin/main. Cleans stale branches, resets to main, and runs npm install on all worktrees.
disable-model-invocation: true
allowed-tools: Bash, AskUserQuestion
---

# Reset worktree to origin/main

Perform the following steps to reset the current worktree branch to origin/main:

1. Kill any active background job

2. **Check for uncommitted changes**: Run `git status` to see if there are any staged or unstaged changes. If there are uncommitted changes, stop and inform the user - they need to commit or stash these changes first.

3. **Check for untracked files**: Run `git status` to list any untracked files. If untracked files exist:
   - Analyze each untracked file to determine if it's throwaway code (temp files, test outputs, build artifacts, etc.) or potentially important work
   - If you're uncertain about any file, use AskUserQuestion to ask the user whether each uncertain file should be deleted or kept
   - Only proceed with cleanup if the user confirms all untracked files can be deleted

4. **Run git clean**: If the user confirms cleanup (or if all untracked files are clearly throwaway), run `git clean -df` from the root of the repository to remove untracked files and directories.

5. **Reset state**: Run the m.sh script located next to this SKILL.md file:

```bash
bash "$(find ~/.claude -path '*/worktree-reset/skills/m/m.sh' 2>/dev/null | head -1)"
```

Report the final status to the user when complete.
