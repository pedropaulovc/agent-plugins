//! Stop hook that detects when the agent dismisses issues as "unrelated"
//! or "pre-existing".
//!
//! Strategy: trust but verify. When the agent tries to end its turn, scans NEW
//! transcript content since the last check (via a per-session offset file) for
//! narrow dismissal phrases. If any are found, blocks the stop and asks Claude
//! to surface evidence for each dismissal so the user can make the judgement
//! call.
//!
//! Loop guard: when `stop_hook_active` is set, Claude is already continuing
//! because of this hook, so we exit cleanly — otherwise the follow-up report
//! (which repeats the dismissal phrases) would trip the detector forever.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::process;

/// Dismissal phrases matched case-insensitively. Kept narrow on purpose so the
/// hook only fires when the agent is *actually* dismissing an issue, not when
/// it incidentally mentions the words "unrelated" or "pre-existing".
const PATTERNS: &[&str] = &[
    // Pre-existing
    "pre-existing issue",
    "pre-existing bug",
    "pre-existing problem",
    "pre-existing failure",
    "pre-existing error",
    "preexisting issue",
    "preexisting bug",
    "preexisting problem",
    "preexisting failure",
    "preexisting error",
    // Unrelated to this/my/the change/PR/work
    "unrelated to this change",
    "unrelated to my change",
    "unrelated to the change",
    "unrelated to these changes",
    "unrelated to my changes",
    "unrelated to this pr",
    "unrelated to my pr",
    "unrelated to this work",
    "unrelated to this task",
    "unrelated to this fix",
    // Not related / not caused / not introduced
    "not related to this change",
    "not related to my change",
    "not related to these changes",
    "not related to my changes",
    "not caused by this change",
    "not caused by my change",
    "not caused by these changes",
    "not introduced by this change",
    "not introduced by my change",
    "not introduced by these changes",
    "not introduced by my changes",
    "not something we introduced",
    "not something i introduced",
    // Already broken / failing on main
    "already broken on main",
    "already failing on main",
    "already failing before",
    "already broken before",
    "already present on main",
    "broken on main",
    // Out of scope
    "outside the scope of this",
    "outside the scope of my",
    "beyond the scope of this",
    "out of scope for this",
    // Separate
    "separate issue from",
    "separate bug from",
    "separate concern from",
];

fn offset_path(session_id: &str) -> PathBuf {
    let mut p = env::temp_dir();
    p.push(format!("unrelated-issue-{}.offset", session_id));
    p
}

