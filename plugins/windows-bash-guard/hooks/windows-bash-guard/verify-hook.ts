/**
 * Verify the windows-bash-guard hook against extracted test cases.
 * Feeds each categorized test case to the hook binary and checks the result.
 *
 * Usage: npx tsx verify-hook.ts [test-cases.json]
 */
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

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

const HOOK = resolve(__dirname, '..', 'bin', 'windows-bash-guard.exe');

function testHook(command: string): { blocked: boolean; message: string } {
  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
  });

  try {
    execFileSync(HOOK, [], { input, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { blocked: false, message: '' };
  } catch (e: any) {
    if (e.status === 2) {
      return { blocked: true, message: (e.stderr || '').toString() };
    }
    return { blocked: false, message: `unexpected exit code ${e.status}` };
  }
}

// Test categorized cases
const categories = ['dev_stdin', 'backslash_path', 'shell_expansion', 'nested_quoting', 'other'];
const results: Record<string, { total: number; blocked: number; samples: string[] }> = {};

for (const cat of categories) {
  const items = data.filter((x) => x.category === cat);
  let blocked = 0;
  const samples: string[] = [];

  for (const item of items) {
    const result = testHook(item.command);
    if (result.blocked) {
      blocked++;
      if (samples.length < 3) {
        samples.push(
          `    CMD: ${item.command.slice(0, 120)}\n    HOOK: ${result.message.split('\n')[0]}`,
        );
      }
    }
  }

  results[cat] = { total: items.length, blocked, samples };
}

console.log('=== HOOK VERIFICATION RESULTS ===\n');

let totalBlocked = 0;
for (const [cat, r] of Object.entries(results)) {
  const pct = r.total > 0 ? ((r.blocked / r.total) * 100).toFixed(0) : '0';
  console.log(`${cat}: ${r.blocked}/${r.total} blocked (${pct}%)`);
  for (const s of r.samples) {
    console.log(s);
  }
  console.log();
  totalBlocked += r.blocked;
}

console.log(`Total blocked: ${totalBlocked} / ${data.length}`);

// False positive check: sample some "other" items that WERE blocked
const otherItems = data.filter((x) => x.category === 'other');
const otherBlocked = otherItems.filter((x) => testHook(x.command).blocked);

if (otherBlocked.length > 0) {
  console.log(`\n=== NEW CATCHES in "other" (${otherBlocked.length}) ===\n`);
  for (const item of otherBlocked.slice(0, 10)) {
    const result = testHook(item.command);
    console.log(`  CMD: ${item.command.slice(0, 150)}`);
    console.log(`  ERR: ${item.error.split('\n').slice(0, 2).join(' | ').slice(0, 120)}`);
    console.log(`  HOOK: ${result.message.split('\n')[0]}`);
    console.log();
  }
}
