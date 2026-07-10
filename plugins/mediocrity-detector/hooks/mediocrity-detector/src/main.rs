//! Stop hook that detects hedging language suggesting shortcuts or deferred work.
//!
//! Strategy: trust but verify. Scans the current turn's assistant messages for
//! patterns indicating corners were cut, then blocks the stop and asks Claude to
//! explicitly report each assumption so the user can make a judgement call.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{self, Read};
use std::process;

/// Hedging phrases matched case-insensitively.
const PATTERNS: &[&str] = &[
    // Deferred work
    "for now",
    "revisit later",
    "revisit this",
    "come back to this",
    "should be replaced",
    "should be updated",
    "should be revisited",
    "will need to be",
    // Quality shortcuts
    "good enough",
    "acceptable solution",
    "simple enough",
    "simple approach",
    "basic implementation",
    "simplified version",
    "quick and dirty",
    "not ideal",
    // Version hedging
    "first version",
    "initial version",
    // Placeholder/mock
    "placeholder",
    "hardcoded",
    "hard-coded",
    "workaround",
    "temporary fix",
    "temporary solution",
    "temporary",
];

/// Code markers matched case-sensitively.
const CODE_MARKERS: &[&str] = &["TODO", "FIXME", "HACK", "XXX"];

/// Substrings that legitimately contain a pattern and must not trigger a
/// finding — e.g. `TemporaryDirectory` (an RAII temp-dir handle) contains
/// "temporary". Matched case-insensitively.
const EXCEPTIONS: &[&str] = &["TemporaryDirectory"];

fn main() {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        process::exit(0);
    }

    let data: Value = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(_) => process::exit(0),
    };

    // Prevent infinite loops — if we already continued from a Stop hook, let it stop.
    if data["stop_hook_active"].as_bool() == Some(true) {
        process::exit(0);
    }

    let transcript_path = match data["transcript_path"].as_str() {
        Some(p) => p,
        None => process::exit(0),
    };

    let transcript = match std::fs::read_to_string(transcript_path) {
        Ok(t) => t,
        Err(_) => process::exit(0),
    };

    let lines: Vec<&str> = transcript.lines().collect();
    let turn_start = find_turn_start(&lines);

    let mut findings: Vec<String> = Vec::new();
    let mut seen = HashSet::new();

    for line in &lines[turn_start..] {
        let entry: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        scan_entry(&entry, &mut findings, &mut seen);
    }

    if findings.is_empty() {
        process::exit(0);
    }

    let list = findings
        .iter()
        .map(|f| format!("  - {}", f))
        .collect::<Vec<_>>()
        .join("\n");
    let reason = format!(
        "Shortcut/assumption language detected in this turn:\n{}\n\n\
         Before stopping, explicitly report to the user each shortcut or assumption. \
         For each: (1) what exactly you did and where, (2) why you chose this approach, \
         (3) what a complete solution looks like. Be specific — the user needs to make \
         an informed judgement call.\n\n\
         No explanation is needed if the flagged expression is itself a preventative \
         measure against the thing it names (e.g. code that detects a placeholder and \
         throws, a test asserting no TODO remains, a guard rejecting hardcoded values). \
         In that case, briefly note it and stop.",
        list
    );

    println!("{}", json!({"decision": "block", "reason": reason}));
    process::exit(0);
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

/// Walk backwards to find the last real user message (string content, not
/// tool_result array). Everything after it belongs to the current turn.
fn find_turn_start(lines: &[&str]) -> usize {
    for i in (0..lines.len()).rev() {
        // Quick pre-filter before JSON parsing. Covers the Claude Code user turn
        // marker and the Codex rollout turn boundary (an event_msg/task_started
        // line, or a user response_item).
        if !lines[i].contains("\"user\"") && !lines[i].contains("task_started") {
            continue;
        }

        let entry: Value = match serde_json::from_str(lines[i]) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Claude Code: {"type":"user","message":{"content":"<string>"}}
        if entry["type"].as_str() == Some("user") && entry["message"]["content"].is_string() {
            return i;
        }

        // Codex rollout: the turn opens with an event_msg/task_started line, or
        // (fallback) a user-authored response_item message.
        let payload = &entry["payload"];
        if entry["type"].as_str() == Some("event_msg")
            && payload["type"].as_str() == Some("task_started")
        {
            return i;
        }
        if entry["type"].as_str() == Some("response_item")
            && payload["type"].as_str() == Some("message")
            && payload["role"].as_str() == Some("user")
        {
            return i;
        }
    }

    0
}

