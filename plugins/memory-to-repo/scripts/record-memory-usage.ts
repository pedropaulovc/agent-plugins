#!/usr/bin/env node
// Scans this project's past Claude Code and Codex sessions (including
// sessions run in git worktrees) for memory files that were consulted under
// ./memory/ — both Read tool calls and shell commands that name a memory file
// (e.g. `cat memory/foo.md` in a Bash call, `Get-Content memory\foo.md` in a
// PowerShell one) — and APPENDS any newly-discovered {sessionId, memoryFileName}
// records to ./memory/usage.jsonl — one record per distinct (session, memory
// file) pair.
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
import type { AssistantEntry, ToolUseBlock, TranscriptEntry } from "claude-code-types";

interface UsageRecord {
  sessionId: string;
  memoryFileName: string;
}

interface CodexUsage {
  storeFound: boolean;
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

// Commands that read a file's contents — the shell equivalent of the Read tool.
// A memory/<name>.md path is only counted as a consultation when it's an
// argument to one of these. This is the crux of separating a real read
// (`cat memory/x.md`, `Get-Content memory\x.md`, `rg pat memory/x.md`) from the
// far more common VCS/lifecycle churn that also names memory paths but never
// opens them: `git add memory/x.md`, `git rm memory/x.md`, `rm memory/x.md`,
// `mv`/`cp`/`ls`. Counting those would inflate the ranking with files that were
// merely committed or deleted, defeating its purpose.
const READ_COMMANDS = new Set([
  "cat", "tac", "bat", "batcat", "nl", "head", "tail", "less", "more", "most", "view",
  "sed", "awk", "gawk", "rg", "grep", "egrep", "fgrep", "ag", "ack", "wc", "cut",
  "strings", "xxd", "od", "hexdump", "jq", "yq",
  "get-content", "gc", "type",
]);

// Shell interpreters whose real command hides behind a `-c`/`-lc`/`-command`/`/c`
// flag (`bash -lc "cat memory/x.md"`, `pwsh -Command "..."`, `cmd /c "..."`).
const INTERPRETERS = new Set([
  "bash", "sh", "zsh", "dash", "fish", "pwsh", "powershell", "cmd", "wsl",
]);
const INTERPRETER_FLAGS = new Set(["-c", "-lc", "-command", "/c", "-encodedcommand"]);

// Commands whose FIRST positional argument is a search PATTERN, not a file:
// `rg memory/x.md` searches the tree for that string, it doesn't read the file.
// Skip that first bare argument so it isn't miscounted as a consultation.
const PATTERN_COMMANDS = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack", "awk", "gawk"]);

// Split a command into statement segments (on unquoted `;` `\n` `|` `&&` `||`
// `&`) and each segment into whitespace-separated tokens, honoring single and
// double quotes so a separator inside a quoted argument (`rg "a|b" memory/x.md`)
// doesn't fragment the command. Quote characters are dropped; the JSON-escaped
// `\"`/`\'` that Codex leaves in a captured command body collapse harmlessly.
function shellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let cur = "";
  let quote: string | null = null;
  const endToken = () => {
    if (cur) tokens.push(cur);
    cur = "";
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === " " || c === "\t" || c === "\r") endToken();
    else if (c === "\n" || c === ";") endSegment();
    else if (c === "|" || c === "&") {
      endSegment();
      if (command[i + 1] === c) i++;
    } else cur += c;
  }
  endSegment();
  return segments;
}

// The leading word of a segment, past env-assignments (`FOO=bar`) and simple
// prefixes (`sudo`, `command`, `\cmd`), normalized to a bare lowercase verb
// (`/usr/bin/rg` → `rg`, `Get-Content` → `get-content`).
function segmentVerb(tokens: string[]): { verb: string; index: number } {
  let i = 0;
  while (i < tokens.length && (/^\w[\w.]*=/.test(tokens[i]) || tokens[i] === "sudo" || tokens[i] === "command")) i++;
  const raw = (tokens[i] ?? "").replace(/^\\/, "");
  const verb = basename(raw.replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/, "");
  return { verb, index: i };
}

