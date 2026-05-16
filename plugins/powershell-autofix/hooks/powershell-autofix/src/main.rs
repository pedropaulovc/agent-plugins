//! PreToolUse hook that auto-appends `| Out-String` to PowerShell commands
//! whose output would otherwise be silently swallowed by the Claude Code
//! PowerShell tool's capture path. See anthropics/claude-code#59609.
//!
//! Strategy: on PreToolUse for tool `PowerShell`, inspect the command string.
//! If the heuristic `needs_out_string` decides the command's final result is
//! an unrendered object stream, rewrite the command to `<command> | Out-String`
//! and re-submit via `hookSpecificOutput.updatedInput`. Otherwise no-op.
//!
//! Failure mode: misclassifying as needing-a-fix only ever appends an extra
//! `| Out-String` to already-text output, which is harmless and idempotent.

use serde_json::{json, Value};
use std::io::{self, Read};
use std::process;

/// Cmdlets / patterns that already produce final text output (or no output at
/// all). If the rightmost top-level pipeline segment starts with one of these,
/// the command does not need `| Out-String` appended.
const TERMINAL_CMDLETS: &[&str] = &[
    // Formatters
    "Format-Table", "Format-List", "Format-Wide", "Format-Custom",
    "ft", "fl", "fw", "fc",
    // Out-*
    "Out-String", "Out-Host", "Out-File", "Out-Null", "Out-GridView",
    "Out-Printer", "Out-Default",
    // Write-*
    "Write-Host", "Write-Output", "Write-Error", "Write-Warning",
    "Write-Information", "Write-Verbose", "Write-Debug",
    // Converters / serializers (already text)
    "ConvertTo-Json", "ConvertTo-Csv", "ConvertTo-Xml", "ConvertTo-Html",
    // Side-effecting consumers
    "Tee-Object",
];

fn main() {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        process::exit(0);
    }

    let payload: Value = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(_) => process::exit(0),
    };

    if payload["tool_name"].as_str() != Some("PowerShell") {
        process::exit(0);
    }

    let tool_input = match payload["tool_input"].as_object() {
        Some(o) => o,
        None => process::exit(0),
    };

    let command = match tool_input.get("command").and_then(Value::as_str) {
        Some(c) if !c.trim().is_empty() => c,
        _ => process::exit(0),
    };

    if !needs_out_string(command) {
        process::exit(0);
    }

    let fixed = apply_fix(command);

    // Echo back the whole tool_input with the rewritten command.
    let mut updated = tool_input.clone();
    updated.insert("command".to_string(), Value::String(fixed));

    let out = json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "updatedInput": Value::Object(updated),
        }
    });

    println!("{}", out);
    process::exit(0);
}

/// Return the rightmost top-level pipeline segment of `command`, trimmed.
///
/// Naively splits on `|` while ignoring pipes inside single/double quotes.
/// Not a full PowerShell parser — sufficient for the command shapes Claude
/// typically emits in tool calls.
fn last_pipeline_segment(command: &str) -> &str {
    let bytes = command.as_bytes();
    let mut in_single = false;
    let mut in_double = false;
    let mut last_pipe_end = 0usize;

    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'\'' if !in_double => in_single = !in_single,
            b'"' if !in_single => in_double = !in_double,
            b'|' if !in_single && !in_double => last_pipe_end = i + 1,
            _ => {}
        }
    }

    command[last_pipe_end..].trim()
}

/// Control-flow / declaration leading tokens that we conservatively skip
/// rather than try to reason about their output behaviour.
const CONTROL_LEADS: &[&str] = &[
    "if", "foreach", "for", "while", "do", "switch", "try",
    "function", "filter", "workflow", "class", "enum", "return",
];

/// Decide whether `command` would silently swallow object output and therefore
/// needs `| Out-String` appended.
///
/// Strategy: bail conservatively on multi-statement / assignment / control-flow
/// shapes whose output semantics are tricky; otherwise inspect the rightmost
/// top-level pipeline segment and flag it unless it starts with a known
/// terminal cmdlet (case-insensitive).
fn needs_out_string(command: &str) -> bool {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return false;
    }

    if has_top_level_semicolon(trimmed) {
        return false;
    }

    let lead = trimmed
        .split(|c: char| c.is_whitespace() || c == '(' || c == '{')
        .next()
        .unwrap_or("");

    // Assignments: `$x = ...`, `$script:x = ...`, etc. Produce no stdout anyway.
    if lead.starts_with('$') && trimmed.contains('=') {
        return false;
    }

    if CONTROL_LEADS.iter().any(|k| k.eq_ignore_ascii_case(lead)) {
        return false;
    }

    let last = last_pipeline_segment(trimmed);
    let first_token = last
        .split(|c: char| c.is_whitespace() || c == '(' || c == '{' || c == ';')
        .next()
        .unwrap_or("");

    !TERMINAL_CMDLETS
        .iter()
        .any(|c| c.eq_ignore_ascii_case(first_token))
}

