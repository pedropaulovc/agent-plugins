//! Differential fuzz test for the command-chain-separator hook.
//!
//! The hook's entire safety guarantee is: it detects every compound-statement
//! opener (`for`/`if`/`while`/`case`/…) at command position and bails, so it
//! never splices a `printf` into the interior of a control-flow block. That is
//! a hand-rolled approximation of bash's grammar, so example-based tests can
//! only cover the cases we thought of.
//!
//! This test instead *generates* valid-by-construction bash programs — nesting
//! compounds, quotes, subshells, comments, pipelines and every separator, with
//! random whitespace (crucially including `\<newline>` line continuations)
//! sprinkled between tokens — then asserts the core invariant:
//!
//!     if the original parses under `bash -n`, so must the rewritten form.
//!
//! A single counterexample is a real bug (a command the hook would corrupt).
//! The generator is seeded deterministically so failures reproduce exactly;
//! override with FUZZ_SEED / FUZZ_ITERS.

use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

// --- deterministic PRNG (no external crate) --------------------------------

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // LCG (Knuth's MMIX constants) + xorshift output mix.
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let mut x = self.0;
        x ^= x >> 33;
        x
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn pick<'a>(&mut self, xs: &[&'a str]) -> &'a str {
        xs[self.below(xs.len())]
    }
    fn chance(&mut self, n: usize) -> bool {
        // true with probability 1/n
        self.below(n) == 0
    }
}

// --- valid-by-construction bash generator ----------------------------------

/// Whitespace between tokens. Includes `\<newline>` line continuations and raw
/// newlines — the constructs that let a keyword reach command position in a
/// non-obvious way (the class of bug this test exists to catch).
fn ws(r: &mut Rng) -> &'static str {
    r.pick(&[" ", "  ", " \\\n  ", " \\\n\t", "\t", " \\\n "])
}

/// A separator joining two commands in a list, padded with whitespace.
fn sep(r: &mut Rng) -> String {
    let op = r.pick(&[";", "&&", "||", "|", "&", "\n"]);
    format!("{}{}{}", ws(r), op, ws(r))
}

/// A leaf simple-command. Some variants embed quotes/redirections/comments/
/// substitutions so the scanner's skip logic is exercised too.
fn simple(r: &mut Rng) -> String {
    let base = r
        .pick(&[
            "echo x", "ls", "true", ":", "x=1", "cat f", "printf y",
            "echo 'a;b'", "echo \"c && d\"", "echo $'e\\nf'", "echo `date`",
            "echo $(id)", "echo ${HOME}", "grep foo",
        ])
        .to_string();
    match r.below(6) {
        0 => format!("{} > /dev/null", base),
        1 => format!("{} 2>&1", base),
        2 => format!("{} < /dev/null", base),
        3 => format!("cat <(echo hi)"), // process substitution
        _ => base,
    }
}

/// 1–3 simple commands joined by `|`.
fn pipeline(r: &mut Rng) -> String {
    let n = 1 + r.below(3);
    let mut s = simple(r);
    for _ in 1..n {
        s.push_str(&format!("{}|{}", ws(r), ws(r)));
        s.push_str(&simple(r));
    }
    s
}

/// A separator legal immediately before `do`/`then`/`fi`/`done` — `;` or
/// newline, padded with whitespace (which may itself contain continuations).
fn kwsep(r: &mut Rng) -> String {
    let op = if r.chance(2) { ";" } else { "\n" };
    format!("{}{}{}", ws(r), op, ws(r))
}

fn compound(r: &mut Rng, depth: usize) -> String {
    match r.below(5) {
        0 => format!(
            "{w}for{w2}i{w3}in{w4}1 2 3{s1}do{s2}{body}{s3}done",
            w = ws(r), w2 = ws(r), w3 = ws(r), w4 = ws(r),
            s1 = kwsep(r), s2 = kwsep(r), s3 = kwsep(r),
            body = list(r, depth - 1),
        ),
        1 => format!(
            "if{w}true{s1}then{s2}{body}{s3}fi",
            w = ws(r), s1 = kwsep(r), s2 = kwsep(r), s3 = kwsep(r),
            body = list(r, depth - 1),
        ),
        2 => format!(
            "while{w}false{s1}do{s2}{body}{s3}done",
            w = ws(r), s1 = kwsep(r), s2 = kwsep(r), s3 = kwsep(r),
            body = list(r, depth - 1),
        ),
        3 => format!("({w}{body}{w2})", w = ws(r), w2 = ws(r), body = list(r, depth - 1)),
        _ => format!("{{ {body} ; }}", body = list(r, depth - 1)),
    }
}