// Resolve a path a session touched to its repo-relative memory name, keyed the
// way the SessionStart hook looks counts up: the bare MEMORY.md link target
// ("<file>.md" or "<sub>/<file>.md", relative to the memory/ dir), NOT
// "memory/<file>.md" — a "memory/"-prefixed key never matches the index and the
// record is silently ignored during ranking. The path is resolved to absolute
// against `cwd` (the call's own workdir), then required to live directly under a
// worktree root's `memory/` dir. That scoping both credits the right store when
// a command runs from a subdirectory (`cat ../memory/x.md` from `src/` → the
// repo memory) and drops reads that target something else (`src/memory/x.md`, or
// another checkout entirely). Returns undefined for non-memory paths, the
// MEMORY.md index, and glob/unexpanded-var tokens (`memory/*.md`, `memory/$f.md`).
function memoryNameForPath(worktrees: string[], cwd: string, filePath: string): string | undefined {
  const absolute = resolve(cwd, filePath.replace(/\\/g, "/"));
  const root = matchingWorktree(worktrees, absolute);
  if (!root) return undefined;
  const rel = relative(root, absolute);
  const parts = rel.split(sep);
  if (parts[0] !== "memory" || parts.length < 2) return undefined;
  if (!rel.endsWith(".md") || basename(rel) === "MEMORY.md") return undefined;
  const name = parts.slice(1).join("/");
  if (/[*?$[\]]/.test(name)) return undefined;
  return name;
}

// A memory file can be consulted through the shell instead of the Read tool —
// `cat memory/foo.md` in a Bash call, `Get-Content memory\foo.md` in a
// PowerShell one, or a Codex shell call. Extract the memory names a command
// reads, resolving each path argument against the call's `cwd` (see
// memoryNameForPath). Only arguments to a file-reading command count — a
// pattern command's first positional (the search term) and in-place `sed -i` /
// `gawk -i inplace` edits are writes/searches, not reads, so they're skipped.
// `depth` bounds interpreter recursion.
function memoryNamesFromCommand(command: string, worktrees: string[], cwd: string, depth = 0): string[] {
  const names: string[] = [];
  for (const tokens of shellSegments(command)) {
    const { verb, index } = segmentVerb(tokens);
    if (depth < 2 && INTERPRETERS.has(verb)) {
      const flag = tokens.findIndex((t, i) => i > index && INTERPRETER_FLAGS.has(t.toLowerCase()));
      if (flag !== -1 && tokens[flag + 1]) names.push(...memoryNamesFromCommand(tokens[flag + 1], worktrees, cwd, depth + 1));
      continue;
    }
    if (!READ_COMMANDS.has(verb)) continue;
    // In-place edits rewrite the file rather than read it.
    if (verb === "sed" && tokens.some((t, i) => i > index && (t.startsWith("-i") || t.startsWith("--in-place")))) continue;
    if ((verb === "awk" || verb === "gawk") && tokens.some((t, i) => i > index && t === "inplace")) continue;
    let skipPattern = PATTERN_COMMANDS.has(verb);
    for (let i = index + 1; i < tokens.length; i++) {
      const raw = tokens[i];
      const prev = tokens[i - 1] ?? "";
      // A path right after an output redirection (`> file`) is written, not read.
      if (raw.startsWith(">") || prev === ">" || prev === ">>") continue;
      const token = raw.replace(/^\(+/, "").replace(/[);,|&]+$/, "");
      if (!token || token.startsWith("-")) continue;
      if (skipPattern) {
        skipPattern = false;
        continue;
      }
      const name = memoryNameForPath(worktrees, cwd, token);
      if (name) names.push(name);
    }
  }
  return names;
}

