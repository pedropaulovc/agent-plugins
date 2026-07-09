#!/usr/bin/env node
// Scans this project's past Claude Code sessions (including sessions run in
// git worktrees) for Read tool calls that targeted a file under ./memory/,
// and APPENDS any newly-discovered {sessionId, memoryFileName} records to
// ./memory/usage.jsonl — one record per distinct (session, memory file) pair.
// The native SessionStart hook reads this file to rank memories by how often they've
// actually been consulted.
//
// Existing lines are preserved byte-for-byte and never reordered: this file
// is shared and git-tracked, so two people (or two branches) running this
// command independently should only ever add lines at the end, which git
// merges cleanly. A full rewrite/re-sort would touch nearly every line and
// turn every concurrent run into a merge conflict.
//
// Run via: node scripts/record-memory-usage.ts (native TS type-stripping,
// Node >=23.6 — no build step, no dependency install required at runtime).
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import type { AssistantEntry, ToolUseBlock, TranscriptEntry } from "claude-code-types";

interface UsageRecord {
  sessionId: string;
  memoryFileName: string;
}

// Mirror Claude Code's project-slug convention: every path separator and dot
// collapses to a dash. Cover the Windows shapes too — a drive-letter colon and
// backslash separators — so "C:\\src\\proj" slugs to "C--src-proj" (matching
// ~/.claude/projects/C--src-proj), not the "C:\\src\\proj" that a POSIX-only
// regex leaves untouched, which would match zero session dirs on Windows.
function slugify(path: string): string {
  return path.replace(/[/\\.:]/g, "-");
}

// Session transcripts for this project live under a slug directory; sessions
// run in a worktree of this project get their own slug directory named
// "<mainSlug>--claude-worktrees-<name>" (Claude Code's EnterWorktree
// convention: worktrees live at "<projectRoot>/.claude/worktrees/<name>").
function findSessionDirs(claudeProjectsDir: string, projectRoot: string): string[] {
  const mainSlug = slugify(projectRoot);
  const worktreePrefix = `${mainSlug}--claude-worktrees-`;
  return readdirSync(claudeProjectsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (e.name === mainSlug || e.name.startsWith(worktreePrefix)))
    .map((e) => join(claudeProjectsDir, e.name));
}

// A Read tool call's file_path is always absolute, but the session may have
// run in this project's root OR in a worktree checkout of it — resolve
// relative to the entry's own cwd so both normalize to the same
// repo-relative "memory/<file>.md" name.
function extractMemoryReads(entry: TranscriptEntry): string[] {
  if (entry.type !== "assistant") return [];
  const message = (entry as AssistantEntry).message;
  const cwd = (entry as AssistantEntry).cwd;
  const names: string[] = [];
  for (const block of message.content) {
    if (block.type !== "tool_use") continue;
    const tu = block as ToolUseBlock;
    if (tu.name !== "Read") continue;
    const filePath = tu.input.file_path;
    if (typeof filePath !== "string" || !filePath) continue;
    const rel = relative(cwd, resolve(cwd, filePath));
    const [top, ...restParts] = rel.split(sep);
    if (top !== "memory" || restParts.length === 0) continue;
    if (!rel.endsWith(".md") || basename(rel) === "MEMORY.md") continue;
    names.push(["memory", ...restParts].join("/"));
  }
  return names;
}

// Reads usage.jsonl as-is (preserving each existing line verbatim, so a
// re-run never rewrites content it already emitted) and returns both the raw
// lines and the set of (session, file) keys they already cover.
function readExisting(outPath: string): { lines: string[]; keys: Set<string> } {
  if (!existsSync(outPath)) return { lines: [], keys: new Set() };
  const lines = readFileSync(outPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const keys = new Set<string>();
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as UsageRecord;
      keys.add(`${rec.sessionId} ${rec.memoryFileName}`);
    } catch {
      continue;
    }
  }
  return { lines, keys };
}

