#!/bin/bash
set -e

RESET_ALL=false
FORCE=false
BASE=""
FOLDER_NAME=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --all) RESET_ALL=true ;;
        --force) FORCE=true ;;
        --base) shift; BASE="$1" ;;
        --base=*) BASE="${1#--base=}" ;;
        *) FOLDER_NAME="$1" ;;
    esac
    shift
done

# Ref to reset every worktree onto. Default matches the historical behaviour.
BASE="${BASE:-origin/main}"

CURRENT_WORKTREE=$(pwd)
FOLDER_NAME="${FOLDER_NAME:-$(basename "$CURRENT_WORKTREE")}"

# Local branch HEAD lands on. For origin/<x> that's <x>; for a tag/SHA/other ref
# we stay on whatever branch is current and just hard-reset it.
if [[ "$BASE" == origin/* ]]; then
    LAND_BRANCH="${BASE#origin/}"
else
    LAND_BRANCH="$(git branch --show-current)"
fi

install_deps() {
    if [[ -f package.json ]]; then
        echo "Found package.json, running npm install..."
        npm install
    fi
    if [[ -f go.mod ]]; then
        echo "Found go.mod, running go mod download..."
        go mod download
    fi
}

# Kill orphaned monitor / background-job pipelines. These outlive a /clear (they run
# under the previous session ID) so the harness task tooling can't see them; the only
# reliable teardown is an OS-level process sweep. Monitor/background-job pipelines are
# identifiable by a command line referencing a .../claude/<project>/<session>/tasks/
# <task-id>.output file (bash/tail/sleep processes). We exclude this script and its
# parent so the sweep never kills the /m run itself.
sweep_orphan_tasks() {
    case "$(uname -s)" in
        MINGW*|MSYS*|CYGWIN*)
            # git-bash on native Windows: the monitors are Windows processes.
            command -v powershell.exe >/dev/null 2>&1 || return 0
            powershell.exe -NoProfile -Command '
                Get-CimInstance Win32_Process |
                  Where-Object { ($_.CommandLine ?? "") -match "claude\\.*\\tasks\\\w+\.output" } |
                  ForEach-Object {
                      Write-Output ("killing " + $_.ProcessId + " " + $_.Name)
                      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
                  }' 2>/dev/null || true
            ;;
        *)
            local pids
            pids=$(ps ax -o pid=,args= 2>/dev/null \
                | grep -E 'claude/.*/tasks/[A-Za-z0-9_-]+\.output' \
                | grep -v grep \
                | awk -v self="$$" -v parent="$PPID" '$1 != self && $1 != parent {print $1}')
            if [[ -n "$pids" ]]; then
                echo "Killing orphaned monitor/background-job processes:" $pids
                echo "$pids" | xargs -r kill 2>/dev/null || true
            fi
            ;;
    esac
}

sweep_orphan_tasks

# Clear a stale lock from a crashed git process, then abort any half-finished
# operation (harmless no-ops when nothing is in progress). Lock first: the aborts
# themselves need the index lock.
rm -f .git/index.lock
git rebase --abort 2>/dev/null || true
git merge --abort 2>/dev/null || true
git cherry-pick --abort 2>/dev/null || true
git am --abort 2>/dev/null || true

# In --force mode, discard everything: untracked + git-ignored files and all stashes.
# Do this before the checkout so a dirty tree can't block it. `git clean` only removes
# untracked/ignored files; CO_FLAGS=-f additionally lets the checkout below overwrite
# tracked modifications that differ from the base branch.
CO_FLAGS=""
if [[ "$FORCE" == "true" ]]; then
    git clean -fdx .
    git stash clear 2>/dev/null || true
    CO_FLAGS="-f"
fi

# Fetch/prune remote tracking branches and drop bookkeeping for gone worktrees.
git fetch --prune
git worktree prune

# Delete stale local branches (whose remote is gone), excluding worktree branches
git branch -vv \
    | { grep ': gone]' || [[ $? -eq 1 ]]; } \
    | grep -v 'C:/src/codjiflo' \
    | awk '{print $1}' \
    | { xargs -r git branch -D 2>/dev/null || true; }

# Reset current worktree to the base ref
git checkout $CO_FLAGS "$LAND_BRANCH" 2>/dev/null || git checkout $CO_FLAGS -b "$LAND_BRANCH" "$BASE"
git reset --hard "$BASE"

# If the folder name matches a separate branch (worktree workflow), reset it too
if [[ "$FOLDER_NAME" != "$LAND_BRANCH" ]] && git show-ref --verify --quiet "refs/heads/$FOLDER_NAME"; then
    git checkout $CO_FLAGS "$FOLDER_NAME"
    git reset --hard "$BASE"
    git branch --unset-upstream 2>/dev/null || true
fi

# Install dependencies in current worktree
install_deps

if [[ "$RESET_ALL" != "true" ]]; then
    echo ""
    echo "=== Current worktree updated ==="
    exit 0
fi

# Rebase and reinstall deps in all other worktrees
git worktree list --porcelain | grep '^worktree ' | cut -d' ' -f2- | while read -r worktree_path; do
    # Skip the main repo and current worktree
    if [[ "$worktree_path" == "$CURRENT_WORKTREE" ]]; then
        continue
    fi

    # Skip if it's the main repository (not a linked worktree)
    if [[ ! -f "$worktree_path/.git" ]]; then
        continue
    fi

    echo ""
    echo ""
    echo "=== Updating worktree: $worktree_path ==="

    # Rebase the worktree branch onto the base ref
    (
        cd "$worktree_path"
        current_branch=$(git branch --show-current)
        echo "Rebasing $current_branch onto $BASE..."
        git rebase "$BASE" || {
            echo "Rebase failed or had conflicts, aborting..."
            git rebase --abort 2>/dev/null || true
        }
        install_deps
    )
done

echo ""
echo "=== All worktrees updated ==="
