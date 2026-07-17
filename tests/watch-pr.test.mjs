import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();

test("watch-pr emits a stall event after a quiet interval", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "watch-pr-stall-"));
  const binDir = path.join(tempDir, "bin");
  const scriptDir = path.join(tempDir, "skill");
  const counterPath = path.join(tempDir, "poll-count");
  const commentsPath = path.join(tempDir, "comments.md");

  try {
    mkdirSync(binDir);
    mkdirSync(scriptDir);
    copyFileSync(
      path.join(root, "plugins/watch-pr/skills/watch-pr/watch-pr.sh"),
      path.join(scriptDir, "watch-pr.sh"),
    );
    writeFileSync(commentsPath, "active_comments: 0\n");
    writeFileSync(path.join(scriptDir, "comments.sh"), [
      "#!/usr/bin/env bash",
      "printf '%s\\n' \"$WATCH_PR_TEST_COMMENTS\"",
    ].join("\n"));
    writeFileSync(path.join(binDir, "git"), [
      "#!/usr/bin/env bash",
      "if [[ \"$1 $2 $3\" == \"remote get-url origin\" ]]; then",
      "  printf '%s\\n' 'https://github.com/example/repo.git'",
      "fi",
    ].join("\n"));
    writeFileSync(path.join(binDir, "gh"), [
      "#!/usr/bin/env bash",
      "if [[ \"$1 $2\" == \"api user\" ]]; then",
      "  printf '%s\\n' 'watcher-test'",
      "  exit 0",
      "fi",
      "if [[ \"$1 $2\" == \"pr checks\" ]]; then",
      "  printf '%s\\n' '[]'",
      "  exit 0",
      "fi",
      "if [[ \"$1 $2\" == \"api graphql\" ]]; then",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == \"api\" ]]; then",
      "  exit 0",
      "fi",
      "if [[ \"$1 $2\" != \"pr view\" ]]; then",
      "  exit 1",
      "fi",
      "if [[ \" $* \" != *\" -R \"* ]]; then",
      "  printf '%s\\n' '{\"url\":\"https://github.com/example/repo/pull/123\",\"number\":123}'",
      "  exit 0",
      "fi",
      "count=0",
      "[[ -f \"$WATCH_PR_TEST_COUNTER\" ]] && read -r count < \"$WATCH_PR_TEST_COUNTER\"",
      "count=$((count + 1))",
      "printf '%s\\n' \"$count\" > \"$WATCH_PR_TEST_COUNTER\"",
      "state=OPEN",
      "[[ $count -ge 3 ]] && state=CLOSED",
      "printf '{\"state\":\"%s\",\"mergeStateStatus\":\"CLEAN\",\"baseRefName\":\"main\",\"reviews\":[],\"reactionGroups\":[],\"comments\":[]}\\n' \"$state\"",
    ].join("\n"));

    for (const executable of [
      path.join(scriptDir, "watch-pr.sh"),
      path.join(scriptDir, "comments.sh"),
      path.join(binDir, "gh"),
      path.join(binDir, "git"),
    ]) chmodSync(executable, 0o755);

    const { stdout } = await execFileAsync("bash", [
      path.join(scriptDir, "watch-pr.sh"),
      "123",
      "--stall-timeout",
      "1s",
    ], {
      cwd: tempDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        WATCH_PR_POLL_SECONDS: "1",
        WATCH_PR_TEST_COMMENTS: commentsPath,
        WATCH_PR_TEST_COUNTER: counterPath,
      },
      timeout: 10_000,
    });

    assert.match(stdout, /stall: no new events for 1s — watcher still running/);
    assert.match(stdout, /PR 123 finished: CLOSED/);
    assert.equal(
      stdout.match(/stall: no new events for 1s/g)?.length,
      1,
      "a new stall event should be emitted once per quiet interval",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
