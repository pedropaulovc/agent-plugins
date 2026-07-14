// End-to-end contract test for the memory usage ranking: run the record-memory-usage
// scanner over synthetic sessions, then the SessionStart hook binary, and assert the
// index is actually reordered by usage. This is the coverage that was missing — the
// Rust `cli.rs` test hand-writes usage.jsonl keys, so it never checked that the
// SCANNER emits keys in the shape the hook looks up. A regression to `memory/foo.md`
// prefixed keys (which never match the `foo.md` MEMORY.md links) fails here.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const scanner = path.join(repoRoot, "plugins/memory-to-repo/scripts/record-memory-usage.ts");
const hookBinary = path.join(repoRoot, "plugins/memory-to-repo/hooks/bin/memory-to-repo");

// Mirror the scanner's project-slug convention (path separators, dots, colon → dash).
const slugify = (p) => p.replace(/[/\\.:]/g, "-");

// One assistant transcript entry running a Bash command, cwd = the project root.
const bashEntry = (projectRoot, command) =>
  JSON.stringify({
    type: "assistant",
    cwd: projectRoot,
    message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
  });

test("scanner + hook rerank the memory index by usage (unprefixed key contract)", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "mem-usage-e2e-"));
  const projectRoot = path.join(tempDir, "project");
  const memoryDir = path.join(projectRoot, "memory");
  mkdirSync(memoryDir, { recursive: true });
  // Index order is Alpha, Bravo, Charlie; links are bare (relative to memory/).
  writeFileSync(
    path.join(memoryDir, "MEMORY.md"),
    "- [Alpha](alpha.md) — a\n- [Bravo](bravo.md) — b\n- [Charlie](charlie.md) — c\n",
  );

  const sessionsDir = path.join(tempDir, ".claude", "projects", slugify(projectRoot));
  mkdirSync(sessionsDir, { recursive: true });
  // Charlie is read in two sessions; Alpha in one. Bravo is only ever committed
  // and edited in place — churn that must NOT count as a read.
  writeFileSync(
    path.join(sessionsDir, "ses1.jsonl"),
    bashEntry(projectRoot, "cat memory/charlie.md") + "\n" +
      bashEntry(projectRoot, "sed -n '1,5p' memory/alpha.md") + "\n",
  );
  writeFileSync(
    path.join(sessionsDir, "ses2.jsonl"),
    bashEntry(projectRoot, "rg -n needle memory/charlie.md") + "\n" +
      bashEntry(projectRoot, "git add memory/bravo.md && git commit -m x") + "\n" +
      bashEntry(projectRoot, "sed -i 's/a/b/' memory/bravo.md") + "\n",
  );

  const env = { ...process.env, HOME: tempDir, CLAUDE_PROJECT_DIR: projectRoot };
  delete env.PLUGIN_ROOT;

  try {
    execFileSync(process.execPath, [scanner], { cwd: projectRoot, encoding: "utf8", env });

    const records = readFileSync(path.join(memoryDir, "usage.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const files = records.map((r) => r.memoryFileName).sort();

    // Keys must be unprefixed to match the MEMORY.md links the hook ranks by.
    assert.ok(
      records.every((r) => !r.memoryFileName.includes("/")),
      `keys must be unprefixed, got ${JSON.stringify(files)}`,
    );
    // charlie (2 sessions) and alpha (1) are read; bravo (commit + sed -i) is not.
    assert.deepEqual([...new Set(files)], ["alpha.md", "charlie.md"]);

    const stdout = execFileSync(hookBinary, ["session-start"], {
      cwd: projectRoot,
      encoding: "utf8",
      input: "{}",
      env,
    });
    const context = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    const iCharlie = context.indexOf("[Charlie]");
    const iAlpha = context.indexOf("[Alpha]");
    const iBravo = context.indexOf("[Bravo]");
    assert.ok(iCharlie >= 0 && iAlpha >= 0 && iBravo >= 0, `index missing an entry: ${context}`);
    // Reranked most-consulted-first: charlie (2) < alpha (1) < bravo (0, unused).
    assert.ok(
      iCharlie < iAlpha && iAlpha < iBravo,
      `expected charlie < alpha < bravo, got charlie=${iCharlie} alpha=${iAlpha} bravo=${iBravo}\n${context}`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
