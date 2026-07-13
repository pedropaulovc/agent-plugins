#!/usr/bin/env node
// Scans this project's past Claude Code and OpenCode sessions (including
// sessions run in git worktrees) for Read tool calls under ./memory/,
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
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssistantEntry, ToolUseBlock, TranscriptEntry } from "claude-code-types";

interface UsageRecord {
  sessionId: string;
  memoryFileName: string;
}

interface OpenCodeUsage {
  databaseFound: boolean;
  sessionCount: number;
  records: UsageRecord[];
}

// Mirror Claude Code's project-slug convention: every path separator and dot
// collapses to a dash. Cover the Windows shapes too — a drive-letter colon and
// backslash separators — so "C:\\src\\proj" slugs to "C--src-proj" (matching
// ~/.claude/projects/C--src-proj), not the "C:\\src\\proj" that a POSIX-only
// regex leaves untouched, which would match zero session dirs on Windows.
function slugify(path: string): string {
  return path.replace(/[/\\.:]/g, "-");
}

// The command may itself be run FROM a worktree, in which case projectRoot is
// the worktree checkout ("<mainRoot>/.claude/worktrees/<name>"), not the main
// project root. Strip that suffix so session-dir discovery keys on the MAIN
// project slug — otherwise we'd only ever find the current worktree's own
// session dir and miss the main checkout plus every sibling worktree.
function mainProjectRoot(projectRoot: string): string {
  const m = projectRoot.match(/^(.*?)[/\\]\.claude[/\\]worktrees[/\\][^/\\]+[/\\]?$/);
  return m ? m[1] : projectRoot;
}

// Session transcripts for this project live under a slug directory; sessions
// run in a worktree of this project get their own slug directory named
// "<mainSlug>--claude-worktrees-<name>" (Claude Code's EnterWorktree
// convention: worktrees live at "<projectRoot>/.claude/worktrees/<name>").
function findSessionDirs(claudeProjectsDir: string, projectRoot: string): string[] {
  const mainSlug = slugify(mainProjectRoot(projectRoot));
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

function gitWorktreeRoots(projectRoot: string): string[] {
  try {
    const output = execSync("git worktree list --porcelain", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const roots = output
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => resolve(line.slice("worktree ".length)));
    return roots.length ? roots : [projectRoot];
  } catch {
    return [projectRoot];
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function matchingWorktree(worktrees: string[], candidate: string): string | undefined {
  return worktrees
    .filter((root) => isWithin(root, candidate))
    .sort((a, b) => b.length - a.length)[0];
}

function openCodeDatabasePath(): string | undefined {
  if (process.env.OPENCODE_DB_PATH) return resolve(process.env.OPENCODE_DB_PATH);
  const dataHome = process.env.XDG_DATA_HOME
    ? resolve(process.env.XDG_DATA_HOME)
    : join(homedir(), ".local", "share");
  const defaultPath = join(dataHome, "opencode", "opencode.db");
  if (existsSync(defaultPath)) return defaultPath;
  try {
    const discovered = execSync("opencode db path", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return discovered || undefined;
  } catch {
    return undefined;
  }
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

function memoryNameFromPath(worktree: string, cwd: string, filePath: string): string | undefined {
  const absolutePath = resolve(cwd, filePath);
  const rel = relative(worktree, absolutePath);
  const parts = rel.split(sep);
  if (parts[0] !== "memory" || parts.length < 2) return undefined;
  if (!rel.endsWith(".md") || basename(rel) === "MEMORY.md") return undefined;
  return parts.join("/");
}

function collectOpenCodeUsage(projectRoot: string): OpenCodeUsage {
  const databasePath = openCodeDatabasePath();
  if (!databasePath || !existsSync(databasePath)) {
    return { databaseFound: false, sessionCount: 0, records: [] };
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (!["session", "part"].every((table) => tableExists(database, table))) {
      return { databaseFound: true, sessionCount: 0, records: [] };
    }
    const worktrees = gitWorktreeRoots(projectRoot);
    const sessions = database
      .prepare(`
        SELECT s.id, s.directory, p.worktree
        FROM session s
        LEFT JOIN project p ON p.id = s.project_id
      `)
      .all() as Array<{ id: string; directory: string; worktree: string | null }>;
    const relevant = new Map<string, { directory: string; worktree: string }>();
    for (const session of sessions) {
      const directory = resolve(session.directory);
      const recordedRoot = session.worktree && session.worktree !== "/"
        ? resolve(session.worktree)
        : directory;
      const worktree = matchingWorktree(worktrees, recordedRoot)
        ?? matchingWorktree(worktrees, directory);
      if (worktree) relevant.set(session.id, { directory, worktree });
    }
    if (!relevant.size) {
      return { databaseFound: true, sessionCount: 0, records: [] };
    }

    const seen = new Set<string>();
    const records: UsageRecord[] = [];
    const parts = database
      .prepare(`
        SELECT session_id, data
        FROM part
        WHERE json_extract(data, '$.type') = 'tool'
          AND lower(json_extract(data, '$.tool')) = 'read'
      `)
      .iterate() as Iterable<{ session_id: string; data: string }>;
    for (const row of parts) {
      const session = relevant.get(row.session_id);
      if (!session) continue;
      let part: unknown;
      try {
        part = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (!part || typeof part !== "object") continue;
      const value = part as {
        type?: string;
        tool?: string;
        state?: { input?: { filePath?: unknown; file_path?: unknown } };
      };
      if (value.type !== "tool" || value.tool?.toLowerCase() !== "read") continue;
      const input = value.state?.input;
      const filePath = input?.filePath ?? input?.file_path;
      if (typeof filePath !== "string" || !filePath) continue;
      const memoryFileName = memoryNameFromPath(session.worktree, session.directory, filePath);
      if (!memoryFileName) continue;
      const key = `${row.session_id} ${memoryFileName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({ sessionId: row.session_id, memoryFileName });
    }
    return { databaseFound: true, sessionCount: relevant.size, records };
  } catch (error) {
    console.warn(`Could not scan OpenCode database ${databasePath}: ${String(error)}`);
    return { databaseFound: true, sessionCount: 0, records: [] };
  } finally {
    database.close();
  }
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
  const sessionDirs = existsSync(claudeProjectsDir)
    ? findSessionDirs(claudeProjectsDir, projectRoot)
    : [];
  const openCodeUsage = collectOpenCodeUsage(projectRoot);
  if (!existsSync(claudeProjectsDir) && !openCodeUsage.databaseFound) {
    console.log("No Claude Code or OpenCode session store found; no past sessions to scan.");
    return;
  }

  const outPath = join(memoryDir, "usage.jsonl");
  const isNewFile = !existsSync(outPath);
  const { lines: existingLines, keys: existingKeys } = readExisting(outPath);

  const combined = [...collectUsage(sessionDirs), ...openCodeUsage.records];
  const unique = new Map(combined.map((record) => [
    `${record.sessionId} ${record.memoryFileName}`,
    record,
  ]));
  const newRecords = [...unique.values()]
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
    `Scanned ${sessionDirs.length} Claude session director${sessionDirs.length === 1 ? "y" : "ies"} ` +
      `and ${openCodeUsage.sessionCount} OpenCode session(s); ` +
      `appended ${newRecords.length} new usage record(s) covering ${files} memory file(s) across ${sessions} session(s) ` +
      `(kept ${existingLines.length} existing record(s)) to ${outPath}`,
  );
}

main();
