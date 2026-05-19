/**
 * Extract failed Bash tool calls from Claude Code transcript JSONL files.
 *
 * Usage:
 *   npx tsx extract-test-cases.ts <dir1> [dir2] ... [-o output.json]
 *
 * Walks directories for *.jsonl files, parses them using claude-code-types,
 * finds Bash tool_use blocks matched to tool_result blocks with is_error: true,
 * and writes structured test cases to the output file.
 */

import type {
  TranscriptEntry,
  AssistantEntry,
  UserEntry,
  ToolUseBlock,
  ToolResultBlock,
  TextBlock,
} from 'claude-code-types';
import { createReadStream } from 'fs';
import { readdir, stat, writeFile } from 'fs/promises';
import { createInterface } from 'readline';
import { join, relative } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingBashCall {
  command: string;
  description: string;
  timestamp: string;
  cwd: string;
  file: string;
}

type Category =
  | 'dev_stdin'
  | 'backslash_path'
  | 'shell_expansion'
  | 'nested_quoting'
  | 'other';

interface TestCase {
  command: string;
  error: string;
  category: Category;
  file: string;
  timestamp: string;
  cwd: string;
}

// ---------------------------------------------------------------------------
// Categorization
// ---------------------------------------------------------------------------

function categorize(command: string, error: string): Category {
  // /dev/stdin, /dev/stdout, /dev/stderr
  if (
    command.includes('/dev/stdin') ||
    command.includes('/dev/stdout') ||
    command.includes('/dev/stderr') ||
    error.includes('/dev/stdin') ||
    error.includes("open 'C:\\dev\\stdin'")
  ) {
    return 'dev_stdin';
  }

  // Backslash drive paths in node -e
  const hasNodeE =
    command.includes('node -e') || command.includes('node --eval');
  if (hasNodeE) {
    // Drive letter + colon + backslash in the command
    if (/[A-Za-z]:\\/.test(command)) {
      // Check if the error indicates path corruption (tab, newline, etc.)
      if (
        error.includes('ENOENT') ||
        error.includes('no such file') ||
        /\\t|\\n|\\r|\\b/.test(error)
      ) {
        return 'backslash_path';
      }
    }
  }

  // $variable expansion in node -e (shell ate a variable)
  if (hasNodeE && (error.includes('SyntaxError') || error.includes('Unexpected'))) {
    // Check if the error shows mangled code (missing $ vars)
    if (/\$[a-zA-Z_]/.test(command)) {
      return 'shell_expansion';
    }
  }

  // Nested quoting: bash -c inside other commands
  if (
    error.includes('unexpected EOF') ||
    error.includes("looking for matching") ||
    error.includes('unterminated')
  ) {
    return 'nested_quoting';
  }

  return 'other';
}

// ---------------------------------------------------------------------------
// JSONL processing
// ---------------------------------------------------------------------------

function extractToolResultContent(block: ToolResultBlock): string {
  if (!block.content) return '';
  if (typeof block.content === 'string') return block.content;
  return (block.content as TextBlock[])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

async function processJsonlFile(
  filePath: string,
  baseDir: string,
  results: TestCase[],
): Promise<void> {
  const pending = new Map<string, PendingBashCall>();
  const relPath = relative(baseDir, filePath);

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }

    // Collect Bash tool_use from assistant messages
    if (entry.type === 'assistant') {
      const assistantEntry = entry as AssistantEntry;
      const content = assistantEntry.message?.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        const toolUse = block as ToolUseBlock;
        if (toolUse.name !== 'Bash') continue;

        const input = toolUse.input as Record<string, unknown>;
        pending.set(toolUse.id, {
          command: (input.command as string) || '',
          description: (input.description as string) || '',
          timestamp: assistantEntry.timestamp || '',
          cwd: assistantEntry.cwd || '',
          file: relPath,
        });
      }
    }

    // Match tool_result with is_error to pending Bash calls
    if (entry.type === 'user') {
      const userEntry = entry as UserEntry;
      const content = userEntry.message?.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const result = block as ToolResultBlock;
        if (!result.is_error) continue;

        const call = pending.get(result.tool_use_id);
        if (!call) continue;

        const errorContent = extractToolResultContent(result);
        // Skip empty errors
        if (!errorContent.trim()) continue;

        results.push({
          command: call.command,
          error: errorContent.slice(0, 2000), // Truncate huge outputs
          category: categorize(call.command, errorContent),
          file: call.file,
          timestamp: call.timestamp,
          cwd: call.cwd,
        });

        pending.delete(result.tool_use_id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

async function* walkJsonl(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonl(full);
    } else if (entry.name.endsWith('.jsonl')) {
      // Skip zero-byte files
      try {
        const s = await stat(full);
        if (s.size > 0) yield full;
      } catch {
        continue;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  let outputPath = 'test-cases.json';
  const dirs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' && args[i + 1]) {
      outputPath = args[++i];
    } else {
      dirs.push(args[i]);
    }
  }

  if (dirs.length === 0) {
    console.error('Usage: npx tsx extract-test-cases.ts <dir1> [dir2] ... [-o output.json]');
    process.exit(1);
  }

  const results: TestCase[] = [];
  let fileCount = 0;

  for (const dir of dirs) {
    console.error(`Scanning ${dir}...`);
    for await (const filePath of walkJsonl(dir)) {
      fileCount++;
      if (fileCount % 500 === 0) {
        console.error(`  Processed ${fileCount} files, ${results.length} failures found...`);
      }
      try {
        await processJsonlFile(filePath, dir, results);
      } catch (e) {
        // Skip files that can't be processed
        continue;
      }
    }
  }

  // Sort by category then timestamp
  results.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.timestamp.localeCompare(b.timestamp);
  });

  // Summary
  const categories = new Map<string, number>();
  for (const r of results) {
    categories.set(r.category, (categories.get(r.category) || 0) + 1);
  }

  console.error(`\nDone. Processed ${fileCount} files.`);
  console.error(`Found ${results.length} failed Bash calls:`);
  for (const [cat, count] of [...categories.entries()].sort()) {
    console.error(`  ${cat}: ${count}`);
  }

  await writeFile(outputPath, JSON.stringify(results, null, 2));
  console.error(`\nWritten to ${outputPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
