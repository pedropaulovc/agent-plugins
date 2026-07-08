//! Integration tests driving the hook binary via stdin/stdout — the actual
//! contract Claude Code uses. Cargo builds the binary before running.

use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

fn run_hook(stdin_json: &str) -> (String, i32) {
    let bin = env!("CARGO_BIN_EXE_command-chain-separator");
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
        "tool_input": {"command": "cmd1 && cmd2"}
    });
    let (stdout, code) = run_hook(&input.to_string());
    assert_eq!(code, 0);
    let h = hook_output(&stdout);
    assert_eq!(h["hookEventName"], "PreToolUse");
    assert!(
        h["updatedInput"]["command"]
            .as_str()
            .unwrap()
            .contains("printf '\\n\\n'")
    );
}

#[test]
fn skips_for_powershell_and_other_tools() {
    for tool in ["PowerShell", "Edit", "Read", "Write", ""] {
        let input = json!({
            "tool_name": tool,
            "tool_input": {"command": "cmd1 && cmd2"}
        });
        let (stdout, code) = run_hook(&input.to_string());
        assert_eq!(code, 0, "tool={tool}");
        assert!(stdout.is_empty(), "tool={tool}: expected silent skip, got {stdout:?}");
    }
}

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

#[test]
fn empty_stdin_noop() {
    let (stdout, code) = run_hook("");
    assert_eq!(code, 0);
    assert!(stdout.is_empty());
}

#[test]
fn invalid_json_noop() {
    let (stdout, code) = run_hook("not json {[");
    assert_eq!(code, 0);
    assert!(stdout.is_empty());
}

#[test]
fn missing_command_noop() {
    let (stdout, code) = run_hook(r#"{"tool_name":"Bash","tool_input":{}}"#);
    assert_eq!(code, 0);
    assert!(stdout.is_empty());
}

#[test]
fn empty_command_noop() {
    let input = json!({"tool_name":"Bash","tool_input":{"command":""}});
    let (stdout, code) = run_hook(&input.to_string());
    assert_eq!(code, 0);
    assert!(stdout.is_empty());
}

#[test]
fn single_command_noop() {
    let input = json!({"tool_name":"Bash","tool_input":{"command":"ls -la"}});
    let (stdout, code) = run_hook(&input.to_string());
    assert_eq!(code, 0);
    assert!(stdout.is_empty());
}

// ---------------------------------------------------------------------------
// Bypass
// ---------------------------------------------------------------------------

#[test]
fn no_rewrite_in_description_bypasses() {
    let input = json!({
        "tool_name":"Bash",
        "tool_input":{
            "command":"cmd1 && cmd2",
            "description":"please don't touch this [no-rewrite]"
        }
    });
    let (stdout, code) = run_hook(&input.to_string());
    assert_eq!(code, 0);
    assert!(stdout.is_empty(), "expected silent skip on [no-rewrite], got {stdout:?}");
}

// ---------------------------------------------------------------------------
// Unsafe constructs → no output
// ---------------------------------------------------------------------------

#[test]
fn heredoc_command_emits_no_output() {
    let input = json!({
        "tool_name":"Bash",
        "tool_input":{"command":"cat <<EOF\nfoo && bar\nEOF\n"}
    });
    let (stdout, code) = run_hook(&input.to_string());
    assert_eq!(code, 0);
    assert!(stdout.is_empty());
}

#[test]
fn for_loop_emits_no_output() {
    let input = json!({
        "tool_name":"Bash",
        "tool_input":{"command":"for x in 1 2 3; do echo $x; done"}
    });
    let (stdout, code) = run_hook(&input.to_string());
    assert_eq!(code, 0);
    assert!(stdout.is_empty());
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

#[test]
fn rewrite_preserves_other_tool_input_fields() {
    let input = json!({
        "tool_name":"Bash",
        "tool_input":{
            "command":"cmd1 && cmd2",
            "description":"chain test",
            "timeout":30000
        }
    });
    let (stdout, _) = run_hook(&input.to_string());
    let h = hook_output(&stdout);
    let updated = &h["updatedInput"];
    assert!(updated["command"].as_str().unwrap().contains("printf '\\n\\n'"));
    assert_eq!(updated["description"], "chain test");
    assert_eq!(updated["timeout"], 30000);
}

#[test]
fn context_mentions_separator_count() {
    let input = json!({
        "tool_name":"Bash",
        "tool_input":{"command":"a && b && c ; d"}
    });
    let (stdout, _) = run_hook(&input.to_string());
    let h = hook_output(&stdout);
    let ctx = h["additionalContext"].as_str().unwrap();
    assert!(ctx.contains("3 output separators"), "ctx={ctx}");
    assert!(ctx.contains("[no-rewrite]"));
}

#[test]
fn rewrite_produces_valid_chain_structure() {
    // The output must be syntactically the same shape: each original separator
    // is preserved and surrounded by an echo.
    let input = json!({
        "tool_name":"Bash",
        "tool_input":{"command":"cmd1 && cmd2"}
    });
    let (stdout, _) = run_hook(&input.to_string());
    let h = hook_output(&stdout);
    let cmd = h["updatedInput"]["command"].as_str().unwrap();
    // && should appear twice (original + injected)
    assert_eq!(cmd.matches("&&").count(), 2, "cmd={cmd}");
    // Exactly one printf separator
    assert_eq!(cmd.matches("printf '\\n\\n'").count(), 1);
}

/// Under Codex (signalled by `PLUGIN_ROOT`), the rewrite must carry
/// `permissionDecision:"allow"`, or Codex rejects the `updatedInput` and runs
/// the original command. The Claude Code path (tested above) must NOT include it.
#[test]
fn codex_emits_permission_decision_allow() {
    let bin = env!("CARGO_BIN_EXE_command-chain-separator");
    let mut child = Command::new(bin)
        .env("PLUGIN_ROOT", "/plugin/root")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hook binary");
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(br#"{"tool_name":"Bash","tool_input":{"command":"echo a && echo b"}}"#)
        .expect("write stdin");
    let out = child.wait_with_output().expect("wait");
    let stdout = String::from_utf8(out.stdout).expect("utf8");
    let h = hook_output(&stdout);
    assert_eq!(h["permissionDecision"], "allow");
    assert!(h["updatedInput"]["command"]
        .as_str()
        .unwrap()
        .contains("printf"));
}
