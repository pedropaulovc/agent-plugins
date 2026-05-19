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

        if entry["type"].as_str() != Some("assistant") {
            continue;
        }

        let content = match entry["message"]["content"].as_array() {
            Some(c) => c,
            None => continue,
        };

        for block in content {
            let block_type = block["type"].as_str().unwrap_or("");

            match block_type {
                "text" => {
                    if let Some(text) = block["text"].as_str() {
                        scan_text(text, &mut findings, &mut seen);
                    }
                }
                "tool_use" => {
                    let input = &block["input"];
                    // Write tool: content field
                    if let Some(t) = input["content"].as_str() {
                        scan_text(t, &mut findings, &mut seen);
                    }
                    // Edit tool: new_string field
                    if let Some(t) = input["new_string"].as_str() {
                        scan_text(t, &mut findings, &mut seen);
                    }
                }
                _ => {}
            }
        }
    }

    if findings.is_empty() {
        process::exit(0);
    }

    let list = findings.join(", ");
    let reason = format!(
        "Shortcut/assumption language detected in this turn: [{}]. \
         Before stopping, explicitly report to the user each shortcut or assumption. \
         For each: (1) what exactly you did and where, (2) why you chose this approach, \
         (3) what a complete solution looks like. Be specific — the user needs to make \
         an informed judgement call.",
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
        // Quick pre-filter before JSON parsing
        if !lines[i].contains("\"user\"") {
            continue;
        }

        let entry: Value = match serde_json::from_str(lines[i]) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if entry["type"].as_str() == Some("user") && entry["message"]["content"].is_string() {
            return i;
        }
    }

    0
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

/// Scan text for hedging patterns (case-insensitive) and code markers
/// (case-sensitive). Deduplicates via `seen`.
fn scan_text(text: &str, findings: &mut Vec<String>, seen: &mut HashSet<String>) {
    let lower = text.to_lowercase();

    for &pattern in PATTERNS {
        if !seen.contains(pattern) && lower.contains(pattern) {
            findings.push(format!("\"{}\"", pattern));
            seen.insert(pattern.to_string());
        }
    }

    for &marker in CODE_MARKERS {
        if !seen.contains(marker) && text.contains(marker) {
            findings.push(format!("{} comment", marker));
            seen.insert(marker.to_string());
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

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
