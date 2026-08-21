import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const watcher = path.join(root, "plugins/watch-pr/skills/watch-pr/watch-pr.py");

// The Windows launcher is the documented entry point but is not always installed;
// fall back to whichever interpreter answers --version.
const python = ["py", "python3", "python"].find((candidate) => {
  if (process.platform !== "win32" && candidate === "py") return false;
  try {
    execFileSync(candidate, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}) ?? "python3";

// The stub `gh`/`git` below are extensionless shell scripts placed on PATH. Windows
// cannot use them: CreateProcess — what subprocess.run(["gh", …]) ends up calling —
// resolves only .exe, so a stub never shadows a real gh.exe, and the .cmd shim that
// would be resolvable truncates the multiline GraphQL argument at its first newline.
// The Windows-specific logic those tests cannot reach is covered natively further
// down, against the real interpreter and the real bash lookup.
const stubsUnsupported = process.platform === "win32"
  ? "stub executables on PATH cannot shadow real .exe binaries on Windows"
  : false;

// Forces the interpreter onto its locale codepage — cp1252 on a stock Windows box,
// ASCII under LC_ALL=C elsewhere — which is the condition issue #67 crashed under.
// Without PYTHONUTF8=0 a UTF-8-mode default (or PEP 538's C locale coercion) would
// quietly paper over the very bug these tests pin down.
const localeCodepage = { PYTHONUTF8: "0", PYTHONCOERCECLOCALE: "0", PYTHONIOENCODING: "", LC_ALL: "C", LANG: "C" };

// A snippet with a ZERO WIDTH JOINER: its UTF-8 encoding carries byte 0x8d, which is
// exactly the byte cp1252 leaves undefined in the reported traceback.
const nonAscii = "review \u{1F468}\u200D\u{1F4BB} body";

// Loads watch-pr.py as a module and evaluates `expression` against it, so the
// helpers can be exercised without standing up a fake GitHub.
async function probe(expression, env = {}) {
  const code = [
    "import importlib.util, sys, json",
    "spec = importlib.util.spec_from_file_location('watch_pr', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    // default=str so a returned Path serialises; None still comes back as null.
    `print(json.dumps(${expression}, default=str))`,
  ].join("\n");
  const { stdout } = await execFileAsync(python, ["-c", code, watcher, ...(env.argv ?? [])], {
    env: { ...process.env, ...env.vars },
    timeout: 30_000,
  });
  return JSON.parse(stdout);
}

// Builds a throwaway skill directory plus stub `gh`/`git` on PATH, so watch-pr.py
// runs its real loop against scripted GitHub state.
//   closeAfter — the poll on which the PR flips to CLOSED (ends the loop)
//   comments   — top-level comment authors reported by every snapshot poll
//   commentsByPoll — optional top-level comment authors per poll
//   unresolvedByPoll — optional unresolved review-thread IDs per poll
//   checksByPoll — optional check rows returned per poll
//   checkFailuresByPoll — optional polls where the check query fails
//   formatter  — "ok" writes a fixture document, "fail" exits non-zero writing nothing
function fixture(prefix, { closeAfter, comments = [], commentsByPoll = null, unresolvedByPoll = null, checksByPoll = null, checkFailuresByPoll = null, formatter = "ok" }) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const binDir = path.join(tempDir, "bin");
  const scriptDir = path.join(tempDir, "skill");
  const counterPath = path.join(tempDir, "poll-count");
  const checkCounterPath = path.join(tempDir, "check-poll-count");
  const documentPath = path.join(tempDir, "comments.md");
  const commentsPath = path.join(tempDir, "comments.jsonl");
  const unresolvedPath = path.join(tempDir, "unresolved.jsonl");
  const checksPath = path.join(tempDir, "checks.jsonl");
  const checkFailuresPath = path.join(tempDir, "check-failures.jsonl");
  const commentPolls = commentsByPoll ?? [comments];
  const unresolvedPolls = unresolvedByPoll ?? [[]];
  const checkFailurePolls = checkFailuresByPoll ?? [];
  const checkPolls = checksByPoll ?? [[]];
  mkdirSync(binDir);
  mkdirSync(scriptDir);
  copyFileSync(
    path.join(root, "plugins/watch-pr/skills/watch-pr/watch-pr.py"),
    path.join(scriptDir, "watch-pr.py"),
  );
  writeFileSync(documentPath, "active_comments: 0\n");
  writeFileSync(commentsPath, Array.from({ length: closeAfter }, (_, index) => {
    const logins = commentPolls[Math.min(index, commentPolls.length - 1)] ?? [];
    return JSON.stringify(logins.map((login) => ({ author: { login } })));
  }).join("\n"));
  writeFileSync(unresolvedPath, Array.from({ length: closeAfter }, (_, index) => {
    const ids = unresolvedPolls[Math.min(index, unresolvedPolls.length - 1)] ?? [];
    return JSON.stringify(ids.map((id) => ({ id, isResolved: false })));
  }).join("\n"));
  writeFileSync(checksPath, Array.from({ length: closeAfter }, (_, index) => {
    const checks = checkPolls[Math.min(index, checkPolls.length - 1)] ?? [];
    return JSON.stringify(checks);
  }).join("\n"));
  writeFileSync(checkFailuresPath, Array.from({ length: closeAfter }, (_, index) => {
    const failed = checkFailurePolls[Math.min(index, checkFailurePolls.length - 1)] ?? false;
    return failed ? "1" : "0";
  }).join("\n"));

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

  writeFileSync(path.join(binDir, "gh"), [
    "#!/usr/bin/env bash",
    'if [[ "$1 $2" == "api user" ]]; then',
    "  printf '%s\\n' 'watcher-test'",
    "  exit 0",
    "fi",
    'if [[ "$1 $2" == "pr checks" ]]; then',
    "  count=0",
    '  [[ -f "$WATCH_PR_TEST_CHECK_COUNTER" ]] && read -r count < "$WATCH_PR_TEST_CHECK_COUNTER"',
    "  count=$((count + 1))",
    '  printf \'%s\\n\' "$count" > "$WATCH_PR_TEST_CHECK_COUNTER"',
    '  check_failed=$(sed -n "${count}p" "$WATCH_PR_TEST_CHECK_FAILURES")',
    '  [[ "$check_failed" == "1" ]] && exit 1',
    '  checks_json=$(sed -n "${count}p" "$WATCH_PR_TEST_CHECKS")',
    '  printf \'%s\\n\' "${checks_json:-[]}"',
    "  exit 0",
    "fi",
    'if [[ "$1 $2" == "api graphql" ]]; then',
    "  count=0",
    '  [[ -f "$WATCH_PR_TEST_COUNTER" ]] && read -r count < "$WATCH_PR_TEST_COUNTER"',
    "  count=$((count + 1))",
    '  printf \'%s\\n\' "$count" > "$WATCH_PR_TEST_COUNTER"',
    '  comments_json=$(sed -n "${count}p" "$WATCH_PR_TEST_COMMENTS")',
    '  unresolved_json=$(sed -n "${count}p" "$WATCH_PR_TEST_UNRESOLVED")',
    "  state=OPEN",
    `  [[ $count -ge ${closeAfter} ]] && state=CLOSED`,
    `  printf '{"data":{"repository":{"pullRequest":{"state":"%s","mergeStateStatus":"CLEAN","baseRefName":"main","reviews":{"nodes":[]},"reactionGroups":[],"comments":{"nodes":%s},"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":%s}}}}}\\n' "$state" "$comments_json" "$unresolved_json"`,
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

  const run = (extraArgs = []) => execFileAsync(python, [
    path.join(scriptDir, "watch-pr.py"),
    "123",
    ...extraArgs,
  ], {
    cwd: tempDir,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      WATCH_PR_POLL_SECONDS: "1",
      WATCH_PR_TEST_DOCUMENT: documentPath,
      WATCH_PR_TEST_CHECKS: checksPath,
      WATCH_PR_TEST_CHECK_FAILURES: checkFailuresPath,
      WATCH_PR_TEST_CHECK_COUNTER: checkCounterPath,
      WATCH_PR_TEST_COMMENTS: commentsPath,
      WATCH_PR_TEST_COUNTER: counterPath,
      WATCH_PR_TEST_UNRESOLVED: unresolvedPath,
    },
    timeout: 30_000,
  });

  return { tempDir, run, cleanup: () => rmSync(tempDir, { recursive: true, force: true }) };
}

test("watch-pr emits a stall event after a quiet interval", { skip: stubsUnsupported }, async () => {
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

test("state events use unresolved deltas and omit the pending sentinel timestamp", async () => {
  const lines = await probe(
    "module.state_lines({'reviews': [], 'comments': [], 'reactionGroups': [], 'mergeStateStatus': 'CLEAN'}, [{'name': 'CI', 'bucket': 'pending', 'completedAt': '0001-01-01T00:00:00Z'}], 'example/repo', True, 'watcher-test', 0, [])",
  );

  assert.deepEqual(lines, [
    "check CI: pending",
    "comments: 0",
    "review-comments: 0",
  ]);
  assert.equal(await probe("module.unresolved_delta_line(set(), {'new-a', 'new-b'})"), "unresolved-comments: +2 (unresolved: 2)");
  assert.equal(await probe("module.unresolved_delta_line({'old'}, set())"), "unresolved-comments: -1 (unresolved: 0)");
  assert.equal(await probe("module.unresolved_delta_line({'old'}, {'new'})"), "unresolved-comments: +1 -1 (unresolved: 1)");
});
test("watch-pr coalesces routine check churn and keeps failures immediate", { skip: stubsUnsupported }, async () => {
  const { run, cleanup } = fixture("watch-pr-checks-", {
    closeAfter: 5,
    checksByPoll: [
      [
        { name: "build", bucket: "pass", completedAt: "2026-08-20T00:00:00Z" },
        { name: "docs", bucket: "skipping", completedAt: "2026-08-20T00:00:01Z" },
        { name: "deploy", bucket: "cancel", completedAt: "2026-08-20T00:00:02Z" },
        { name: "unit", bucket: "fail", completedAt: "2026-08-20T00:00:03Z" },
      ],
      [
        { name: "build", bucket: "pending", completedAt: "0001-01-01T00:00:00Z" },
        { name: "docs", bucket: "pending", completedAt: "0001-01-01T00:00:00Z" },
        { name: "deploy", bucket: "pending", completedAt: "0001-01-01T00:00:00Z" },
        { name: "lint", bucket: "pending", completedAt: "0001-01-01T00:00:00Z" },
        { name: "unit", bucket: "fail", completedAt: "2026-08-20T00:00:03Z" },
      ],
      [
        { name: "build", bucket: "pass", completedAt: "2026-08-20T00:00:10Z" },
        { name: "docs", bucket: "skipping", completedAt: "2026-08-20T00:00:11Z" },
        { name: "deploy", bucket: "cancel", completedAt: "2026-08-20T00:00:12Z" },
        { name: "lint", bucket: "pending", completedAt: "0001-01-01T00:00:00Z" },
        { name: "unit", bucket: "fail", completedAt: "2026-08-20T00:00:03Z" },
      ],
      [
        { name: "build", bucket: "pass", completedAt: "2026-08-20T00:00:10Z" },
        { name: "docs", bucket: "skipping", completedAt: "2026-08-20T00:00:11Z" },
        { name: "deploy", bucket: "cancel", completedAt: "2026-08-20T00:00:12Z" },
        { name: "lint", bucket: "fail", completedAt: "2026-08-20T00:00:13Z" },
        { name: "unit", bucket: "fail", completedAt: "2026-08-20T00:00:03Z" },
      ],
    ],
  });
  try {
    const { stdout } = await run(["--stall-timeout", "1h"]);

    assert.equal(stdout.match(/^checks: rerun started \(pending: build, deploy, docs, lint\)$/gm)?.length, 1);
    assert.equal(stdout.match(/^checks: all terminal \(pass: 1, fail: 2, skipping: 1, cancel: 1\)$/gm)?.length, 1);
    assert.equal(stdout.match(/^check unit: fail @2026-08-20T00:00:03Z$/gm)?.length, 1);
    assert.equal(stdout.match(/^check lint: fail @2026-08-20T00:00:13Z$/gm)?.length, 1);
    assert.equal(stdout.match(/^check /gm)?.length, 2, "routine check buckets stay aggregated");
    assert.doesNotMatch(stdout, /^check .*: (pending|pass|skipping|cancel)/m);
    assert.match(stdout, /PR 123 finished: CLOSED/);
  } finally {
    cleanup();
  }
});
test("watch-pr aggregates checks already pending at startup", { skip: stubsUnsupported }, async () => {
  const { run, cleanup } = fixture("watch-pr-startup-checks-", {
    closeAfter: 3,
    checksByPoll: [
      [
        { name: "build", bucket: "pending", completedAt: "0001-01-01T00:00:00Z" },
        { name: "lint", bucket: "pending", completedAt: "0001-01-01T00:00:00Z" },
      ],
      [
        { name: "build", bucket: "pass", completedAt: "2026-08-20T00:00:10Z" },
        { name: "lint", bucket: "cancel", completedAt: "2026-08-20T00:00:11Z" },
      ],
    ],
  });
  try {
    const { stdout } = await run(["--stall-timeout", "1h"]);

    assert.equal(stdout.match(/^checks: rerun started \(pending: build, lint\)$/gm)?.length, 1);
    assert.equal(stdout.match(/^checks: all terminal \(pass: 1, fail: 0, skipping: 0, cancel: 1\)$/gm)?.length, 1);
    assert.doesNotMatch(stdout, /^check /m);
    assert.match(stdout, /PR 123 finished: CLOSED/);
  } finally {
    cleanup();
  }
});
test("watch-pr ignores removed pending checks", { skip: stubsUnsupported }, async () => {
  const { run, cleanup } = fixture("watch-pr-removed-checks-", {
    closeAfter: 4,
    checksByPoll: [
      [{ name: "build", bucket: "pass", completedAt: "2026-08-20T00:00:00Z" }],
      [
        { name: "build", bucket: "pending", completedAt: "0001-01-01T00:00:00Z" },
        { name: "obsolete", bucket: "pending", completedAt: "0001-01-01T00:00:00Z" },
      ],
      [{ name: "build", bucket: "pass", completedAt: "2026-08-20T00:00:10Z" }],
    ],
  });
  try {
    const { stdout } = await run(["--stall-timeout", "1h"]);

    assert.equal(stdout.match(/^checks: rerun started /gm)?.length, 1);
    assert.doesNotMatch(stdout, /^checks: all terminal /m);
    assert.match(stdout, /PR 123 finished: CLOSED/);
  } finally {
    cleanup();
  }
});

test("watch-pr keeps a pending wave across a failed checks query", { skip: stubsUnsupported }, async () => {
  const { run, cleanup } = fixture("watch-pr-check-failure-", {
    closeAfter: 5,
    checksByPoll: [
      [{ name: "build", bucket: "pass", completedAt: "2026-08-20T00:00:00Z" }],
      [{ name: "build", bucket: "pending", completedAt: "0001-01-01T00:00:00Z" }],
      [{ name: "build", bucket: "pass", completedAt: "2026-08-20T00:00:10Z" }],
    ],
    checkFailuresByPoll: [false, false, true, false],
  });
  try {
    const { stdout } = await run(["--stall-timeout", "1h"]);

    assert.equal(stdout.match(/^checks: rerun started /gm)?.length, 1);
    assert.equal(stdout.match(/^checks: all terminal \(pass: 1, fail: 0, skipping: 0, cancel: 0\)$/gm)?.length, 1);
    assert.doesNotMatch(stdout, /^check build: pass/m);
    assert.match(stdout, /PR 123 finished: CLOSED/);
  } finally {
    cleanup();
  }
});

test("watch-pr preserves duplicate check names in aggregate state", { skip: stubsUnsupported }, async () => {
  const { run, cleanup } = fixture("watch-pr-duplicate-checks-", {
    closeAfter: 4,
    checksByPoll: [
      [
        { name: "build", bucket: "pass", completedAt: "2026-08-20T00:00:00Z" },
        { name: "build", bucket: "pass", completedAt: "2026-08-20T00:00:01Z" },
      ],
      [
        { name: "build", bucket: "pending", completedAt: "0001-01-01T00:00:00Z" },
        { name: "build", bucket: "fail", completedAt: "2026-08-20T00:00:02Z" },
      ],
      [
        { name: "build", bucket: "pass", completedAt: "2026-08-20T00:00:03Z" },
        { name: "build", bucket: "fail", completedAt: "2026-08-20T00:00:02Z" },
      ],
    ],
  });
  try {
    const { stdout } = await run(["--stall-timeout", "1h"]);

    assert.equal(stdout.match(/^checks: rerun started \(pending: build\)$/gm)?.length, 1);
    assert.equal(stdout.match(/^check build: fail @2026-08-20T00:00:02Z$/gm)?.length, 1);
    assert.equal(stdout.match(/^checks: all terminal \(pass: 1, fail: 1, skipping: 0, cancel: 0\)$/gm)?.length, 1);
    assert.match(stdout, /PR 123 finished: CLOSED/);
  } finally {
    cleanup();
  }
});


test("watch-pr does not re-emit active feedback on later triggers", { skip: stubsUnsupported }, async () => {
  const document = [
    "---",
    "fetched_at: 2026-08-19T00:00:00Z",
    "active_comments: 1",
    "---",
    '<review-thread id="thread-1">',
    "### Thread 1",
    "| **ID** | `101` |",
    "| **File** | `src/example.py` |",
    "| **Lines** | 12 |",
    "| **Author** | reviewer |",
    "> Keep this change",
    "</review-thread>",
    '<pr-comment id="202" author="reviewer">',
    "> Top-level note",
    "</pr-comment>",
    '<review-summary id="review-303" author="reviewer">',
    "> Summary title",
    "</review-summary>",
  ].join("\n");
  const { tempDir, run, cleanup } = fixture("watch-pr-dedupe-", {
    closeAfter: 4,
    commentsByPoll: [["reviewer"], ["reviewer", "reviewer-2"]],
    unresolvedByPoll: [["thread-0"], ["thread-0", "thread-1"]],
  });
  try {
    writeFileSync(path.join(tempDir, "comments.md"), document);
    const { stdout } = await run(["--stall-timeout", "1h"]);

    assert.equal(stdout.match(/^feedback \[101\].*$/gm)?.length, 1, "the active thread should be emitted once");
    assert.equal(stdout.match(/^feedback comment /gm)?.length ?? 0, 0, "top-level feedback stays in the file");
    assert.equal(stdout.match(/^feedback review /gm)?.length ?? 0, 0, "review summaries stay in the file");
    assert.equal(stdout.match(/→ full bodies \+ code context:/g)?.length, 1, "unchanged feedback must not get a new pointer");
    assert.equal(stdout.match(/^unresolved-comments: \+1 \(unresolved: 1\)$/gm)?.length, 1);
    assert.equal(stdout.match(/^unresolved-comments: \+1 \(unresolved: 2\)$/gm)?.length, 1);
    assert.match(stdout, /comments: 2/);
    assert.match(stdout, /PR 123 finished: CLOSED/);
  } finally {
    cleanup();
  }
});

test("watch-pr passes the formatter an output path it can read back", { skip: stubsUnsupported }, async () => {
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

test("a persistently failing formatter neither loops nor re-emits state", { skip: stubsUnsupported }, async () => {
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
    assert.doesNotMatch(stdout, /^unresolved-threads:/m, "the old total-count event must stay removed");

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

test("formatter event lines strip XML comments and omit broad feedback summaries", async () => {
  const document = [
    '<review-thread id="thread-1" created="2026-08-19T00:00:00Z">',
    "### Thread 1",
    "| Field | Value |",
    "|-------|-------|",
    "| **ID** | `101` |",
    "| **File** | `src/example.py` |",
    "| **Lines** | 12 |",
    "| **Author** | reviewer |",
    "> <!-- hidden thread title -->",
    "> Keep <!-- hidden inline --> this change",
    "</review-thread>",
    '<pr-comment id="202" author="reviewer" created="2026-08-19T00:00:01Z">',
    "> <!-- hidden",
    "> multiline -->",
    "> Top-level <!-- internal --> note",
    "</pr-comment>",
    '<review-summary id="review-303" author="reviewer" created="2026-08-19T00:00:02Z">',
    "> <!-- hidden summary -->",
    "> Summary <!-- internal --> title",
    "</review-summary>",
  ].join("\n");

  const lines = await probe("module.formatter_lines(sys.argv[2])", { argv: [document] });

  assert.deepEqual(lines, [
    "feedback [101] src/example.py:12 @reviewer Keep  this change",
  ]);
  assert.ok(lines.every((line) => !line.includes("<!--") && !line.includes("-->")));
});


// ---------------------------------------------------------------------------
// Coverage for the platform-specific pieces of issue #63. These drive the real
// helpers directly, so unlike the fixtures above they run natively on Windows —
// which is the only place the bug reproduced.
// ---------------------------------------------------------------------------

test("the formatter runs under a bash whose files the parent can read back", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "watch-pr-roundtrip-"));
  try {
    const script = path.join(tempDir, "comments.sh");
    // Stands in for comments.sh: writes the document to the path it was handed.
    writeFileSync(script, ['#!/usr/bin/env bash', 'printf \'active_comments: 1\n\' > "$2"'].join("\n"));
    chmodSync(script, 0o755);

    const produced = await probe(
      "module.run_formatter(module.bash_executable(), __import__('pathlib').Path(sys.argv[2]), 'https://example.com/pr/7', 7, 1)",
      { argv: [script] },
    );

    assert.ok(produced, "run_formatter should return the path it chose");
    assert.equal(
      readFileSync(produced, "utf8").trim(),
      "active_comments: 1",
      "the parent must be able to read what the child bash wrote",
    );
    rmSync(produced, { force: true });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a formatter that writes nothing is reported as a failure", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "watch-pr-empty-"));
  try {
    // Exits 0 but produces an empty file — comments.sh truncates its output before
    // the jq pipeline that fills it, so "the file exists" is not enough on its own.
    const script = path.join(tempDir, "comments.sh");
    writeFileSync(script, ['#!/usr/bin/env bash', ': > "$2"'].join("\n"));
    chmodSync(script, 0o755);

    const produced = await probe(
      "module.run_formatter(module.bash_executable(), __import__('pathlib').Path(sys.argv[2]), 'https://example.com/pr/7', 7, 1)",
      { argv: [script] },
    );
    assert.equal(produced, null);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Issue #67: gh emits UTF-8, but text-mode capture decodes with the locale codepage.
// Both directions are driven under a forced non-UTF-8 locale, so they fail on the
// unfixed script on Linux too rather than only on the Windows box that reported it.
// ---------------------------------------------------------------------------

test("captured command output survives a non-UTF-8 locale", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "watch-pr-decode-"));
  try {
    // Stands in for gh: writes UTF-8 bytes, as gh does on every platform.
    const emitter = path.join(tempDir, "emit.py");
    writeFileSync(emitter, `import sys\nsys.stdout.buffer.write(${JSON.stringify(nonAscii)}.encode("utf-8"))\n`, "utf8");

    const captured = await probe("module.output(sys.executable, sys.argv[2])", {
      argv: [emitter],
      vars: localeCodepage,
    });

    assert.equal(captured, nonAscii, "a review body must not be mangled by the console codepage");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("emitted events are UTF-8 whatever the console codepage is", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "watch-pr-encode-"));
  try {
    // A file, not `python -c`: a C-locale interpreter cannot even decode a command
    // line carrying an emoji, whereas source files are always read as UTF-8.
    const driver = path.join(tempDir, "emit-event.py");
    writeFileSync(driver, [
      "import importlib.util, sys",
      "spec = importlib.util.spec_from_file_location('watch_pr', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "module.use_utf8_streams()",
      `print(${JSON.stringify(nonAscii)})`,
    ].join("\n"), "utf8");

    const { stdout } = await execFileAsync(python, [driver, watcher], {
      env: { ...process.env, ...localeCodepage },
      encoding: "buffer",
      timeout: 30_000,
    });

    assert.equal(stdout.toString("utf8").trim(), nonAscii, "the monitor reading this pipe decodes UTF-8");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bash_executable avoids WSL and honours the override", async () => {
  const chosen = await probe("module.bash_executable()");

  if (process.platform === "win32") {
    // WSL's bash is first on PATH on a stock box, and its /tmp is a filesystem this
    // process cannot open — picking it is exactly what broke issue #63.
    assert.doesNotMatch(chosen, /system32/i, `must not select WSL's bash, got ${chosen}`);
    assert.match(chosen, /bash\.exe$/i);
  } else {
    assert.equal(chosen, "bash");
  }

  const override = await probe("module.bash_executable()", { vars: { WATCH_PR_BASH: "/custom/bash" } });
  assert.equal(override, "/custom/bash");
});
