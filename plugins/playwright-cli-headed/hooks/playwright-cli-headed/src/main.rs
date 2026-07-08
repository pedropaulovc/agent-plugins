//! PreToolUse hook that enforces `--headed` on `playwright-cli open` invocations
//! in Bash and PowerShell commands and nudges toward a standard viewport size.
//!
//! Rules:
//! 1. Any `playwright-cli ... open ...` invocation must include `--headed`.
//!    When missing, the hook auto-injects ` --headed` immediately after the
//!    `open` subcommand token, leaving the rest of the command byte-for-byte
//!    unchanged.
//! 2. Whenever `playwright-cli open` is detected (regardless of `--headed`),
//!    a system reminder recommends running `playwright-cli resize 1600 900`
//!    first for consistent screenshot dimensions.
//!
//! Output:
//! - `updatedInput` is included when a rewrite happened.
//! - `additionalContext` is included whenever `playwright-cli open` is seen.
//!
//! Claude can bypass rewriting (but not the tip) by adding `[no-rewrite]` to
//! the tool description.

use serde_json::{json, Map, Value};
use std::io::{self, Read};
use std::process;

fn main() {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        process::exit(0);
    }

    let data: Value = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(_) => process::exit(0),
    };

    let tool_name = data.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
    if !matches!(tool_name, "Bash" | "PowerShell") {
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
    let bypass_rewrite = description.contains("[no-rewrite]");

    let command = match tool_input.get("command").and_then(|v| v.as_str()) {
        Some(c) if !c.is_empty() => c,
        _ => process::exit(0),
    };

    let analysis = analyze(command, bypass_rewrite);
    if !analysis.open_detected {
        process::exit(0);
    }

    // Under Codex, applying updatedInput requires permissionDecision:"allow",
    // which also skips the approval prompt — so rewriting would launder the
    // command past the user's approval gate. Only rewrite when the session is
    // already in an approval-skipping mode (bypassPermissions/dontAsk); in an
    // approval-requiring mode, stay inert rather than auto-approve. Claude Code
    // applies a bare updatedInput without approving, so it always rewrites.
    let codex = under_codex();
    if analysis.rewrites > 0 && codex && !codex_approval_already_skipped(&data) {
        process::exit(0);
    }

    let mut hook_output = Map::new();
    hook_output.insert(
        "hookEventName".into(),
        Value::String("PreToolUse".into()),
    );

    if analysis.rewrites > 0 {
        let mut updated = tool_input.as_object().cloned().unwrap_or_default();
        updated.insert("command".into(), Value::String(analysis.command));
        // Codex requires permissionDecision:"allow" alongside updatedInput (a
        // bare updatedInput is rejected as an error). Only emit it when we are
        // actually rewriting; a context-only response needs no decision.
        if codex {
            hook_output.insert("permissionDecision".into(), Value::String("allow".into()));
        }
        hook_output.insert("updatedInput".into(), Value::Object(updated));
    }

    hook_output.insert(
        "additionalContext".into(),
        Value::String(build_context(analysis.rewrites, bypass_rewrite)),
    );

    println!("{}", json!({ "hookSpecificOutput": hook_output }));
    process::exit(0);
}

/// True when running as a Codex plugin hook. Codex sets the `PLUGIN_ROOT` env
/// var for plugin hook commands (Claude Code sets only `CLAUDE_PLUGIN_ROOT`),
/// so its presence distinguishes the two harnesses.
fn under_codex() -> bool {
    std::env::var_os("PLUGIN_ROOT").is_some()
}

