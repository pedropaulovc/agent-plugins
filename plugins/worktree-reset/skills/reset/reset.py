#!/usr/bin/env python
"""Reset one worktree, or rebase every linked worktree onto origin/main."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys
from typing import List, Optional


class ResetBlocked(RuntimeError):
    """Raised when the safety checks require an explicit user decision."""


def use_utf8_streams() -> None:
    """Emit UTF-8 whatever the console codepage is, so printed branch names survive."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8", errors="replace")


def run(
    *args: str,
    cwd: Optional[Path] = None,
    capture_output: bool = False,
    check: bool = True,
) -> subprocess.CompletedProcess:
    # git speaks UTF-8, but text mode decodes captured output with the locale codepage —
    # cp1252 on a stock Windows box. `git branch -vv` carries commit subjects, so a
    # single emoji in someone's commit message would otherwise raise UnicodeDecodeError
    # and take the reset down before any worktree was touched (issue #67).
    return subprocess.run(
        args,
        cwd=cwd,
        check=check,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=capture_output,
    )


def git(
    *args: str,
    cwd: Path,
    capture_output: bool = False,
    check: bool = True,
) -> subprocess.CompletedProcess:
    return run("git", *args, cwd=cwd, capture_output=capture_output, check=check)


def install_dependencies(worktree: Path) -> None:
    if (worktree / "package.json").is_file():
        print("Found package.json, running npm install...")
        run("npm", "install", cwd=worktree)

    if (worktree / "go.mod").is_file():
        print("Found go.mod, running go mod download...")
        run("go", "mod", "download", cwd=worktree)

    if (worktree / "pyproject.toml").is_file() and (worktree / "uv.lock").is_file():
        print("Found pyproject.toml and uv.lock, running uv sync --locked...")
        run("uv", "sync", "--locked", cwd=worktree)


def git_directory(worktree: Path) -> Path:
    dot_git = worktree / ".git"
    if not dot_git.is_file():
        return dot_git

    contents = dot_git.read_text(encoding="utf-8").strip()
    if not contents.startswith("gitdir:"):
        return dot_git

    gitdir = Path(contents.partition(":")[2].strip())
    if not gitdir.is_absolute():
        gitdir = dot_git.parent / gitdir
    return gitdir.resolve()


