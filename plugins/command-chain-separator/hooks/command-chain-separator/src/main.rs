//! PreToolUse hook for Bash that injects a visible output separator between
//! commands chained with `&&` or `;`, so per-command output is easier to read.
//!
//! `cmd1 && cmd2 ; cmd3` becomes
//! `cmd1 && printf '\n\n' && cmd2 ; printf '\n\n' ; cmd3`.
//!
//! The hook bails out silently on any command containing constructs where
//! naive splicing would change semantics: heredocs (`<<`, `<<-`), brace groups
//! (`{ ... ; }`), `;;` case terminators, comments (`#`), or any of the bash
//! control-flow keywords (`if`/`for`/`while`/`case`/`function`/`select`/`until`/
//! `do`/`then`/`else`/`elif`/`fi`/`done`/`esac`). Separators inside quotes,
//! command substitution (`$(...)`), parameter expansion (`${...}`), subshells
//! (`(...)`), and backslash-escaped operators are all skipped correctly.
//!
//! Bypass: add `[no-rewrite]` to the tool description.

use serde_json::{json, Value};
use std::io::{self, Read};
use std::process;

/// String spliced in *after* each separator. The original separator is
/// reissued at the end so the chain stays valid: e.g., `&&` becomes
/// `&& printf '...' &&`. `printf` is used (not `echo`) so the `\n` escapes
/// are interpreted as real newlines on every shell; single-quoting prevents
/// the shell from touching the backslashes before `printf` sees them.
const INJECT_PREFIX: &str = " printf '\\n\\n' ";

fn main() {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        process::exit(0);
    }

    let data: Value = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(_) => process::exit(0),
    };

    if data.get("tool_name").and_then(|v| v.as_str()) != Some("Bash") {
        process::exit(0);
    }

    let tool_input = match data.get("tool_input") {
        Some(v) => v,
        None => process::exit(0),
    };

    let description = tool_input
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if description.contains("[no-rewrite]") {
        process::exit(0);
    }

    let command = match tool_input.get("command").and_then(|v| v.as_str()) {
        Some(c) if !c.is_empty() => c,
        _ => process::exit(0),
    };

    let Some(rw) = rewrite(command) else {
        process::exit(0);
    };

    let mut updated = tool_input.as_object().cloned().unwrap_or_default();
    updated.insert("command".into(), Value::String(rw.command));

    let plural = if rw.count == 1 { "" } else { "s" };
    let output = json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "updatedInput": updated,
            "additionalContext": format!(
                "command-chain-separator: inserted {} output separator{} between commands joined by `&&` or `;`. Each prints two blank lines so per-command output is visually segmented. To bypass, add [no-rewrite] to the tool description.",
                rw.count, plural
            )
        }
    });
    println!("{}", output);
    process::exit(0);
}

// ---------------------------------------------------------------------------
// Rewrite
// ---------------------------------------------------------------------------

struct Rewrite {
    command: String,
    count: usize,
}

