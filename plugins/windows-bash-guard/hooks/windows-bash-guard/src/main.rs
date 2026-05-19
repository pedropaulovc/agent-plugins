//! PreToolUse hook that auto-fixes common Windows+bash path pitfalls in Bash
//! commands before execution, avoiding a wasted round-trip.
//!
//! Fixes:
//! 1. `/dev/stdin` → fd `0` in node commands (doesn't exist on Windows)
//! 2. Backslash drive paths → forward slashes everywhere (fixes unquoted paths,
//!    node -e escape bugs, and trailing `\"` in one pass)
//!
//! Returns JSON with `updatedInput` so Claude Code executes the corrected
//! command transparently.

use serde_json::{json, Value};
use std::io::{self, Read};
use std::process;

fn main() {
    if std::env::consts::OS != "windows" {
        process::exit(0);
    }

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

    if let Some(fixed) = fix_command(command) {
        let mut updated = tool_input.as_object().cloned().unwrap_or_default();
        updated.insert("command".into(), Value::String(fixed.command));

        let output = json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "updatedInput": updated,
                "additionalContext": fixed.context
            }
        });
        println!("{}", output);
    }

    process::exit(0);
}

// ---------------------------------------------------------------------------
// Top-level fix orchestrator
// ---------------------------------------------------------------------------

struct FixResult {
    command: String,
    context: String,
}

impl PartialEq<&str> for FixResult {
    fn eq(&self, other: &&str) -> bool {
        self.command == *other
    }
}

impl std::fmt::Debug for FixResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FixResult")
            .field("command", &self.command)
            .field("context", &self.context)
            .finish()
    }
}

/// Apply all fixes to the command. Returns `Some(FixResult)` if anything changed.
fn fix_command(command: &str) -> Option<FixResult> {
    let mut result = command.to_string();
    let mut fixes: Vec<&str> = Vec::new();

    // Fix 1: /dev/stdin → fd number in node commands
    if fix_dev_stdin(&mut result) {
        fixes.push("/dev/stdin replaced with fd number (doesn't exist on Windows)");
    }

    // Fix 2: backslash drive paths → forward slashes
    let (fixed, path_changed) = fix_drive_paths(&result);
    if path_changed {
        result = fixed;
        fixes.push("backslash paths converted to forward slashes (avoids bash escape issues)");
    }

    if fixes.is_empty() {
        return None;
    }

    let context = format!(
        "windows-bash-guard hook rewrote this command: {}. Use forward-slash paths on Windows to avoid this. To bypass rewriting, add [no-rewrite] to the Bash tool description.",
        fixes.join("; ")
    );

    Some(FixResult { command: result, context })
}

// ---------------------------------------------------------------------------
// Fix 1: /dev/stdin → file descriptor
// ---------------------------------------------------------------------------

/// Replace `'/dev/stdin'` → `0`, `'/dev/stdout'` → `1`, `'/dev/stderr'` → `2`
/// in commands that involve node. These paths don't exist on Windows;
/// `readFileSync(0)` reads from fd 0 (stdin) and works cross-platform.
fn fix_dev_stdin(command: &mut String) -> bool {
    if !command.contains("node") {
        return false;
    }

    let mut changed = false;
    for (quoted, fd) in [
        ("'/dev/stdin'", "0"),
        ("\"/dev/stdin\"", "0"),
        ("'/dev/stdout'", "1"),
        ("\"/dev/stdout\"", "1"),
        ("'/dev/stderr'", "2"),
        ("\"/dev/stderr\"", "2"),
    ] {
        if command.contains(quoted) {
            *command = command.replace(quoted, fd);
            changed = true;
        }
    }

    changed
}

// ---------------------------------------------------------------------------
// Fix 2: Backslash drive paths → forward slashes
// ---------------------------------------------------------------------------