def git_process_running() -> bool:
    if os.name == "nt":
        try:
            result = subprocess.run(
                ("tasklist", "/FI", "IMAGENAME eq git.exe", "/NH"),
                check=False,
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
            )
        except FileNotFoundError:
            return False
        return "git.exe" in result.stdout.lower()

    try:
        result = subprocess.run(
            ("pgrep", "-x", "git"),
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        return False
    return result.returncode == 0


def clear_stale_index_lock(worktree: Path) -> None:
    lock = git_directory(worktree) / "index.lock"
    if not lock.exists():
        return
    if git_process_running():
        raise ResetBlocked(f"refusing to remove active Git lock: {lock}")
    lock.unlink()


def abort_git_operations(worktree: Path) -> None:
    for operation in (
        ("rebase", "--abort"),
        ("merge", "--abort"),
        ("cherry-pick", "--abort"),
        ("am", "--abort"),
    ):
        git(*operation, cwd=worktree, check=False)


def status_entries(worktree: Path) -> List[str]:
    result = git(
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        cwd=worktree,
        capture_output=True,
    )
    return [line for line in result.stdout.splitlines() if line]


def stash_entries(worktree: Path) -> List[str]:
    result = git("stash", "list", cwd=worktree, capture_output=True)
    return [line for line in result.stdout.splitlines() if line]


def prepare_worktree(worktree: Path, args: argparse.Namespace) -> None:
    entries = status_entries(worktree)
    tracked = [entry for entry in entries if not entry.startswith("??")]
    untracked = [entry for entry in entries if entry.startswith("??")]

    if args.force:
        git("clean", "-fdx", ".", cwd=worktree)
        git("stash", "clear", cwd=worktree, check=False)
        return

    if tracked:
        print("Reset stopped: the worktree has uncommitted changes:", file=sys.stderr)
        print("\n".join(tracked), file=sys.stderr)
        raise ResetBlocked("commit or stash tracked changes, or use --force")

    if untracked and not args.clean:
        print("Reset stopped: the worktree has untracked files:", file=sys.stderr)
        print("\n".join(untracked), file=sys.stderr)
        raise ResetBlocked("review them, then rerun with --clean or --force")

    if untracked:
        git("clean", "-df", ".", cwd=worktree)

    stashes = stash_entries(worktree)
    if stashes:
        print("Stashes preserved:")
        print("\n".join(stashes))


def stale_branches(worktree: Path) -> List[str]:
    branches = git("branch", "-vv", cwd=worktree, capture_output=True).stdout.splitlines()
    stale: List[str] = []

    for branch in branches:
        if ": gone]" not in branch or "C:/src/codjiflo" in branch:
            continue

        name = branch.lstrip("* ").split(maxsplit=1)[0]
        if name:
            stale.append(name)

    return stale


def delete_stale_branches(worktree: Path) -> None:
    for branch in stale_branches(worktree):
        git("branch", "-D", branch, cwd=worktree, check=False)


def worktrees(worktree: Path) -> List[Path]:
    output = git("worktree", "list", "--porcelain", cwd=worktree, capture_output=True).stdout
    prefix = "worktree "
    return [Path(line[len(prefix) :]) for line in output.splitlines() if line.startswith(prefix)]


def reset_current_worktree(current_worktree: Path, folder_name: str, force: bool) -> None:
    checkout = ["checkout"]
    if force:
        checkout.append("-f")
    checkout.append("main")
    git(*checkout, cwd=current_worktree)
    git("reset", "--hard", "origin/main", cwd=current_worktree)

    if folder_name == "main":
        return

    branch_exists = (
        git(
            "show-ref",
            "--verify",
            "--quiet",
            f"refs/heads/{folder_name}",
            cwd=current_worktree,
            check=False,
        ).returncode
        == 0
    )
    if not branch_exists:
        return

    checkout = ["checkout"]
    if force:
        checkout.append("-f")
    checkout.append(folder_name)
    git(*checkout, cwd=current_worktree)
    git("reset", "--hard", "origin/main", cwd=current_worktree)
    git("branch", "--unset-upstream", cwd=current_worktree, check=False)


def update_worktree(worktree: Path) -> None:
    branch = git("branch", "--show-current", cwd=worktree, capture_output=True).stdout.strip()
    print(f"Rebasing {branch} onto origin/main...")

    rebase = git("rebase", "origin/main", cwd=worktree, check=False)
    if rebase.returncode:
        print("Rebase failed or had conflicts, aborting...")
        git("rebase", "--abort", cwd=worktree, check=False)

    install_dependencies(worktree)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--all", action="store_true", help="update all linked worktrees")
    parser.add_argument(
        "--clean",
        action="store_true",
        help="remove reviewed untracked files without removing ignored files",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="discard tracked, untracked, ignored, and stashed changes without confirmation",
    )
    parser.add_argument("folder_name", nargs="?", help="branch to reset after updating main")
    return parser.parse_args()


def main() -> int:
    use_utf8_streams()
    args = parse_args()
    actual_worktree = Path.cwd()
    inherited_pwd = Path(os.environ.get("PWD", str(actual_worktree)))
    logical_worktree = inherited_pwd if inherited_pwd.resolve() == actual_worktree.resolve() else actual_worktree
    current_worktree = logical_worktree.resolve()
    folder_name = args.folder_name or logical_worktree.name

    clear_stale_index_lock(current_worktree)
    abort_git_operations(current_worktree)
    prepare_worktree(current_worktree, args)
    git("fetch", "--prune", cwd=current_worktree)
    git("worktree", "prune", cwd=current_worktree)
    delete_stale_branches(current_worktree)
    reset_current_worktree(current_worktree, folder_name, args.force)
    install_dependencies(current_worktree)

    if not args.all:
        print("\n=== Current worktree updated ===")
        return 0

    for worktree in worktrees(current_worktree):
        if worktree.resolve() == current_worktree or not (worktree / ".git").is_file():
            continue

        print(f"\n\n=== Updating worktree: {worktree} ===")
        update_worktree(worktree)

    print("\n=== All worktrees updated ===")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ResetBlocked as error:
        print(f"Command not run: {error}", file=sys.stderr)
        raise SystemExit(2)
    except subprocess.CalledProcessError as error:
        print(f"Command failed ({error.returncode}): {' '.join(error.cmd)}", file=sys.stderr)
        raise SystemExit(error.returncode)