/// True iff `s` contains a `;` outside single or double quotes.
fn has_top_level_semicolon(s: &str) -> bool {
    let mut in_single = false;
    let mut in_double = false;
    for &b in s.as_bytes() {
        match b {
            b'\'' if !in_double => in_single = !in_single,
            b'"' if !in_single => in_double = !in_double,
            b';' if !in_single && !in_double => return true,
            _ => {}
        }
    }
    false
}

/// Append `| Out-String` to the command, preserving any trailing whitespace.
fn apply_fix(command: &str) -> String {
    let trimmed = command.trim_end();
    let suffix = &command[trimmed.len()..];
    format!("{} | Out-String{}", trimmed, suffix)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_segment_simple() {
        assert_eq!(last_pipeline_segment("Get-Process"), "Get-Process");
    }

    #[test]
    fn last_segment_pipeline() {
        assert_eq!(
            last_pipeline_segment("Get-Process | Select-Object Id, Name"),
            "Select-Object Id, Name"
        );
    }

    #[test]
    fn last_segment_ignores_quoted_pipe() {
        assert_eq!(
            last_pipeline_segment("Write-Output 'a | b' | Select-Object"),
            "Select-Object"
        );
        assert_eq!(
            last_pipeline_segment("Write-Output 'a | b'"),
            "Write-Output 'a | b'"
        );
    }

    #[test]
    fn apply_fix_appends_out_string() {
        assert_eq!(
            apply_fix("Get-Process | Select-Object Id"),
            "Get-Process | Select-Object Id | Out-String"
        );
    }

    #[test]
    fn apply_fix_preserves_trailing_newline() {
        assert_eq!(
            apply_fix("Get-Process\n"),
            "Get-Process | Out-String\n"
        );
    }

    // -- Heuristic ------------------------------------------------------------

    #[test]
    fn flags_bare_get_process() {
        assert!(needs_out_string("Get-Process"));
    }

    #[test]
    fn flags_get_process_select() {
        assert!(needs_out_string(
            "Get-Process -Name explorer -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, StartTime"
        ));
    }

    #[test]
    fn skips_when_format_table_terminal() {
        assert!(!needs_out_string(
            "Get-Process | Select-Object Id, ProcessName | Format-Table"
        ));
    }

    #[test]
    fn skips_when_out_string_already_present() {
        assert!(!needs_out_string("Get-Process | Out-String"));
    }

    #[test]
    fn case_insensitive_terminal_cmdlet() {
        assert!(!needs_out_string("Get-Process | format-table"));
        assert!(!needs_out_string("Get-Process | FORMAT-TABLE"));
    }

    #[test]
    fn skips_format_table_alias_ft() {
        assert!(!needs_out_string("Get-Process | ft"));
    }

    #[test]
    fn skips_out_null() {
        assert!(!needs_out_string("Get-Process | Out-Null"));
    }

    #[test]
    fn skips_convertto_json() {
        assert!(!needs_out_string("Get-Process | ConvertTo-Json"));
    }

    #[test]
    fn skips_assignment() {
        assert!(!needs_out_string("$procs = Get-Process"));
        assert!(!needs_out_string("$global:x = Get-Process | Select-Object Id"));
    }

    #[test]
    fn skips_control_flow() {
        assert!(!needs_out_string("foreach ($p in Get-Process) { $p.Name }"));
        assert!(!needs_out_string("if ($true) { Get-Process }"));
        assert!(!needs_out_string("while ($x -lt 5) { $x++ }"));
    }

    #[test]
    fn skips_semicolon_separated_statements() {
        assert!(!needs_out_string("Get-Process; Get-Service"));
    }

    #[test]
    fn semicolon_inside_quotes_does_not_bail() {
        assert!(needs_out_string("Write-Output 'a;b' | Select-Object"));
    }

    #[test]
    fn flags_where_object_terminal() {
        assert!(needs_out_string(
            "Get-Process | Where-Object { $_.CPU -gt 10 }"
        ));
    }

    #[test]
    fn flags_get_childitem() {
        assert!(needs_out_string("Get-ChildItem . -Recurse"));
    }

    #[test]
    fn empty_or_whitespace_returns_false() {
        assert!(!needs_out_string(""));
        assert!(!needs_out_string("   "));
        assert!(!needs_out_string("\n\t"));
    }

    #[test]
    fn quoted_pipe_does_not_split_last_segment() {
        // `'a | b'` is one token; the real last segment is `Select-Object`.
        assert!(needs_out_string("Write-Output 'a | b' | Select-Object"));
    }

    #[test]
    fn format_tableish_does_not_match_format_table() {
        // Sanity: `Format-Tableish` (hypothetical) must not be treated as terminal.
        assert!(needs_out_string("Get-Process | Format-Tableish"));
    }
}
