/**
 * Deep analysis of Windows-specific patterns in failed Bash calls.
 * Usage: npx tsx analyze-windows-patterns.ts [test-cases.json]
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

// Pattern 1: Backslash-eaten paths in bash (not node -e)
// When bash processes unquoted C:\path, \p becomes just p
console.log('=== BACKSLASH PATHS EATEN BY BASH (not node -e) ===\n');

const backslashEaten = data.filter((x) => {
  const err = x.error;
  // Error shows path with backslashes removed: C:srcpath instead of C:\src\path
  return (
    /C:[a-z]/i.test(err) &&
    !err.includes('C:\\') &&
    (err.includes('No such file') || err.includes('cannot access') || err.includes('ENOENT'))
  );
});

console.log(`Total: ${backslashEaten.length}`);
for (const item of backslashEaten.slice(0, 10)) {
  console.log(`\n  CMD: ${item.command.slice(0, 250)}`);
  console.log(`  ERR: ${item.error.split('\n').find((l) => /C:[a-z]/i.test(l))?.slice(0, 200)}`);
}

// Pattern 2: Trailing backslash before closing double-quote
// "C:\path\" -> bash interprets \" as escaped quote -> unterminated string
console.log('\n\n=== TRAILING BACKSLASH IN DOUBLE-QUOTED PATH ===\n');

const trailingBs = data.filter((x) => {
  return (
    (x.error.includes('unexpected EOF') || x.error.includes('looking for matching')) &&
    // Check if command has a double-quoted string ending with backslash
    /\"[^"]*\\\"/.test(x.command)
  );
});

console.log(`Total: ${trailingBs.length}`);
for (const item of trailingBs.slice(0, 10)) {
  console.log(`\n  CMD: ${item.command.slice(0, 250)}`);
  console.log(`  ERR: ${item.error.slice(0, 150)}`);
}

// Pattern 3: Also check for the broader trailing-bs pattern
// Any command ending with \" inside a quoted path
console.log('\n\n=== ALL TRAILING BACKSLASH-QUOTE ERRORS ===\n');

const allTrailingBsErrors = data.filter((x) =>
  x.error.includes("unexpected EOF while looking for matching `\"'"),
);

console.log(`Total: ${allTrailingBsErrors.length}`);
for (const item of allTrailingBsErrors.slice(0, 10)) {
  console.log(`\n  CMD: ${item.command.slice(0, 250)}`);
}

// Pattern 4: /dev/null → nul issues
console.log('\n\n=== /dev/null and nul ISSUES ===\n');

const nulIssues = data.filter(
  (x) =>
    x.command.includes('> nul') ||
    (x.error.includes("'nul'") && x.error.includes('cannot')),
);
console.log(`Total: ${nulIssues.length}`);
for (const item of nulIssues.slice(0, 5)) {
  console.log(`\n  CMD: ${item.command.slice(0, 250)}`);
  console.log(`  ERR: ${item.error.slice(0, 150)}`);
}

// Pattern 5: bash-autofix.py hook errors
console.log('\n\n=== BASH-AUTOFIX HOOK ERRORS ===\n');

const hookErrors = data.filter((x) => x.error.includes('bash-autofix'));
console.log(`Total: ${hookErrors.length}`);
for (const item of hookErrors.slice(0, 5)) {
  console.log(`\n  CMD: ${item.command.slice(0, 250)}`);
  console.log(`  ERR: ${item.error.slice(0, 250)}`);
}

// Pattern 6: Windows path with tab/newline corruption in error messages
console.log('\n\n=== TAB/NEWLINE CORRUPTION IN PATHS (from error messages) ===\n');

const tabCorruption = data.filter((x) => {
  const err = x.error;
  // Look for paths where \t or \n were interpreted: shows as whitespace in path
  return (
    err.includes('ENOENT') &&
    (/open '[A-Z]:.*\t/.test(err) || /open '[A-Z]:.*\n/.test(err))
  );
});
console.log(`Total with tab/newline corruption: ${tabCorruption.length}`);
for (const item of tabCorruption.slice(0, 5)) {
  // Show the corrupted path
  const match = item.error.match(/open '([^']+)'/);
  if (match) {
    console.log(
      `\n  CORRUPTED PATH: ${JSON.stringify(match[1]).slice(0, 200)}`,
    );
    console.log(`  CMD: ${item.command.slice(0, 200)}`);
  }
}

// Summary
console.log('\n\n=== SUMMARY: Hook-Detectable Windows Patterns ===\n');
console.log(`  /dev/stdin in node commands:     ${data.filter((x) => x.category === 'dev_stdin').length}`);
console.log(`  Backslash paths in node -e:      ${data.filter((x) => x.category === 'backslash_path').length}`);
console.log(`  Shell expansion in node -e:      ${data.filter((x) => x.category === 'shell_expansion').length}`);
console.log(`  Nested quoting:                  ${data.filter((x) => x.category === 'nested_quoting').length}`);
console.log(`  Backslash eaten by bash:         ${backslashEaten.length}`);
console.log(`  Trailing backslash-quote:        ${allTrailingBsErrors.length}`);
console.log(`  Tab/newline path corruption:     ${tabCorruption.length}`);
console.log(`  -----------------------------------------`);

const hookDetectable =
  data.filter((x) => x.category === 'dev_stdin').length +
  data.filter((x) => x.category === 'backslash_path').length +
  data.filter((x) => x.category === 'shell_expansion').length +
  data.filter((x) => x.category === 'nested_quoting').length +
  backslashEaten.length +
  allTrailingBsErrors.length +
  tabCorruption.length;

console.log(`  Total hook-detectable:           ~${hookDetectable} (some overlap)`);
console.log(`  Total failures:                  ${data.length}`);
