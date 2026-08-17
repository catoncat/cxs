use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::tempdir;

use crate::identity::SourceId;
use crate::selector::Selector;

use super::{
    FullProjectionReason, ProjectedSource, ProjectionMode, ProjectionOutcome, SourceCatalog,
    SourceFile, SourceMetadataCache, inject_metadata_failure, write_zstd_lines,
};

#[test]
fn per_file_metadata_failure_is_reported_without_hiding_observed_membership() {
    let temp = tempdir().unwrap();
    let root = temp.path().join("sessions/2026/08/15");
    fs::create_dir_all(&root).unwrap();
    let good = root.join("good.jsonl");
    let bad = root.join("bad.jsonl");
    write_lines(
        &good,
        &[codex_line(
            "event_msg",
            json!({"type":"user_message","message":"readable"}),
        )],
    );
    write_lines(
        &bad,
        &[codex_line(
            "event_msg",
            json!({"type":"user_message","message":"temporarily unreadable metadata"}),
        )],
    );

    let injection = inject_metadata_failure(&bad);
    let incomplete = scan_all(SourceId::Codex, temp.path());
    assert_eq!(incomplete.files.len(), 1);
    assert_eq!(incomplete.inventory.total_files, 2);
    assert_eq!(incomplete.snapshot.file_count, 2);
    assert_eq!(incomplete.failures.len(), 1);
    assert_eq!(incomplete.failures[0].file_path, bad);
    assert_eq!(
        incomplete.failures[0].operation,
        "read accepted source metadata"
    );
    let failed_content = incomplete.snapshot.fingerprint;
    let failed_file_set = incomplete.snapshot.file_set_fingerprint;

    drop(injection);
    let complete = scan_all(SourceId::Codex, temp.path());
    assert_eq!(complete.files.len(), 2);
    assert!(complete.failures.is_empty());
    assert_ne!(complete.snapshot.fingerprint, failed_content);
    assert_ne!(complete.snapshot.file_set_fingerprint, failed_file_set);
}

#[test]
fn sanitized_contract_fixtures_scan_and_project_with_raw_evidence() {
    let repository = repository_root();
    let cases = [
        (
            SourceId::Codex,
            repository.join("eval/fixtures/contract/codex"),
            "contract shared beacon codex request",
        ),
        (
            SourceId::ClaudeCode,
            repository.join("eval/fixtures/contract/claude-code"),
            "contract shared beacon claude request",
        ),
        (
            SourceId::Pi,
            repository.join("eval/fixtures/contract/pi"),
            "contract shared beacon pi request",
        ),
    ];

    for (source_id, root, needle) in cases {
        let scan = scan_all(source_id, &root);
        assert!(scan.inventory.total_files >= 1, "{source_id} inventory");
        assert_eq!(scan.snapshot.file_count, scan.files.len() as u64);
        let mut found = false;
        for file in &scan.files {
            let projected = expect_projected(project(file, file.size, None));
            assert!(projected.read_proof.stable());
            assert_eq!(projected.read_proof.safe_offset, file.size);
            let raw = fs::read(&file.file_path).unwrap();
            for document in &projected.documents {
                let span = &raw[document.raw_start as usize..document.raw_end as usize];
                assert!(serde_json::from_slice::<Value>(span).is_ok());
                if document.message.content_text == needle {
                    found = true;
                }
            }
        }
        assert!(found, "missing accepted fixture text for {source_id}");
    }
}