/// True when the Codex session is already in a permission mode that skips the
/// approval prompt, so emitting `permissionDecision:"allow"` for our rewrite
/// grants nothing the session wasn't already granting. Codex reports the mode as
/// `permission_mode`; only `bypassPermissions` and `dontAsk` bypass approval.
/// Any other value — or a missing field — is treated as approval-required, so
/// the hook fails safe (no rewrite, no auto-approve).
fn codex_approval_already_skipped(data: &Value) -> bool {
    matches!(
        data.get("permission_mode").and_then(|v| v.as_str()),
        Some("bypassPermissions") | Some("dontAsk")
    )
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

struct Analysis {
    /// True when at least one `playwright-cli ... open ...` invocation was seen.
    open_detected: bool,
    /// Number of `--headed` insertions made.
    rewrites: usize,
    /// Possibly-rewritten command (equal to the input when `rewrites == 0`).
    command: String,
}

const NEEDLE: &[u8] = b"playwright-cli";

fn analyze(command: &str, bypass_rewrite: bool) -> Analysis {
    let bytes = command.as_bytes();
    let mut result = String::with_capacity(command.len() + 16);
    let mut cursor = 0;
    let mut rewrites = 0usize;
    let mut open_detected = false;
    let mut i = 0;

    while i + NEEDLE.len() <= bytes.len() {
        if !is_word_start(bytes, i) {
            i += 1;
            continue;
        }
        if &bytes[i..i + NEEDLE.len()] != NEEDLE {
            i += 1;
            continue;
        }
        let after = i + NEEDLE.len();
        if !is_word_end(bytes, after) {
            i += 1;
            continue;
        }

        let args_end = find_args_end(bytes, after);
        let tokens = tokenize(&command[after..args_end], after);

        let has_headed = tokens.iter().any(|t| {
            t.text == "--headed" || t.text.starts_with("--headed=") || t.text == "-headed"
        });
        let open_token = tokens.iter().find(|t| t.text == "open");

        if open_token.is_some() {
            open_detected = true;
        }

        if !has_headed && !bypass_rewrite {
            if let Some(open) = open_token {
                result.push_str(&command[cursor..open.end]);
                result.push_str(" --headed");
                cursor = open.end;
                rewrites += 1;
            }
        }

        i = args_end;
    }

    if rewrites > 0 {
        result.push_str(&command[cursor..]);
    } else {
        result.clear();
        result.push_str(command);
    }

    Analysis {
        open_detected,
        rewrites,
        command: result,
    }
}

// ---------------------------------------------------------------------------
// Context message
// ---------------------------------------------------------------------------

const RESIZE_TIP: &str =
    "It is recommended to execute `playwright-cli resize 1600 900` for better screenshot compatibility.";

fn build_context(rewrites: usize, bypass_rewrite: bool) -> String {
    if rewrites > 0 {
        let plural = if rewrites == 1 { "" } else { "s" };
        return format!(
            "playwright-cli-headed: added `--headed` to {} `playwright-cli open` invocation{} (rule: playwright-cli open must always run --headed so the browser is visible). To bypass rewriting, add [no-rewrite] to the tool description. {}",
            rewrites, plural, RESIZE_TIP
        );
    }

    if bypass_rewrite {
        return format!(
            "playwright-cli-headed: detected `playwright-cli open`; rewriting bypassed via [no-rewrite]. {}",
            RESIZE_TIP
        );
    }

    format!(
        "playwright-cli-headed: detected `playwright-cli open` (already has --headed). {}",
        RESIZE_TIP
    )
}

// ---------------------------------------------------------------------------
// Word boundaries
// ---------------------------------------------------------------------------

/// `playwright-cli` is a fresh token start when the preceding byte is whitespace,
/// a path separator (so `/usr/local/bin/playwright-cli` matches), a quote, or a
/// shell command opener (`;`, `|`, `&`, `(`, `=`, backtick, `$`).
fn is_word_start(bytes: &[u8], i: usize) -> bool {
    if i == 0 {
        return true;
    }
    matches!(
        bytes[i - 1],
        b' ' | b'\t'
            | b'\n'
            | b'\r'
            | b'/'
            | b'\\'
            | b'"'
            | b'\''
            | b'`'
            | b';'
            | b'&'
            | b'|'
            | b'('
            | b'='
            | b'$'
    )
}

/// End-of-token: either at end-of-string or the next byte is whitespace/separator.
fn is_word_end(bytes: &[u8], i: usize) -> bool {
    if i >= bytes.len() {
        return true;
    }
    matches!(
        bytes[i],
        b' ' | b'\t' | b'\n' | b'\r' | b';' | b'|' | b'&' | b')' | b'\'' | b'"' | b'`'
    )
}

// ---------------------------------------------------------------------------
// Argument-slice detection
// ---------------------------------------------------------------------------

/// Walk forward from `start` until we hit an unquoted shell statement separator
/// (`;`, `&`, `|`, newline) or end-of-string. Quoted strings are skipped so a
/// `;` inside `'foo;bar'` doesn't terminate the slice.
fn find_args_end(bytes: &[u8], start: usize) -> usize {
    let mut i = start;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\'' || b == b'"' {
            i = skip_quoted(bytes, i);
            continue;
        }
        if matches!(b, b';' | b'&' | b'|' | b'\n') {
            return i;
        }
        i += 1;
    }
    bytes.len()
}