function collectUsage(sessionDirs: string[]): UsageRecord[] {
  const seen = new Set<string>();
  const records: UsageRecord[] = [];
  for (const dir of sessionDirs) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const sessionId = name.slice(0, -".jsonl".length);
      for (const line of readFileSync(join(dir, name), "utf-8").split("\n")) {
        if (!line.trim()) continue;
        let entry: TranscriptEntry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        for (const memoryFileName of extractMemoryReads(entry)) {
          const key = `${sessionId} ${memoryFileName}`;
          if (seen.has(key)) continue;
          seen.add(key);
          records.push({ sessionId, memoryFileName });
        }
      }
    }
  }
  return records;
}

// usage.jsonl is a shared, git-tracked append log: concurrent runs on
// different branches only ever add lines at the tail, which git's default
// 3-way merge already handles cleanly in the common case. `merge=union` is a
// cheap extra safety net for the edge cases default merge doesn't cover
// (rebase/cherry-pick reordering the tail context, a stray hand-edit) — it
// guarantees no leftover conflict markers, which would otherwise corrupt
// every line downstream readers parse. Wired up once, when the file is first
// created, rather than checked on every run, to keep this script's side
// effects limited to a one-time setup step.
function ensureGitAttributes(projectRoot: string): void {
  const path = join(projectRoot, ".gitattributes");
  const line = "memory/usage.jsonl merge=union";
  if (!existsSync(path)) {
    writeFileSync(path, `${line}\n`);
    console.log(`Created ${path} with "${line}"`);
    return;
  }
  const content = readFileSync(path, "utf-8");
  if (content.split("\n").some((l) => l.trim() === line)) return;
  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${content}${separator}${line}\n`);
  console.log(`Appended "${line}" to ${path}`);
}

// Codex sets no CLAUDE_PROJECT_DIR and may launch from a subdirectory, so fall
// back to the git top-level (not process.cwd()) to find the repo-root memory
// store. Mirrors the native SessionStart hook's resolution.
function gitTopLevel(): string | undefined {
  try {
    return (
      execSync("git rev-parse --show-toplevel", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

function main(): void {
  const projectRoot = resolve(
    process.env.CLAUDE_PROJECT_DIR || gitTopLevel() || process.cwd(),
  );
  const memoryDir = join(projectRoot, "memory");
  if (!existsSync(memoryDir)) {
    console.log(`No memory/ directory at ${memoryDir}; nothing to record.`);
    return;
  }

  const claudeProjectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(claudeProjectsDir)) {
    console.log(`No ${claudeProjectsDir}; no past sessions to scan.`);
    return;
  }

  const outPath = join(memoryDir, "usage.jsonl");
  const isNewFile = !existsSync(outPath);
  const { lines: existingLines, keys: existingKeys } = readExisting(outPath);

  const sessionDirs = findSessionDirs(claudeProjectsDir, projectRoot);
  const newRecords = collectUsage(sessionDirs)
    .filter((r) => !existingKeys.has(`${r.sessionId} ${r.memoryFileName}`))
    .sort((a, b) =>
      a.memoryFileName === b.memoryFileName
        ? a.sessionId.localeCompare(b.sessionId)
        : a.memoryFileName.localeCompare(b.memoryFileName),
    );

  const allLines = [...existingLines, ...newRecords.map((r) => JSON.stringify(r))];
  writeFileSync(outPath, allLines.length ? allLines.join("\n") + "\n" : "");
  if (isNewFile) ensureGitAttributes(projectRoot);

  const files = new Set(newRecords.map((r) => r.memoryFileName)).size;
  const sessions = new Set(newRecords.map((r) => r.sessionId)).size;
  console.log(
    `Scanned ${sessionDirs.length} session director${sessionDirs.length === 1 ? "y" : "ies"}; ` +
      `appended ${newRecords.length} new usage record(s) covering ${files} memory file(s) across ${sessions} session(s) ` +
      `(kept ${existingLines.length} existing record(s)) to ${outPath}`,
  );
}

main();