// A Read tool call's file_path is always absolute, but the session may have
// run in this project's root OR in a worktree checkout of it — resolve
// relative to the entry's own cwd so both normalize to the same repo-relative
// memory name. Bash calls are scanned too, for the shell-read case above.
function extractMemoryReads(entry: TranscriptEntry, worktrees: string[]): string[] {
  if (entry.type !== "assistant") return [];
  const message = (entry as AssistantEntry).message;
  const cwd = (entry as AssistantEntry).cwd;
  const names: string[] = [];
  for (const block of message.content) {
    if (block.type !== "tool_use") continue;
    const tu = block as ToolUseBlock;
    if (tu.name === "Bash") {
      const command = tu.input.command;
      if (typeof command === "string") names.push(...memoryNamesFromCommand(command, worktrees, cwd));
      continue;
    }
    if (tu.name !== "Read") continue;
    const filePath = tu.input.file_path;
    if (typeof filePath !== "string" || !filePath) continue;
    const name = memoryNameForPath(worktrees, cwd, filePath);
    if (name) names.push(name);
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

function collectUsage(sessionDirs: string[], worktrees: string[]): UsageRecord[] {
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
        for (const memoryFileName of extractMemoryReads(entry, worktrees)) {
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

// Codex stores each session as a JSONL "rollout" under
// ~/.codex/sessions/<yyyy>/<mm>/<dd>/ (or $CODEX_HOME/sessions when relocated).
function codexSessionsDir(): string {
  const home = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
  return join(home, "sessions");
}

function findJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findJsonlFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

// Codex reads files by running shell commands (`cat`, `sed`, `rg`,
// `Get-Content`), not through a dedicated Read tool, so its memory consultations
// only show up as shell calls. Two shapes carry a command: a `function_call` to
// a named shell tool (`arguments` is JSON with a `cmd`/`command` field), and the
// generic `exec` `custom_tool_call` whose `input` is JS that may invoke a shell
// (`tools.shell_command({command:...})` / `tools.exec_command({cmd:...})`),
// apply_patch (a write), or a web tool (irrelevant). File writes via apply_patch
// carry no `cmd`/`command` argument, so the arg-extraction below skips them and
// they never register as usage.
const CODEX_SHELL_FUNCTIONS = new Set([
  "shell",
  "shell_command",
  "local_shell",
  "exec_command",
  "container.exec",
]);

// Matches a shell tool's command argument (`cmd:"..."` or `command:"..."`, key
// optionally quoted), capturing the escape-laden string body up to its closing
// quote. Scoping to this argument keeps patch text, `workdir`, and other JSON
// noise out of what gets scanned, and cuts the command off at its real end
// rather than letting the trailing `","workdir":...` bleed into the last token.
const CODEX_COMMAND_ARG = /"?(?:cmd|command)"?\s*:\s*"((?:\\.|[^"\\])*)"/g;
const CODEX_WORKDIR_ARG = /"?(?:workdir|cwd)"?\s*:\s*"((?:\\.|[^"\\])*)"/g;

// A shell call runs in its own workdir, which may differ from the session cwd
// (a call from a subdirectory). Carry it so memory paths resolve against the
// right base; callers fall back to the session cwd when it's absent.
interface CodexCommand {
  command: string;
  workdir?: string;
}

function codexShellArgs(args: unknown): CodexCommand | undefined {
  if (typeof args !== "string") return undefined;
  try {
    const parsed = JSON.parse(args) as { cmd?: unknown; command?: unknown; workdir?: unknown; cwd?: unknown };
    const cmd = parsed.cmd ?? parsed.command;
    const workdir = typeof parsed.workdir === "string" ? parsed.workdir
      : typeof parsed.cwd === "string" ? parsed.cwd : undefined;
    if (Array.isArray(cmd)) return { command: cmd.map(String).join(" "), workdir };
    if (typeof cmd === "string") return { command: cmd, workdir };
  } catch {
    // Not JSON — fall back to scanning the raw argument text.
  }
  return { command: args };
}

// The capture is a JSON string body: quotes inside are escaped (`\"`), so
// `exec_command({cmd:"bash -lc \"cat memory/x.md\""})` yields
// `bash -lc \"cat memory/x.md\"`. Decode it back to real quotes.
function decodeJsonBody(body: string): string {
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return body;
  }
}

