#!/usr/bin/env python
"""Behavior tests for the Python worktree-reset helper."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "skills" / "reset" / "reset.py"

# Pins the interpreter to its locale codepage — cp1252 on a stock Windows box, ASCII
# under LC_ALL=C elsewhere — which is what made git's UTF-8 output undecodable in
# issue #67. Without PYTHONUTF8=0, a UTF-8-mode default would hide the bug.
LOCALE_CODEPAGE = {
    "PYTHONUTF8": "0",
    "PYTHONCOERCECLOCALE": "0",
    "PYTHONIOENCODING": "",
    "LC_ALL": "C",
    "LANG": "C",
}

# Commit subjects reach the script through `git branch -vv`, so any emoji in someone's
# history lands in captured output; the ZWJ here encodes the byte cp1252 has no mapping for.
COMMIT_SUBJECT = "tidy up \U0001F468\u200D\U0001F4BB"
CURRENT_BRANCH = "feature-\U0001F4A5"


class WorktreeResetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        self.repo = self.root / "main"
        self.linked = self.root / "feature"
        self.second_linked = self.root / "feature-two"
        self.bare = self.root / "bare.git"
        self.subdir = self.root / "main-subdir"
        self.bin = self.root / "bin"
        self.repo.mkdir()
        self.subdir.mkdir()
        self.linked.mkdir()
        self.second_linked.mkdir()
        self.bare.mkdir()
        self.bin.mkdir()
        (self.repo / ".git").mkdir()
        (self.linked / ".git").write_text(f"gitdir: {self.repo / '.git' / 'worktrees' / 'feature'}\n")
        (self.second_linked / ".git").write_text(
            f"gitdir: {self.repo / '.git' / 'worktrees' / 'feature-two'}\n"
        )
        (self.repo / "package.json").write_text("{}")
        (self.linked / "go.mod").write_text("module example.com/feature\n")
        (self.linked / "pyproject.toml").write_text("[project]\nname = 'feature'\nversion = '0.0.0'\n")
        (self.linked / "uv.lock").write_text("version = 1\n")
        self.log = self.root / "commands.log"
        self._write_fake_command("git", self._fake_git())
        self._write_fake_command("ps", self._fake_ps())
        self._write_fake_command("npm", "#!/bin/sh\nprintf 'npm %s\\n' \"$*\" >> \"$COMMAND_LOG\"\n")
        self._write_fake_command("go", "#!/bin/sh\nprintf 'go %s\\n' \"$*\" >> \"$COMMAND_LOG\"\n")
        self._write_fake_command("uv", "#!/bin/sh\nprintf 'uv %s\\n' \"$*\" >> \"$COMMAND_LOG\"\n")

    def tearDown(self) -> None:
        shutil.rmtree(self.root)

    def _write_fake_command(self, name: str, content: str) -> None:
        command = self.bin / name
        command.write_text(content)
        command.chmod(0o755)

    def _fake_git(self) -> str:
        return f'''#!/bin/sh
printf 'git %s [cwd=%s]\\n' "$*" "$PWD" >> "$COMMAND_LOG"
case "$*" in
  'status --porcelain=v1 --untracked-files=all -z')
    if [ -n "${{STATUS_OUTPUT_NUL:-}}" ]; then printf '%s\\0' "$STATUS_OUTPUT_NUL"; fi
    if [ -n "${{STATUS_OUTPUT:-}}" ]; then
      printf '%s\\n' "$STATUS_OUTPUT" | while IFS= read -r entry; do printf '%s\\0' "$entry"; done
    fi
    ;;
  'status --porcelain=v1 --untracked-files=all -z --ignore-submodules=none')
    if [ -n "${{FINAL_STATUS_OUTPUT:-}}" ]; then
      printf '%s\\n' "$FINAL_STATUS_OUTPUT" | while IFS= read -r entry; do printf '%s\\0' "$entry"; done
    fi
    ;;
  'stash list')
    if [ -n "${{STASH_OUTPUT:-}}" ]; then printf '%s\\n' "$STASH_OUTPUT"; fi
    ;;
  'submodule sync --recursive') ;;
  'submodule update --init --recursive')
    if [ -n "${{SUBMODULE_UPDATE_FAIL:-}}" ]; then
      printf 'submodule update failed\\n' >&2
      exit 1
    fi
    ;;
  'submodule status --recursive')
    if [ -n "${{SUBMODULE_STATUS_OUTPUT:-}}" ]; then printf '%s\\n' "$SUBMODULE_STATUS_OUTPUT"; fi
    ;;
  'branch -vv')
    printf '%s\\n' '  stale abc123 [origin/stale: gone] {COMMIT_SUBJECT}' '  +linked abc [origin/linked: gone]'
    ;;
  'rev-parse --show-toplevel') printf '%s\\n' "${{TOP_LEVEL:-$PWD}}" ;;
  'rev-parse --verify --quiet refs/remotes/origin/main')
    if [ -n "${{MISSING_ORIGIN_MAIN:-}}" ]; then exit 1; fi
    ;;
  'worktree list --porcelain')
    if [ -n "${{BARE_WORKTREE:-}}" ]; then
      printf 'worktree %s\\nHEAD bare\\nbare\\n\\n' "$BARE_WORKTREE"
      printf 'worktree {self.linked}\\nHEAD two\\nbranch refs/heads/main\\n\\n'
    else
      printf 'worktree {self.repo}\\nHEAD one\\nbranch refs/heads/main\\n\\n'
      printf 'worktree {self.linked}\\nHEAD two\\nbranch refs/heads/feature\\n'
      if [ "$DETACHED_LINKED" = "{self.linked}" ]; then
        printf 'detached\\n'
      fi
      printf '\\n'
    fi
    if [ -n "${{SECOND_LINKED:-}}" ]; then
      printf 'worktree %s\\nHEAD three\\nbranch refs/heads/feature-two\\n' "$SECOND_LINKED"
      if [ "$LOCKED_LINKED" = "{self.second_linked}" ]; then
        printf 'locked\\n'
      fi
    fi
    ;;
  'worktree remove --force --force '*)
    if [ "$FAIL_REMOVE" = "{self.linked}" ] && [ "$*" = "worktree remove --force --force $FAIL_REMOVE" ]; then exit 1; fi
    ;;
  'branch --show-current') printf '{CURRENT_BRANCH}\\n' ;;
  'rebase origin/main')
    if [ "${{REBASE_STATUS:-1}}" -ne 0 ]; then exit 1; fi
    ;;
esac
'''

    def _fake_ps(self) -> str:
        return '''#!/bin/sh
if [ -n "${ACTIVE_GIT_PATH:-}" ]; then
  sleep 1 >/dev/null 2>&1 &
  printf '%s git %s\n' "$!" "$ACTIVE_GIT_PATH"
fi
'''

    def run_script(
        self,
        *args: str,
        cwd: Path | None = None,
        locale_codepage: bool = False,
        extra_env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment.update({"PATH": f"{self.bin}:{os.environ['PATH']}", "COMMAND_LOG": str(self.log)})
        if locale_codepage:
            environment.update(LOCALE_CODEPAGE)
        if extra_env:
            environment.update(extra_env)
        working_directory = cwd or self.repo
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=working_directory,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            env=environment,
            check=False,
        )

    def test_resets_current_worktree_and_installs_dependencies(self) -> None:
        result = self.run_script()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("=== Current worktree updated ===", result.stdout)
        log = self.log.read_text()
        self.assertIn("git fetch --prune", log)
        self.assertIn("git worktree prune", log)
        self.assertIn("git branch -D stale", log)
        self.assertIn("git branch -D linked", log)
        self.assertIn("git checkout main", log)
        self.assertIn("git reset --hard origin/main", log)
        self.assertIn("npm install", log)

    def test_force_reclaims_main_worktree_and_removes_all_linked_worktrees(self) -> None:
        result = self.run_script(
            "--force",
            cwd=self.repo,
            extra_env={
                "SECOND_LINKED": str(self.second_linked),
                "LOCKED_LINKED": str(self.second_linked),
            },
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("=== Main worktree reclaimed; linked worktrees removed ===", result.stdout)
        log = self.log.read_text()
        self.assertIn(f"git worktree remove --force --force {self.linked} [cwd={self.repo}]", log)
        self.assertIn(f"git worktree remove --force --force {self.second_linked} [cwd={self.repo}]", log)
        self.assertIn(f"git checkout -f -B main origin/main [cwd={self.repo}]", log)
        self.assertNotIn("git checkout -f feature", log)

    def test_force_syncs_submodules_and_verifies_submodule_state(self) -> None:
        result = self.run_script(
            "--force",
            extra_env={"SUBMODULE_STATUS_OUTPUT": " abc123 sub (heads/main)"},
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        log = self.log.read_text()
        reset = log.index("git reset --hard origin/main")
        sync = log.index("git submodule sync --recursive")
        update = log.index("git submodule update --init --recursive")
        status = log.index("git submodule status --recursive")
        final_root_status = log.index(
            "git status --porcelain=v1 --untracked-files=all -z --ignore-submodules=none"
        )
        npm = log.index("npm install")
        self.assertLess(reset, sync)
        self.assertLess(sync, update)
        self.assertLess(update, npm)
        self.assertLess(npm, final_root_status)
        self.assertLess(final_root_status, status)
        self.assertIn("=== Main worktree reclaimed; linked worktrees removed ===", result.stdout)

    def test_force_fails_when_submodule_update_fails(self) -> None:
        result = self.run_script("--force", extra_env={"SUBMODULE_UPDATE_FAIL": "1"})

        self.assertEqual(result.returncode, 1)
        self.assertIn("Command failed (1): git submodule update --init --recursive", result.stderr)
        self.assertNotIn("=== Main worktree reclaimed; linked worktrees removed ===", result.stdout)
        self.assertNotIn("npm install", self.log.read_text())

    def test_force_fails_when_submodule_status_reports_drift(self) -> None:
        result = self.run_script(
            "--force",
            extra_env={"SUBMODULE_STATUS_OUTPUT": "+deadbeef sub (heads/main)"},
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("submodules are not at recorded commits", result.stderr)
        self.assertIn("+deadbeef sub (heads/main)", result.stderr)
        self.assertNotIn("=== Main worktree reclaimed; linked worktrees removed ===", result.stdout)

    def test_force_fails_when_final_worktree_status_is_dirty(self) -> None:
        result = self.run_script("--force", extra_env={"FINAL_STATUS_OUTPUT": " M sub"})

        self.assertEqual(result.returncode, 2)
        self.assertIn("worktree changes", result.stderr)
        self.assertIn(" M sub", result.stderr)
        self.assertNotIn("=== Main worktree reclaimed; linked worktrees removed ===", result.stdout)

    def test_force_refuses_to_delete_the_invoking_linked_worktree(self) -> None:
        result = self.run_script("--force", cwd=self.linked)

        self.assertEqual(result.returncode, 2)
        self.assertIn("primary worktree", result.stderr)
        self.assertIn("delete every linked worktree", result.stderr)

        log = self.log.read_text()
        self.assertNotIn("git clean -fdx .", log)
        self.assertNotIn("git fetch --prune", log)
        self.assertNotIn("git worktree remove", log)


    def test_force_accepts_a_primary_worktree_subdirectory(self) -> None:
        result = self.run_script(
            "--force",
            cwd=self.subdir,
            extra_env={"TOP_LEVEL": str(self.repo)},
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"git checkout -f -B main origin/main [cwd={self.repo}]", self.log.read_text())

    def test_force_refuses_bare_repository_layout(self) -> None:
        result = self.run_script(
            "--force",
            cwd=self.linked,
            extra_env={"BARE_WORKTREE": str(self.bare)},
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("bare repositories", result.stderr)
        self.assertNotIn("git worktree remove", self.log.read_text())


    def test_force_all_reports_removal_instead_of_rebases(self) -> None:
        result = self.run_script("--force", "--all")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("=== Main worktree reclaimed; linked worktrees removed ===", result.stdout)
        self.assertNotIn("=== All worktrees updated ===", result.stdout)
        self.assertNotIn("git rebase origin/main", self.log.read_text())

    def test_force_verifies_origin_main_before_cleanup(self) -> None:
        result = self.run_script("--force", extra_env={"MISSING_ORIGIN_MAIN": "1"})

        self.assertEqual(result.returncode, 2)
        self.assertIn("origin/main is unavailable", result.stderr)
        log = self.log.read_text()
        self.assertNotIn("git clean -fdx .", log)

        self.assertNotIn("git stash clear", log)
        self.assertNotIn("git worktree remove", log)

    def test_force_refuses_active_linked_worktree(self) -> None:
        (self.repo / ".git" / "worktrees" / "feature").mkdir(parents=True)
        (self.repo / ".git" / "worktrees" / "feature" / "index.lock").touch()
        result = self.run_script("--force", extra_env={"ACTIVE_GIT_PATH": str(self.linked)})

        self.assertEqual(result.returncode, 2)
        self.assertIn("while a Git operation is active", result.stderr)
        log = self.log.read_text()
        self.assertNotIn("git worktree remove", log)
        self.assertNotIn("git clean -fdx .", log)

    def test_force_refuses_linked_git_operation(self) -> None:
        (self.repo / ".git" / "worktrees" / "feature" / "rebase-merge").mkdir(parents=True)
        result = self.run_script("--force")

        self.assertEqual(result.returncode, 2)
        self.assertIn("while a Git operation is active", result.stderr)
        self.assertNotIn("git worktree remove", self.log.read_text())

    def test_force_refuses_linked_revert_operation(self) -> None:
        gitdir = self.repo / ".git" / "worktrees" / "feature"
        gitdir.mkdir(parents=True)
        (gitdir / "REVERT_HEAD").write_text("revert")
        result = self.run_script("--force")

        self.assertEqual(result.returncode, 2)
        self.assertIn("while a Git operation is active", result.stderr)
        self.assertNotIn("git worktree remove", self.log.read_text())

    def test_force_warns_before_removing_detached_linked_worktree(self) -> None:
        result = self.run_script("--force", extra_env={"DETACHED_LINKED": str(self.linked)})

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("detached linked worktree", result.stderr)
        self.assertIn(f"git worktree remove --force --force {self.linked}", self.log.read_text())

    def test_force_warns_before_removing_dirty_linked_worktree(self) -> None:
        result = self.run_script("--force", extra_env={"STATUS_OUTPUT": " M linked.txt"})

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("uncommitted changes", result.stderr)



    def test_force_continues_removals_after_one_failure(self) -> None:
        result = self.run_script(
            "--force",
            extra_env={
                "SECOND_LINKED": str(self.second_linked),
                "FAIL_REMOVE": str(self.linked),
            },
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn("=== Worktrees failed ===", result.stderr)
        log = self.log.read_text()
        self.assertIn(f"git worktree remove --force --force {self.linked}", log)
        self.assertIn(f"git worktree remove --force --force {self.second_linked}", log)
        self.assertNotIn("git checkout -f -B main origin/main", log)

    def test_all_updates_linked_worktrees_and_reports_failed_rebases(self) -> None:
        result = self.run_script("--all", extra_env={"REBASE_STATUS": "1"})

        self.assertEqual(result.returncode, 1)
        self.assertIn("=== Worktrees failed ===", result.stderr)
        log = self.log.read_text()
        self.assertIn(f"git rebase origin/main [cwd={self.linked}]", log)
        self.assertIn(f"git rebase --abort [cwd={self.linked}]", log)
        self.assertIn("go mod download", log)
        self.assertIn("uv sync --locked", log)

    def test_non_ascii_git_output_survives_a_locale_codepage(self) -> None:
        result = self.run_script("--all", locale_codepage=True, extra_env={"REBASE_STATUS": "0"})

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("git branch -D stale", self.log.read_text())
        self.assertIn(f"Rebasing {CURRENT_BRANCH} onto origin/main", result.stdout)

    def test_blocks_tracked_changes_without_force(self) -> None:
        result = self.run_script(extra_env={"STATUS_OUTPUT": " M tracked.txt"})

        self.assertEqual(result.returncode, 2)
        self.assertIn("uncommitted changes", result.stderr)
        self.assertNotIn("git fetch --prune", self.log.read_text())

    def test_requires_confirmation_for_untracked_files(self) -> None:
        result = self.run_script(extra_env={"STATUS_OUTPUT": "?? disposable.txt"})

        self.assertEqual(result.returncode, 2)
        self.assertIn("untracked files", result.stderr)
        self.assertIn("--confirm", result.stderr)
        self.assertNotIn("git fetch --prune", self.log.read_text())
        self.assertEqual(
            (self.repo / ".git" / "worktree-reset-reviewed-paths").read_bytes(),
            b"disposable.txt\0",
        )

    def test_confirm_removes_only_reviewed_untracked_files(self) -> None:
        review = self.run_script(extra_env={"STATUS_OUTPUT": "?? disposable.txt"})
        self.assertEqual(review.returncode, 2)

        result = self.run_script(
            "--confirm",
            extra_env={"STATUS_OUTPUT": "?? created_after_review.txt"},
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        log = self.log.read_text()
        self.assertIn("git clean -df -- :(literal)disposable.txt", log)
        self.assertNotIn("created_after_review.txt", log)
        self.assertFalse((self.repo / ".git" / "worktree-reset-reviewed-paths").exists())

    def test_confirm_uses_literal_pathspecs(self) -> None:
        review = self.run_script(extra_env={"STATUS_OUTPUT_NUL": "?? *.tmp"})
        self.assertEqual(review.returncode, 2)

        result = self.run_script("--confirm")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("git clean -df -- :(literal)*.tmp", self.log.read_text())

    def test_reviewed_snapshot_preserves_newlines(self) -> None:
        reviewed_name = "line\nbreak.txt"
        result = self.run_script(extra_env={"STATUS_OUTPUT_NUL": f"?? {reviewed_name}"})

        self.assertEqual(result.returncode, 2)
        self.assertEqual(
            (self.repo / ".git" / "worktree-reset-reviewed-paths").read_bytes(),
            reviewed_name.encode() + b"\0",
        )

    def test_confirm_still_blocks_tracked_changes(self) -> None:
        result = self.run_script(
            "--confirm",
            extra_env={"STATUS_OUTPUT": " M tracked.txt"},
        )

        self.assertEqual(result.returncode, 2)
        log = self.log.read_text()
        self.assertNotIn("git clean -df", log)
        self.assertNotIn("git fetch --prune", log)

    def test_force_discards_all_changes_and_stashes(self) -> None:
        result = self.run_script(
            "--force",
            extra_env={"STATUS_OUTPUT": " M tracked.txt\n?? disposable.txt", "STASH_OUTPUT": "stash@{0}: WIP"},
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        log = self.log.read_text()
        self.assertIn("git clean -fdx .", log)
        self.assertIn("git stash clear", log)
        self.assertIn(f"git worktree remove --force --force {self.linked} [cwd={self.repo}]", log)
        self.assertIn("git checkout -f -B main origin/main", log)
        self.assertNotIn("git checkout -f feature", log)

if __name__ == "__main__":
    unittest.main()