/// Scan one transcript line's assistant-authored text for hedging, supporting
/// both the Claude Code transcript schema and the Codex rollout schema.
///
/// Claude Code: `{"type":"assistant","message":{"content":[ {type:text,text}
/// | {type:tool_use,input:{content,new_string}} ]}}`.
///
/// Codex rollout: `{"type":"response_item","payload": {type:message,
/// role:assistant, content:[{type:output_text,text}]} | {type:function_call,
/// name, arguments:"<json string>"}}`.
fn scan_entry(entry: &Value, findings: &mut Vec<String>, seen: &mut HashSet<String>) {
    // ---- Claude Code ----
    if entry["type"].as_str() == Some("assistant") {
        let Some(content) = entry["message"]["content"].as_array() else {
            return;
        };
        for block in content {
            match block["type"].as_str().unwrap_or("") {
                "text" => {
                    if let Some(t) = block["text"].as_str() {
                        scan_text(t, findings, seen);
                    }
                }
                "tool_use" => {
                    let input = &block["input"];
                    if let Some(t) = input["content"].as_str() {
                        scan_text(t, findings, seen);
                    }
                    if let Some(t) = input["new_string"].as_str() {
                        scan_text(t, findings, seen);
                    }
                }
                _ => {}
            }
        }
        return;
    }

    // ---- Codex rollout ----
    if entry["type"].as_str() != Some("response_item") {
        return;
    }
    let payload = &entry["payload"];
    match payload["type"].as_str().unwrap_or("") {
        "message" if payload["role"].as_str() == Some("assistant") => {
            if let Some(content) = payload["content"].as_array() {
                for block in content {
                    if matches!(block["type"].as_str(), Some("output_text") | Some("text")) {
                        if let Some(t) = block["text"].as_str() {
                            scan_text(t, findings, seen);
                        }
                    }
                }
            }
        }
        "function_call" => {
            // Mirror Claude, which scanned only file-content fields (Write.content,
            // Edit.new_string), not arbitrary shell commands. In Codex, file edits
            // go through apply_patch; scan only the ADDED lines of the patch. Skip
            // shell/exec calls, and never scan deleted/context lines — a cleanup
            // that removes `// TODO`/`placeholder` must not trip the hook.
            let name = payload["name"].as_str().unwrap_or("");
            if !matches!(name, "apply_patch" | "Edit" | "Write" | "MultiEdit") {
                return;
            }
            let Some(args) = payload["arguments"].as_str() else {
                return;
            };
            // `arguments` is a JSON-encoded string. Prefer structured edit fields
            // (content / new_string); for apply_patch scan the added lines of the
            // patch it carries under `input`/`patch`. Fall back to treating the raw
            // arguments as a patch when no known field is present.
            match serde_json::from_str::<Value>(args) {
                Ok(av) => {
                    let mut matched = false;
                    if let Some(t) = av["content"].as_str() {
                        scan_text(t, findings, seen);
                        matched = true;
                    }
                    if let Some(t) = av["new_string"].as_str() {
                        scan_text(t, findings, seen);
                        matched = true;
                    }
                    if let Some(p) = av["input"].as_str().or_else(|| av["patch"].as_str()) {
                        scan_added_lines(p, findings, seen);
                        matched = true;
                    }
                    if !matched {
                        scan_added_lines(args, findings, seen);
                    }
                }
                Err(_) => scan_added_lines(args, findings, seen),
            }
        }
        _ => {}
    }
}

