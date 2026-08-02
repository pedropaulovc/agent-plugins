#!/usr/bin/env python
"""Reset one worktree, or rebase every linked worktree onto origin/main."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


COMMAND_TIMEOUT_SECONDS = 300
LOCK_RECENCY_SECONDS = 30
REVIEWED_PATHS_FILE = "worktree-reset-reviewed-paths"


class ResetBlocked(RuntimeError):
    """Raised when the safety checks require an explicit user decision."""


def use_utf8_streams() -> None:
    """Emit UTF-8 whatever the console codepage is, so printed branch names survive."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8", errors="replace")


def run(
    *args: str | bytes,
    cwd: Path | None = None,
    capture_output: bool = False,
    check: bool = True,
    timeout: float | None = None,
    text: bool = True,
) -> subprocess.CompletedProcess:
    # git speaks UTF-8, but text mode decodes captured output with the locale codepage —
    # cp1252 on a stock Windows box. `git branch -vv` carries commit subjects, so a
    # single emoji in someone's commit message would otherwise raise UnicodeDecodeError
    # and take the reset down before any worktree was touched (issue #67).
    return subprocess.run(
        args,
        cwd=cwd,
        check=check,
        text=text,
        encoding="utf-8" if text else None,
        errors="replace" if text else None,
        capture_output=capture_output,
        timeout=timeout,
    )


def git(
    *args: str | bytes,
    cwd: Path,
    capture_output: bool = False,
    check: bool = True,
    timeout: float | None = None,
    text: bool = True,
) -> subprocess.CompletedProcess:
    return run(
        "git",
        *args,
        cwd=cwd,
        capture_output=capture_output,
        check=check,
        timeout=timeout,
        text=text,
    )


def install_dependencies(worktree: Path) -> None:
    if (worktree / "package.json").is_file():
        print("Found package.json, running npm install...")
        run("npm", "install", cwd=worktree, timeout=COMMAND_TIMEOUT_SECONDS)

    if (worktree / "go.mod").is_file():
        print("Found go.mod, running go mod download...")
        run("go", "mod", "download", cwd=worktree, timeout=COMMAND_TIMEOUT_SECONDS)

    if (worktree / "pyproject.toml").is_file() and (worktree / "uv.lock").is_file():
        print("Found pyproject.toml and uv.lock, running uv sync --locked...")
        run("uv", "sync", "--locked", cwd=worktree, timeout=COMMAND_TIMEOUT_SECONDS)


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


