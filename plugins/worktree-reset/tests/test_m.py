#!/usr/bin/env python3
"""Behavior tests for the Python worktree-reset helper."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "skills" / "m" / "m.py"


class WorktreeResetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        self.repo = self.root / "main"
        self.linked = self.root / "feature"
        self.bin = self.root / "bin"
        self.repo.mkdir()
        self.linked.mkdir()
        self.bin.mkdir()
        (self.linked / ".git").touch()
        (self.repo / "package.json").write_text("{}")
        (self.linked / "go.mod").write_text("module example.com/feature\n")
        (self.linked / "pyproject.toml").write_text("[project]\nname = 'feature'\nversion = '0.0.0'\n")
        self.log = self.root / "commands.log"
        self._write_fake_command("git", self._fake_git())
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
  'branch -vv')
    printf '%s\\n' '  stale abc123 [origin/stale: gone]' '  C:/src/codjiflo abc [origin/keep: gone]'
    ;;
  'show-ref --verify --quiet refs/heads/feature') exit 0 ;;
  'worktree list --porcelain')
    printf 'worktree {self.repo}\\nHEAD one\\nbranch refs/heads/main\\n\\nworktree {self.linked}\\nHEAD two\\nbranch refs/heads/feature\\n'
    ;;
  'branch --show-current') printf 'feature\\n' ;;
  'rebase origin/main') exit 1 ;;
esac
'''

    def run_script(self, *args: str) -> subprocess.CompletedProcess[str]:
        environment = os.environ | {"PATH": f"{self.bin}:{os.environ['PATH']}", "COMMAND_LOG": str(self.log)}
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=self.repo,
            text=True,
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
        self.assertIn("git branch -D stale", log)
        self.assertIn("git checkout main", log)
        self.assertIn("git reset --hard origin/main", log)
        self.assertIn("npm install", log)

    def test_all_updates_linked_worktrees_and_aborts_failed_rebases(self) -> None:
        result = self.run_script("--all", "feature")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("=== All worktrees updated ===", result.stdout)
        log = self.log.read_text()
        self.assertIn(f"git rebase origin/main [cwd={self.linked}]", log)
        self.assertIn(f"git rebase --abort [cwd={self.linked}]", log)
        self.assertIn("go mod download", log)
        self.assertIn("uv sync", log)


if __name__ == "__main__":
    unittest.main()