fn item(r: &mut Rng, depth: usize) -> String {
    if depth > 0 && r.chance(3) {
        return compound(r, depth);
    }
    pipeline(r)
}

/// A command list: items joined by separators. Optionally a trailing comment.
fn list(r: &mut Rng, depth: usize) -> String {
    let n = 1 + r.below(4);
    let mut s = item(r, depth);
    for _ in 1..n {
        s.push_str(&sep(r));
        s.push_str(&item(r, depth));
    }
    if depth > 0 && r.chance(8) {
        s.push_str(" # trailing comment");
    }
    s
}

fn gen_program(r: &mut Rng) -> String {
    list(r, 3)
}

// --- harness ---------------------------------------------------------------

/// Syntax-check a command with `bash -n -c`. Returns Some(true) if bash parses
/// it, Some(false) if it's a syntax error, None if bash couldn't be run.
fn bash_ok(cmd: &str) -> Option<bool> {
    let out = Command::new("bash")
        .arg("-n")
        .arg("-c")
        .arg(cmd)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    Some(out.status.success())
}

/// Run the command through the hook binary; return the rewritten command, or
/// the original unchanged if the hook produced no rewrite.
fn hook_rewrite(cmd: &str) -> String {
    let bin = env!("CARGO_BIN_EXE_command-chain-separator");
    let payload = json!({
        "tool_name": "Bash",
        "tool_input": { "command": cmd, "description": "fuzz" }
    })
    .to_string();

    let mut child = Command::new(bin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn hook binary");
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(payload.as_bytes())
        .expect("write stdin");
    let out = child.wait_with_output().expect("wait");
    let stdout = String::from_utf8(out.stdout).expect("utf8");

    if stdout.trim().is_empty() {
        return cmd.to_string(); // no rewrite
    }
    let v: Value = serde_json::from_str(&stdout).expect("hook emitted valid json");
    v["hookSpecificOutput"]["updatedInput"]["command"]
        .as_str()
        .expect("rewritten command present")
        .to_string()
}

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[test]
fn rewrite_never_breaks_a_valid_command() {
    if bash_ok("true").is_none() {
        eprintln!("bash unavailable — skipping differential fuzz test");
        return;
    }

    let seed = env_usize("FUZZ_SEED", 0x5eed_1234) as u64;
    let iters = env_usize("FUZZ_ITERS", 3000);
    let mut r = Rng(seed);

    let mut checked = 0usize; // originals that parsed and were tested
    let mut rewritten = 0usize; // of those, how many the hook actually changed
    let mut failures: Vec<(String, String)> = Vec::new();

    for _ in 0..iters {
        let original = gen_program(&mut r);

        // Only the invariant "valid original ⇒ valid rewrite" is meaningful;
        // skip programs the generator happened to make syntactically invalid.
        if bash_ok(&original) != Some(true) {
            continue;
        }
        checked += 1;

        let out = hook_rewrite(&original);
        if out != original {
            rewritten += 1;
        }
        if bash_ok(&out) != Some(true) {
            if failures.len() < 8 {
                failures.push((original.clone(), out));
            }
        }
    }

    eprintln!(
        "fuzz: seed={:#x} iters={} valid-originals-checked={} rewritten={} failures={}",
        seed, iters, checked, rewritten, failures.len()
    );

    // Guard against a degenerate generator that never produces rewritable
    // multi-command programs — the test would be vacuously green otherwise.
    assert!(
        checked > iters / 2,
        "generator produced too few valid programs ({checked}/{iters}) — test is not exercising the hook"
    );
    assert!(
        rewritten > checked / 10,
        "hook rewrote too few programs ({rewritten}/{checked}) — test is not exercising the splice path"
    );

    if !failures.is_empty() {
        for (orig, out) in &failures {
            eprintln!("\n--- COUNTEREXAMPLE ---\nORIGINAL (valid):\n{orig:?}\nREWRITTEN (invalid):\n{out:?}");
        }
        panic!(
            "{} rewrite(s) turned a valid command into a syntax error (seed {:#x})",
            failures.len(), seed
        );
    }
}
