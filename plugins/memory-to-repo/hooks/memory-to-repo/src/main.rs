//! Native hook runner for the memory-to-repo plugin.
//!
//! One binary handles both lifecycle events selected by argv:
//!
//! - `pre-tool-use` blocks operations aimed at machine-local memory stores and
//!   implements the explicitly requested `[force-memory]` escape hatch.
//! - `session-start` injects the repository memory reminder and a bounded index.
//!
//! Shipping native Linux and Windows binaries keeps the behavior identical in
//! Claude Code and Codex without depending on `sh`, `jq`, PowerShell, Python,
//! or Node being installed or discoverable on the hook process `PATH`.

use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process;
use std::time::SystemTime;

const HARD_CAP: usize = 10_000;
const SAFETY_MARGIN: usize = 1_500;
const MIN_DESCRIBED: usize = 3;
const DESCRIPTION_SHARE_PERCENT: usize = 30;
const USAGE_STALE_SECS: u64 = 24 * 60 * 60;

const STALE_USAGE_NOTE: &str = "\n\nThe usage ranking (memory/usage.jsonl) is missing or over a day old — run the /record-memory-usage command to refresh it so this index is ordered by which memories are actually being consulted.";

const FORCE_CONTEXT: &str = "memory-to-repo: [force-memory] escape hatch honored; the marker was stripped from the request before the operation runs.";

const DENY_REASON: &str = "Blocked: this targets a machine-local auto-memory directory (~/.claude/projects/<slug>/memory/ or the Codex store ~/.codex/memories/). It is NOT tracked in git and NOT shared across users, machines, or cloud sessions, so anything stored there is invisible to teammates and lost on a fresh checkout.\n\nMake the EXACT same change in the repository ./memory/ folder instead (relative to the repo root), then commit it so the knowledge is version-controlled and shared with everyone:\n- Create / Update: write the same file under ./memory/ with identical content (e.g. ./memory/MEMORY.md, ./memory/debugging.md).\n- Read: read the corresponding file under ./memory/ instead.\n- Delete / Rename: do it under ./memory/.\nCreate ./memory/ if it does not exist, and keep ./memory/MEMORY.md as the index, mirroring the auto-memory layout.\n\nEscape hatch: if a note is genuinely machine-specific, secret, or otherwise must NOT be shared, add [force-memory] to the call's main string field (the Bash command, or the file_path for a file tool) to bypass this block — the marker is stripped before the operation runs. Do not use it to avoid the redirect above.";

fn main() {
    let event = env::args().nth(1).unwrap_or_default();
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        process::exit(0);
    }

    let output = match event.as_str() {
        "pre-tool-use" => pre_tool_use(&input),
        "session-start" => Some(session_start()),
        _ => None,
    };

    if let Some(value) = output {
        println!("{}", value);
    }
}

fn pre_tool_use(input: &str) -> Option<Value> {
    let data: Value = serde_json::from_str(input).ok()?;
    let tool_input = data.get("tool_input")?.as_object()?;

    if input.contains("[force-memory]") {
        let codex = under_codex();
        if codex && !codex_approval_already_skipped(&data) {
            return None;
        }

        let mut updated = Value::Object(tool_input.clone());
        strip_force_marker(&mut updated);

        let mut hook_output = Map::new();
        hook_output.insert("hookEventName".into(), Value::String("PreToolUse".into()));
        if codex {
            hook_output.insert("permissionDecision".into(), Value::String("allow".into()));
        }
        hook_output.insert("updatedInput".into(), updated);
        hook_output.insert(
            "additionalContext".into(),
            Value::String(FORCE_CONTEXT.into()),
        );
        return Some(json!({ "hookSpecificOutput": hook_output }));
    }

    let file_path = string_field(tool_input, "file_path");
    let path = string_field(tool_input, "path");
    let command = string_field(tool_input, "command");
    let command_targets = patch_target_headers(command);
    let candidates = format!("{file_path}\n{path}\n{command_targets}");

    if !targets_machine_local_memory(&candidates) {
        return None;
    }

    Some(json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": DENY_REASON
        }
    }))
}

fn string_field<'a>(object: &'a Map<String, Value>, name: &str) -> &'a str {
    object.get(name).and_then(Value::as_str).unwrap_or("")
}

fn strip_force_marker(value: &mut Value) {
    let marker = Regex::new(r" ?\[force-memory\] ?").expect("constant regex");
    strip_force_marker_with(value, &marker);
}