/// Find all Windows drive paths (`X:\...`) and convert backslashes to forward
/// slashes. This fixes multiple failure modes in one pass:
///
/// - Unquoted `C:\src` → bash eats `\s` → `C:src` (fix: `C:/src`)
/// - `"C:\path\"` → `\"` eats closing quote → EOF (fix: `"C:/path/"`)
/// - `node -e "..C:\\src.."` → JS interprets `\s` as escape (fix: `C:/src`)
/// - `node -e "..C:\\\\tmp.."` → multi-layer escaping hell (fix: `C:/tmp`)
///
/// Forward slashes work everywhere: bash, Node.js, and Windows APIs.
fn fix_drive_paths(command: &str) -> (String, bool) {
    let bytes = command.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let mut changed = false;

    while i < bytes.len() {
        // Match drive letter path: [A-Za-z]:\ at a word boundary
        if i + 2 < bytes.len()
            && bytes[i].is_ascii_alphabetic()
            && bytes[i + 1] == b':'
            && bytes[i + 2] == b'\\'
            && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric())
        {
            // Emit drive letter and colon
            out.push(bytes[i]);
            out.push(b':');
            i += 2;

            // Walk the path, converting backslash runs to single /
            loop {
                if i >= bytes.len() {
                    break;
                }

                if bytes[i] == b'\\' {
                    // Consume all consecutive backslashes (1, 2, or 4)
                    while i < bytes.len() && bytes[i] == b'\\' {
                        i += 1;
                    }
                    // Emit a single forward slash
                    out.push(b'/');
                    changed = true;

                    // If next char isn't a path char, path ended
                    // (the / is a trailing separator, which is fine)
                    if i >= bytes.len() || !is_path_char(bytes[i]) {
                        break;
                    }
                } else if is_path_char(bytes[i]) {
                    out.push(bytes[i]);
                    i += 1;
                } else {
                    break;
                }
            }
            continue;
        }

        out.push(bytes[i]);
        i += 1;
    }

    (
        String::from_utf8(out).unwrap_or_else(|_| command.to_string()),
        changed,
    )
}

