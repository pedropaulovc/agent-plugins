import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();

// Builds a throwaway skill directory plus stub `gh`/`git` on PATH, so watch-pr.py
// runs its real loop against scripted GitHub state.
//   closeAfter — the poll on which the PR flips to CLOSED (ends the loop)
//   comments   — top-level comment authors reported by the snapshot query
//   formatter  — "ok" writes a fixture document, "fail" exits non-zero writing nothing
function fixture(prefix, { closeAfter, comments = [], formatter = "ok" }) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const binDir = path.join(tempDir, "bin");
  const scriptDir = path.join(tempDir, "skill");
  const counterPath = path.join(tempDir, "poll-count");
  const documentPath = path.join(tempDir, "comments.md");

  mkdirSync(binDir);
  mkdirSync(scriptDir);
  copyFileSync(
    path.join(root, "plugins/watch-pr/skills/watch-pr/watch-pr.py"),
    path.join(scriptDir, "watch-pr.py"),
  );
  writeFileSync(documentPath, "active_comments: 0\n");

  // The real comments.sh takes the output file as its SECOND argument and writes the
  // formatted document there; watch-pr.py picks that path itself rather than reading
  // one off stdout (issue #63), so the stub has to honour the same contract.
  writeFileSync(path.join(scriptDir, "comments.sh"), formatter === "fail"
    ? ["#!/usr/bin/env bash", "exit 1"].join("\n")
    : ["#!/usr/bin/env bash", 'cat "$WATCH_PR_TEST_DOCUMENT" > "$2"'].join("\n"));

  writeFileSync(path.join(binDir, "git"), [
    "#!/usr/bin/env bash",
    'if [[ "$1 $2 $3" == "remote get-url origin" ]]; then',
    "  printf '%s\\n' 'https://github.com/example/repo.git'",
    "fi",
  ].join("\n"));

  const commentNodes = comments.map((login) => `{\\"author\\":{\\"login\\":\\"${login}\\"}}`).join(",");
  writeFileSync(path.join(binDir, "gh"), [
    "#!/usr/bin/env bash",
    'if [[ "$1 $2" == "api user" ]]; then',
    "  printf '%s\\n' 'watcher-test'",
    "  exit 0",
    "fi",
    'if [[ "$1 $2" == "pr checks" ]]; then',
    "  printf '%s\\n' '[]'",
    "  exit 8",
    "fi",
    'if [[ "$1 $2" == "api graphql" ]]; then',
    "  count=0",
    '  [[ -f "$WATCH_PR_TEST_COUNTER" ]] && read -r count < "$WATCH_PR_TEST_COUNTER"',
    "  count=$((count + 1))",
    '  printf \'%s\\n\' "$count" > "$WATCH_PR_TEST_COUNTER"',
    "  state=OPEN",
    `  [[ $count -ge ${closeAfter} ]] && state=CLOSED`,
    `  printf '{"data":{"repository":{"pullRequest":{"state":"%s","mergeStateStatus":"CLEAN","baseRefName":"main","reviews":{"nodes":[]},"reactionGroups":[],"comments":{"nodes":[${commentNodes}]},"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}\\n' "$state"`,
    "  exit 0",
    "fi",
    'if [[ "$1" == "api" ]]; then',
    "  exit 0",
    "fi",
    'if [[ "$1 $2" != "pr view" ]]; then',
    "  exit 1",
    "fi",
    'if [[ " $* " != *" -R "* ]]; then',
    "  printf '%s\\n' '{\"url\":\"https://github.com/example/repo/pull/123\",\"number\":123}'",
    "  exit 0",
    "fi",
    "printf '%s\\n' '{}'",
  ].join("\n"));

  for (const executable of [
    path.join(scriptDir, "watch-pr.py"),
    path.join(scriptDir, "comments.sh"),
    path.join(binDir, "gh"),
    path.join(binDir, "git"),
  ]) chmodSync(executable, 0o755);

  const run = (extraArgs = []) => execFileAsync("python3", [
    path.join(scriptDir, "watch-pr.py"),
    "123",
    ...extraArgs,
  ], {
    cwd: tempDir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      WATCH_PR_POLL_SECONDS: "1",
      WATCH_PR_TEST_DOCUMENT: documentPath,
      WATCH_PR_TEST_COUNTER: counterPath,
    },
    timeout: 30_000,
  });

  return { tempDir, run, cleanup: () => rmSync(tempDir, { recursive: true, force: true }) };
}

test("watch-pr emits a stall event after a quiet interval", async () => {
  const { run, cleanup } = fixture("watch-pr-stall-", { closeAfter: 3 });
  try {
    const { stdout } = await run(["--stall-timeout", "1s"]);

    assert.match(stdout, /stall: no new events for 1s — watcher still running/);
    assert.match(stdout, /PR 123 finished: CLOSED/);
    assert.equal(
      stdout.match(/stall: no new events for 1s/g)?.length,
      1,
      "a new stall event should be emitted once per quiet interval",
    );
  } finally {
    cleanup();
  }
});

test("watch-pr passes the formatter an output path it can read back", async () => {
  const { run, cleanup } = fixture("watch-pr-formatter-", { closeAfter: 3, comments: ["reviewer"] });
  try {
    const { stdout } = await run(["--stall-timeout", "1h"]);

    assert.match(stdout, /^comments: 1$/m);
    assert.doesNotMatch(
      stdout,
      /comment formatter failed/,
      "a formatter honouring the output-path contract must not read as a failure",
    );
    assert.match(stdout, /PR 123 finished: CLOSED/);
  } finally {
    cleanup();
  }
});

test("a persistently failing formatter neither loops nor re-emits state", async () => {
  const { run, cleanup } = fixture("watch-pr-loop-", {
    closeAfter: 6,
    comments: ["reviewer"],
    formatter: "fail",
  });
  try {
    const { stdout } = await run(["--stall-timeout", "1h"]);

    // The baseline advances even though the fetch failed, so the state block that
    // triggered the fetch goes out exactly once instead of on every poll (issue #64).
    assert.equal(stdout.match(/^comments: 1$/gm)?.length, 1, "state lines must not repeat");
    assert.equal(stdout.match(/^unresolved-threads: 0$/gm)?.length, 1, "state lines must not repeat");

    // Retries are capped per feedback event: one "will retry" line, then one line
    // announcing the pause. Six polls must not mean six failure notifications.
    const failures = stdout.match(/comment formatter failed/g)?.length ?? 0;
    assert.equal(failures, 2, `bounded failure notifications, got ${failures}`);
    assert.match(stdout, /pausing retries until new feedback arrives/);
    assert.match(stdout, /PR 123 finished: CLOSED/);
  } finally {
    cleanup();
  }
});