function codexCommandsFromEntry(entry: unknown): CodexCommand[] {
  if (!entry || typeof entry !== "object") return [];
  const payload = (entry as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") return [];
  const p = payload as { type?: string; name?: string; arguments?: unknown; input?: unknown };
  if (p.type === "function_call" && typeof p.name === "string" && CODEX_SHELL_FUNCTIONS.has(p.name)) {
    const parsed = codexShellArgs(p.arguments);
    return parsed ? [parsed] : [];
  }
  if (p.type === "custom_tool_call" && typeof p.input === "string") {
    const workdirs = [...p.input.matchAll(CODEX_WORKDIR_ARG)];
    return [...p.input.matchAll(CODEX_COMMAND_ARG)].map((m) => {
      // Pair each command with the workdir declared alongside it (the same
      // `{cmd:..., workdir:...}` object, so the first workdir following the cmd).
      const workdir = workdirs.find((w) => (w.index ?? 0) > (m.index ?? 0));
      return { command: decodeJsonBody(m[1]), workdir: workdir ? decodeJsonBody(workdir[1]) : undefined };
    });
  }
  return [];
}

function collectCodexUsage(worktrees: string[]): CodexUsage {
  const sessionsDir = codexSessionsDir();
  if (!existsSync(sessionsDir)) return { storeFound: false, sessionCount: 0, records: [] };

  const seen = new Set<string>();
  const records: UsageRecord[] = [];
  const sessions = new Set<string>();
  for (const file of findJsonlFiles(sessionsDir)) {
    let lines: string[];
    try {
      lines = readFileSync(file, "utf-8").split("\n");
    } catch {
      continue;
    }
    let sessionId: string | undefined;
    let cwd: string | undefined;
    const commands: CodexCommand[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const obj = entry as {
        type?: string;
        payload?: { session_id?: unknown; id?: unknown; cwd?: unknown };
      };
      if (obj.type === "session_meta" && obj.payload) {
        const id = obj.payload.session_id ?? obj.payload.id;
        if (typeof id === "string") sessionId = id;
        if (typeof obj.payload.cwd === "string") cwd = obj.payload.cwd;
        continue;
      }
      commands.push(...codexCommandsFromEntry(entry));
    }
    // A rollout with no meta cwd, or one whose cwd isn't in this project (nor a
    // worktree of it), belongs to a different repo — skip it.
    if (!sessionId || !cwd || !matchingWorktree(worktrees, resolve(cwd))) continue;
    sessions.add(sessionId);
    for (const { command, workdir } of commands) {
      // Resolve against the call's own workdir when it declared one (absolute
      // wins; a relative workdir is taken against the session cwd), else the
      // session cwd.
      const base = workdir ? resolve(cwd, workdir.replace(/\\/g, "/")) : cwd;
      for (const memoryFileName of memoryNamesFromCommand(command, worktrees, base)) {
        const key = `${sessionId} ${memoryFileName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        records.push({ sessionId, memoryFileName });
      }
    }
  }
  return { storeFound: true, sessionCount: sessions.size, records };
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

  const worktrees = gitWorktreeRoots(projectRoot);
  const claudeProjectsDir = join(homedir(), ".claude", "projects");
  const sessionDirs = existsSync(claudeProjectsDir)
    ? findSessionDirs(claudeProjectsDir, projectRoot)
    : [];
  const codexUsage = collectCodexUsage(worktrees);
  if (!existsSync(claudeProjectsDir) && !codexUsage.storeFound) {
    console.log("No Claude Code or Codex session store found; no past sessions to scan.");
    return;
  }

  const outPath = join(memoryDir, "usage.jsonl");
  const isNewFile = !existsSync(outPath);
  const { lines: existingLines, keys: existingKeys } = readExisting(outPath);

  const combined = [...collectUsage(sessionDirs, worktrees), ...codexUsage.records];
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
      `and ${codexUsage.sessionCount} Codex session(s); ` +
      `appended ${newRecords.length} new usage record(s) covering ${files} memory file(s) across ${sessions} session(s) ` +
      `(kept ${existingLines.length} existing record(s)) to ${outPath}`,
  );
}

main();
