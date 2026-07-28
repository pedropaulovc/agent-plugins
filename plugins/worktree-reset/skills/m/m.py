#!/usr/bin/env python3
"""Reset one worktree, or rebase every linked worktree onto origin/main."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys
from typing import List, Optional


def use_utf8_streams() -> None:
    """Emit UTF-8 whatever the console codepage is, so printed branch names survive."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8", errors="replace")


def run(*args: str, cwd: Optional[Path] = None, capture_output: bool = False) -> subprocess.CompletedProcess:
    # git speaks UTF-8, but text mode decodes captured output with the locale codepage —
    # cp1252 on a stock Windows box. `git branch -vv` carries commit subjects, so a
    # single emoji in someone's commit message would otherwise raise UnicodeDecodeError
    # and take the reset down before any worktree was touched (issue #67).
    return subprocess.run(
        args,
        cwd=cwd,
        check=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=capture_output,
    )


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


def stale_branches() -> List[str]:
    branches = run("git", "branch", "-vv", capture_output=True).stdout.splitlines()
    stale: List[str] = []

    for branch in branches:
        if ": gone]" not in branch or "C:/src/codjiflo" in branch:
            continue

        name = branch.lstrip("* ").split(maxsplit=1)[0]
        if name:
            stale.append(name)

    return stale


def delete_stale_branches() -> None:
    for branch in stale_branches():
        subprocess.run(
            ("git", "branch", "-D", branch),
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def worktrees() -> List[Path]:
    output = run("git", "worktree", "list", "--porcelain", capture_output=True).stdout
    prefix = "worktree "
    return [Path(line[len(prefix) :]) for line in output.splitlines() if line.startswith(prefix)]


def reset_current_worktree(current_worktree: Path, folder_name: str) -> None:
    run("git", "checkout", "main", cwd=current_worktree)
    run("git", "reset", "--hard", "origin/main", cwd=current_worktree)

    if folder_name == "main":
        return

    branch_exists = subprocess.run(
        ("git", "show-ref", "--verify", "--quiet", f"refs/heads/{folder_name}"),
        cwd=current_worktree,
        check=False,
    ).returncode == 0
    if not branch_exists:
        return

    run("git", "checkout", folder_name, cwd=current_worktree)
    run("git", "reset", "--hard", "origin/main", cwd=current_worktree)
    subprocess.run(("git", "branch", "--unset-upstream"), cwd=current_worktree, check=False)


def update_worktree(worktree: Path) -> None:
    branch = run("git", "branch", "--show-current", cwd=worktree, capture_output=True).stdout.strip()
    print(f"Rebasing {branch} onto origin/main...")

    rebase = subprocess.run(("git", "rebase", "origin/main"), cwd=worktree, check=False)
    if rebase.returncode:
        print("Rebase failed or had conflicts, aborting...")
        subprocess.run(("git", "rebase", "--abort"), cwd=worktree, check=False)

    install_dependencies(worktree)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--all", action="store_true", help="update all linked worktrees")
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

    run("git", "fetch", "--prune", cwd=current_worktree)
    delete_stale_branches()
    reset_current_worktree(current_worktree, folder_name)
    install_dependencies(current_worktree)

    if not args.all:
        print("\n=== Current worktree updated ===")
        return 0

    for worktree in worktrees():
        if worktree.resolve() == current_worktree or not (worktree / ".git").is_file():
            continue

        print(f"\n\n=== Updating worktree: {worktree} ===")
        update_worktree(worktree)

    print("\n=== All worktrees updated ===")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        print(f"Command failed ({error.returncode}): {' '.join(error.cmd)}", file=sys.stderr)
        raise SystemExit(error.returncode)
