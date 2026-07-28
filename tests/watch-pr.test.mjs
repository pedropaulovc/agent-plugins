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
      WATCH_PR_TEST_COUNTER: counterPath,
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