fn rewrite(cmd: &str) -> Option<Rewrite> {
    let seps = scan(cmd)?;
    if seps.is_empty() {
        return None;
    }

    let mut out = String::with_capacity(cmd.len() + seps.len() * 32);
    let mut cursor = 0;
    for sep in &seps {
        let after = sep.start + sep.len;
        out.push_str(&cmd[cursor..after]);
        out.push_str(INJECT_PREFIX);
        out.push_str(&cmd[sep.start..after]);
        cursor = after;
    }
    out.push_str(&cmd[cursor..]);

    Some(Rewrite { command: out, count: seps.len() })
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct Sep {
    start: usize,
    len: usize,
}

/// Bash *opening* control-flow keywords. Encountering one of these at command
/// position means we're entering a compound statement whose body uses `;` and
/// `&&` syntactically — we bail to avoid breaking it. Closing/middle keywords
/// (`do`, `then`, `fi`, `done`, `esac`, …) deliberately aren't listed: outside
/// a compound block they're just literal words (e.g. `echo done`), and inside
/// one we've already bailed on the opener.
const KEYWORDS: &[&[u8]] = &[
    b"if", b"for", b"while", b"case", b"function", b"select", b"until",
];

/// Walk `cmd` quote-and-paren-aware. Returns `None` if any unsafe construct is
/// found (then no rewrite happens); otherwise returns the positions of every
/// top-level `&&` (len 2) and `;` (len 1) separator.
fn scan(cmd: &str) -> Option<Vec<Sep>> {
    let b = cmd.as_bytes();
    let mut seps = Vec::new();
    let mut paren_depth: i32 = 0;
    // True when the next non-whitespace byte begins a new shell command —
    // i.e. start of input, or just after `;`, `&&`, `||`, `|`, `&`, `(`,
    // `$(`, or `\n`. Used to scope keyword and `#` checks to command position
    // (so `echo done` doesn't false-bail).
    let mut at_cmd_pos = true;
    let mut i = 0;

    while i < b.len() {
        let c = b[i];

        // Space/tab/CR: skip without changing cmd_pos.
        if matches!(c, b' ' | b'\t' | b'\r') {
            i += 1;
            continue;
        }

        // Newline: statement separator (but not one we splice at). Resets
        // cmd_pos so a keyword on the next line is detected.
        if c == b'\n' {
            i += 1;
            at_cmd_pos = true;
            continue;
        }

        // Backslash escape: consume the next byte verbatim. Handles `\\\n`
        // line continuation and any escaped operator (`\&`, `\;`, etc.).
        // A line continuation (`\` + newline) merely joins two physical
        // lines — it's whitespace and must NOT change command position, or a
        // control-flow keyword on the continued line (e.g. `&& \<newline>for`)
        // goes undetected and we fail to bail, corrupting the loop body. Any
        // other escaped byte is part of a word, so it leaves command position.
        if c == b'\\' && i + 1 < b.len() {
            if b[i + 1] != b'\n' {
                at_cmd_pos = false;
            }
            i += 2;
            continue;
        }

        // Quoted regions
        if c == b'\'' {
            i = skip_single_quoted(b, i);
            at_cmd_pos = false;
            continue;
        }
        if c == b'"' {
            i = skip_double_quoted(b, i);
            at_cmd_pos = false;
            continue;
        }
        if c == b'`' {
            i = skip_backtick(b, i);
            at_cmd_pos = false;
            continue;
        }

        // $-prefixed constructs
        if c == b'$' && i + 1 < b.len() {
            let next = b[i + 1];
            if next == b'\'' {
                i = skip_ansi_c(b, i + 1);
                at_cmd_pos = false;
                continue;
            }
            if next == b'"' {
                i = skip_double_quoted(b, i + 1);
                at_cmd_pos = false;
                continue;
            }
            if next == b'(' {
                paren_depth += 1;
                i += 2;
                at_cmd_pos = true;
                continue;
            }
            if next == b'{' {
                paren_depth += 1;
                i += 2;
                at_cmd_pos = false;
                continue;
            }
            // else: bare `$foo` variable expansion → falls through to default.
        }

        if c == b'(' {
            paren_depth += 1;
            i += 1;
            at_cmd_pos = true;
            continue;
        }
        if c == b')' || c == b'}' {
            paren_depth -= 1;
            i += 1;
            at_cmd_pos = false;
            continue;
        }

        // Bail conditions ---------------------------------------------------

        // Brace group as a command — `{ cmd1; cmd2; }`. (We deliberately do
        // NOT bail on `${...}`: that branch consumed the `${` already.)
        if c == b'{' {
            return None;
        }

        // Heredoc operator. `<<` or `<<-` introduces a body that may contain
        // arbitrary `&&` / `;` text we must not touch.
        if c == b'<' && i + 1 < b.len() && b[i + 1] == b'<' {
            return None;
        }

        // `#` starts a comment at any word boundary (not just command
        // position): `cmd1 && cmd2 # comment` is a comment too.
        if c == b'#' && (i == 0 || is_token_boundary(b[i - 1])) {
            return None;
        }

        // Opening control-flow keywords at command position.
        if at_cmd_pos {
            for kw in KEYWORDS {
                if b[i..].starts_with(kw) && is_token_end(b, i + kw.len()) {
                    return None;
                }
            }
        }

        // Operators at top level (paren_depth == 0) ------------------------
        if paren_depth == 0 {
            if c == b'&' && i + 1 < b.len() && b[i + 1] == b'&' {
                seps.push(Sep { start: i, len: 2 });
                i += 2;
                at_cmd_pos = true;
                continue;
            }
            if c == b'|' && i + 1 < b.len() && b[i + 1] == b'|' {
                // `||` is not a separator we splice at, but we step past it
                // as a single token so the second `|` isn't mistaken later.
                i += 2;
                at_cmd_pos = true;
                continue;
            }
            if c == b';' {
                if i + 1 < b.len() && b[i + 1] == b';' {
                    return None; // `;;` is a case-statement terminator.
                }
                seps.push(Sep { start: i, len: 1 });
                i += 1;
                at_cmd_pos = true;
                continue;
            }
            if c == b'|' {
                // Pipeline: not spliced, but starts a new command position.
                i += 1;
                at_cmd_pos = true;
                continue;
            }
            if c == b'&' {
                // Trailing `&` for backgrounding: not spliced; next is cmd_pos.
                i += 1;
                at_cmd_pos = true;
                continue;
            }
        }

        // Default: a regular byte inside a word/argument.
        at_cmd_pos = false;
        i += 1;
    }

    Some(seps)
}

// ---------------------------------------------------------------------------
// Quote helpers
// ---------------------------------------------------------------------------

/// `'...'` — no escapes; anything until the next `'` is literal.
fn skip_single_quoted(b: &[u8], i: usize) -> usize {
    let mut j = i + 1;
    while j < b.len() && b[j] != b'\'' {
        j += 1;
    }
    if j < b.len() { j + 1 } else { b.len() }
}

/// `"..."` — backslash escapes one byte; closes on unescaped `"`.
fn skip_double_quoted(b: &[u8], i: usize) -> usize {
    let mut j = i + 1;
    while j < b.len() {
        let c = b[j];
        if c == b'\\' && j + 1 < b.len() {
            j += 2;
            continue;
        }
        if c == b'"' {
            return j + 1;
        }
        j += 1;
    }
    b.len()
}

/// `` `...` `` — backslash escapes; closes on unescaped backtick.
fn skip_backtick(b: &[u8], i: usize) -> usize {
    let mut j = i + 1;
    while j < b.len() {
        let c = b[j];
        if c == b'\\' && j + 1 < b.len() {
            j += 2;
            continue;
        }
        if c == b'`' {
            return j + 1;
        }
        j += 1;
    }
    b.len()
}

/// `$'...'` ANSI-C string. `i` points at the opening `'`.
fn skip_ansi_c(b: &[u8], i: usize) -> usize {
    let mut j = i + 1;
    while j < b.len() {
        let c = b[j];
        if c == b'\\' && j + 1 < b.len() {
            j += 2;
            continue;
        }
        if c == b'\'' {
            return j + 1;
        }
        j += 1;
    }
    b.len()
}

// ---------------------------------------------------------------------------
// Token boundary helpers
// ---------------------------------------------------------------------------

fn is_token_boundary(byte: u8) -> bool {
    matches!(
        byte,
        b' ' | b'\t' | b'\n' | b'\r' | b';' | b'&' | b'|' | b'(' | b')'
    )
}

fn is_token_end(bytes: &[u8], i: usize) -> bool {
    i >= bytes.len() || is_token_boundary(bytes[i])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn out(cmd: &str) -> String {
        rewrite(cmd).unwrap().command
    }
    fn count(cmd: &str) -> usize {
        rewrite(cmd).unwrap().count
    }

    // -- Basic injection -----------------------------------------------------

    #[test]
    fn injects_between_two_amp_amp_commands() {
        assert_eq!(
            out("cmd1 && cmd2"),
            "cmd1 && printf '\\n\\n' && cmd2"
        );
    }

    #[test]
    fn injects_between_three_amp_amp_commands() {
        assert_eq!(count("cmd1 && cmd2 && cmd3"), 2);
    }

    #[test]
    fn injects_at_semicolon() {
        assert_eq!(
            out("cmd1 ; cmd2"),
            "cmd1 ; printf '\\n\\n' ; cmd2"
        );
    }

    #[test]
    fn injects_at_semicolon_no_spaces() {
        // `cmd1;cmd2` → `cmd1; printf '...' ;cmd2`. The injected printf keeps
        // a leading space so the original operator stays delimited.
        assert_eq!(
            out("cmd1;cmd2"),
            "cmd1; printf '\\n\\n' ;cmd2"
        );
    }

    #[test]
    fn injects_in_mixed_chain() {
        assert_eq!(
            out("a && b ; c"),
            "a && printf '\\n\\n' && b ; printf '\\n\\n' ; c"
        );
    }

    // -- No-op cases ---------------------------------------------------------

    #[test]
    fn no_op_for_single_command() {
        assert!(rewrite("ls -la /tmp").is_none());
    }

    #[test]
    fn no_op_for_pipeline_only() {
        // `|` is not a separator we splice at.
        assert!(rewrite("cat file | grep foo | wc -l").is_none());
    }

    #[test]
    fn no_op_for_or_chain() {
        // `||` is not a target either.
        assert!(rewrite("cmd1 || cmd2").is_none());
    }

    #[test]
    fn no_op_for_background_amp() {
        // Single `&` is backgrounding, not a separator.
        assert!(rewrite("long-task &").is_none());
    }

    // -- Quote protection ----------------------------------------------------

    #[test]
    fn ignores_amp_amp_inside_double_quotes() {
        assert!(rewrite("echo \"foo && bar\"").is_none());
    }

    #[test]
    fn ignores_semicolon_inside_single_quotes() {
        assert!(rewrite("echo 'a;b'").is_none());
    }

    #[test]
    fn ignores_separators_inside_ansi_c_string() {
        assert!(rewrite("echo $'foo;bar && baz'").is_none());
    }

    #[test]
    fn ignores_separators_inside_backticks() {
        assert!(rewrite("echo `cmd1 && cmd2`").is_none());
    }

    #[test]
    fn injects_around_quoted_strings_that_contain_separators() {
        assert_eq!(
            out("echo 'a && b' && ls"),
            "echo 'a && b' && printf '\\n\\n' && ls"
        );
    }

    // -- Paren / substitution depth ------------------------------------------

    #[test]
    fn ignores_amp_amp_inside_subshell() {
        // Subshell `(...)` is a single command from the outer chain's view.
        assert!(rewrite("(cd /tmp && ls)").is_none());
    }

    #[test]
    fn ignores_amp_amp_inside_command_substitution() {
        assert!(rewrite("echo $(cmd1 && cmd2)").is_none());
    }

    #[test]
    fn injects_around_subshell_at_top_level() {
        assert_eq!(
            out("(cd /tmp && ls) && echo done"),
            "(cd /tmp && ls) && printf '\\n\\n' && echo done"
        );
    }

    #[test]
    fn injects_around_command_substitution_at_top_level() {
        assert_eq!(
            count("echo $(date) && ls && pwd"),
            2
        );
    }

    // -- Unsafe constructs → bail -------------------------------------------

    #[test]
    fn bails_on_heredoc() {
        assert!(rewrite("cat <<EOF\nfoo && bar\nEOF\n && echo done").is_none());
    }

    #[test]
    fn bails_on_dash_heredoc() {
        assert!(rewrite("cat <<-EOF\nhi\nEOF\n").is_none());
    }

    #[test]
    fn bails_on_for_loop() {
        assert!(rewrite("for x in 1 2 3; do echo $x; done").is_none());
    }

    #[test]
    fn bails_on_if_block() {
        assert!(rewrite("if [ -f foo ]; then echo yes; fi").is_none());
    }

    #[test]
    fn bails_on_while_loop() {
        assert!(rewrite("while read line; do echo $line; done < file").is_none());
    }

    #[test]
    fn bails_on_case_statement() {
        assert!(rewrite("case $x in a) echo a;; b) echo b;; esac").is_none());
    }

    #[test]
    fn bails_on_brace_group() {
        assert!(rewrite("{ cmd1 ; cmd2 ; }").is_none());
    }

    #[test]
    fn bails_on_function_keyword() {
        assert!(rewrite("function foo() { echo hi; }").is_none());
    }

    #[test]
    fn bails_on_double_semicolon() {
        // `;;` is a case-statement terminator and rewriting would corrupt it.
        assert!(rewrite("foo ;; bar").is_none());
    }

    #[test]
    fn bails_on_comment() {
        assert!(rewrite("cmd1 && cmd2 # trailing comment").is_none());
    }

    // -- Escape handling -----------------------------------------------------

    #[test]
    fn ignores_escaped_amp_amp() {
        // `\&` is a literal &, not part of an operator.
        assert!(rewrite(r"echo a \&\& b").is_none());
    }

    #[test]
    fn handles_line_continuation() {
        // `\\\n` is line continuation, but `&&` still operates between commands.
        assert_eq!(
            count("cmd1 \\\n  && cmd2"),
            1
        );
    }

    #[test]
    fn bails_on_for_loop_reached_via_line_continuation() {
        // Regression: the `for` opens at command position but is reached over a
        // `&& \<newline>` line continuation. The continuation must not clear
        // command position, or the keyword goes undetected and the loop's
        // internal `;` (before `do`/`done`) get spliced, corrupting it.
        assert!(rewrite("split x && \\\n  for i in 00 01 02; do \\\n    echo $i; \\\n  done && ls").is_none());
    }

    #[test]
    fn bails_on_if_block_reached_via_line_continuation() {
        assert!(rewrite("prep && \\\n  if [ -f foo ]; then echo yes; fi").is_none());
    }

    // -- Realistic chains ----------------------------------------------------

    #[test]
    fn realistic_build_chain() {
        assert_eq!(
            count("npm install && npm run build && npm test"),
            2
        );
    }

    #[test]
    fn realistic_git_chain() {
        assert_eq!(
            count("git pull && git rebase main && git push"),
            2
        );
    }

    // -- Context message -----------------------------------------------------

    #[test]
    fn rewrite_preserves_original_when_no_separators() {
        // `rewrite` returns None, so the binary emits nothing — but the cmd
        // should be untouched in any path that doesn't go through main().
        assert!(rewrite("just-one-command").is_none());
    }
}