def path_is_within(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
    except ValueError:
        return False
    return True


def process_name(command_line: str) -> str:
    executable = command_line.split(maxsplit=1)[0].strip("'\"")
    return Path(executable).name.lower()


def process_cwd(pid: int) -> Path | None:
    if os.name == "nt":
        return None
    try:
        return Path(os.readlink(f"/proc/{pid}/cwd"))
    except (FileNotFoundError, OSError):
        return None


def git_process_running(worktree: Path, lock: Path) -> bool:
    if os.name == "nt":
        tasklist = shutil.which("tasklist")
        if not tasklist:
            return False
        result = subprocess.run(
            (tasklist, "/FI", "IMAGENAME eq git.exe", "/NH"),
            check=False,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
        )
        if "git.exe" not in result.stdout.lower():
            return False
        try:
            return time.time() - lock.stat().st_mtime <= LOCK_RECENCY_SECONDS
        except FileNotFoundError:
            return False

    ps = shutil.which("ps")
    if not ps:
        return False
    result = subprocess.run(
        (ps, "-eo", "pid=,args="),
        check=False,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
    )
    gitdir = git_directory(worktree)
    for line in result.stdout.splitlines():
        fields = line.strip().split(maxsplit=1)
        if len(fields) != 2:
            continue
        try:
            pid = int(fields[0])
        except ValueError:
            continue
        if pid == os.getpid():
            continue

        command_line = fields[1]
        name = process_name(command_line)
        if name != "git" and not name.startswith("git-"):
            continue

        cwd = process_cwd(pid)
        if cwd and path_is_within(cwd, worktree):
            return True
        if str(worktree) in command_line or str(gitdir) in command_line:
            return True

    return False


def clear_stale_index_lock(worktree: Path) -> None:
    lock = git_directory(worktree) / "index.lock"
    try:
        initial = lock.stat()
    except FileNotFoundError:
        return

    if git_process_running(worktree, lock):
        raise ResetBlocked(f"refusing to remove active Git lock: {lock}")

    try:
        current = lock.stat()
    except FileNotFoundError:
        return
    if (current.st_ino, current.st_size, current.st_mtime_ns) != (
        initial.st_ino,
        initial.st_size,
        initial.st_mtime_ns,
    ):
        raise ResetBlocked(f"Git lock changed while checking it: {lock}")
    if git_process_running(worktree, lock):
        raise ResetBlocked(f"refusing to remove active Git lock: {lock}")
    lock.unlink(missing_ok=True)


def abort_git_operations(worktree: Path) -> None:
    for operation in (
        ("rebase", "--abort"),
        ("merge", "--abort"),
        ("cherry-pick", "--abort"),
        ("am", "--abort"),
    ):
        git(*operation, cwd=worktree, capture_output=True, check=False)


def status_entries(worktree: Path) -> list[bytes]:
    result = git(
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "-z",
        cwd=worktree,
        capture_output=True,
        text=False,
    )
    return [entry for entry in result.stdout.split(b"\0") if entry]


def stash_entries(worktree: Path) -> list[str]:
    result = git("stash", "list", cwd=worktree, capture_output=True)
    return [line for line in result.stdout.splitlines() if line]


def untracked_path(entry: bytes) -> bytes:
    return entry[3:]


def reviewed_paths_file(worktree: Path) -> Path:
    return git_directory(worktree) / REVIEWED_PATHS_FILE


def save_reviewed_paths(worktree: Path, paths: list[bytes]) -> None:
    reviewed_paths_file(worktree).write_bytes(b"\0".join(paths) + b"\0")


def load_reviewed_paths(worktree: Path) -> list[bytes]:
    try:
        snapshot = reviewed_paths_file(worktree).read_bytes()
    except FileNotFoundError:
        return []
    return [path for path in snapshot.split(b"\0") if path]


def clear_reviewed_paths(worktree: Path) -> None:
    reviewed_paths_file(worktree).unlink(missing_ok=True)


def literal_path(path: bytes) -> bytes:
    return b":(literal)" + path


def display_entries(entries: list[bytes]) -> str:
    return "\n".join(os.fsdecode(entry) for entry in entries)


def prepare_worktree(worktree: Path, args: argparse.Namespace) -> None:
    entries = status_entries(worktree)
    tracked = [entry for entry in entries if not entry.startswith(b"??")]
    untracked = [entry for entry in entries if entry.startswith(b"??")]

    if args.force:
        git("clean", "-fdx", ".", cwd=worktree)
        # --force intentionally drops the repository-wide stash stack. This is the
        # explicit destructive mode; normal mode always preserves and reports stashes.
        git("stash", "clear", cwd=worktree, check=False)
        clear_reviewed_paths(worktree)
        return

    if tracked:
        print("Reset stopped: the worktree has uncommitted changes:", file=sys.stderr)
        print(display_entries(tracked), file=sys.stderr)
        raise ResetBlocked("preserve tracked changes outside this worktree, or use --force")

    if args.confirm:
        reviewed = load_reviewed_paths(worktree)
        if not reviewed:
            raise ResetBlocked("no reviewed untracked-file snapshot; rerun without --confirm")
        git(
            "clean",
            "-df",
            "--",
            *(literal_path(path) for path in reviewed),
            cwd=worktree,
        )
        clear_reviewed_paths(worktree)
    elif untracked:
        reviewed = [untracked_path(entry) for entry in untracked]
        save_reviewed_paths(worktree, reviewed)
        print("Reset stopped: the worktree has untracked files:", file=sys.stderr)
        print(display_entries(untracked), file=sys.stderr)
        raise ResetBlocked("review them, then rerun with --confirm or --force")
    else:
        clear_reviewed_paths(worktree)

    stashes = stash_entries(worktree)
    if stashes:
        print("Stashes preserved:")
        print("\n".join(stashes))


def stale_branches(worktree: Path) -> list[str]:
    branches = git("branch", "-vv", cwd=worktree, capture_output=True).stdout.splitlines()
    stale: list[str] = []

    for branch in branches:
        if ": gone]" not in branch:
            continue

        name = branch.lstrip("*+ ").split(maxsplit=1)[0]
        if name:
            stale.append(name)

    return stale


def delete_stale_branches(worktree: Path) -> None:
    for branch in stale_branches(worktree):
        git("branch", "-D", branch, cwd=worktree, check=False)


def worktrees(worktree: Path) -> list[Path]:
    output = git("worktree", "list", "--porcelain", cwd=worktree, capture_output=True).stdout
    prefix = "worktree "
    return [Path(line[len(prefix) :]) for line in output.splitlines() if line.startswith(prefix)]


def reset_current_worktree(current_worktree: Path, folder_name: str, *, force: bool) -> None:
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
    if not branch_exists or not force:
        return

    # A folder-named branch is an optional destructive reset. Require --force so a
    # normal reset cannot discard its committed history after a safety rerun.
    checkout = ["checkout", "-f", folder_name]
    git(*checkout, cwd=current_worktree)
    git("reset", "--hard", "origin/main", cwd=current_worktree)
    git("branch", "--unset-upstream", cwd=current_worktree, check=False)


def update_worktree(worktree: Path) -> bool:
    try:
        branch = git("branch", "--show-current", cwd=worktree, capture_output=True).stdout.strip()
        print(f"Rebasing {branch} onto origin/main...")

        rebase = git("rebase", "origin/main", cwd=worktree, check=False)
        succeeded = rebase.returncode == 0
        if not succeeded:
            print("Rebase failed or had conflicts, aborting...")
            git("rebase", "--abort", cwd=worktree, capture_output=True, check=False)

        install_dependencies(worktree)
        return succeeded
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(f"Worktree update failed for {worktree}: {error}", file=sys.stderr)
        return False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--all", action="store_true", help="update all linked worktrees")
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="remove reviewed untracked files after explicit confirmation",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="discard tracked, untracked, ignored, and stashed changes without confirmation",
    )
    parser.add_argument("folder_name", nargs="?", help="branch to reset after updating main")
    return parser.parse_args()


