//! Integration tests that exercise the hook binary via stdin/stdout — the
//! actual contract Claude Code uses. Cargo builds the binary before running.

use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

/// Drive the binary with `stdin_json` on stdin. Returns `(stdout, exit_code)`.
fn run_hook(stdin_json: &str) -> (String, i32) {
    let bin = env!("CARGO_BIN_EXE_playwright-cli-headed");
    let mut child = Command::new(bin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hook binary");

    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(stdin_json.as_bytes())
        .expect("write stdin");

    let out = child.wait_with_output().expect("wait");
    (
        String::from_utf8(out.stdout).expect("utf8 stdout"),
        out.status.code().unwrap_or(-1),
    )
}

/// Parse stdout as JSON and return the `hookSpecificOutput` object.
fn hook_output(stdout: &str) -> Value {
    let v: Value = serde_json::from_str(stdout.trim())
        .unwrap_or_else(|e| panic!("expected JSON on stdout, got {:?}: {}", stdout, e));
    v.get("hookSpecificOutput")
        .cloned()
        .unwrap_or_else(|| panic!("missing hookSpecificOutput in {}", stdout))
}

// ---------------------------------------------------------------------------
// Tool-name filtering
// ---------------------------------------------------------------------------

#[test]
fn passes_for_bash_tool() {
    let input = json!({
        "tool_name": "Bash",
        "tool_input": {"command": "playwright-cli open https://example.com"}
    });
    let (stdout, code) = run_hook(&input.to_string());
    assert_eq!(code, 0);
    let h = hook_output(&stdout);
    assert_eq!(h["hookEventName"], "PreToolUse");
    assert_eq!(
        h["updatedInput"]["command"],
        "playwright-cli open --headed https://example.com"
    );
}

#[test]
fn passes_for_powershell_tool() {
    let input = json!({
        "tool_name": "PowerShell",
        "tool_input": {"command": "playwright-cli open https://example.com"}
    });
    let (stdout, code) = run_hook(&input.to_string());
    assert_eq!(code, 0);
    let h = hook_output(&stdout);
    assert_eq!(
        h["updatedInput"]["command"],
        "playwright-cli open --headed https://example.com"
    );
}

#[test]
fn skips_for_non_shell_tool() {
    for tool in ["Edit", "Read", "Write", "Grep", ""] {
        let input = json!({
            "tool_name": tool,
            "tool_input": {"command": "playwright-cli open https://example.com"}
        });
        let (stdout, code) = run_hook(&input.to_string());
        assert_eq!(code, 0, "tool={tool}");
        assert!(stdout.is_empty(), "tool={tool}: expected silent skip, got {stdout:?}");
    }
}

// ---------------------------------------------------------------------------
// Robustness against bad input
// ---------------------------------------------------------------------------

#[test]
fn empty_stdin_is_a_silent_noop() {
    let (stdout, code) = run_hook("");
    assert_eq!(code, 0);
    assert!(stdout.is_empty());
}

#[test]
fn invalid_json_is_a_silent_noop() {
    let (stdout, code) = run_hook("not json {[");
    assert_eq!(code, 0);
    assert!(stdout.is_empty());
}

#[test]
fn missing_tool_input_is_a_silent_noop() {
    let (stdout, code) = run_hook(r#"{"tool_name":"Bash"}"#);
    assert_eq!(code, 0);
    assert!(stdout.is_empty());
}

#[test]
fn empty_command_is_a_silent_noop() {
    let input = json!({"tool_name": "Bash", "tool_input": {"command": ""}});
    let (stdout, code) = run_hook(&input.to_string());
    assert_eq!(code, 0);
    assert!(stdout.is_empty());
}

#[test]
fn unrelated_command_is_a_silent_noop() {
    let input = json!({
        "tool_name": "Bash",
        "tool_input": {"command": "ls -la /tmp"}
    });
    let (stdout, code) = run_hook(&input.to_string());
    assert_eq!(code, 0);
    assert!(stdout.is_empty());
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

#[test]
fn rewrite_emits_updated_input_and_context_with_tip() {
    let input = json!({
        "tool_name": "Bash",
        "tool_input": {"command": "playwright-cli open https://example.com"}
    });
    let (stdout, _) = run_hook(&input.to_string());
    let h = hook_output(&stdout);
    assert!(h.get("updatedInput").is_some());
    let ctx = h["additionalContext"].as_str().unwrap();
    assert!(ctx.contains("--headed"), "context missing rewrite mention: {ctx}");
    assert!(
        ctx.contains("playwright-cli resize 1600 900"),
        "context missing resize tip: {ctx}"
    );
}

#[test]
fn already_headed_emits_tip_only_no_updated_input() {
    let input = json!({
        "tool_name": "Bash",
        "tool_input": {"command": "playwright-cli open --headed https://example.com"}
    });
    let (stdout, _) = run_hook(&input.to_string());
    let h = hook_output(&stdout);
    assert!(
        h.get("updatedInput").is_none(),
        "updatedInput should be omitted when no rewrite happens: {stdout}"
    );
    let ctx = h["additionalContext"].as_str().unwrap();
    assert!(
        ctx.contains("playwright-cli resize 1600 900"),
        "context missing resize tip: {ctx}"
    );
}

#[test]
fn no_open_subcommand_produces_no_output() {
    let input = json!({
        "tool_name": "Bash",
        "tool_input": {"command": "playwright-cli codegen https://example.com"}
    });
    let (stdout, code) = run_hook(&input.to_string());
    assert_eq!(code, 0);
    assert!(stdout.is_empty(), "expected silent skip, got {stdout:?}");
}

// ---------------------------------------------------------------------------
// [no-rewrite] bypass
// ---------------------------------------------------------------------------

#[test]
fn no_rewrite_suppresses_updated_input_but_keeps_tip() {
    let input = json!({
        "tool_name": "Bash",
        "tool_input": {
            "command": "playwright-cli open https://example.com",
            "description": "explicit test [no-rewrite] keep headless"
        }
    });
    let (stdout, _) = run_hook(&input.to_string());
    let h = hook_output(&stdout);
    assert!(
        h.get("updatedInput").is_none(),
        "[no-rewrite] should suppress updatedInput"
    );
    let ctx = h["additionalContext"].as_str().unwrap();
    assert!(ctx.contains("no-rewrite"));
    assert!(ctx.contains("playwright-cli resize 1600 900"));
}

// ---------------------------------------------------------------------------
// tool_input field preservation
// ---------------------------------------------------------------------------

#[test]
fn updated_input_preserves_other_tool_input_fields() {
    let input = json!({
        "tool_name": "Bash",
        "tool_input": {
            "command": "playwright-cli open https://example.com",
            "description": "drive playwright",
            "timeout": 30000
        }
    });
    let (stdout, _) = run_hook(&input.to_string());
    let h = hook_output(&stdout);
    let updated = &h["updatedInput"];
    assert_eq!(
        updated["command"],
        "playwright-cli open --headed https://example.com"
    );
    assert_eq!(updated["description"], "drive playwright");
    assert_eq!(updated["timeout"], 30000);
}

/// Under Codex (signalled by `PLUGIN_ROOT`), a rewrite must carry
/// `permissionDecision:"allow"` so Codex applies the `--headed` injection
/// instead of rejecting the `updatedInput`.
#[test]
fn codex_rewrite_emits_permission_decision_allow() {
    let bin = env!("CARGO_BIN_EXE_playwright-cli-headed");
    let mut child = Command::new(bin)
        .env("PLUGIN_ROOT", "/plugin/root")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hook binary");
    let needle = format!("playwright{} open https://example.com", "-cli");
    let input = json!({"tool_name": "Bash", "tool_input": {"command": needle}}).to_string();
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(input.as_bytes())
        .expect("write stdin");
    let out = child.wait_with_output().expect("wait");
    let stdout = String::from_utf8(out.stdout).expect("utf8");
    let h = hook_output(&stdout);
    assert_eq!(h["permissionDecision"], "allow");
    assert!(h["updatedInput"]["command"]
        .as_str()
        .unwrap()
        .contains("--headed"));
}