fn strip_force_marker_with(value: &mut Value, marker: &Regex) {
    match value {
        Value::String(text) => {
            *text = marker.replace_all(text, "").into_owned();
        }
        Value::Array(values) => {
            for value in values {
                strip_force_marker_with(value, marker);
            }
        }
        Value::Object(object) => {
            for value in object.values_mut() {
                strip_force_marker_with(value, marker);
            }
        }
        _ => {}
    }
}

fn patch_target_headers(command: &str) -> String {
    if !command.contains("*** Begin Patch")
        && !command.contains("*** Add File:")
        && !command.contains("*** Update File:")
        && !command.contains("*** Delete File:")
        && !command.contains("*** Move to:")
    {
        return command.to_owned();
    }

    command
        .lines()
        .filter_map(|line| {
            [
                "*** Add File: ",
                "*** Update File: ",
                "*** Delete File: ",
                "*** Move to: ",
            ]
            .iter()
            .find_map(|prefix| line.strip_prefix(prefix))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn targets_machine_local_memory(text: &str) -> bool {
    let pattern = Regex::new(
        r#"(?i)\.claude[\\/]+projects[\\/]+[^\\/]+[\\/]+memory(?:[\\/"\s]|$)|\.codex[\\/]+memories(?:[\\/"\s]|$)"#,
    )
    .expect("constant regex");
    pattern.is_match(text)
}

/// Codex sets `PLUGIN_ROOT`; Claude Code sets `CLAUDE_PLUGIN_ROOT` only.
fn under_codex() -> bool {
    env::var_os("PLUGIN_ROOT").is_some()
}

/// A Codex `updatedInput` requires `permissionDecision:"allow"`, which also
/// skips approval. Emit it only when approval was already disabled.
fn codex_approval_already_skipped(data: &Value) -> bool {
    matches!(
        data.get("permission_mode").and_then(Value::as_str),
        Some("bypassPermissions") | Some("dontAsk")
    )
}

fn session_start() -> Value {
    let root = project_root();
    let root_display = display_path(&root);
    let memory_dir = root.join("memory");
    let memory_index = memory_dir.join("MEMORY.md");
    let usage_path = memory_dir.join("usage.jsonl");
    let memory_display = display_path(&memory_index);

    let mut reminder = format!(
        "Ignore the default auto-memory destination and use `{root_display}/memory` instead. Memories must be kept under version control."
    );

    if let Ok(contents) = fs::read_to_string(&memory_index) {
        let mut entries = parse_memory_entries(&contents);
        let usage = fs::read_to_string(&usage_path).unwrap_or_default();
        let header = if usage.is_empty() {
            format!("\n\nMemory index from {memory_display} (read MEMORY.md for the full contents of each):\n\n")
        } else {
            sort_by_usage(&mut entries, &usage);
            format!("\n\nMemory index from {memory_display}, sorted by usage — most-consulted-first:\n\n")
        };
        reminder.push_str(&memory_context(&reminder, &memory_display, entries, &header));
        if usage_is_stale(&usage_path) {
            reminder.push_str(STALE_USAGE_NOTE);
        }
    }

    let context = format!("<system-reminder>\n{reminder}\n</system-reminder>");
    json!({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": context
        }
    })
}

fn project_root() -> PathBuf {
    if let Some(value) = env::var_os("CLAUDE_PROJECT_DIR") {
        if !value.is_empty() {
            return PathBuf::from(value);
        }
    }

    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for ancestor in cwd.ancestors() {
        if ancestor.join(".git").exists() {
            return ancestor.to_path_buf();
        }
    }
    cwd
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[derive(Clone, Debug)]
struct MemoryEntry {
    title: String,
    file: String,
    full_line: String,
    original_index: usize,
}

fn parse_memory_entries(contents: &str) -> Vec<MemoryEntry> {
    let pattern = Regex::new(r"^- \[([^]]+)\]\(([^)]+)\)").expect("constant regex");
    contents
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let captures = pattern.captures(line)?;
            Some(MemoryEntry {
                title: captures.get(1)?.as_str().to_owned(),
                file: captures.get(2)?.as_str().to_owned(),
                full_line: line.to_owned(),
                original_index: index,
            })
        })
        .collect()
}

fn usage_counts(contents: &str) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for line in contents.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(file) = value.get("memoryFileName").and_then(Value::as_str) else {
            continue;
        };
        *counts.entry(file.to_owned()).or_insert(0) += 1;
    }
    counts
}