/// Characters that can appear within a path component (between separators).
fn is_path_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'+' | b'@' | b'#')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- Fix 1: /dev/stdin ---------------------------------------------------

    #[test]
    fn fixes_dev_stdin_single_quotes() {
        let cmd =
            r#"cat data.json | node -e "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))""#;
        let fixed = fix_command(cmd).unwrap();
        assert!(fixed.command.contains("readFileSync(0,"));
        assert!(!fixed.command.contains("/dev/stdin"));
    }

    #[test]
    fn fixes_dev_stdin_double_quotes() {
        let cmd =
            r#"curl -s url | node -e 'JSON.parse(require("fs").readFileSync("/dev/stdin","utf8"))'"#;
        let fixed = fix_command(cmd).unwrap();
        assert!(fixed.command.contains("readFileSync(0,"));
    }

    #[test]
    fn ignores_dev_stdin_without_node() {
        // curl -D /dev/stderr works in MSYS2, don't touch it
        let cmd = "curl -s -D /dev/stderr http://localhost:3000/api";
        assert!(fix_command(cmd).is_none());
    }

    // -- Fix 2: Drive paths --------------------------------------------------

    #[test]
    fn fixes_unquoted_path() {
        let cmd = r"ls -la C:\src\codeflow";
        assert_eq!(fix_command(cmd).unwrap(), "ls -la C:/src/codeflow");
    }

    #[test]
    fn fixes_unquoted_rm_multiple_paths() {
        let cmd = r"rm C:\src\a\file.json C:\src\b\file.json";
        assert_eq!(
            fix_command(cmd).unwrap(),
            "rm C:/src/a/file.json C:/src/b/file.json"
        );
    }

    #[test]
    fn fixes_double_quoted_path() {
        let cmd = r#"ls -la "C:\src\project""#;
        assert_eq!(fix_command(cmd).unwrap(), r#"ls -la "C:/src/project""#);
    }

    #[test]
    fn fixes_trailing_backslash_quote() {
        // "C:\path\" is broken in bash (\" eats quote).
        // After fix: "C:/path/" — properly closed string.
        let cmd = r#"ls -la "C:\src\el400\main\.github\workflows\""#;
        assert_eq!(
            fix_command(cmd).unwrap(),
            r#"ls -la "C:/src/el400/main/.github/workflows/""#
        );
    }

    #[test]
    fn fixes_trailing_backslash_quote_in_grep() {
        let cmd = r#"grep -r "pattern" "C:\src\codjiflo\C\src\styles\" --include="*.css""#;
        assert_eq!(
            fix_command(cmd).unwrap(),
            r#"grep -r "pattern" "C:/src/codjiflo/C/src/styles/" --include="*.css""#
        );
    }

    #[test]
    fn fixes_double_backslash_path() {
        // C:\\ in raw command → C:\ in bash (correct but fragile).
        // Converting to C:/ is equally correct and more portable.
        let cmd = r"grep pattern C:\\src\\codjiflo\\AGENTS.md";
        assert_eq!(
            fix_command(cmd).unwrap(),
            "grep pattern C:/src/codjiflo/AGENTS.md"
        );
    }

    #[test]
    fn fixes_quad_backslash_in_node_e() {
        // C:\\\\ in raw command → after bash: C:\\ → after JS: C:\ (correct
        // but fragile). Forward slashes avoid the entire escaping chain.
        let cmd = r#"node -e "require('fs').readFileSync('C:\\\\src\\\\file.json','utf8')""#;
        assert_eq!(
            fix_command(cmd).unwrap(),
            r#"node -e "require('fs').readFileSync('C:/src/file.json','utf8')""#
        );
    }

    #[test]
    fn fixes_double_backslash_in_node_e() {
        let cmd = r#"node -e "require('fs').readFileSync('C:\\tmp\\kv-ns.json','utf8')""#;
        assert_eq!(
            fix_command(cmd).unwrap(),
            r#"node -e "require('fs').readFileSync('C:/tmp/kv-ns.json','utf8')""#
        );
    }

    #[test]
    fn fixes_combined_dev_stdin_and_path() {
        let cmd = r#"cat C:\\tmp\\data.json | node -e "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))""#;
        let fixed = fix_command(cmd).unwrap();
        assert!(fixed.command.contains("C:/tmp/data.json"));
        assert!(fixed.command.contains("readFileSync(0,"));
    }

    // -- No-op cases ---------------------------------------------------------

    #[test]
    fn ignores_forward_slash_path() {
        let cmd = "ls -la C:/src/project";
        assert!(fix_command(cmd).is_none());
    }

    #[test]
    fn ignores_unix_path() {
        let cmd = "cd /c/src/project && ls";
        assert!(fix_command(cmd).is_none());
    }

    #[test]
    fn ignores_clean_node_e() {
        let cmd = r#"node -e "console.log('hello')""#;
        assert!(fix_command(cmd).is_none());
    }

    #[test]
    fn ignores_url_with_colon() {
        let cmd = "curl https://example.com:8080/api";
        assert!(fix_command(cmd).is_none());
    }

    #[test]
    fn does_not_match_mid_word_colon() {
        // "Error:" has 'r' before ':' which is alphanumeric → no match
        let cmd = r#"echo "Error: something failed""#;
        assert!(fix_command(cmd).is_none());
    }

    // -- Edge cases ----------------------------------------------------------

    #[test]
    fn fixes_path_with_dots() {
        let cmd = r"ls C:\src\el400\main\.github";
        assert_eq!(fix_command(cmd).unwrap(), "ls C:/src/el400/main/.github");
    }

    #[test]
    fn preserves_non_path_backslashes() {
        // \n in echo is NOT a drive path — should not be touched
        let cmd = r#"echo "line1\nline2""#;
        assert!(fix_command(cmd).is_none());
    }

    #[test]
    fn fixes_path_after_equals() {
        let cmd = r"VAR=C:\src\project echo test";
        assert_eq!(
            fix_command(cmd).unwrap(),
            "VAR=C:/src/project echo test"
        );
    }

    // -- Context messages -----------------------------------------------------

    #[test]
    fn context_mentions_backslash() {
        let cmd = r"ls C:\src\project";
        let fixed = fix_command(cmd).unwrap();
        assert!(fixed.context.contains("backslash"));
        assert!(fixed.context.contains("forward slash"));
    }

    #[test]
    fn context_mentions_dev_stdin() {
        let cmd = r#"node -e "require('fs').readFileSync('/dev/stdin','utf8')""#;
        let fixed = fix_command(cmd).unwrap();
        assert!(fixed.context.contains("/dev/stdin"));
    }

    #[test]
    fn context_mentions_both_fixes() {
        let cmd = r#"cat C:\\tmp\\data.json | node -e "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))""#;
        let fixed = fix_command(cmd).unwrap();
        assert!(fixed.context.contains("/dev/stdin"));
        assert!(fixed.context.contains("backslash"));
    }
}