def command_text(command: object) -> str:
    if isinstance(command, (tuple, list)):
        return " ".join(str(part) for part in command)
    return str(command)


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
    git("fetch", "--prune", cwd=current_worktree, timeout=COMMAND_TIMEOUT_SECONDS)
    git("worktree", "prune", cwd=current_worktree)
    delete_stale_branches(current_worktree)
    reset_current_worktree(current_worktree, folder_name, force=args.force)
    install_dependencies(current_worktree)

    if not args.all:
        print("\n=== Current worktree updated ===")
        return 0

    failed_worktrees: list[Path] = []
    for worktree in worktrees(current_worktree):
        if worktree.resolve() == current_worktree or not (worktree / ".git").is_file():
            continue

        print(f"\n\n=== Updating worktree: {worktree} ===")
        if not update_worktree(worktree):
            failed_worktrees.append(worktree)

    if failed_worktrees:
        print("\n=== Worktrees failed ===", file=sys.stderr)
        print("\n".join(str(worktree) for worktree in failed_worktrees), file=sys.stderr)
        return 1

    print("\n=== All worktrees updated ===")
    return 0


def main_entry() -> int:
    try:
        return main()
    except ResetBlocked as error:
        print(f"Command not run: {error}", file=sys.stderr)
        return 2
    except FileNotFoundError as error:
        print(f"Executable not found: {error.filename}", file=sys.stderr)
        return 127
    except subprocess.TimeoutExpired as error:
        print(f"Command timed out after {COMMAND_TIMEOUT_SECONDS}s: {command_text(error.cmd)}", file=sys.stderr)
        return 124
    except subprocess.CalledProcessError as error:
        print(f"Command failed ({error.returncode}): {command_text(error.cmd)}", file=sys.stderr)
        return error.returncode


if __name__ == "__main__":
    raise SystemExit(main_entry())
