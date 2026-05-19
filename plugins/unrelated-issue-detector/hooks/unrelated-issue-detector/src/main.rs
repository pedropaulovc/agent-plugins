//! PostToolUse hook that detects when the agent dismisses issues as "unrelated"
//! or "pre-existing" and forces investigation via a parallel worktree agent.
//!
//! Fires after every tool call. Reads only NEW transcript content since the
//! last check (tracked via a per-session offset file) so each dismissal is
//! caught exactly once without re-triggering on old matches.

use regex::RegexSet;
use serde_json::Value;
use std::env;
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::process;

const DISMISSAL_PATTERNS: &[&str] = &[
    r"(?:existing|pre-existing|preexisting)\s+(?:issues?|bugs?|problems?|errors?|defects?)",
    r"(?:not|isn'?t|aren'?t|is\s+not|are\s+not)\s+(?:related|caused|introduced)\s+(?:to|by)\s+(?:this|our|the|my)",
    r"unrelated\s+(?:issues?|bugs?|problems?|errors?|to\s+(?:this|our|the))",
    r"separate\s+(?:issues?|bugs?|problems?|concerns?|matters?)",
    r"(?:outside|beyond)\s+(?:the\s+)?scope\s+of\s+(?:this|our|the)",
    r"(?:was\s+)?already\s+(?:present|broken|failing|there)\s+(?:before|on\s+main|in\s+main)",
    r"known\s+(?:issues?|bugs?|problems?|limitations?)",
    r"not\s+something\s+we\s+introduced",
    r"(?:this|the|these)\s+(?:issues?|bugs?|problems?|errors?)\s+(?:is|are|was|were|appears?)\s+(?:to\s+be\s+)?(?:pre-existing|preexisting|unrelated)",
];

const INVESTIGATION_INSTRUCTIONS: &str = "\
STOP. You just dismissed an issue as \"unrelated\" or \"pre-existing\". \
You MUST investigate before moving on.\n\
\n\
Spawn an agent in your agent team with these parameters:\n\
- subagent_type: \"general-purpose\"\n\
- model: \"opus\"\n\
- run_in_background: false\n\
\n\
In the prompt, include the FULL description of the issue you dismissed \
(error messages, symptoms, affected code, reproduction steps).\n\
\n\
Tell the agent to:\n\
1. Create a worktree: `git worktree add -b investigate-issue .claude/worktrees/investigation main`\n\
2. cd into the worktree.\n\
3. Run /systematic-debugging [full description of the issue]\n\
4. Attempt to reproduce the issue on main.\n\
5. If it **REPRODUCES on main** (truly pre-existing): file a GitHub issue \
using `gh issue create` with a clear title, full description, repro steps, \
expected vs actual behavior, and label `bug`.\n\
6. If it does **NOT reproduce on main**: report back that the issue was \
introduced by the current changes.\n\
7. Clean up: `git worktree remove .claude/worktrees/investigation`\n\
\n\
After the agent completes:\n\
- If a bug was filed (truly pre-existing): you may continue.\n\
- If the issue is NOT pre-existing: you MUST fix it. Do NOT dismiss it again.\n\
\n\
Do NOT skip this. Do NOT dismiss issues without evidence.";

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
        entry
            .get("message")
            .and_then(|m| m.get("content"))
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

fn main() {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        process::exit(0);
    }

    let input_data: Value = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(_) => process::exit(0),
    };

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

    // Extract assistant text from new transcript entries.
    let mut texts = Vec::new();
    for line in new_content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(entry) = serde_json::from_str::<Value>(line) {
            let text = extract_assistant_text(&entry);
            if !text.is_empty() {
                texts.push(text);
            }
        }
    }

    let combined = texts.join("\n").to_lowercase();

    if combined.is_empty() {
        process::exit(0);
    }

    let set = RegexSet::new(DISMISSAL_PATTERNS).expect("invalid regex patterns");
    if !set.is_match(&combined) {
        process::exit(0);
    }

    // Inject investigation instructions into the agent's next loop iteration.
    let output = serde_json::json!({
        "decision": "block",
        "reason": INVESTIGATION_INSTRUCTIONS
    });
    println!("{}", output);
}
