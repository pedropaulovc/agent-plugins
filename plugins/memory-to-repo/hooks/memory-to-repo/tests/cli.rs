use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use tempfile::TempDir;

fn run_hook(
    event: &str,
    input: &Value,
    project_dir: Option<&Path>,
    codex: bool,
) -> (String, String, i32) {
    let binary = env!("CARGO_BIN_EXE_memory-to-repo");
    let mut command = Command::new(binary);
    command
        .arg(event)
        .env_remove("PLUGIN_ROOT")
        .env_remove("CLAUDE_PROJECT_DIR")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = project_dir {
        command.env("CLAUDE_PROJECT_DIR", path);
    }
    if codex {
        command.env("PLUGIN_ROOT", "/plugin/root");
    }

    let mut child = command.spawn().expect("spawn hook binary");
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(input.to_string().as_bytes())
        .expect("write stdin");
    let output = child.wait_with_output().expect("wait for hook");
    (
        String::from_utf8(output.stdout).expect("utf8 stdout"),
        String::from_utf8(output.stderr).expect("utf8 stderr"),
        output.status.code().unwrap_or(-1),
    )
}

fn hook_output(stdout: &str) -> Value {
    let value: Value = serde_json::from_str(stdout.trim())
        .unwrap_or_else(|error| panic!("invalid hook JSON {stdout:?}: {error}"));
    value["hookSpecificOutput"].clone()
}

#[test]
fn windows_hook_commands_use_explicit_powershell_launcher() {
    let hooks_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../hooks.json");
    let hooks: Value =
        serde_json::from_str(&fs::read_to_string(hooks_path).expect("read hooks.json"))
            .expect("parse hooks.json");

    let pre_tool_use = hooks["hooks"]["PreToolUse"][0]["hooks"][0]["commandWindows"]
        .as_str()
        .expect("PreToolUse commandWindows");
    let session_start = hooks["hooks"]["SessionStart"][0]["hooks"][0]["commandWindows"]
        .as_str()
        .expect("SessionStart commandWindows");

    assert_eq!(
        pre_tool_use,
        r#"powershell.exe -NoLogo -NoProfile -NonInteractive -Command "if ([Environment]::GetEnvironmentVariable('PLUGIN_ROOT')) { & (Join-Path ([Environment]::GetEnvironmentVariable('PLUGIN_ROOT')) 'hooks\bin\memory-to-repo.exe') pre-tool-use } else { & (Join-Path ([Environment]::GetEnvironmentVariable('CLAUDE_PLUGIN_ROOT')) 'hooks\bin\memory-to-repo.exe') pre-tool-use }""#
    );
    assert_eq!(
        session_start,
        r#"powershell.exe -NoLogo -NoProfile -NonInteractive -Command "if ([Environment]::GetEnvironmentVariable('PLUGIN_ROOT')) { & (Join-Path ([Environment]::GetEnvironmentVariable('PLUGIN_ROOT')) 'hooks\bin\memory-to-repo.exe') session-start } else { & (Join-Path ([Environment]::GetEnvironmentVariable('CLAUDE_PLUGIN_ROOT')) 'hooks\bin\memory-to-repo.exe') session-start }""#
    );
}

fn session_context(root: &Path) -> String {
    let (stdout, stderr, code) = run_hook("session-start", &json!({}), Some(root), false);
    assert_eq!(code, 0, "stderr={stderr}");
    hook_output(&stdout)["additionalContext"]
        .as_str()
        .expect("context string")
        .to_owned()
}

#[test]
fn blocks_claude_auto_memory_write() {
    let input = json!({
        "tool_name": "Write",
        "tool_input": {
            "file_path": "/home/me/.claude/projects/-home-me-repo/memory/MEMORY.md",
            "content": "x"
        }
    });
    let (stdout, stderr, code) = run_hook("pre-tool-use", &input, None, false);
    assert_eq!(code, 0, "stderr={stderr}");
    assert_eq!(hook_output(&stdout)["permissionDecision"], "deny");
}

#[test]
fn blocks_codex_memory_write_with_windows_path() {
    let input = json!({
        "tool_name": "Write",
        "tool_input": {"file_path": r"C:\Users\me\.codex\memories\MEMORY.md"}
    });
    let (stdout, _, code) = run_hook("pre-tool-use", &input, None, true);
    assert_eq!(code, 0);
    assert_eq!(hook_output(&stdout)["permissionDecision"], "deny");
}

#[test]
fn allows_repository_memory_write() {
    let input = json!({
        "tool_name": "Write",
        "tool_input": {"file_path": "./memory/MEMORY.md", "content": "x"}
    });
    let (stdout, stderr, code) = run_hook("pre-tool-use", &input, None, false);
    assert_eq!(code, 0, "stderr={stderr}");
    assert!(stdout.is_empty());
}

#[test]
fn patch_scans_targets_not_added_content() {
    let input = json!({
        "tool_name": "apply_patch",
        "tool_input": {
            "command": "*** Begin Patch\n*** Update File: docs/memory.md\n@@\n+mention C:\\Users\\me\\.codex\\memories\\MEMORY.md\n*** End Patch"
        }
    });
    let (stdout, _, _) = run_hook("pre-tool-use", &input, None, true);
    assert!(stdout.is_empty());
}