#[test]
fn source_allowlists_reject_private_and_format_drift_records() {
    let temp = tempdir().unwrap();

    let codex_root = temp.path().join("codex/2026/08/15");
    fs::create_dir_all(&codex_root).unwrap();
    let codex_file =
        codex_root.join("rollout-2026-08-15T00-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl");
    write_lines(
        &codex_file,
        &[
            "{not json".to_owned(),
            codex_line(
                "session_meta",
                json!({"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","cwd":"/safe/codex"}),
            ),
            codex_line(
                "event_msg",
                json!({"type":"tool_result","message":"codex tool result must not leak"}),
            ),
            codex_line(
                "event_msg",
                json!({"type":"user_message","message":"accepted codex user"}),
            ),
            codex_line(
                "event_msg",
                json!({"type":"user_message","message":"The following is the Codex agent history whose request action you are assessing\ninternal codex must not leak"}),
            ),
            codex_line(
                "event_msg",
                json!({"type":"agent_message","message":"accepted codex assistant"}),
            ),
            codex_line("compacted", json!({"message":"accepted codex handoff"})),
            codex_line(
                "response_item",
                json!({"type":"reasoning","summary":[{"text":"accepted codex reasoning"}]}),
            ),
        ],
    );

    let claude_root = temp.path().join("claude");
    fs::create_dir_all(&claude_root).unwrap();
    let claude_file = claude_root.join("conversation.jsonl");
    write_lines(
        &claude_file,
        &[
            "{not json".to_owned(),
            json!({"type":"user","isMeta":true,"sessionId":"private-meta","cwd":"/private","timestamp":"1999-01-01T00:00:00Z","message":{"content":"claude meta must not leak"}}).to_string(),
            json!({"type":"assistant","isSidechain":true,"sessionId":"private-sidechain","cwd":"/private","timestamp":"1999-01-02T00:00:00Z","message":{"content":"claude sidechain must not leak"}}).to_string(),
            json!({"type":"user","sessionId":"claude-safe","cwd":"/safe/claude","timestamp":"2026-08-15T00:00:00Z","message":{"content":[{"type":"text","text":"accepted claude user"},{"type":"tool_result","content":"claude tool result must not leak"},{"type":"thinking","thinking":"claude thinking must not leak"},{"type":"attachment","text":"claude attachment must not leak"}]}}).to_string(),
            json!({"type":"assistant","sessionId":"claude-safe","cwd":"/safe/claude","timestamp":"2026-08-15T00:00:01Z","message":{"content":"accepted claude assistant"}}).to_string(),
        ],
    );

    let pi_root = temp.path().join("pi");
    fs::create_dir_all(&pi_root).unwrap();
    let pi_file = pi_root.join("conversation.jsonl");
    write_lines(
        &pi_file,
        &[
            "{not json".to_owned(),
            json!({"type":"session","id":"pi-safe","cwd":"/safe/pi","timestamp":"2026-08-15T00:00:00Z"}).to_string(),
            json!({"type":"message","timestamp":"2026-08-15T00:00:01Z","message":{"role":"user","content":[{"type":"text","text":"accepted pi user"},{"type":"thinking","thinking":"pi thinking must not leak"}]}}).to_string(),
            json!({"type":"message","timestamp":"2026-08-15T00:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"accepted pi assistant"},{"type":"toolCall","name":"bash","arguments":{"command":"pi tool call must not leak"}}]}}).to_string(),
            json!({"type":"message","timestamp":"2026-08-15T00:00:03Z","message":{"role":"toolResult","content":[{"type":"text","text":"pi tool result must not leak"}]}}).to_string(),
            json!({"type":"future_event","text":"pi format drift must not leak"}).to_string(),
            json!({"type":"compaction","timestamp":"2026-08-15T00:00:04Z","summary":"accepted pi compaction"}).to_string(),
        ],
    );

    let cases = [
        (
            SourceId::Codex,
            temp.path().join("codex"),
            vec!["accepted codex user", "accepted codex assistant"],
            vec!["tool result must not leak", "internal codex must not leak"],
        ),
        (
            SourceId::ClaudeCode,
            claude_root,
            vec!["accepted claude user", "accepted claude assistant"],
            vec![
                "meta must not leak",
                "sidechain must not leak",
                "tool result must not leak",
                "thinking must not leak",
                "attachment must not leak",
            ],
        ),
        (
            SourceId::Pi,
            pi_root,
            vec!["accepted pi user", "accepted pi assistant"],
            vec![
                "thinking must not leak",
                "tool call must not leak",
                "tool result must not leak",
                "format drift must not leak",
            ],
        ),
    ];

    for (source_id, root, accepted, rejected) in cases {
        let scan = scan_all(source_id, &root);
        assert_eq!(scan.files.len(), 1, "{source_id} accepted file count");
        let projected = expect_projected(project(&scan.files[0], scan.files[0].size, None));
        let searchable = serde_json::to_string(&projected).unwrap();
        for value in accepted {
            assert!(searchable.contains(value), "{source_id} lost {value}");
        }
        for value in rejected {
            assert!(!searchable.contains(value), "{source_id} leaked {value}");
        }
    }
}

#[test]
fn codex_coverage_fingerprint_ignores_rejected_append_but_tracks_accepted_append() {
    let temp = tempdir().unwrap();
    let root = temp.path().join("codex/2026/08/15");
    fs::create_dir_all(&root).unwrap();
    let path = root.join("rollout-2026-08-15T00-00-00-private.jsonl");
    write_lines(
        &path,
        &[
            codex_line(
                "session_meta",
                json!({"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","cwd":"/safe"}),
            ),
            codex_line(
                "event_msg",
                json!({"type":"user_message","message":"accepted baseline"}),
            ),
        ],
    );
    let baseline = scan_all(SourceId::Codex, temp.path());
    let baseline_size = baseline.files[0].size;
    let baseline_accepted = baseline.files[0].accepted_fingerprint.clone();
    let baseline_content = baseline.snapshot.fingerprint.clone();

    append(
        &path,
        &codex_line(
            "response_item",
            json!({"type":"function_call","name":"shell","arguments":"private"}),
        ),
    );
    let rejected = scan_all(SourceId::Codex, temp.path());
    assert!(rejected.files[0].size > baseline_size);
    assert_eq!(rejected.files[0].accepted_fingerprint, baseline_accepted);
    assert_eq!(rejected.snapshot.fingerprint, baseline_content);

    append(
        &path,
        &codex_line(
            "event_msg",
            json!({"type":"agent_message","message":"accepted answer"}),
        ),
    );
    let accepted = scan_all(SourceId::Codex, temp.path());
    assert_ne!(accepted.files[0].accepted_fingerprint, baseline_accepted);
    assert_ne!(accepted.snapshot.fingerprint, baseline_content);
}

#[test]
fn pi_coverage_fingerprint_ignores_private_append_and_tracks_late_accepted_events() {
    let temp = tempdir().unwrap();
    let root = temp.path().join("pi");
    fs::create_dir_all(&root).unwrap();
    let path = root.join("conversation.jsonl");
    write_lines(
        &path,
        &[
            json!({"type":"session","id":"pi-safe","cwd":"/safe/pi","timestamp":"2026-08-15T00:00:00Z"}).to_string(),
            json!({"type":"message","timestamp":"2026-08-15T00:00:01Z","message":{"role":"user","content":"first"}}).to_string(),
            json!({"type":"message","timestamp":"2026-08-15T00:00:02Z","message":{"role":"assistant","content":"second"}}).to_string(),
        ],
    );
    let baseline = scan_all(SourceId::Pi, &root);
    let baseline_size = baseline.files[0].size;
    let baseline_accepted = baseline.files[0].accepted_fingerprint.clone();
    let baseline_content = baseline.snapshot.fingerprint.clone();

    append(
        &path,
        &json!({"type":"message","timestamp":"2026-08-15T00:00:03Z","message":{"role":"toolResult","content":"private tool output"}}).to_string(),
    );
    let rejected = scan_all(SourceId::Pi, &root);
    assert!(rejected.files[0].size > baseline_size);
    assert_eq!(rejected.files[0].accepted_fingerprint, baseline_accepted);
    assert_eq!(rejected.snapshot.fingerprint, baseline_content);

    append(
        &path,
        &json!({"type":"message","timestamp":"2026-08-15T00:00:04Z","message":{"role":"user","content":"third accepted after old metadata limit"}}).to_string(),
    );
    let third = scan_all(SourceId::Pi, &root);
    assert_ne!(third.files[0].accepted_fingerprint, baseline_accepted);
    let third_fingerprint = third.snapshot.fingerprint.clone();

    append(
        &path,
        &json!({"type":"model_change","modelId":"accepted-model"}).to_string(),
    );
    let model = scan_all(SourceId::Pi, &root);
    assert_ne!(model.snapshot.fingerprint, third_fingerprint);
}

#[test]
fn claude_coverage_fingerprint_scans_past_64k_and_ignores_rejected_tail() {
    let temp = tempdir().unwrap();
    let root = temp.path().join("claude");
    fs::create_dir_all(&root).unwrap();
    let path = root.join("conversation.jsonl");
    write_lines(
        &path,
        &[
            json!({"type":"user","sessionId":"claude-safe","cwd":"/safe/claude","timestamp":"2026-08-15T00:00:00Z","message":{"content":"accepted baseline"}}).to_string(),
            json!({"type":"diagnostic","padding":"x".repeat(70 * 1024)}).to_string(),
        ],
    );
    let baseline = scan_all(SourceId::ClaudeCode, &root);
    assert!(baseline.files[0].size > 64 * 1024);
    let baseline_content = baseline.snapshot.fingerprint.clone();

    append(
        &path,
        &json!({"type":"assistant","isSidechain":true,"sessionId":"private","cwd":"/private","timestamp":"2026-08-15T00:00:01Z","message":{"content":"private tail"}}).to_string(),
    );
    let rejected = scan_all(SourceId::ClaudeCode, &root);
    assert_eq!(rejected.snapshot.fingerprint, baseline_content);

    append(
        &path,
        &json!({"type":"assistant","sessionId":"claude-safe","cwd":"/safe/claude","timestamp":"2026-08-15T00:00:02Z","message":{"content":"accepted beyond old metadata window"}}).to_string(),
    );
    let accepted = scan_all(SourceId::ClaudeCode, &root);
    assert_ne!(accepted.snapshot.fingerprint, baseline_content);
}

#[test]
fn read_limit_and_newline_boundary_exclude_partial_or_late_records() {
    let temp = tempdir().unwrap();
    let root = temp.path().join("2026/08/15");
    fs::create_dir_all(&root).unwrap();
    let path = root.join("rollout-2026-08-15T00-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl");
    let initial = format!(
        "{}\n{}\n",
        codex_line(
            "session_meta",
            json!({"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","cwd":"/safe"}),
        ),
        codex_line(
            "event_msg",
            json!({"type":"user_message","message":"bounded first"}),
        ),
    );
    fs::write(&path, &initial).unwrap();
    let initial_limit = initial.len() as u64;
    append(
        &path,
        &codex_line(
            "event_msg",
            json!({"type":"agent_message","message":"late complete must wait"}),
        ),
    );
    append_without_newline(
        &path,
        &codex_line(
            "event_msg",
            json!({"type":"agent_message","message":"partial tail must wait"}),
        ),
    );

    let scan = scan_all(SourceId::Codex, temp.path());
    let file = &scan.files[0];
    let bounded = expect_projected(project(file, initial_limit, None));
    assert_eq!(bounded.documents.len(), 1);
    assert_eq!(bounded.documents[0].message.content_text, "bounded first");
    assert_eq!(bounded.read_proof.requested_limit, initial_limit);
    assert_eq!(bounded.read_proof.byte_count, initial_limit);
    assert_eq!(bounded.read_proof.safe_offset, initial_limit);
    let initial_digest = hex::encode(Sha256::digest(initial.as_bytes()));
    assert_eq!(bounded.read_proof.content_fingerprint, initial_digest);
    assert_eq!(bounded.checkpoint.prefix_digest, initial_digest);

    let full = expect_projected(project(file, file.size, None));
    assert_eq!(
        full.documents
            .iter()
            .map(|document| document.message.content_text.as_str())
            .collect::<Vec<_>>(),
        ["bounded first", "late complete must wait"]
    );
    assert!(full.read_proof.byte_count > full.read_proof.safe_offset);
    assert_eq!(full.checkpoint.indexed_bytes, full.read_proof.safe_offset);
    assert_eq!(full.checkpoint.next_seq, 2);
}

#[test]
fn codex_checkpoint_projects_only_appended_documents_and_rejects_rewrites() {
    let temp = tempdir().unwrap();
    let root = temp.path().join("2026/08/15");
    fs::create_dir_all(&root).unwrap();
    let path = root.join("rollout-2026-08-15T00-00-00-cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl");
    let initial = format!(
        "{}\n{}\n",
        codex_line(
            "session_meta",
            json!({"id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","cwd":"/safe"}),
        ),
        codex_line(
            "event_msg",
            json!({"type":"user_message","message":"delta first message"}),
        ),
    );
    fs::write(&path, &initial).unwrap();
    let first_scan = scan_all(SourceId::Codex, temp.path());
    let full = expect_projected(project(
        &first_scan.files[0],
        first_scan.files[0].size,
        None,
    ));
    assert_eq!(full.mode, ProjectionMode::Full);
    assert_eq!(full.checkpoint.next_seq, 1);

    append(
        &path,
        &codex_line(
            "event_msg",
            json!({"type":"agent_message","message":"delta appended answer"}),
        ),
    );
    append(
        &path,
        &codex_line("compacted", json!({"message":"delta appended handoff"})),
    );
    let grown_scan = scan_all(SourceId::Codex, temp.path());
    let delta = expect_projected(project(
        &grown_scan.files[0],
        grown_scan.files[0].size,
        Some(&full.checkpoint),
    ));
    assert_eq!(delta.mode, ProjectionMode::Delta);
    assert_eq!(delta.documents.len(), 1);
    assert_eq!(delta.documents[0].message.seq, 1);
    assert_eq!(
        delta.documents[0].message.content_text,
        "delta appended answer"
    );
    assert_eq!(delta.session.document_count, 2);
    assert!(
        delta
            .session
            .compact_text
            .contains("delta appended handoff")
    );
    assert_eq!(delta.checkpoint.next_seq, 2);
    assert_eq!(delta.checkpoint.indexed_bytes, grown_scan.files[0].size);

    let rewritten = initial.replace("delta first message", "delta frost message");
    assert_eq!(rewritten.len(), initial.len());
    fs::write(&path, rewritten).unwrap();
    let rewritten_scan = scan_all(SourceId::Codex, temp.path());
    let outcome = project(
        &rewritten_scan.files[0],
        rewritten_scan.files[0].size,
        Some(&full.checkpoint),
    );
    assert!(matches!(
        outcome,
        ProjectionOutcome::FullRequired {
            reason: FullProjectionReason::PrefixChanged,
            ..
        }
    ));
}

#[test]
fn dsh_adapter_accepts_real_messages_and_rejects_injected_context() {
    let temp = tempdir().unwrap();
    let root = temp.path().join("dsh");
    fs::create_dir_all(&root).unwrap();
    let session_dir = root.join("session-dsh-safe");
    fs::create_dir_all(&session_dir).unwrap();
    let file = session_dir.join("session.jsonl.zstd");
    write_zstd_lines(
        &file,
        &[
            json!({"type":"session","version":0,"id":"session-dsh-safe","createdAt":1786870711696i64,"cwd":"/safe/dsh"}).to_string(),
            json!({"type":"session/title","seq":1,"time":1786870711696i64,"data":{"title":"accepted dsh title"}}).to_string(),
            json!({"type":"request/header","seq":2,"time":1786870711696i64,"data":{"header":{"config":{"model":"deepseek-v4-flash"}}}}).to_string(),
            json!({"type":"session/title","seq":7,"time":1786870711701i64,"data":{"title":"refined dsh title"}}).to_string(),
            json!({"type":"request/header","seq":8,"time":1786870711702i64,"data":{"header":{"config":{"model":"deepseek-v4-pro"}}}}).to_string(),
            json!({"type":"user/message","seq":3,"time":1786870711697i64,"data":{"source":{"kind":"user"},"role":"user","content":[{"type":"text","text":"accepted dsh user"}]}}).to_string(),
            json!({"type":"user/message","seq":4,"time":1786870711698i64,"data":{"source":{"kind":"plugin"},"role":"user","content":[{"type":"text","text":"plugin context must not leak"}]}}).to_string(),
            json!({"type":"user/message","seq":5,"time":1786870711699i64,"data":{"source":{"kind":"skill-catalog"},"role":"user","content":[{"type":"text","text":"skill catalog must not leak"}]}}).to_string(),
            json!({"type":"user/message","seq":5,"time":1786870711712i64,"data":{"source":{"kind":"agent-instructions"},"role":"user","content":[{"type":"text","text":"agent instructions must not leak"}]}}).to_string(),
            json!({"type":"assistant/message","seq":6,"time":1786870711700i64,"data":{"message":{"role":"assistant","content":[{"type":"reasoning","text":"reasoning must not leak"},{"type":"text","text":"accepted dsh assistant"},{"type":"tool-call","name":"bash","arguments":"tool call must not leak"}]}}}).to_string(),
        ],
    );

    let scan = scan_all(SourceId::Dsh, &root);
    assert_eq!(scan.files.len(), 1);
    let projected = expect_projected(project(&scan.files[0], scan.files[0].size, None));
    assert_eq!(projected.session.source_id, SourceId::Dsh);
    assert_eq!(projected.session.native_session_id, "session-dsh-safe");
    assert_eq!(projected.session.cwd, "/safe/dsh");
    // Latest wins: refined titles and mid-session model switches supersede
    // the first records.
    assert_eq!(projected.session.model, "deepseek-v4-pro");
    assert_eq!(projected.session.title, "refined dsh title");
    assert!(projected.read_proof.stable());
    assert_eq!(projected.read_proof.safe_offset, scan.files[0].size);
    assert!(
        projected
            .documents
            .iter()
            .all(|document| document.raw_start == 0 && document.raw_end == 0)
    );

    let searchable = serde_json::to_string(&projected).unwrap();
    for accepted in [
        "accepted dsh user",
        "accepted dsh assistant",
        "refined dsh title",
    ] {
        assert!(searchable.contains(accepted), "DSH lost {accepted}");
    }
    for rejected in [
        // Superseded by the later refined title.
        "accepted dsh title",
        "plugin context must not leak",
        "skill catalog must not leak",
        "agent instructions must not leak",
        "reasoning must not leak",
        "tool call must not leak",
    ] {
        assert!(!searchable.contains(rejected), "DSH leaked {rejected}");
    }
}

#[test]
fn dsh_adapter_rejects_incomplete_records() {
    let temp = tempdir().unwrap();
    let root = temp.path().join("dsh");
    let session_dir = root.join("session-dsh-incomplete");
    fs::create_dir_all(&session_dir).unwrap();
    let file = session_dir.join("session.jsonl.zstd");
    write_zstd_lines(
        &file,
        &[
            // Missing createdAt: the session record is rejected, so identity
            // and cwd must fall back instead of carrying an empty timestamp.
            json!({"type":"session","version":0,"id":"session-dsh-incomplete","cwd":"/incomplete/dsh"}).to_string(),
            // Missing record time: incomplete messages are rejected.
            json!({"type":"user/message","seq":1,"data":{"source":{"kind":"user"},"role":"user","content":[{"type":"text","text":"timeless user must not project"}]}}).to_string(),
            json!({"type":"assistant/message","seq":2,"data":{"message":{"role":"assistant","content":[{"type":"text","text":"timeless assistant must not project"}]}}}).to_string(),
            json!({"type":"user/message","seq":3,"time":1786870711697i64,"data":{"source":{"kind":"user"},"role":"user","content":[{"type":"text","text":"complete dsh user"}]}}).to_string(),
        ],
    );

    let scan = scan_all(SourceId::Dsh, &root);
    assert_eq!(scan.files.len(), 1);
    assert!(scan.files[0].cwd.is_empty());
    let projected = expect_projected(project(&scan.files[0], scan.files[0].size, None));
    // Without a session record the native id falls back to the session
    // directory name, not the constant file stem "session.jsonl".
    assert_eq!(
        projected.session.native_session_id,
        "session-dsh-incomplete"
    );
    assert!(projected.session.cwd.is_empty());
    assert_eq!(projected.documents.len(), 1);
    assert_eq!(
        projected.documents[0].message.timestamp,
        "2026-08-16T08:58:31.697Z"
    );
    assert_eq!(projected.session.started_at, "2026-08-16T08:58:31.697Z");

    let searchable = serde_json::to_string(&projected).unwrap();
    assert!(searchable.contains("complete dsh user"));
    for rejected in [
        "timeless user must not project",
        "timeless assistant must not project",
        "/incomplete/dsh",
    ] {
        assert!(!searchable.contains(rejected), "DSH leaked {rejected}");
    }
}

#[test]
fn dsh_adapter_tolerates_torn_final_frame() {
    let temp = tempdir().unwrap();
    let root = temp.path().join("dsh");
    let session_dir = root.join("session-dsh-torn");
    fs::create_dir_all(&session_dir).unwrap();
    let file = session_dir.join("session.jsonl.zstd");
    // A large final record forces the earlier records into completed zstd
    // blocks, so truncating the frame tail leaves a decodable line prefix.
    let padding = "x".repeat(200_000);
    write_zstd_lines(
        &file,
        &[
            json!({"type":"session","version":0,"id":"session-dsh-torn","createdAt":1786870711696i64,"cwd":"/torn/dsh"}).to_string(),
            json!({"type":"user/message","seq":1,"time":1786870711697i64,"data":{"source":{"kind":"user"},"role":"user","content":[{"type":"text","text":"torn prefix user"}]}}).to_string(),
            json!({"type":"assistant/message","seq":2,"time":1786870711698i64,"data":{"message":{"role":"assistant","content":[{"type":"text","text":padding}]}}}).to_string(),
        ],
    );
    // Simulate an interrupted in-flight write: cut the compressed frame tail.
    let bytes = fs::read(&file).unwrap();
    fs::write(&file, &bytes[..bytes.len() - 7]).unwrap();

    let scan = scan_all(SourceId::Dsh, &root);
    assert_eq!(scan.files.len(), 1);
    assert!(scan.failures.is_empty());
    let projected = expect_projected(project(&scan.files[0], scan.files[0].size, None));
    let searchable = serde_json::to_string(&projected).unwrap();
    assert!(searchable.contains("torn prefix user"));
    assert!(!searchable.contains(&padding));
}

#[test]
fn dsh_adapter_rejects_corrupt_frame_header() {
    let temp = tempdir().unwrap();
    let root = temp.path().join("dsh");
    let session_dir = root.join("session-dsh-corrupt");
    fs::create_dir_all(&session_dir).unwrap();
    let file = session_dir.join("session.jsonl.zstd");
    write_zstd_lines(
        &file,
        &[
            json!({"type":"session","version":0,"id":"session-dsh-corrupt","createdAt":1786870711696i64,"cwd":"/corrupt/dsh"}).to_string(),
            json!({"type":"user/message","seq":1,"time":1786870711697i64,"data":{"source":{"kind":"user"},"role":"user","content":[{"type":"text","text":"corrupt frame must not project"}]}}).to_string(),
        ],
    );
    // Corrupt the frame header (past the 4-byte magic): not a torn tail, so
    // the failure must stay hard and surface as a scan failure.
    let mut bytes = fs::read(&file).unwrap();
    bytes[5] ^= 0xFF;
    fs::write(&file, &bytes).unwrap();

    let scan = scan_all(SourceId::Dsh, &root);
    assert!(scan.files.is_empty());
    assert_eq!(scan.failures.len(), 1);
}

#[test]
fn accepted_digest_does_not_weaken_private_prefix_rewrite_detection() {
    let temp = tempdir().unwrap();
    let root = temp.path().join("2026/08/15");
    fs::create_dir_all(&root).unwrap();
    let path = root.join("rollout-private-prefix.jsonl");
    let private_a = codex_line(
        "response_item",
        json!({"type":"function_call","arguments":"private-aaa"}),
    );
    let private_b = private_a.replace("private-aaa", "private-bbb");
    assert_eq!(private_a.len(), private_b.len());
    write_lines(
        &path,
        &[
            private_a.clone(),
            codex_line(
                "event_msg",
                json!({"type":"user_message","message":"stable searchable message"}),
            ),
        ],
    );
    let initial_scan = scan_all(SourceId::Codex, temp.path());
    let initial_fingerprint = initial_scan.snapshot.fingerprint.clone();
    let full = expect_projected(project(
        &initial_scan.files[0],
        initial_scan.files[0].size,
        None,
    ));

    write_lines(
        &path,
        &[
            private_b,
            codex_line(
                "event_msg",
                json!({"type":"user_message","message":"stable searchable message"}),
            ),
        ],
    );
    let rewritten = scan_all(SourceId::Codex, temp.path());
    assert_eq!(rewritten.snapshot.fingerprint, initial_fingerprint);
    assert!(matches!(
        project(
            &rewritten.files[0],
            rewritten.files[0].size,
            Some(&full.checkpoint),
        ),
        ProjectionOutcome::FullRequired {
            reason: FullProjectionReason::PrefixChanged,
            ..
        }
    ));
}

#[test]
fn fallback_identity_uses_full_path_not_only_shared_file_name() {
    let temp = tempdir().unwrap();
    for (directory, text) in [("alpha", "alpha fallback"), ("beta", "beta fallback")] {
        let parent = temp.path().join(directory);
        fs::create_dir_all(&parent).unwrap();
        write_lines(
            &parent.join("conversation.jsonl"),
            &[json!({"type":"user","cwd":format!("/{directory}"),"timestamp":"2026-08-15T00:00:00Z","message":{"content":text}}).to_string()],
        );
    }
    let scan = scan_all(SourceId::ClaudeCode, temp.path());
    assert_eq!(scan.files.len(), 2);
    let identities = scan
        .files
        .iter()
        .map(|file| {
            expect_projected(project(file, file.size, None))
                .session
                .native_session_id
        })
        .collect::<Vec<_>>();
    assert_ne!(identities[0], identities[1]);
    assert!(
        identities
            .iter()
            .all(|identity| identity.starts_with("conversation-"))
    );
}

#[test]
fn codex_short_file_name_uses_fallback_without_panicking() {
    let temp = tempdir().unwrap();
    let path = temp.path().join("x.jsonl");
    write_lines(
        &path,
        &[codex_line(
            "event_msg",
            json!({"type":"user_message","message":"short filename fallback"}),
        )],
    );

    let scan = scan_all(SourceId::Codex, temp.path());
    assert_eq!(scan.files.len(), 1);
    let projected = expect_projected(project(&scan.files[0], scan.files[0].size, None));
    assert!(projected.session.native_session_id.starts_with("x-"));
    assert_eq!(
        projected.documents[0].message.content_text,
        "short filename fallback"
    );
}

fn repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn scan_all(source_id: SourceId, root: &Path) -> super::SourceScan {
    SourceCatalog
        .scan(
            &Selector::All {
                source: source_id,
                root: root.to_string_lossy().into_owned(),
            },
            &SourceMetadataCache::default(),
        )
        .unwrap()
}

fn project(
    file: &SourceFile,
    read_limit: u64,
    checkpoint: Option<&super::ProjectionCheckpoint>,
) -> ProjectionOutcome {
    SourceCatalog.project(file, read_limit, checkpoint).unwrap()
}

fn expect_projected(outcome: ProjectionOutcome) -> ProjectedSource {
    match outcome {
        ProjectionOutcome::Projected(projected) => *projected,
        other => panic!("expected projected source, got {other:?}"),
    }
}

fn codex_line(record_type: &str, payload: Value) -> String {
    json!({
        "timestamp": "2026-08-15T00:00:00.000Z",
        "type": record_type,
        "payload": payload,
    })
    .to_string()
}

fn write_lines(path: &Path, lines: &[String]) {
    fs::write(path, format!("{}\n", lines.join("\n"))).unwrap();
}

fn append(path: &Path, line: &str) {
    let mut file = OpenOptions::new().append(true).open(path).unwrap();
    writeln!(file, "{line}").unwrap();
}

fn append_without_newline(path: &Path, line: &str) {
    let mut file = OpenOptions::new().append(true).open(path).unwrap();
    write!(file, "{line}").unwrap();
}