/// Scan only the ADDED lines of an apply_patch / unified diff — lines that begin
/// with a single `+` (not the `+++` file header). Deleted (`-`) and context
/// (` `) lines are ignored so removing flagged text is treated as a cleanup, not
/// a finding — matching the Claude path, which only ever sees added content.
fn scan_added_lines(patch: &str, findings: &mut Vec<String>, seen: &mut HashSet<String>) {
    for line in patch.lines() {
        let Some(rest) = line.strip_prefix('+') else {
            continue;
        };
        if rest.starts_with("++") {
            continue; // `+++ b/file` header
        }
        scan_text(rest, findings, seen);
    }
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

/// Scan text for hedging patterns (case-insensitive) and code markers
/// (case-sensitive). Deduplicates via `seen`. Each finding includes the
/// surrounding phrase so the user can see the trigger in context.
fn scan_text(text: &str, findings: &mut Vec<String>, seen: &mut HashSet<String>) {
    for &pattern in PATTERNS {
        if seen.contains(pattern) {
            continue;
        }
        if let Some(pos) = find_pattern(text, pattern) {
            let phrase = extract_phrase(text, pos, pattern.len());
            findings.push(format!("\"{}\" → \"{}\"", pattern, phrase));
            seen.insert(pattern.to_string());
        }
    }

    for &marker in CODE_MARKERS {
        if seen.contains(marker) {
            continue;
        }
        if let Some(pos) = text.find(marker) {
            let phrase = extract_phrase(text, pos, marker.len());
            findings.push(format!("{} comment → \"{}\"", marker, phrase));
            seen.insert(marker.to_string());
        }
    }
}

/// Find the first case-insensitive occurrence of `pattern` that is not part of
/// a known false-positive substring (see EXCEPTIONS).
fn find_pattern(text: &str, pattern: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(rel) = find_case_insensitive(&text[from..], pattern) {
        let pos = from + rel;
        if !within_exception(text, pos, pattern.len()) {
            return Some(pos);
        }
        // Patterns are ASCII, so `pos` is a char boundary and `pos + 1` is too.
        from = pos + 1;
    }
    None
}

/// True if the match at `[pos, pos + len)` lies within an occurrence of any
/// EXCEPTIONS entry.
fn within_exception(text: &str, pos: usize, len: usize) -> bool {
    for &exc in EXCEPTIONS {
        let mut from = 0;
        while let Some(rel) = find_case_insensitive(&text[from..], exc) {
            let start = from + rel;
            let end = start + exc.len();
            if start <= pos && pos + len <= end {
                return true;
            }
            from = start + 1;
        }
    }
    false
}

/// Case-insensitive byte-level substring search (ASCII-folding only).
/// Returns the byte offset of the first match in `haystack`.
fn find_case_insensitive(haystack: &str, needle: &str) -> Option<usize> {
    let h = haystack.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    'outer: for i in 0..=(h.len() - n.len()) {
        for j in 0..n.len() {
            if !h[i + j].eq_ignore_ascii_case(&n[j]) {
                continue 'outer;
            }
        }
        return Some(i);
    }
    None
}