/// Given `bytes[i]` is a quote, return the index just past the matching closing
/// quote (or end of string if unterminated).
fn skip_quoted(bytes: &[u8], i: usize) -> usize {
    let quote = bytes[i];
    let mut j = i + 1;
    while j < bytes.len() {
        let b = bytes[j];
        if b == b'\\' && quote == b'"' && j + 1 < bytes.len() {
            j += 2;
            continue;
        }
        if b == quote {
            return j + 1;
        }
        j += 1;
    }
    bytes.len()
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

struct Token {
    /// Token text with any surrounding quotes stripped.
    text: String,
    /// Byte offset of the token's last byte + 1 in the original command string.
    end: usize,
}

/// Tokenize a slice of shell arguments. `base` is the byte offset of `slice`
/// inside the original command; recorded `end` positions are absolute.
fn tokenize(slice: &str, base: usize) -> Vec<Token> {
    let bytes = slice.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;

    while i < bytes.len() {
        while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b'\r' | b'\n') {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }

        let mut text = String::new();

        while i < bytes.len() {
            let b = bytes[i];
            if matches!(b, b' ' | b'\t' | b'\r' | b'\n') {
                break;
            }
            if b == b'\'' || b == b'"' {
                let close = skip_quoted(bytes, i);
                let inner_end = if close <= bytes.len()
                    && close > i + 1
                    && bytes.get(close - 1).copied() == Some(b)
                {
                    close - 1
                } else {
                    close
                };
                text.push_str(&slice[i + 1..inner_end]);
                i = close;
                continue;
            }
            text.push(b as char);
            i += 1;
        }

        tokens.push(Token {
            text,
            end: base + i,
        });
    }

    tokens
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn run(cmd: &str) -> Analysis {
        analyze(cmd, false)
    }

    // -- Basic insertion -----------------------------------------------------

    #[test]
    fn adds_headed_after_open() {
        let a = run("playwright-cli open https://example.com");
        assert!(a.open_detected);
        assert_eq!(a.rewrites, 1);
        assert_eq!(a.command, "playwright-cli open --headed https://example.com");
    }

    #[test]
    fn adds_headed_with_no_extra_args() {
        let a = run("playwright-cli open");
        assert_eq!(a.command, "playwright-cli open --headed");
        assert_eq!(a.rewrites, 1);
    }

    #[test]
    fn adds_headed_with_flags_before_open() {
        let a = run("playwright-cli --verbose open https://example.com");
        assert_eq!(
            a.command,
            "playwright-cli --verbose open --headed https://example.com"
        );
    }

    #[test]
    fn adds_headed_with_flags_after_open() {
        let a = run("playwright-cli open --device 'iPhone 15' https://example.com");
        assert_eq!(
            a.command,
            "playwright-cli open --headed --device 'iPhone 15' https://example.com"
        );
    }

    // -- Tip-only path (open detected, no rewrite) ---------------------------

    #[test]
    fn detects_open_when_headed_already_present() {
        let a = run("playwright-cli open --headed https://example.com");
        assert!(a.open_detected);
        assert_eq!(a.rewrites, 0);
        assert_eq!(a.command, "playwright-cli open --headed https://example.com");
    }

    #[test]
    fn detects_open_when_headed_before_open() {
        let a = run("playwright-cli --headed open https://example.com");
        assert!(a.open_detected);
        assert_eq!(a.rewrites, 0);
    }

    #[test]
    fn detects_open_when_headed_equals_form() {
        let a = run("playwright-cli open --headed=true https://example.com");
        assert!(a.open_detected);
        assert_eq!(a.rewrites, 0);
    }

    #[test]
    fn bypass_rewrite_still_reports_detection() {
        let a = analyze("playwright-cli open https://example.com", true);
        assert!(a.open_detected);
        assert_eq!(a.rewrites, 0);
        assert_eq!(a.command, "playwright-cli open https://example.com");
    }

    // -- Negative cases ------------------------------------------------------

    #[test]
    fn no_detection_when_no_open_subcommand() {
        let a = run("playwright-cli codegen https://example.com");
        assert!(!a.open_detected);
        assert_eq!(a.rewrites, 0);
    }

    #[test]
    fn no_detection_when_not_playwright_cli() {
        let a = run("playwright open https://example.com");
        assert!(!a.open_detected);
    }

    #[test]
    fn no_detection_when_playwright_cli_is_substring() {
        let a = run("foo-playwright-cli-bar open https://example.com");
        assert!(!a.open_detected);
    }

    // -- Path & shell-context invocations ------------------------------------

    #[test]
    fn handles_full_path_invocation() {
        let a = run("/usr/local/bin/playwright-cli open https://example.com");
        assert_eq!(
            a.command,
            "/usr/local/bin/playwright-cli open --headed https://example.com"
        );
    }

    #[test]
    fn handles_relative_path_invocation() {
        let a = run("./playwright-cli open https://example.com");
        assert_eq!(a.command, "./playwright-cli open --headed https://example.com");
    }

    #[test]
    fn handles_env_prefix() {
        let a = run("DEBUG=1 playwright-cli open https://example.com");
        assert_eq!(
            a.command,
            "DEBUG=1 playwright-cli open --headed https://example.com"
        );
    }

    // -- Multi-statement commands --------------------------------------------

    #[test]
    fn rewrites_only_the_offending_statement() {
        let a = run("echo hi && playwright-cli open https://example.com");
        assert_eq!(
            a.command,
            "echo hi && playwright-cli open --headed https://example.com"
        );
        assert_eq!(a.rewrites, 1);
    }

    #[test]
    fn does_not_pull_open_from_a_different_statement() {
        let a = run("playwright-cli codegen url; open file.txt");
        assert!(!a.open_detected);
    }

    #[test]
    fn rewrites_multiple_invocations() {
        let a = run("playwright-cli open a; playwright-cli open b");
        assert_eq!(
            a.command,
            "playwright-cli open --headed a; playwright-cli open --headed b"
        );
        assert_eq!(a.rewrites, 2);
    }

    #[test]
    fn handles_powershell_semicolon_chain() {
        let a = run("Write-Host hi; playwright-cli open https://example.com");
        assert_eq!(
            a.command,
            "Write-Host hi; playwright-cli open --headed https://example.com"
        );
    }

    // -- Quoting edge cases --------------------------------------------------

    #[test]
    fn ignores_open_inside_a_quoted_url() {
        let a = run("playwright-cli codegen 'https://example.com/open'");
        assert!(!a.open_detected);
    }

    #[test]
    fn quoted_open_argument_still_counts_as_subcommand() {
        let a = run("playwright-cli 'open' https://example.com");
        assert_eq!(a.command, "playwright-cli 'open' --headed https://example.com");
        assert_eq!(a.rewrites, 1);
    }

    // -- Context message -----------------------------------------------------

    #[test]
    fn context_mentions_resize_tip_when_rewriting() {
        let ctx = build_context(1, false);
        assert!(ctx.contains("--headed"));
        assert!(ctx.contains("playwright-cli resize 1600 900"));
    }

    #[test]
    fn context_mentions_resize_tip_when_only_detected() {
        let ctx = build_context(0, false);
        assert!(!ctx.contains("rewrote"));
        assert!(!ctx.contains("added `--headed`"));
        assert!(ctx.contains("playwright-cli resize 1600 900"));
    }

    #[test]
    fn context_mentions_bypass_state() {
        let ctx = build_context(0, true);
        assert!(ctx.contains("no-rewrite"));
        assert!(ctx.contains("playwright-cli resize 1600 900"));
    }

    #[test]
    fn context_singular_vs_plural() {
        assert!(build_context(1, false).contains("1 `playwright-cli open` invocation "));
        assert!(build_context(2, false).contains("2 `playwright-cli open` invocations"));
    }

    // -- Additional edge cases ------------------------------------------------

    #[test]
    fn no_headed_flag_does_not_count_as_headed() {
        // A hypothetical `--no-headed` flag must not satisfy the rule.
        let a = run("playwright-cli --no-headed open https://example.com");
        assert_eq!(a.rewrites, 1);
        assert_eq!(
            a.command,
            "playwright-cli --no-headed open --headed https://example.com"
        );
    }

    #[test]
    fn longer_flag_starting_with_headed_does_not_count() {
        // `--headedness` is not the same flag as `--headed`.
        let a = run("playwright-cli open --headedness whatever https://example.com");
        assert_eq!(a.rewrites, 1);
        assert!(a.command.contains("open --headed --headedness"));
    }

    #[test]
    fn handles_pipe_separator() {
        // The pipe ends the playwright-cli statement, but `open` was already seen.
        let a = run("playwright-cli open https://example.com | tee log");
        assert_eq!(
            a.command,
            "playwright-cli open --headed https://example.com | tee log"
        );
    }

    #[test]
    fn mixed_invocations_only_rewrite_offenders() {
        let a = run("playwright-cli open --headed a; playwright-cli open b");
        assert!(a.open_detected);
        assert_eq!(a.rewrites, 1);
        assert_eq!(
            a.command,
            "playwright-cli open --headed a; playwright-cli open --headed b"
        );
    }

    #[test]
    fn playwright_cli_with_no_args_is_a_no_op() {
        let a = run("playwright-cli");
        assert!(!a.open_detected);
        assert_eq!(a.rewrites, 0);
    }

    #[test]
    fn handles_newline_separated_commands() {
        let a = run("echo hi\nplaywright-cli open https://example.com");
        assert_eq!(
            a.command,
            "echo hi\nplaywright-cli open --headed https://example.com"
        );
    }

    #[test]
    fn preserves_command_when_no_open_in_any_invocation() {
        let cmd = "playwright-cli codegen url; playwright-cli --help";
        let a = run(cmd);
        assert!(!a.open_detected);
        assert_eq!(a.command, cmd);
    }
}