fn read_offset(session_id: &str) -> u64 {
    fs::read_to_string(offset_path(session_id))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

fn save_offset(session_id: &str, offset: u64) {
    let _ = fs::write(offset_path(session_id), offset.to_string());
}

fn extract_assistant_text(entry: &Value) -> String {
    let role = entry.get("role").and_then(|v| v.as_str()).unwrap_or("");
    let msg_type = entry.get("type").and_then(|v| v.as_str()).unwrap_or("");

    let content = if role == "assistant" {
        entry.get("content")
    } else if msg_type == "assistant" {
        entry.get("message").and_then(|m| m.get("content"))
    } else {
        return String::new();
    };

    let Some(content) = content else {
        return String::new();
    };

    if let Some(s) = content.as_str() {
        return s.to_string();
    }

    if let Some(arr) = content.as_array() {
        return arr
            .iter()
            .filter_map(|item| {
                if item.get("type")?.as_str()? == "text" {
                    item.get("text")?.as_str().map(String::from)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
    }

    String::new()
}

/// Scan text for dismissal patterns (case-insensitive). Deduplicates via
/// `seen`. Each finding includes the surrounding phrase so the user can see the
/// trigger in context.
fn scan_text(text: &str, findings: &mut Vec<String>, seen: &mut HashSet<String>) {
    for &pattern in PATTERNS {
        if seen.contains(pattern) {
            continue;
        }
        if let Some(pos) = find_case_insensitive(text, pattern) {
            let phrase = extract_phrase(text, pos, pattern.len());
            findings.push(format!("\"{}\" → \"{}\"", pattern, phrase));
            seen.insert(pattern.to_string());
        }
    }
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

fn main() {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        process::exit(0);
    }

    let input_data: Value = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(_) => process::exit(0),
    };

    // Loop guard: if we already blocked a stop this turn, Claude is now
    // producing its evidence report — which echoes the dismissal phrases. Let
    // it stop rather than re-trigger on its own report.
    if input_data
        .get("stop_hook_active")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        process::exit(0);
    }

    let session_id = input_data
        .get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    let transcript_path = match input_data.get("transcript_path").and_then(|v| v.as_str()) {
        Some(p) if !p.is_empty() => p,
        _ => process::exit(0),
    };

    let last_offset = read_offset(session_id);

    // Read only new transcript content since last check.
    let mut file = match fs::File::open(transcript_path) {
        Ok(f) => f,
        Err(_) => process::exit(0),
    };

    let current_size = match file.seek(SeekFrom::End(0)) {
        Ok(s) => s,
        Err(_) => process::exit(0),
    };

    if current_size <= last_offset {
        process::exit(0);
    }

    if file.seek(SeekFrom::Start(last_offset)).is_err() {
        process::exit(0);
    }

    let mut new_content = String::new();
    if file.read_to_string(&mut new_content).is_err() {
        process::exit(0);
    }

    // Always advance the offset so we never re-scan the same content.
    save_offset(session_id, current_size);

    let mut findings = Vec::new();
    let mut seen = HashSet::new();

    for line in new_content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(entry) = serde_json::from_str::<Value>(line) {
            let text = extract_assistant_text(&entry);
            if !text.is_empty() {
                scan_text(&text, &mut findings, &mut seen);
            }
        }
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
        "Dismissal language detected in this turn:\n{}\n\n\
         Before moving on, explicitly report to the user each issue you dismissed. \
         For each: (1) the exact symptom (error message, failing test, unexpected \
         behavior), (2) the evidence it is pre-existing or unrelated (commit hash, \
         line on main, a repro on main), (3) what you would investigate further if \
         asked. Be specific — the user needs to make an informed judgement call.\n\n\
         Recommended: if this is a true positive, use the AskUserQuestion tool to \
         offer options such as: start the fix in a separate worktree; pause current \
         work and fix the issue here immediately; or log the issue and proceed.",
        list
    );

    println!("{}", json!({"decision": "block", "reason": reason}));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_pre_existing_issue() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text(
            "This is a pre-existing issue on main, not from my work.",
            &mut findings,
            &mut seen,
        );
        assert!(findings.iter().any(|f| f.contains("pre-existing issue")));
    }

    #[test]
    fn detects_unrelated_to_this_change() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text(
            "That failing test is unrelated to this change.",
            &mut findings,
            &mut seen,
        );
        assert!(findings.iter().any(|f| f.contains("unrelated to this change")));
    }

    #[test]
    fn detects_already_broken_on_main() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text(
            "Skipping this — it was already broken on main before I touched anything.",
            &mut findings,
            &mut seen,
        );
        assert!(findings.iter().any(|f| f.contains("already broken on main")));
    }

    #[test]
    fn ignores_incidental_unrelated_mention() {
        // Narrow patterns must not fire on bare "unrelated" usage.
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text(
            "The two features are unrelated by design, so they live in separate modules.",
            &mut findings,
            &mut seen,
        );
        assert!(findings.is_empty());
    }

    #[test]
    fn ignores_incidental_preexisting_mention() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text(
            "Reuse the pre-existing configuration loader instead of writing a new one.",
            &mut findings,
            &mut seen,
        );
        assert!(findings.is_empty());
    }

    #[test]
    fn case_insensitive_match() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text(
            "This is Unrelated To This Change.",
            &mut findings,
            &mut seen,
        );
        assert!(findings.iter().any(|f| f.contains("unrelated to this change")));
    }

    #[test]
    fn deduplicates() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text("pre-existing issue here", &mut findings, &mut seen);
        scan_text("another pre-existing issue", &mut findings, &mut seen);
        let count = findings
            .iter()
            .filter(|f| f.contains("pre-existing issue"))
            .count();
        assert_eq!(count, 1);
    }

    #[test]
    fn detects_not_introduced_by() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text(
            "That warning was not introduced by this change.",
            &mut findings,
            &mut seen,
        );
        assert!(findings.iter().any(|f| f.contains("not introduced by this change")));
    }

    #[test]
    fn detects_out_of_scope() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text(
            "Fixing that is out of scope for this PR.",
            &mut findings,
            &mut seen,
        );
        assert!(findings.iter().any(|f| f.contains("out of scope for this")));
    }

    #[test]
    fn clean_text_no_findings() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text(
            "I fixed the failing test and verified the regression locally.",
            &mut findings,
            &mut seen,
        );
        assert!(findings.is_empty());
    }

    // -- Phrase extraction ----------------------------------------------------

    #[test]
    fn finding_includes_surrounding_phrase() {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();
        scan_text(
            "The auth test is unrelated to this change, it fails on main too.",
            &mut findings,
            &mut seen,
        );
        let finding = findings
            .iter()
            .find(|f| f.starts_with("\"unrelated to this change\""))
            .expect("unrelated finding present");
        assert!(
            finding.contains("The auth test is unrelated to this change"),
            "expected surrounding phrase, got: {}",
            finding
        );
    }

    #[test]
    fn phrase_uses_sentence_boundary() {
        let phrase = extract_phrase(
            "Here is some context. That is a pre-existing issue. Then I moved on.",
            "Here is some context. That is a ".len(),
            "pre-existing issue".len(),
        );
        assert_eq!(phrase, "That is a pre-existing issue.");
    }

    #[test]
    fn phrase_caps_long_runs() {
        // No sentence punctuation — should cap and emit ellipsis markers.
        let prefix = "a ".repeat(200);
        let suffix = " b".repeat(200);
        let text = format!("{}pre-existing issue{}", prefix, suffix);
        let pos = prefix.len();
        let phrase = extract_phrase(&text, pos, "pre-existing issue".len());
        assert!(phrase.contains("pre-existing issue"));
        assert!(phrase.starts_with('…'), "expected leading ellipsis, got: {}", phrase);
        assert!(phrase.ends_with('…'), "expected trailing ellipsis, got: {}", phrase);
        assert!(phrase.len() < text.len(), "expected truncation");
    }

    #[test]
    fn phrase_handles_utf8() {
        // Multi-byte chars on both sides; should not panic.
        let text = "Résumé note — that is a pre-existing bug — café.";
        let pos = text.find("pre-existing bug").unwrap();
        let phrase = extract_phrase(text, pos, "pre-existing bug".len());
        assert!(phrase.contains("pre-existing bug"));
    }
}
