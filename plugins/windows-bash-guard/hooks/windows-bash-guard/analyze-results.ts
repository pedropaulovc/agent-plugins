/**
 * Analyze extracted test cases to find error patterns.
 * Usage: npx tsx analyze-results.ts [test-cases.json]
 */
import { readFileSync } from 'fs';

interface TestCase {
  command: string;
  error: string;
  category: string;
  file: string;
  timestamp: string;
  cwd: string;
}

const file = process.argv[2] || 'test-cases.json';
const data: TestCase[] = JSON.parse(readFileSync(file, 'utf8'));
const others = data.filter((x) => x.category === 'other');

// Classify by error pattern
const patterns: Record<string, TestCase[]> = {};

function classify(item: TestCase): string {
  const err = item.error;
  const cmd = item.command;

  // Trailing backslash before closing double-quote: "C:\path\" -> bash eats the quote
  if (err.includes('unexpected EOF') || err.includes('looking for matching')) {
    if (/[A-Za-z]:\\/.test(cmd)) return 'trailing_backslash_quote';
    return 'quoting_generic';
  }

  // Node-related errors
  if (err.includes('ENOENT')) {
    if (cmd.includes('node') || cmd.includes('npx')) return 'enoent_node';
    return 'enoent_bash';
  }
  if (err.includes('EACCES') || err.includes('Permission denied'))
    return 'permission';
  if (err.includes('command not found')) return 'cmd_not_found';
  if (err.includes('No such file or directory') && !err.includes('ENOENT'))
    return 'no_such_file_bash';
  if (err.includes('SyntaxError') || err.includes('Unexpected'))
    return 'syntax_error';
  if (
    err.includes('MODULE_NOT_FOUND') ||
    err.includes('Cannot find module')
  )
    return 'module_not_found';
  if (
    err.includes('ECONNREFUSED') ||
    err.includes('ECONNRESET') ||
    err.includes('fetch failed')
  )
    return 'connection';
  if (
    err.includes('timeout') ||
    err.includes('Timeout') ||
    err.includes('ETIMEDOUT')
  )
    return 'timeout';
  if (err.includes('EPERM')) return 'eperm';
  if (err.includes('EBUSY')) return 'ebusy';
  if (err.includes('already exists')) return 'already_exists';

  return 'uncategorized';
}

for (const item of others) {
  const key = classify(item);
  if (!patterns[key]) patterns[key] = [];
  patterns[key].push(item);
}

// Print summary
console.log('\n=== OTHER category breakdown ===\n');
const sorted = Object.entries(patterns).sort((a, b) => b[1].length - a[1].length);
for (const [key, items] of sorted) {
  console.log(`${items.length.toString().padStart(5)}  ${key}`);
}

// Print samples of each pattern
for (const [key, items] of sorted) {
  console.log(`\n--- ${key} (${items.length}) ---`);
  for (const item of items.slice(0, 2)) {
    console.log(`\n  CMD: ${item.command.slice(0, 200)}`);
    console.log(`  ERR: ${item.error.slice(0, 200)}`);
  }
}

// Extra analysis: Look for Windows-specific errors in "other" that we should detect
console.log('\n\n=== WINDOWS-SPECIFIC PATTERNS IN OTHER ===\n');

// Trailing backslash + double-quote
const trailingBs = others.filter(
  (x) =>
    x.error.includes('unexpected EOF') &&
    x.command.match(/\\"/),
);
console.log(`Trailing backslash+quote (\\") causing EOF: ${trailingBs.length}`);
for (const item of trailingBs.slice(0, 3)) {
  console.log(`  CMD: ${item.command.slice(0, 200)}`);
}

// nul file creation (piping to /dev/null but creating 'nul' file)
const nulFile = others.filter((x) => x.error.includes('nul') || x.command.includes('> nul'));
console.log(`\nnul file issues: ${nulFile.length}`);

// Windows path in bash context (not node -e)
const winPathBash = others.filter(
  (x) =>
    x.command.match(/[A-Za-z]:\\\\[A-Za-z]/) &&
    !x.command.includes('node -e') &&
    (x.error.includes('No such file') || x.error.includes('ENOENT')),
);
console.log(`\nWindows path issues (non-node): ${winPathBash.length}`);
for (const item of winPathBash.slice(0, 3)) {
  console.log(`  CMD: ${item.command.slice(0, 200)}`);
  console.log(`  ERR: ${item.error.slice(0, 150)}`);
}