/// True when the usage log is missing or its last update was over a day ago —
/// a cue for the agent to re-run `/record-memory-usage` so the ranking reflects
/// recent sessions. A missing file counts as stale (usage was never recorded).
fn usage_is_stale(path: &Path) -> bool {
    let Ok(modified) = fs::metadata(path).and_then(|meta| meta.modified()) else {
        return true;
    };
    match SystemTime::now().duration_since(modified) {
        Ok(age) => age.as_secs() >= USAGE_STALE_SECS,
        Err(_) => false,
    }
}

fn sort_by_usage(entries: &mut [MemoryEntry], usage: &str) {
    let counts = usage_counts(usage);
    entries.sort_by(|a, b| {
        counts
            .get(&b.file)
            .copied()
            .unwrap_or(0)
            .cmp(&counts.get(&a.file).copied().unwrap_or(0))
            .then_with(|| a.original_index.cmp(&b.original_index))
    });
}

/// Render the index: the leading entries get their full `- [Title](file) — description`
/// line, then remaining entries fall back to bare titles so the whole index still fits
/// under the hook's character cap. Callers pass entries already in display order.
fn memory_context(
    reminder: &str,
    memory_display: &str,
    entries: Vec<MemoryEntry>,
    header: &str,
) -> String {
    let total_budget = context_budget(reminder, header);
    let description_budget = total_budget * DESCRIPTION_SHARE_PERCENT / 100;
    let mut description_used = 0usize;
    let mut title_used = 0usize;
    let mut title_budget = total_budget;
    let mut described = 0usize;
    let mut title_phase = false;
    let mut lines = Vec::new();
    let mut omitted = 0usize;

    for entry in entries {
        if !title_phase {
            let mut line = entry.full_line.clone();
            let mut line_len = line.len() + 1;
            if described < MIN_DESCRIBED
                || description_used.saturating_add(line_len) <= description_budget
            {
                if description_used.saturating_add(line_len) > description_budget {
                    let remaining = description_budget.saturating_sub(description_used).max(20);
                    line = truncate_utf8_bytes(&line, remaining);
                    line.push('…');
                    line_len = line.len() + 1;
                }
                lines.push(line);
                description_used = description_used.saturating_add(line_len);
                described += 1;
                continue;
            }
            title_phase = true;
            title_budget = total_budget.saturating_sub(description_used);
        }

        let title = format!("- {}", entry.title);
        let title_len = title.len() + 1;
        if omitted == 0 && title_used.saturating_add(title_len) <= title_budget {
            lines.push(title);
            title_used += title_len;
        } else {
            omitted += 1;
        }
    }

    append_omitted(&mut lines, omitted, memory_display);
    format!("{header}{}", lines.join("\n"))
}

fn context_budget(reminder: &str, header: &str) -> usize {
    HARD_CAP
        .saturating_sub(SAFETY_MARGIN)
        .saturating_sub(reminder.len() + header.len())
        .max(200)
}

fn append_omitted(lines: &mut Vec<String>, omitted: usize, memory_display: &str) {
    if omitted > 0 {
        lines.push(format!(
            "\n…and {omitted} more memories omitted (see {memory_display} for the full index)"
        ));
    }
}

fn truncate_utf8_bytes(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_owned();
    }
    let mut end = max_bytes.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_claude_and_codex_default_memory_paths() {
        for path in [
            "/home/me/.claude/projects/-home-me-repo/memory/MEMORY.md",
            r"C:\Users\me\.claude\projects\C--repo\memory\notes.md",
            "/home/me/.codex/memories/MEMORY.md",
            r"C:\Users\me\.codex\memories\notes.md",
        ] {
            assert!(targets_machine_local_memory(path), "path={path}");
        }
    }

    #[test]
    fn permits_repository_memory_paths_and_documentation_mentions() {
        assert!(!targets_machine_local_memory("./memory/MEMORY.md"));
        let patch = "*** Begin Patch\n*** Update File: docs/memory.md\n+mention ~/.codex/memories/foo.md\n*** End Patch";
        assert_eq!(patch_target_headers(patch), "docs/memory.md");
        assert!(!targets_machine_local_memory(&patch_target_headers(patch)));
    }

    #[test]
    fn marker_stripping_preserves_non_string_values() {
        let mut value = json!({
            "command": "rm x [force-memory]",
            "nested": ["[force-memory] y", 3, true]
        });
        strip_force_marker(&mut value);
        assert_eq!(value["command"], "rm x");
        assert_eq!(value["nested"][0], "y");
        assert_eq!(value["nested"][1], 3);
    }

    #[test]
    fn truncation_never_splits_utf8() {
        assert_eq!(truncate_utf8_bytes("abcéxyz", 4), "abc");
        assert_eq!(truncate_utf8_bytes("abcéxyz", 5), "abcé");
    }
}