#[test]
fn claude_escape_hatch_rewrites_without_auto_approval() {
    let input = json!({
        "tool_name": "Write",
        "tool_input": {
            "file_path": "[force-memory] /home/me/.claude/projects/x/memory/MEMORY.md",
            "content": "secret"
        }
    });
    let (stdout, _, _) = run_hook("pre-tool-use", &input, None, false);
    let output = hook_output(&stdout);
    assert_eq!(
        output["updatedInput"]["file_path"],
        "/home/me/.claude/projects/x/memory/MEMORY.md"
    );
    assert_eq!(output["updatedInput"]["content"], "secret");
    assert!(output.get("permissionDecision").is_none());
}

#[test]
fn codex_escape_hatch_only_rewrites_when_approval_is_already_skipped() {
    for mode in ["bypassPermissions", "dontAsk"] {
        let input = json!({
            "permission_mode": mode,
            "tool_name": "Bash",
            "tool_input": {"command": "rm x [force-memory]"}
        });
        let (stdout, _, _) = run_hook("pre-tool-use", &input, None, true);
        let output = hook_output(&stdout);
        assert_eq!(output["permissionDecision"], "allow", "mode={mode}");
        assert_eq!(output["updatedInput"]["command"], "rm x", "mode={mode}");
    }

    for mode in ["default", "acceptEdits", "plan"] {
        let input = json!({
            "permission_mode": mode,
            "tool_name": "Bash",
            "tool_input": {"command": "rm x [force-memory]"}
        });
        let (stdout, _, _) = run_hook("pre-tool-use", &input, None, true);
        assert!(stdout.is_empty(), "mode={mode}: {stdout}");
    }
}

#[test]
fn invalid_input_and_unknown_event_are_silent() {
    let binary = env!("CARGO_BIN_EXE_memory-to-repo");
    let output = Command::new(binary)
        .arg("pre-tool-use")
        .stdin(Stdio::null())
        .output()
        .expect("run empty input");
    assert!(output.status.success());
    assert!(output.stdout.is_empty());

    let (stdout, _, code) = run_hook("unknown", &json!({}), None, false);
    assert_eq!(code, 0);
    assert!(stdout.is_empty());
}

#[test]
fn session_start_without_index_emits_redirect_only() {
    let temp = TempDir::new().expect("tempdir");
    let context = session_context(temp.path());
    assert!(context.contains("<system-reminder>"));
    assert!(context.contains("/memory` instead"));
    assert!(!context.contains("Memory titles from"));
}

#[test]
fn session_start_surfaces_titles_without_descriptions() {
    let temp = TempDir::new().expect("tempdir");
    fs::create_dir(temp.path().join("memory")).expect("memory dir");
    fs::write(
        temp.path().join("memory/MEMORY.md"),
        "# Index\n- [foo](foo.md) — bar baz\n",
    )
    .expect("write index");
    let context = session_context(temp.path());
    assert!(context.lines().any(|line| line == "- foo"));
    assert!(!context.contains("bar baz"));
    assert!(!context.contains("foo.md)"));
}

#[test]
fn session_start_ranks_used_memories_stably() {
    let temp = TempDir::new().expect("tempdir");
    let memory = temp.path().join("memory");
    fs::create_dir(&memory).expect("memory dir");
    fs::write(
        memory.join("MEMORY.md"),
        "- [Alpha](alpha.md) — alpha desc\n- [Bravo](bravo.md) — bravo desc\n- [Charlie](charlie.md) — charlie desc\n",
    )
    .expect("write index");
    fs::write(
        memory.join("usage.jsonl"),
        "{\"sessionId\":\"1\",\"memoryFileName\":\"charlie.md\"}\n{\"sessionId\":\"2\",\"memoryFileName\":\"charlie.md\"}\n{\"sessionId\":\"1\",\"memoryFileName\":\"alpha.md\"}\n",
    )
    .expect("write usage");
    let context = session_context(temp.path());
    let charlie = context.find("[Charlie]").expect("Charlie entry");
    let alpha = context.find("[Alpha]").expect("Alpha entry");
    let bravo = context.find("[Bravo]").expect("Bravo entry");
    assert!(charlie < alpha && alpha < bravo, "context={context}");
}

#[test]
fn session_start_output_stays_below_cap_for_many_short_titles() {
    let temp = TempDir::new().expect("tempdir");
    let memory = temp.path().join("memory");
    fs::create_dir(&memory).expect("memory dir");
    let mut index = String::new();
    for i in 0..3_000 {
        index.push_str(&format!("- [A](a{i}.md) — d\n"));
    }
    fs::write(memory.join("MEMORY.md"), index).expect("write index");
    let context = session_context(temp.path());
    assert!(context.len() < 10_000, "length={}", context.len());
    assert!(context.contains("more memories omitted"));
}

#[test]
fn session_start_discovers_git_root_from_nested_directory() {
    let temp = TempDir::new().expect("tempdir");
    fs::create_dir(temp.path().join(".git")).expect("git marker");
    fs::create_dir_all(temp.path().join("nested/deeper")).expect("nested dir");
    fs::create_dir(temp.path().join("memory")).expect("memory dir");
    fs::write(
        temp.path().join("memory/MEMORY.md"),
        "- [Root](root.md) — desc\n",
    )
    .expect("write index");

    let binary = env!("CARGO_BIN_EXE_memory-to-repo");
    let mut child = Command::new(binary)
        .arg("session-start")
        .current_dir(temp.path().join("nested/deeper"))
        .env_remove("CLAUDE_PROJECT_DIR")
        .env_remove("PLUGIN_ROOT")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn hook");
    child.stdin.as_mut().unwrap().write_all(b"{}").unwrap();
    let output = child.wait_with_output().expect("wait");
    let context = hook_output(std::str::from_utf8(&output.stdout).unwrap())["additionalContext"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        context.lines().any(|line| line == "- Root"),
        "context={context}"
    );
}