/// Extract the surrounding sentence containing the match at `match_start`.
/// Sentence boundaries are `.`, `!`, `?`, `\n`. A per-side cap of 120 bytes
/// keeps runaway paragraphs short. Result is whitespace-trimmed and has
/// newlines flattened to spaces.
fn extract_phrase(text: &str, match_start: usize, match_len: usize) -> String {
    const MAX_PER_SIDE: usize = 120;
    let bytes = text.as_bytes();

    let lo_bound = match_start.saturating_sub(MAX_PER_SIDE);
    let hi_bound = (match_start + match_len + MAX_PER_SIDE).min(bytes.len());

    let mut start = match_start;
    while start > lo_bound {
        if matches!(bytes[start - 1], b'.' | b'!' | b'?' | b'\n') {
            break;
        }
        start -= 1;
    }

    let mut end = match_start + match_len;
    while end < hi_bound {
        if matches!(bytes[end], b'.' | b'!' | b'?' | b'\n') {
            end += 1; // include the punctuation
            break;
        }
        end += 1;
    }

    // Snap to UTF-8 char boundaries.
    while start > 0 && !text.is_char_boundary(start) {
        start -= 1;
    }
    while end < text.len() && !text.is_char_boundary(end) {
        end += 1;
    }

    let snippet: String = text[start..end]
        .replace('\n', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    let prefix = if start > 0 && !matches!(bytes[start - 1], b'.' | b'!' | b'?' | b'\n') {
        "…"
    } else {
        ""
    };
    let suffix = if end < bytes.len() && !matches!(bytes[end - 1], b'.' | b'!' | b'?' | b'\n') {
        "…"
    } else {
        ""
    };

    format!("{}{}{}", prefix, snippet, suffix)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    #[test]
    fn windows_hook_command_uses_explicit_powershell_launcher() {
        let hooks_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../hooks.json");
        let hooks: Value =
            serde_json::from_str(&fs::read_to_string(hooks_path).expect("read hooks.json"))
                .expect("parse hooks.json");

        let command = hooks["hooks"]["Stop"][0]["hooks"][0]["commandWindows"]
            .as_str()
            .expect("Stop commandWindows");

        assert_eq!(
            command,
            r#"powershell.exe -NoLogo -NoProfile -NonInteractive -Command "if ([Environment]::GetEnvironmentVariable('PLUGIN_ROOT')) { & (Join-Path ([Environment]::GetEnvironmentVariable('PLUGIN_ROOT')) 'hooks\bin\mediocrity-detector.exe') } else { & (Join-Path ([Environment]::GetEnvironmentVariable('CLAUDE_PLUGIN_ROOT')) 'hooks\bin\mediocrity-detector.exe') }""#
        );
    }

    // -- Codex rollout transcript format ------------------------------------

    #[test]
    fn scans_codex_assistant_message() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        let entry = json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "I hardcoded it as a placeholder for now."}]
            }
        });
        scan_entry(&entry, &mut findings, &mut seen);
        assert!(findings.iter().any(|f| f.contains("hardcoded")));
        assert!(findings.iter().any(|f| f.contains("placeholder")));
        assert!(findings.iter().any(|f| f.contains("for now")));
    }

    #[test]
    fn scans_codex_apply_patch_arguments() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        let entry = json!({
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "apply_patch",
                "arguments": "{\"input\":\"*** Begin Patch\\n+ // TODO: revisit later\\n*** End Patch\"}"
            }
        });
        scan_entry(&entry, &mut findings, &mut seen);
        assert!(findings.iter().any(|f| f.contains("TODO")));
        assert!(findings.iter().any(|f| f.contains("revisit later")));
    }

    #[test]
    fn codex_apply_patch_ignores_deleted_lines() {
        // A cleanup that DELETES flagged text must not trip the hook; only added
        // lines count. Here the added line is clean, the removed line has markers.
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        let entry = json!({
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "apply_patch",
                "arguments": "{\"input\":\"*** Begin Patch\\n- // TODO: remove this placeholder for now\\n+ let value = config.resolve();\\n*** End Patch\"}"
            }
        });
        scan_entry(&entry, &mut findings, &mut seen);
        assert!(findings.is_empty(), "deleted-line markers must not trip: {findings:?}");
    }

    #[test]
    fn ignores_codex_shell_function_call() {
        // Mirror Claude: shell commands are not scanned, only file-content edits.
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        let entry = json!({
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "shell",
                "arguments": "{\"command\":\"rm placeholder_tmp && echo hardcoded\"}"
            }
        });
        scan_entry(&entry, &mut findings, &mut seen);
        assert!(findings.is_empty(), "shell command text must not trigger: {findings:?}");
    }

    #[test]
    fn ignores_codex_user_message() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        let entry = json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "just use a placeholder for now"}]
            }
        });
        scan_entry(&entry, &mut findings, &mut seen);
        assert!(findings.is_empty(), "user text must not trigger: {findings:?}");
    }

    #[test]
    fn find_turn_start_codex_task_started() {
        let lines = vec![
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"old"}]}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_started"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"new"}]}}"#,
        ];
        assert_eq!(find_turn_start(&lines), 1);
    }

    #[test]
    fn detects_for_now() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text("I used a simple implementation for now.", &mut findings, &mut seen);
        assert!(findings.iter().any(|f| f.contains("for now")));
    }

    #[test]
    fn detects_multiple_patterns() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text(
            "This is good enough for now. I'll revisit later.",
            &mut findings,
            &mut seen,
        );
        assert!(findings.iter().any(|f| f.contains("good enough")));
        assert!(findings.iter().any(|f| f.contains("for now")));
        assert!(findings.iter().any(|f| f.contains("revisit later")));
    }

    #[test]
    fn detects_todo_case_sensitive() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text("// TODO: handle edge case", &mut findings, &mut seen);
        assert!(findings.iter().any(|f| f.contains("TODO")));
    }

    #[test]
    fn ignores_todo_lowercase() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text("I updated the todo list component", &mut findings, &mut seen);
        assert!(findings.iter().all(|f| !f.contains("TODO")));
    }

    #[test]
    fn deduplicates() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text("for now this is fine", &mut findings, &mut seen);
        scan_text("I did this for now", &mut findings, &mut seen);
        let count = findings.iter().filter(|f| f.contains("for now")).count();
        assert_eq!(count, 1);
    }

    #[test]
    fn clean_text_no_findings() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text(
            "I implemented the feature with full error handling and comprehensive tests.",
            &mut findings,
            &mut seen,
        );
        assert!(findings.is_empty());
    }

    #[test]
    fn case_insensitive_match() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text("This is a Basic Implementation.", &mut findings, &mut seen);
        assert!(findings.iter().any(|f| f.contains("basic implementation")));
    }

    #[test]
    fn detects_temporary() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text(
            "I added a temporary workaround for the race condition.",
            &mut findings,
            &mut seen,
        );
        assert!(findings.iter().any(|f| f.contains("temporary")));
    }

    #[test]
    fn ignores_temporary_directory() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text(
            "with tempfile.TemporaryDirectory() as tmp:",
            &mut findings,
            &mut seen,
        );
        assert!(findings.is_empty(), "got: {:?}", findings);
    }

    #[test]
    fn detects_temporary_after_exception() {
        // A real "temporary" hedge later in the text must still fire even when a
        // TemporaryDirectory occurrence precedes it.
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text(
            "I used a TemporaryDirectory. This is a temporary hack.",
            &mut findings,
            &mut seen,
        );
        assert!(findings.iter().any(|f| f.starts_with("\"temporary\"")), "got: {:?}", findings);
    }

    #[test]
    fn detects_placeholder() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text(
            "I added a placeholder for the authentication logic.",
            &mut findings,
            &mut seen,
        );
        assert!(findings.iter().any(|f| f.contains("placeholder")));
    }

    #[test]
    fn detects_workaround() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text(
            "I used a workaround to avoid the API limitation.",
            &mut findings,
            &mut seen,
        );
        assert!(findings.iter().any(|f| f.contains("workaround")));
    }

    #[test]
    fn detects_fixme_in_code() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text(
            "function init() {\n  // FIXME: needs proper error handling\n}",
            &mut findings,
            &mut seen,
        );
        assert!(findings.iter().any(|f| f.contains("FIXME")));
    }

    // -- Phrase extraction ----------------------------------------------------

    #[test]
    fn finding_includes_surrounding_phrase() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text(
            "I added a temporary workaround for the race condition.",
            &mut findings,
            &mut seen,
        );
        // The "temporary" finding should include the full sentence as context.
        let temp = findings
            .iter()
            .find(|f| f.starts_with("\"temporary\""))
            .expect("temporary finding present");
        assert!(
            temp.contains("temporary workaround for the race condition"),
            "expected surrounding phrase, got: {}",
            temp
        );
    }

    #[test]
    fn phrase_uses_sentence_boundary() {
        let phrase = extract_phrase(
            "Here is some context. I added a temporary fix. Then I moved on.",
            "Here is some context. I added a ".len(),
            "temporary".len(),
        );
        assert_eq!(phrase, "I added a temporary fix.");
    }

    #[test]
    fn phrase_handles_newline_boundary() {
        let text = "Line one\nThis is a temporary thing\nLine three";
        let pos = text.find("temporary").unwrap();
        let phrase = extract_phrase(text, pos, "temporary".len());
        assert_eq!(phrase, "This is a temporary thing");
    }

    #[test]
    fn phrase_caps_long_runs() {
        // No sentence punctuation — should cap and emit ellipsis markers.
        let prefix = "a ".repeat(200);
        let suffix = " b".repeat(200);
        let text = format!("{}temporary{}", prefix, suffix);
        let pos = prefix.len();
        let phrase = extract_phrase(&text, pos, "temporary".len());
        assert!(phrase.contains("temporary"));
        assert!(phrase.starts_with('…'), "expected leading ellipsis, got: {}", phrase);
        assert!(phrase.ends_with('…'), "expected trailing ellipsis, got: {}", phrase);
        assert!(phrase.len() < text.len(), "expected truncation");
    }

    #[test]
    fn phrase_handles_utf8() {
        // Multi-byte chars on both sides; should not panic.
        let text = "Résumé note — added a temporary fix — café.";
        let pos = text.find("temporary").unwrap();
        let phrase = extract_phrase(text, pos, "temporary".len());
        assert!(phrase.contains("temporary"));
    }

    // -- Transcript parsing ---------------------------------------------------

    #[test]
    fn finds_turn_start_skips_tool_results() {
        let lines = vec![
            r#"{"type":"user","message":{"role":"user","content":"Fix the bug"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"On it."}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"123"}]}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}"#,
        ];
        assert_eq!(find_turn_start(&lines), 0);
    }

    #[test]
    fn finds_latest_user_message() {
        let lines = vec![
            r#"{"type":"user","message":{"role":"user","content":"First task"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":"Second task"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Working."}]}}"#,
        ];
        assert_eq!(find_turn_start(&lines), 2);
    }
}
