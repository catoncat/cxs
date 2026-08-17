use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};
use tempfile::TempDir;

use crate::cli::{
    DatabaseArg, FindArgs, FindSort as CliFindSort, ListArgs, ListSort, ReadPageArgs, StatsArgs,
    StatusArgs,
};
use crate::cold::{add_cold_root, cold_roots_path_for_db};
use crate::config::{INDEX_VERSION, ResolvedPaths};
use crate::identity::{SessionIdentity, SourceId};
use crate::index::{
    ANALYZER_EPOCH, COVERAGE_EPOCH, CoverageWrite, IndexWriter, MessageWrite, PROJECTION_EPOCH,
    SessionWrite, SourceFileState,
};
use crate::migration::ColdConfigFence;
use crate::model::MessageRole;
use crate::runner::{AppServices, run_from_with_services};
use crate::selector::Selector;
use crate::sources::{
    ProjectionCheckpoint, SourceCatalog, SourceFile, SourceMetadataCache, inject_metadata_failure,
};

use super::NativeAppServices;

fn resolved_paths(directory: &TempDir, raw_root: &Path) -> ResolvedPaths {
    let data_dir = directory.path().join("state");
    ResolvedPaths {
        db_path: data_dir.join("index.sqlite"),
        data_dir,
        default_codex_dir: raw_root.to_path_buf(),
        default_claude_code_dir: directory.path().join("missing-claude"),
        default_pi_dir: directory.path().join("missing-pi"),
        default_dsh_dir: directory.path().join("missing-dsh"),
        legacy_data_dirs: vec![],
    }
}

fn seed_index(path: &Path, raw_root: &Path) {
    let root = raw_root.to_string_lossy().into_owned();
    seed_index_with_coverage(
        path,
        raw_root,
        Selector::All {
            source: SourceId::Codex,
            root,
        },
    );
}

fn seed_index_with_coverage(path: &Path, raw_root: &Path, coverage_selector: Selector) {
    let root = raw_root.to_string_lossy().into_owned();
    let session = SessionWrite {
        identity: SessionIdentity::new(SourceId::Codex, "native-session"),
        session_uuid: "compat-session".to_owned(),
        file_path: raw_root
            .join("deleted.jsonl")
            .to_string_lossy()
            .into_owned(),
        source_root: root.clone(),
        title: "Contract beacon".to_owned(),
        summary_text: "stored search projection".to_owned(),
        compact_text: "compact evidence".to_owned(),
        reasoning_summary_text: String::new(),
        cwd: "/repo".to_owned(),
        model: "test".to_owned(),
        started_at: "2020-01-01T00:00:00Z".to_owned(),
        ended_at: "2020-01-01T00:01:00Z".to_owned(),
        path_date: "2020-01-01".to_owned(),
        raw_file_mtime: 1,
        raw_file_size: 1,
        index_version: INDEX_VERSION.to_owned(),
    };
    let messages = [
        MessageWrite {
            seq: 0,
            role: MessageRole::User,
            timestamp: "2020-01-01T00:00:00Z".to_owned(),
            source_kind: "event_msg".to_owned(),
            body_text: "contract shared beacon 汉".to_owned(),
            raw_start: Some(0),
            raw_end: Some(10),
            projection_epoch: PROJECTION_EPOCH,
        },
        MessageWrite {
            seq: 1,
            role: MessageRole::Assistant,
            timestamp: "2020-01-01T00:01:00Z".to_owned(),
            source_kind: "event_msg".to_owned(),
            body_text: "answer from the immutable index".to_owned(),
            raw_start: Some(10),
            raw_end: Some(20),
            projection_epoch: PROJECTION_EPOCH,
        },
    ];
    let mut writer = IndexWriter::create_v8(path).unwrap();
    let mut transaction = writer.begin().unwrap();
    transaction.replace_session(&session, &messages).unwrap();
    transaction
        .replace_coverage(&CoverageWrite {
            selector: coverage_selector,
            source_fingerprint: "content".to_owned(),
            source_file_set_fingerprint: "files".to_owned(),
            source_file_count: 1,
            indexed_session_count: 1,
            indexed_document_count: 3,
            source_generation: "test".to_owned(),
            completed_at: Some("2020-01-01T00:02:00Z".to_owned()),
            index_version: INDEX_VERSION.to_owned(),
            projection_epoch: PROJECTION_EPOCH,
            analyzer_epoch: ANALYZER_EPOCH,
            coverage_epoch: COVERAGE_EPOCH,
        })
        .unwrap();
    transaction.commit().unwrap();
}

fn append_indexed_session(
    path: &Path,
    raw_root: &Path,
    source: SourceId,
    native_session_id: &str,
    session_uuid: &str,
    body: &str,
) {
    let session = SessionWrite {
        identity: SessionIdentity::new(source, native_session_id),
        session_uuid: session_uuid.to_owned(),
        file_path: raw_root
            .join(format!("{native_session_id}.jsonl"))
            .to_string_lossy()
            .into_owned(),
        source_root: raw_root.to_string_lossy().into_owned(),
        title: "Experimental self hit".to_owned(),
        summary_text: String::new(),
        compact_text: String::new(),
        reasoning_summary_text: String::new(),
        cwd: "/repo".to_owned(),
        model: "test".to_owned(),
        started_at: "2020-01-02T00:00:00Z".to_owned(),
        ended_at: "2020-01-02T00:01:00Z".to_owned(),
        path_date: "2020-01-02".to_owned(),
        raw_file_mtime: 2,
        raw_file_size: 2,
        index_version: INDEX_VERSION.to_owned(),
    };
    let messages = [MessageWrite {
        seq: 0,
        role: MessageRole::User,
        timestamp: "2020-01-02T00:00:00Z".to_owned(),
        source_kind: "event_msg".to_owned(),
        body_text: body.to_owned(),
        raw_start: Some(0),
        raw_end: Some(body.len() as u64),
        projection_epoch: PROJECTION_EPOCH,
    }];
    let mut writer = IndexWriter::open_v8(path).unwrap();
    let mut transaction = writer.begin().unwrap();
    transaction.replace_session(&session, &messages).unwrap();
    transaction.commit().unwrap();
}

fn json_output(
    call: impl FnOnce(&mut Vec<u8>, &mut Vec<u8>) -> Result<(), crate::error::AppError>,
) -> serde_json::Value {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    call(&mut stdout, &mut stderr).unwrap();
    assert!(stderr.is_empty());
    serde_json::from_slice(&stdout).unwrap()
}

fn write_codex_session(path: &Path, id: &str, messages: &[(&str, &str)]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut lines = vec![
        serde_json::json!({
            "timestamp": "2026-08-15T00:00:00Z",
            "type": "session_meta",
            "payload": {"id": id, "cwd": "/repo"},
        })
        .to_string(),
    ];
    for (index, (kind, message)) in messages.iter().enumerate() {
        lines.push(
            serde_json::json!({
                "timestamp": format!("2026-08-15T00:00:{:02}Z", index + 1),
                "type": "event_msg",
                "payload": {"type": kind, "message": message},
            })
            .to_string(),
        );
    }
    std::fs::write(path, format!("{}\n", lines.join("\n"))).unwrap();
}

fn write_dsh_zstd_session(path: &Path, id: &str, messages: &[(&str, &str)]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut lines = vec![
        serde_json::json!({
            "type": "session",
            "version": 0,
            "id": id,
            "createdAt": 1786870711696i64,
            "cwd": "/repo",
        })
        .to_string(),
        serde_json::json!({
            "type": "session/title",
            "seq": 0,
            "time": 1786870711696i64,
            "data": {"title": "dsh e2e title"},
        })
        .to_string(),
    ];
    for (index, (kind, message)) in messages.iter().enumerate() {
        let time = 1786870711696i64 + (index as i64 + 1) * 1000;
        if *kind == "user" {
            lines.push(
                serde_json::json!({
                    "type": "user/message",
                    "seq": index + 1,
                    "time": time,
                    "data": {
                        "source": {"kind": "user"},
                        "role": "user",
                        "content": [{"type": "text", "text": message}],
                    },
                })
                .to_string(),
            );
        } else {
            lines.push(
                serde_json::json!({
                    "type": "assistant/message",
                    "seq": index + 1,
                    "time": time,
                    "data": {
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": message}],
                        }
                    },
                })
                .to_string(),
            );
        }
    }
    crate::sources::write_zstd_lines(path, &lines);
}

fn cached_source_file_state(file: &SourceFile, root: &Path) -> SourceFileState {
    SourceFileState {
        source_id: file.source_id,
        file_path: file.file_path.to_string_lossy().into_owned(),
        source_root: root.to_string_lossy().into_owned(),
        source_generation: "cached-status-fixture".to_owned(),
        mtime_ms: file.mtime_ms,
        mtime_ns: Some(i64::try_from(file.mtime_ns).unwrap()),
        size: file.size,
        indexed_bytes: 0,
        head_digest: String::new(),
        boundary_digest: String::new(),
        next_seq: 0,
        reducer_checkpoint: Some(
            serde_json::to_vec(&ProjectionCheckpoint {
                source_id: file.source_id,
                file_identity: file.identity.clone(),
                indexed_bytes: 0,
                prefix_digest: String::new(),
                next_seq: 0,
                reducer_state: String::new(),
            })
            .unwrap(),
        ),
        cwd: file.cwd.clone(),
        path_date: file.path_date.clone(),
        extra_fingerprint: file.accepted_fingerprint.clone(),
        projection_epoch: PROJECTION_EPOCH,
        analyzer_epoch: ANALYZER_EPOCH,
        coverage_epoch: COVERAGE_EPOCH,
        session: None,
    }
}

fn run_cli(services: &mut NativeAppServices, args: Vec<String>) -> (u8, Vec<u8>, Vec<u8>) {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let code = run_from_with_services(args, services, &mut stdout, &mut stderr);
    (code, stdout, stderr)
}

fn has_imported_cold_backup(config_path: &Path) -> bool {
    let fence = ColdConfigFence::inspect(config_path).unwrap();
    fence.is_published()
        && fence
            .recovery_backup_path()
            .is_some_and(|path| path.is_file())
}

fn assert_published_cold_fence(config_path: &Path) {
    assert!(
        std::fs::symlink_metadata(config_path)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(
        ColdConfigFence::inspect(config_path)
            .unwrap()
            .is_published()
    );
}

fn create_v7_index(db: &Path, raw: &Path, id: &str, root: &Path) {
    let connection = Connection::open(db).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE sessions (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               source_id TEXT NOT NULL DEFAULT 'codex',
               native_session_id TEXT NOT NULL DEFAULT '',
               session_key TEXT NOT NULL UNIQUE,
               session_uuid TEXT NOT NULL,
               file_path TEXT NOT NULL,
               source_root TEXT NOT NULL DEFAULT '',
               title TEXT NOT NULL DEFAULT '',
               summary_text TEXT NOT NULL DEFAULT '',
               compact_text TEXT NOT NULL DEFAULT '',
               reasoning_summary_text TEXT NOT NULL DEFAULT '',
               cwd TEXT NOT NULL DEFAULT '',
               model TEXT NOT NULL DEFAULT '',
               started_at TEXT NOT NULL,
               ended_at TEXT NOT NULL,
               path_date TEXT NOT NULL DEFAULT '',
               message_count INTEGER NOT NULL DEFAULT 0,
               raw_file_mtime INTEGER NOT NULL DEFAULT 0,
               raw_file_size INTEGER NOT NULL DEFAULT 0,
               index_version TEXT NOT NULL DEFAULT '',
               updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               UNIQUE(source_id, native_session_id),
               UNIQUE(source_id, file_path)
             );
             CREATE TABLE messages (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
               session_uuid TEXT NOT NULL,
               seq INTEGER NOT NULL,
               role TEXT NOT NULL,
               content_text TEXT NOT NULL,
               timestamp TEXT NOT NULL,
               source_kind TEXT NOT NULL,
               UNIQUE(session_id, seq)
             );
             PRAGMA user_version = 7;",
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO sessions(
               source_id, native_session_id, session_key, session_uuid, file_path, source_root,
               title, summary_text, compact_text, reasoning_summary_text, cwd, model,
               started_at, ended_at, path_date, message_count, raw_file_mtime,
               raw_file_size, index_version
             ) VALUES ('codex', ?, ?, ?, ?, ?, 'Legacy session', 'legacy summary',
                       'legacy compact', '', '/repo', 'test', ?, ?, '2026-08-15', 1,
                       1, 1, 'shlog-v7-source-identity')",
            params![
                id,
                format!("codex:{id}"),
                id,
                raw.to_string_lossy(),
                root.to_string_lossy(),
                "2026-08-15T00:00:00Z",
                "2026-08-15T00:00:01Z",
            ],
        )
        .unwrap();
    let session_id = connection.last_insert_rowid();
    connection
        .execute(
            "INSERT INTO messages(session_id, session_uuid, seq, role, content_text, timestamp, source_kind)
             VALUES (?, ?, 0, 'user', 'legacy evidence', '2026-08-15T00:00:01Z', 'event_msg')",
            params![session_id, id],
        )
        .unwrap();
}

#[test]
fn query_commands_read_only_sqlite_after_raw_files_disappear() {
    let directory = TempDir::new().unwrap();
    let raw_root = directory.path().join("raw-that-does-not-exist");
    let paths = resolved_paths(&directory, &raw_root);
    std::fs::create_dir_all(&paths.data_dir).unwrap();
    seed_index(&paths.db_path, &raw_root);
    assert!(!raw_root.exists());
    let mut services = NativeAppServices::new(paths.clone(), PathBuf::from("/repo"));

    let find = json_output(|stdout, stderr| {
        services.find(
            &FindArgs {
                query: "contract shared beacon".to_owned(),
                source: Some("codex".to_owned()),
                limit: 10,
                root: None,
                selector: None,
                cwd: None,
                sort: CliFindSort::Relevance,
                exclude_session: vec![],
                database: DatabaseArg {
                    db: paths.db_path.clone(),
                },
                json: true,
            },
            stdout,
            stderr,
        )
    });
    assert_eq!(find["results"][0]["sessionRef"], "compat-session");
    assert_eq!(find["results"][0]["evidenceRead"]["kind"], "read-range");
    assert_eq!(find["coverage"]["freshness"], "not_checked");
    assert!(find["elapsedMs"].is_u64());

    let page = json_output(|stdout, stderr| {
        services.read_page(
            &ReadPageArgs {
                session_ref: "native-session".to_owned(),
                source: None,
                offset: 0,
                limit: 1,
                max_message_chars: 800,
                database: DatabaseArg {
                    db: paths.db_path.clone(),
                },
                json: true,
            },
            stdout,
            stderr,
        )
    });
    assert_eq!(page["messages"].as_array().unwrap().len(), 1);
    assert_eq!(page["hasMore"], true);

    let listed = json_output(|stdout, stderr| {
        services.list(
            &ListArgs {
                source: Some("codex".to_owned()),
                cwd: None,
                since: None,
                root: None,
                selector: None,
                sort: ListSort::Messages,
                limit: 10,
                database: DatabaseArg {
                    db: paths.db_path.clone(),
                },
                json: true,
            },
            stdout,
            stderr,
        )
    });
    assert_eq!(listed["results"].as_array().unwrap().len(), 1);

    let stats = json_output(|stdout, stderr| {
        services.stats(
            &StatsArgs {
                source: Some("codex".to_owned()),
                database: DatabaseArg {
                    db: paths.db_path.clone(),
                },
                json: true,
            },
            stdout,
            stderr,
        )
    });
    assert_eq!(stats["sessionCount"], 1);
    assert_eq!(stats["messageCount"], 2);
}

#[test]
fn find_exclusions_resolve_qualified_and_experimental_native_session_ids() {
    let directory = TempDir::new().unwrap();
    let raw_root = directory.path().join("sessions");
    let paths = resolved_paths(&directory, &raw_root);
    std::fs::create_dir_all(&paths.data_dir).unwrap();
    seed_index(&paths.db_path, &raw_root);
    append_indexed_session(
        &paths.db_path,
        &raw_root,
        SourceId::ClaudeCode,
        "claude-native-session",
        "claude-visible-uuid",
        "contract shared beacon",
    );
    let db = paths.db_path.to_string_lossy().into_owned();
    let mut services = NativeAppServices::new(paths, directory.path().to_path_buf());

    let (code, stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "find".to_owned(),
            "contract shared beacon".to_owned(),
            "--source".to_owned(),
            "codex".to_owned(),
            "--exclude-session".to_owned(),
            "codex:native-session".to_owned(),
            "--db".to_owned(),
            db.clone(),
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    let codex: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(
        codex["excludedSessions"],
        serde_json::json!(["codex:native-session"])
    );
    assert_eq!(codex["results"], serde_json::json!([]));

    let (code, stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "find".to_owned(),
            "contract shared beacon".to_owned(),
            "--source".to_owned(),
            "claude-code".to_owned(),
            "--exclude-session".to_owned(),
            "claude-native-session".to_owned(),
            "--db".to_owned(),
            db,
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    let claude: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(
        claude["excludedSessions"],
        serde_json::json!(["claude-native-session"])
    );
    assert_eq!(claude["results"], serde_json::json!([]));
}

#[test]
fn unscoped_find_and_list_do_not_treat_narrow_coverage_as_complete() {
    let directory = TempDir::new().unwrap();
    let raw_root = directory.path().join("sessions");
    let paths = resolved_paths(&directory, &raw_root);
    std::fs::create_dir_all(&paths.data_dir).unwrap();
    seed_index_with_coverage(
        &paths.db_path,
        &raw_root,
        Selector::Cwd {
            source: SourceId::Codex,
            root: raw_root.to_string_lossy().into_owned(),
            cwd: "/repo".to_owned(),
        },
    );
    let mut services = NativeAppServices::new(paths.clone(), PathBuf::from("/repo"));

    let found = json_output(|stdout, stderr| {
        services.find(
            &FindArgs {
                query: "contract shared beacon".to_owned(),
                source: Some("codex".to_owned()),
                limit: 10,
                root: None,
                selector: None,
                cwd: None,
                sort: CliFindSort::Relevance,
                exclude_session: vec![],
                database: DatabaseArg {
                    db: paths.db_path.clone(),
                },
                json: true,
            },
            stdout,
            stderr,
        )
    });
    assert_eq!(found["coverage"]["requested"]["kind"], "all");
    assert_eq!(found["coverage"]["complete"], false);
    assert_eq!(
        found["coverage"]["coveringSelectors"],
        serde_json::json!([])
    );

    let listed = json_output(|stdout, stderr| {
        services.list(
            &ListArgs {
                source: Some("codex".to_owned()),
                cwd: None,
                since: None,
                root: None,
                selector: None,
                sort: ListSort::Ended,
                limit: 10,
                database: DatabaseArg {
                    db: paths.db_path.clone(),
                },
                json: true,
            },
            stdout,
            stderr,
        )
    });
    assert_eq!(listed["coverage"]["requested"], serde_json::Value::Null);
    assert_eq!(listed["coverage"]["complete"], false);
    assert_eq!(
        listed["coverage"]["coveringSelectors"],
        serde_json::json!([])
    );
}

#[test]
fn unscoped_find_searches_the_canonical_default_root_only() {
    let directory = TempDir::new().unwrap();
    let root = directory.path().join("sessions");
    let secondary = directory.path().join("secondary-sessions");
    let default_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let secondary_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    write_codex_session(
        &root
            .join("2026/08/15")
            .join(format!("rollout-2026-08-15T00-00-00-{default_id}.jsonl")),
        default_id,
        &[("user_message", "needle only in default root")],
    );
    write_codex_session(
        &secondary
            .join("2026/08/15")
            .join(format!("rollout-2026-08-15T00-00-00-{secondary_id}.jsonl")),
        secondary_id,
        &[("user_message", "needle only in secondary root")],
    );
    let paths = resolved_paths(&directory, &root);
    let mut services = NativeAppServices::new(paths.clone(), directory.path().to_path_buf());

    let mut sync = |target: &Path| {
        let (code, _stdout, stderr) = run_cli(
            &mut services,
            vec![
                "shlog".to_owned(),
                "sync".to_owned(),
                "--source".to_owned(),
                "codex".to_owned(),
                "--root".to_owned(),
                target.to_string_lossy().into_owned(),
                "--db".to_owned(),
                paths.db_path.to_string_lossy().into_owned(),
                "--json".to_owned(),
            ],
        );
        assert_eq!(code, 0);
        assert!(stderr.is_empty());
    };
    sync(&root);
    sync(&secondary);

    let find_args = |root: Option<&Path>| FindArgs {
        query: "needle".to_owned(),
        source: Some("codex".to_owned()),
        limit: 10,
        root: root.map(Path::to_path_buf),
        selector: None,
        cwd: None,
        sort: CliFindSort::Relevance,
        exclude_session: vec![],
        database: DatabaseArg {
            db: paths.db_path.clone(),
        },
        json: true,
    };

    let unscoped = json_output(|stdout, stderr| services.find(&find_args(None), stdout, stderr));
    let refs = unscoped["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|result| result["sessionRef"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(refs, vec![default_id.to_owned()]);
    assert_eq!(unscoped["scannedMessageCount"], serde_json::json!(1));
    assert_eq!(
        unscoped["coverage"]["requested"]["root"],
        serde_json::json!(root.to_string_lossy())
    );

    let scoped =
        json_output(|stdout, stderr| services.find(&find_args(Some(&secondary)), stdout, stderr));
    let refs = scoped["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|result| result["sessionRef"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(refs, vec![secondary_id.to_owned()]);
    assert_eq!(
        scoped["coverage"]["requested"]["root"],
        serde_json::json!(secondary.to_string_lossy())
    );
}

#[test]
fn single_cjk_find_and_read_range_use_bounded_like_recall() {
    let directory = TempDir::new().unwrap();
    let raw_root = directory.path().join("sessions");
    let paths = resolved_paths(&directory, &raw_root);
    std::fs::create_dir_all(&paths.data_dir).unwrap();
    seed_index(&paths.db_path, &raw_root);
    let db = paths.db_path.to_string_lossy().into_owned();
    let root = raw_root.to_string_lossy().into_owned();
    let mut services = NativeAppServices::new(paths, PathBuf::from("/repo"));

    let (code, stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "find".to_owned(),
            "汉".to_owned(),
            "--source".to_owned(),
            "codex".to_owned(),
            "--root".to_owned(),
            root,
            "--db".to_owned(),
            db.clone(),
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    let found: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(found["results"][0]["sessionRef"], "compat-session");
    assert_eq!(found["results"][0]["evidenceRead"]["kind"], "read-range");
    assert_eq!(found["results"][0]["evidenceRead"]["seq"], 0);

    let (code, stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "find".to_owned(),
            "汉".to_owned(),
            "--source".to_owned(),
            "codex".to_owned(),
            "--exclude-session".to_owned(),
            "compat-session".to_owned(),
            "--db".to_owned(),
            db.clone(),
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    let excluded: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(excluded["results"], serde_json::json!([]));

    let (code, stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "read-range".to_owned(),
            "native-session".to_owned(),
            "--query".to_owned(),
            "汉".to_owned(),
            "--before".to_owned(),
            "0".to_owned(),
            "--after".to_owned(),
            "0".to_owned(),
            "--db".to_owned(),
            db,
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    let range: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(range["anchorSeq"], 0);
    assert_eq!(
        range["messages"][0]["contentText"],
        "contract shared beacon 汉"
    );
}

#[test]
fn native_sync_handles_first_noop_append_and_imports_pending_cold_roots() {
    let directory = TempDir::new().unwrap();
    let root = directory.path().join("sessions");
    let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let raw = root
        .join("2026/08/15")
        .join(format!("rollout-2026-08-15T00-00-00-{id}.jsonl"));
    write_codex_session(&raw, id, &[("user_message", "initial evidence")]);
    let cold_root = directory.path().join("cold");
    std::fs::create_dir_all(&cold_root).unwrap();
    let claude_cold_root = directory.path().join("claude-cold");
    std::fs::create_dir_all(&claude_cold_root).unwrap();
    let paths = resolved_paths(&directory, &root);
    let config = cold_roots_path_for_db(&paths.db_path, directory.path());
    add_cold_root(
        &config,
        &cold_root,
        "codex",
        "2026-08-15T00:00:00.000Z",
        directory.path(),
    )
    .unwrap();
    add_cold_root(
        &config,
        &claude_cold_root,
        "claude-code",
        "2026-08-15T00:00:01.000Z",
        directory.path(),
    )
    .unwrap();
    let argv = || {
        vec![
            "shlog".to_owned(),
            "sync".to_owned(),
            "--source".to_owned(),
            "codex".to_owned(),
            "--root".to_owned(),
            root.to_string_lossy().into_owned(),
            "--db".to_owned(),
            paths.db_path.to_string_lossy().into_owned(),
            "--json".to_owned(),
        ]
    };
    let mut services = NativeAppServices::new(paths.clone(), directory.path().to_path_buf());

    let (code, stdout, stderr) = run_cli(&mut services, argv());
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    let first: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(
        (first["added"].as_u64(), first["updated"].as_u64()),
        (Some(1), Some(0))
    );
    assert_eq!(
        crate::index::IndexReader::open(&paths.db_path)
            .unwrap()
            .cold_roots(Some(SourceId::Codex))
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        crate::index::IndexReader::open(&paths.db_path)
            .unwrap()
            .cold_roots(None)
            .unwrap()
            .len(),
        2
    );
    assert_published_cold_fence(&config);
    assert!(has_imported_cold_backup(&config));

    let (code, stdout, stderr) = run_cli(&mut services, argv());
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    let noop: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(noop["skipped"], 1);

    let mut file = OpenOptions::new().append(true).open(&raw).unwrap();
    writeln!(
        file,
        "{}",
        serde_json::json!({
            "timestamp": "2026-08-15T00:00:02Z",
            "type": "event_msg",
            "payload": {"type": "agent_message", "message": "append evidence"},
        })
    )
    .unwrap();
    drop(file);
    let (code, stdout, stderr) = run_cli(&mut services, argv());
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    let appended: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(appended["updated"], 1);
    let page = crate::index::IndexReader::open(&paths.db_path)
        .unwrap()
        .read_page(&crate::identity::parse_session_ref(id), 0, 10)
        .unwrap();
    assert_eq!(page.total_count, 2);
    assert_eq!(page.messages[1].content_text, "append evidence");
}

#[test]
fn dsh_sync_find_read_page_round_trip() {
    let directory = TempDir::new().unwrap();
    let root = directory.path().join("dsh-sessions");
    let id = "session-dsh-e2e";
    let raw = root.join("--repo--").join(id).join("session.jsonl.zstd");
    write_dsh_zstd_session(
        &raw,
        id,
        &[("user", "dsh e2e query"), ("assistant", "dsh e2e answer")],
    );
    let paths = resolved_paths(&directory, &root);
    let mut services = NativeAppServices::new(paths.clone(), directory.path().to_path_buf());
    let db = paths.db_path.to_string_lossy().into_owned();
    let root_text = root.to_string_lossy().into_owned();

    let (code, stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "sync".to_owned(),
            "--source".to_owned(),
            "dsh".to_owned(),
            "--root".to_owned(),
            root_text.clone(),
            "--db".to_owned(),
            db.clone(),
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    let sync: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(sync["added"], 1);

    let (code, stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "find".to_owned(),
            "dsh e2e".to_owned(),
            "--source".to_owned(),
            "dsh".to_owned(),
            "--root".to_owned(),
            root_text,
            "--db".to_owned(),
            db.clone(),
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    let find: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(find["results"][0]["sourceId"], "dsh");
    assert_eq!(find["results"][0]["sessionRef"], format!("dsh:{id}"));
    assert_eq!(find["results"][0]["matchSeq"], 0);

    let (code, stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "read-page".to_owned(),
            format!("dsh:{id}"),
            "--source".to_owned(),
            "dsh".to_owned(),
            "--db".to_owned(),
            db.clone(),
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    let page: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(page["totalCount"], 2);
    assert_eq!(page["messages"][0]["contentText"], "dsh e2e query");
    assert_eq!(page["messages"][1]["contentText"], "dsh e2e answer");

    let (code, stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "list".to_owned(),
            "--source".to_owned(),
            "dsh".to_owned(),
            "--db".to_owned(),
            db.clone(),
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    let list: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(list["results"].as_array().unwrap().len(), 1);
    assert_eq!(list["results"][0]["sessionUuid"], format!("dsh:{id}"));
    assert_eq!(list["results"][0]["messageCount"], 2);

    let (code, stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "stats".to_owned(),
            "--source".to_owned(),
            "dsh".to_owned(),
            "--db".to_owned(),
            db,
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    let stats: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(stats["sessionCount"], 1);
    assert_eq!(stats["messageCount"], 2);
}

#[test]
fn sync_failure_routes_strict_json_to_stderr_and_best_effort_json_to_stdout() {
    let directory = TempDir::new().unwrap();
    let missing = directory.path().join("missing-source");
    let paths = resolved_paths(&directory, &missing);
    let argv = |db: &Path, best_effort: bool| {
        let mut args = vec![
            "shlog".to_owned(),
            "sync".to_owned(),
            "--root".to_owned(),
            missing.to_string_lossy().into_owned(),
            "--db".to_owned(),
            db.to_string_lossy().into_owned(),
            "--json".to_owned(),
        ];
        if best_effort {
            args.push("--best-effort".to_owned());
        }
        args
    };
    let mut services = NativeAppServices::new(paths.clone(), directory.path().to_path_buf());

    let strict_db = directory.path().join("strict.sqlite");
    let (code, stdout, stderr) = run_cli(&mut services, argv(&strict_db, false));
    assert_eq!(code, 1);
    assert!(stdout.is_empty());
    let strict: serde_json::Value = serde_json::from_slice(&stderr).unwrap();
    assert_eq!(strict["errors"], 1);
    assert_eq!(strict["coverage"]["reason"], "source_unavailable");
    assert!(strict.get("error").is_none());

    let best_db = directory.path().join("best.sqlite");
    let (code, stdout, stderr) = run_cli(&mut services, argv(&best_db, true));
    assert_eq!(code, 1);
    assert!(stderr.is_empty());
    let best: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(best["errors"], 1);
    assert!(best.get("error").is_none());
}

#[test]
fn first_sync_rejects_malformed_legacy_cold_state_without_publishing_v8() {
    let directory = TempDir::new().unwrap();
    let root = directory.path().join("sessions");
    let id = "abababab-abab-4bab-8bab-abababababab";
    let raw = root
        .join("2026/08/15")
        .join(format!("rollout-2026-08-15T00-00-00-{id}.jsonl"));
    write_codex_session(&raw, id, &[("user_message", "valid raw evidence")]);
    let paths = resolved_paths(&directory, &root);
    let config = cold_roots_path_for_db(&paths.db_path, directory.path());
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    let malformed = br#"{"version":1,"roots":[{"sourceId":"future","root":"/tmp"}]}"#;
    std::fs::write(&config, malformed).unwrap();
    let mut services = NativeAppServices::new(paths.clone(), directory.path().to_path_buf());
    let (code, stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "sync".to_owned(),
            "--root".to_owned(),
            root.to_string_lossy().into_owned(),
            "--db".to_owned(),
            paths.db_path.to_string_lossy().into_owned(),
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 1);
    assert!(stderr.is_empty());
    let payload: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(payload["error"]["code"], "index_error");
    assert!(
        payload["error"]["message"]
            .as_str()
            .unwrap()
            .contains("cold-root configuration")
    );
    assert!(!paths.db_path.exists());
    assert_eq!(std::fs::read(&config).unwrap(), malformed);
    assert!(config.is_file());
}

#[test]
fn legacy_v7_content_commands_fail_closed_and_status_reports_the_layout() {
    let directory = TempDir::new().unwrap();
    let root = directory.path().join("sessions");
    let id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let raw = root
        .join("2026/08/15")
        .join(format!("rollout-2026-08-15T00-00-00-{id}.jsonl"));
    write_codex_session(&raw, id, &[("user_message", "legacy evidence")]);
    let paths = resolved_paths(&directory, &root);
    std::fs::create_dir_all(&paths.data_dir).unwrap();
    create_v7_index(&paths.db_path, &raw, id, &root);
    let mut services = NativeAppServices::new(paths.clone(), directory.path().to_path_buf());

    // status is the nudge surface: it works and names the legacy layout.
    let status = json_output(|stdout, stderr| {
        services.status(
            &StatusArgs {
                source: Some("codex".to_owned()),
                root: Some(root.clone()),
                selector: None,
                cwd: None,
                database: DatabaseArg {
                    db: paths.db_path.clone(),
                },
                inventory: false,
                json: true,
            },
            stdout,
            stderr,
        )
    });
    assert_eq!(status["index"]["layout"], serde_json::json!("legacy_v7"));
    assert_eq!(status["index"]["exists"], serde_json::json!(true));

    // Content-bearing commands fail closed with the typed upgrade error.
    let (code, stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "find".to_owned(),
            "legacy".to_owned(),
            "--db".to_owned(),
            paths.db_path.to_string_lossy().into_owned(),
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 1);
    assert!(stderr.is_empty());
    let payload: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(
        payload["error"]["code"],
        serde_json::json!("index_schema_upgrade_required")
    );
    assert_eq!(
        payload["error"]["nextAction"]["commands"][0]["argv"],
        serde_json::json!([
            "shlog",
            "sync",
            "--db",
            paths.db_path.to_string_lossy(),
            "--json"
        ])
    );

    // One explicit sync migrates and restores normal reads.
    let (code, _stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "sync".to_owned(),
            "--db".to_owned(),
            paths.db_path.to_string_lossy().into_owned(),
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    let found = json_output(|stdout, stderr| {
        services.find(
            &FindArgs {
                query: "legacy evidence".to_owned(),
                source: Some("codex".to_owned()),
                limit: 10,
                root: None,
                selector: None,
                cwd: None,
                sort: CliFindSort::Relevance,
                exclude_session: vec![],
                database: DatabaseArg {
                    db: paths.db_path.clone(),
                },
                json: true,
            },
            stdout,
            stderr,
        )
    });
    assert_eq!(found["results"][0]["sessionRef"], serde_json::json!(id));
}

#[test]
fn explicit_sync_migrates_v7_before_running_the_v8_writer() {
    let directory = TempDir::new().unwrap();
    let root = directory.path().join("sessions");
    let id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let raw = root
        .join("2026/08/15")
        .join(format!("rollout-2026-08-15T00-00-00-{id}.jsonl"));
    write_codex_session(&raw, id, &[("user_message", "current raw evidence")]);
    let paths = resolved_paths(&directory, &root);
    std::fs::create_dir_all(&paths.data_dir).unwrap();
    create_v7_index(&paths.db_path, &raw, id, &root);
    let cold_root = directory.path().join("cold");
    std::fs::create_dir_all(&cold_root).unwrap();
    let cold_config = cold_roots_path_for_db(&paths.db_path, directory.path());
    add_cold_root(
        &cold_config,
        &cold_root,
        "codex",
        "2026-08-15T00:00:00.000Z",
        directory.path(),
    )
    .unwrap();
    assert_eq!(
        crate::index::IndexReader::open(&paths.db_path)
            .unwrap()
            .layout(),
        crate::index::IndexLayout::V7
    );
    let mut services = NativeAppServices::new(paths.clone(), directory.path().to_path_buf());
    let (code, stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "sync".to_owned(),
            "--root".to_owned(),
            root.to_string_lossy().into_owned(),
            "--db".to_owned(),
            paths.db_path.to_string_lossy().into_owned(),
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0, "stderr={}", String::from_utf8_lossy(&stderr));
    assert!(stderr.is_empty());
    let report: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(report["errors"], 0);
    let reader = crate::index::IndexReader::open(&paths.db_path).unwrap();
    assert_eq!(reader.layout(), crate::index::IndexLayout::V8);
    assert!(reader.metadata().migration_receipt.is_some());
    assert_eq!(reader.cold_roots(Some(SourceId::Codex)).unwrap().len(), 1);
    assert_published_cold_fence(&cold_config);
    assert!(has_imported_cold_backup(&cold_config));
    let page = reader
        .read_page(&crate::identity::parse_session_ref(id), 0, 10)
        .unwrap();
    assert_eq!(page.messages[0].content_text, "current raw evidence");
    assert!(
        std::fs::read_dir(paths.db_path.parent().unwrap())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".v7.bak."))
    );
}

#[test]
fn v7_cold_list_is_read_only_and_cold_writers_migrate_to_sqlite() {
    let directory = TempDir::new().unwrap();
    let raw_root = directory.path().join("sessions");
    let raw = raw_root.join("legacy.jsonl");
    let paths = resolved_paths(&directory, &raw_root);
    std::fs::create_dir_all(&paths.data_dir).unwrap();
    create_v7_index(
        &paths.db_path,
        &raw,
        "12121212-1212-4212-8212-121212121212",
        &raw_root,
    );
    let registered = directory.path().join("registered-cold");
    let added = directory.path().join("added-cold");
    std::fs::create_dir_all(&registered).unwrap();
    std::fs::create_dir_all(&added).unwrap();
    let config = cold_roots_path_for_db(&paths.db_path, directory.path());
    add_cold_root(
        &config,
        &registered,
        "codex",
        "2026-08-15T00:00:00.000Z",
        directory.path(),
    )
    .unwrap();
    let db = paths.db_path.to_string_lossy().into_owned();
    let mut services = NativeAppServices::new(paths.clone(), directory.path().to_path_buf());

    let (code, stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "cold".to_owned(),
            "list".to_owned(),
            "--db".to_owned(),
            db.clone(),
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&stdout).unwrap()["roots"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        crate::index::IndexReader::open(&paths.db_path)
            .unwrap()
            .layout(),
        crate::index::IndexLayout::V7
    );
    assert!(config.is_file());

    let (code, _, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "cold".to_owned(),
            "add".to_owned(),
            "--root".to_owned(),
            added.to_string_lossy().into_owned(),
            "--db".to_owned(),
            db.clone(),
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0, "stderr={}", String::from_utf8_lossy(&stderr));
    assert!(stderr.is_empty());
    let reader = crate::index::IndexReader::open(&paths.db_path).unwrap();
    assert_eq!(reader.layout(), crate::index::IndexLayout::V8);
    assert_eq!(reader.cold_roots(Some(SourceId::Codex)).unwrap().len(), 2);
    drop(reader);
    assert_published_cold_fence(&config);

    let (code, stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "cold".to_owned(),
            "remove".to_owned(),
            "--root".to_owned(),
            registered.to_string_lossy().into_owned(),
            "--db".to_owned(),
            db,
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&stdout).unwrap()["removed"],
        true
    );
    let roots = crate::sync::list_cold_roots(&paths.db_path, Some(SourceId::Codex)).unwrap();
    assert_eq!(roots.len(), 1);
    assert_eq!(roots[0].root, added.to_string_lossy());
    assert_published_cold_fence(&config);
}

#[test]
fn no_index_cold_writers_bootstrap_sqlite_and_retire_legacy_json() {
    let directory = TempDir::new().unwrap();
    let raw_root = directory.path().join("sessions");
    let paths = resolved_paths(&directory, &raw_root);
    let legacy = directory.path().join("legacy-cold");
    let added = directory.path().join("added-cold");
    std::fs::create_dir_all(&legacy).unwrap();
    std::fs::create_dir_all(&added).unwrap();
    let config = cold_roots_path_for_db(&paths.db_path, directory.path());
    add_cold_root(
        &config,
        &legacy,
        "claude-code",
        "2026-08-15T00:00:00.000Z",
        directory.path(),
    )
    .unwrap();
    let db = paths.db_path.to_string_lossy().into_owned();
    let mut services = NativeAppServices::new(paths.clone(), directory.path().to_path_buf());
    let (code, _, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "cold".to_owned(),
            "add".to_owned(),
            "--root".to_owned(),
            added.to_string_lossy().into_owned(),
            "--source".to_owned(),
            "codex".to_owned(),
            "--db".to_owned(),
            db,
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0, "stderr={}", String::from_utf8_lossy(&stderr));
    assert!(stderr.is_empty());
    let reader = crate::index::IndexReader::open(&paths.db_path).unwrap();
    assert_eq!(reader.layout(), crate::index::IndexLayout::V8);
    let roots = reader.cold_roots(None).unwrap();
    assert_eq!(roots.len(), 2);
    assert!(roots.iter().any(|entry| entry.source_id == SourceId::Codex));
    assert!(
        roots
            .iter()
            .any(|entry| entry.source_id == SourceId::ClaudeCode)
    );
    drop(reader);
    assert_published_cold_fence(&config);

    let second = TempDir::new().unwrap();
    let second_paths = resolved_paths(&second, &second.path().join("sessions"));
    let removed = second.path().join("remove-me");
    std::fs::create_dir_all(&removed).unwrap();
    let second_config = cold_roots_path_for_db(&second_paths.db_path, second.path());
    add_cold_root(
        &second_config,
        &removed,
        "pi",
        "2026-08-15T00:00:00.000Z",
        second.path(),
    )
    .unwrap();
    let mut second_services =
        NativeAppServices::new(second_paths.clone(), second.path().to_path_buf());
    let (code, stdout, stderr) = run_cli(
        &mut second_services,
        vec![
            "shlog".to_owned(),
            "cold".to_owned(),
            "remove".to_owned(),
            "--root".to_owned(),
            removed.to_string_lossy().into_owned(),
            "--source".to_owned(),
            "pi".to_owned(),
            "--db".to_owned(),
            second_paths.db_path.to_string_lossy().into_owned(),
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0, "stderr={}", String::from_utf8_lossy(&stderr));
    assert!(stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&stdout).unwrap()["removed"],
        true
    );
    let reader = crate::index::IndexReader::open(&second_paths.db_path).unwrap();
    assert_eq!(reader.layout(), crate::index::IndexLayout::V8);
    assert!(reader.cold_roots(None).unwrap().is_empty());
    assert_published_cold_fence(&second_config);

    // Simulate a process dying after the irreversible filesystem fence but
    // before its scratch v8 database became active. The next native writer
    // must recover every registration from the durable backup.
    let recovery = TempDir::new().unwrap();
    let recovery_paths = resolved_paths(&recovery, &recovery.path().join("sessions"));
    let recovered_root = recovery.path().join("recovered-cold");
    let retry_added_root = recovery.path().join("retry-added-cold");
    std::fs::create_dir_all(&recovered_root).unwrap();
    std::fs::create_dir_all(&retry_added_root).unwrap();
    let recovery_config = cold_roots_path_for_db(&recovery_paths.db_path, recovery.path());
    add_cold_root(
        &recovery_config,
        &recovered_root,
        "codex",
        "2026-08-15T00:00:00.000Z",
        recovery.path(),
    )
    .unwrap();
    let mut interrupted_fence = ColdConfigFence::inspect(&recovery_config).unwrap();
    interrupted_fence.preflight().unwrap();
    interrupted_fence.publish().unwrap();
    drop(interrupted_fence);
    assert!(!recovery_paths.db_path.exists());
    assert_published_cold_fence(&recovery_config);

    let mut recovery_services =
        NativeAppServices::new(recovery_paths.clone(), recovery.path().to_path_buf());
    let (code, _, stderr) = run_cli(
        &mut recovery_services,
        vec![
            "shlog".to_owned(),
            "cold".to_owned(),
            "add".to_owned(),
            "--root".to_owned(),
            retry_added_root.to_string_lossy().into_owned(),
            "--db".to_owned(),
            recovery_paths.db_path.to_string_lossy().into_owned(),
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0, "stderr={}", String::from_utf8_lossy(&stderr));
    assert!(stderr.is_empty());
    let roots = crate::sync::list_cold_roots(&recovery_paths.db_path, None).unwrap();
    assert_eq!(roots.len(), 2);
    assert!(
        roots
            .iter()
            .any(|entry| entry.root == recovered_root.to_string_lossy())
    );
    assert!(
        roots
            .iter()
            .any(|entry| entry.root == retry_added_root.to_string_lossy())
    );
}

#[test]
fn v8_cold_state_is_authoritative_and_ephemeral_roots_never_register() {
    let directory = TempDir::new().unwrap();
    let root = directory.path().join("sessions");
    let id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let raw = root
        .join("2026/08/15")
        .join(format!("rollout-2026-08-15T00-00-00-{id}.jsonl"));
    write_codex_session(&raw, id, &[("user_message", "cold state evidence")]);
    let cold_root = directory.path().join("cold");
    std::fs::create_dir_all(&cold_root).unwrap();
    let ephemeral_root = directory.path().join("ephemeral");
    std::fs::create_dir_all(&ephemeral_root).unwrap();
    let paths = resolved_paths(&directory, &root);
    let db = paths.db_path.to_string_lossy().into_owned();
    let root_text = root.to_string_lossy().into_owned();
    let cold_text = cold_root.to_string_lossy().into_owned();
    let mut services = NativeAppServices::new(paths.clone(), directory.path().to_path_buf());

    let (code, _, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "sync".to_owned(),
            "--root".to_owned(),
            root_text.clone(),
            "--db".to_owned(),
            db.clone(),
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0);
    assert!(stderr.is_empty());

    let (code, stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "cold".to_owned(),
            "add".to_owned(),
            "--root".to_owned(),
            cold_text.clone(),
            "--source".to_owned(),
            "codex".to_owned(),
            "--db".to_owned(),
            db.clone(),
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    let added: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(added["entry"]["sourceId"], "codex");
    assert_eq!(added["entry"]["root"], cold_text);

    let (code, stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "cold".to_owned(),
            "list".to_owned(),
            "--db".to_owned(),
            db.clone(),
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    let listed: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(listed["roots"].as_array().unwrap().len(), 1);

    let (code, stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "cold".to_owned(),
            "remove".to_owned(),
            "--root".to_owned(),
            cold_text.clone(),
            "--source".to_owned(),
            "codex".to_owned(),
            "--db".to_owned(),
            db.clone(),
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    let removed: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(removed["removed"], true);

    // The published TS writer opens the canonical path directly. The symlink
    // fence redirects that open to a private directory and fails with EISDIR,
    // while the native Rust command continues to mutate SQLite.
    let config = cold_roots_path_for_db(&paths.db_path, directory.path());
    assert_published_cold_fence(&config);
    let legacy_write = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&config)
        .unwrap_err();
    assert_eq!(legacy_write.kind(), std::io::ErrorKind::IsADirectory);
    let (code, _, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "sync".to_owned(),
            "--root".to_owned(),
            root_text,
            "--cold-root".to_owned(),
            ephemeral_root.to_string_lossy().into_owned(),
            "--db".to_owned(),
            db,
            "--json".to_owned(),
        ],
    );
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    assert!(
        crate::sync::list_cold_roots(&paths.db_path, Some(SourceId::Codex))
            .unwrap()
            .is_empty()
    );
    assert_published_cold_fence(&config);
}

#[test]
fn v8_cold_writer_lock_failure_preserves_json_stdout_contract() {
    let directory = TempDir::new().unwrap();
    let raw_root = directory.path().join("raw");
    let cold_root = directory.path().join("cold");
    std::fs::create_dir_all(&cold_root).unwrap();
    let paths = resolved_paths(&directory, &raw_root);
    std::fs::create_dir_all(&paths.data_dir).unwrap();
    seed_index(&paths.db_path, &raw_root);
    let lock_path = PathBuf::from(format!("{}.sync.lock", paths.db_path.to_string_lossy()));
    std::fs::write(
        &lock_path,
        serde_json::json!({
            "pid": std::process::id(),
            "createdAt": "2026-08-15T00:00:00Z",
        })
        .to_string(),
    )
    .unwrap();
    let mut services = NativeAppServices::new(paths.clone(), directory.path().to_path_buf());
    let (code, stdout, stderr) = run_cli(
        &mut services,
        vec![
            "shlog".to_owned(),
            "cold".to_owned(),
            "add".to_owned(),
            "--root".to_owned(),
            cold_root.to_string_lossy().into_owned(),
            "--db".to_owned(),
            paths.db_path.to_string_lossy().into_owned(),
            "--json".to_owned(),
        ],
    );
    std::fs::remove_file(lock_path).unwrap();
    assert_eq!(code, 1);
    assert!(stderr.is_empty());
    let payload: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(payload["error"]["code"], "index_error");
    assert!(
        payload["error"]["message"]
            .as_str()
            .unwrap()
            .contains("acquire writer lock")
    );
    assert!(
        payload["error"]["message"]
            .as_str()
            .unwrap()
            .contains(paths.db_path.to_string_lossy().as_ref())
    );
}

#[test]
fn status_succeeds_without_a_database_and_scans_only_the_fixture_root() {
    let directory = TempDir::new().unwrap();
    let fixture_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../eval/fixtures/contract/codex")
        .canonicalize()
        .unwrap();
    let paths = resolved_paths(&directory, &fixture_root);
    let mut services = NativeAppServices::new(paths.clone(), PathBuf::from("/repo"));
    let status = json_output(|stdout, stderr| {
        services.status(
            &StatusArgs {
                source: Some("codex".to_owned()),
                root: None,
                selector: None,
                cwd: None,
                database: DatabaseArg {
                    db: paths.db_path.clone(),
                },
                inventory: false,
                json: true,
            },
            stdout,
            stderr,
        )
    });
    assert_eq!(status["index"]["exists"], false);
    assert_eq!(status["index"]["sessionCount"], 0);
    assert!(status["sourceInventory"]["totalFiles"].as_u64().unwrap() >= 1);
    assert_eq!(
        status["sourceInventory"]["cwdGroups"],
        serde_json::json!([])
    );
}

#[test]
fn status_selector_performs_live_freshness_proof_without_writing() {
    let directory = TempDir::new().unwrap();
    let fixture_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../eval/fixtures/contract/codex")
        .canonicalize()
        .unwrap();
    let paths = resolved_paths(&directory, &fixture_root);
    std::fs::create_dir_all(&paths.data_dir).unwrap();
    seed_index(&paths.db_path, &fixture_root);
    let before = std::fs::metadata(&paths.db_path).unwrap().len();
    let mut services = NativeAppServices::new(paths.clone(), PathBuf::from("/repo"));
    let selector = serde_json::json!({
        "kind": "all",
        "source": "codex",
        "root": fixture_root,
    })
    .to_string();
    let status = json_output(|stdout, stderr| {
        services.status(
            &StatusArgs {
                source: Some("codex".to_owned()),
                root: None,
                selector: Some(selector),
                cwd: None,
                database: DatabaseArg {
                    db: paths.db_path.clone(),
                },
                inventory: false,
                json: true,
            },
            stdout,
            stderr,
        )
    });
    assert_eq!(status["requestedCoverage"]["freshness"], "stale");
    assert_eq!(status["requestedCoverage"]["recommendedAction"], "sync");
    assert_eq!(std::fs::metadata(&paths.db_path).unwrap().len(), before);
}

#[test]
fn status_reuses_v8_source_metadata_cache_before_scanning_raw_files() {
    let directory = TempDir::new().unwrap();
    let raw_root = directory.path().join("sessions");
    let id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let raw = raw_root
        .join("2026/08/15")
        .join(format!("rollout-2026-08-15T00-00-00-{id}.jsonl"));
    write_codex_session(&raw, id, &[("user_message", "private accepted metadata")]);
    let selector = Selector::All {
        source: SourceId::Codex,
        root: raw_root.to_string_lossy().into_owned(),
    };
    let scan = SourceCatalog
        .scan(&selector, &SourceMetadataCache::default())
        .unwrap();
    assert_eq!(scan.files.len(), 1);
    let file = &scan.files[0];

    let paths = resolved_paths(&directory, &raw_root);
    std::fs::create_dir_all(&paths.data_dir).unwrap();
    seed_index(&paths.db_path, &raw_root);
    let mut writer = IndexWriter::open_v8(&paths.db_path).unwrap();
    let mut transaction = writer.begin().unwrap();
    transaction
        .upsert_source_file(&cached_source_file_state(file, &raw_root))
        .unwrap();
    transaction.commit().unwrap();
    drop(writer);

    // A cache miss would invoke the injected raw metadata parser failure and
    // lose its accepted cwd metadata. A cache hit remains a read-only stat walk.
    let _failure = inject_metadata_failure(&raw);
    let mut services = NativeAppServices::new(paths.clone(), directory.path().to_path_buf());
    let status = json_output(|stdout, stderr| {
        services.status(
            &StatusArgs {
                source: Some("codex".to_owned()),
                root: None,
                selector: None,
                cwd: None,
                database: DatabaseArg {
                    db: paths.db_path.clone(),
                },
                inventory: true,
                json: true,
            },
            stdout,
            stderr,
        )
    });
    assert_eq!(status["sourceInventory"]["totalFiles"], 1);
    assert_eq!(status["sourceInventory"]["cwdGroups"][0]["cwd"], "/repo");

    let connection = Connection::open(&paths.db_path).unwrap();
    connection
        .execute(
            "UPDATE meta SET value=? WHERE key='coverage_epoch'",
            [COVERAGE_EPOCH - 1],
        )
        .unwrap();
    drop(connection);
    let stale_global = json_output(|stdout, stderr| {
        services.status(
            &StatusArgs {
                source: Some("codex".to_owned()),
                root: None,
                selector: None,
                cwd: None,
                database: DatabaseArg {
                    db: paths.db_path.clone(),
                },
                inventory: true,
                json: true,
            },
            stdout,
            stderr,
        )
    });
    assert_eq!(
        stale_global["sourceInventory"]["cwdGroups"],
        serde_json::json!([])
    );

    let connection = Connection::open(&paths.db_path).unwrap();
    connection
        .execute(
            "UPDATE meta SET value=? WHERE key='coverage_epoch'",
            [COVERAGE_EPOCH],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE source_files SET projection_epoch=?",
            [PROJECTION_EPOCH - 1],
        )
        .unwrap();
    drop(connection);
    let stale_row = json_output(|stdout, stderr| {
        services.status(
            &StatusArgs {
                source: Some("codex".to_owned()),
                root: None,
                selector: None,
                cwd: None,
                database: DatabaseArg {
                    db: paths.db_path.clone(),
                },
                inventory: true,
                json: true,
            },
            stdout,
            stderr,
        )
    });
    assert_eq!(
        stale_row["sourceInventory"]["cwdGroups"],
        serde_json::json!([])
    );
}

#[test]
fn status_preloads_metadata_for_explicit_and_inventory_history_roots() {
    let directory = TempDir::new().unwrap();
    let base_root = directory.path().join("base-sessions");
    let history_root = directory.path().join("history-sessions");
    let base_raw = base_root
        .join("2026/08/15")
        .join("rollout-2026-08-15T00-00-00-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jsonl");
    let history_raw = history_root
        .join("2026/08/14")
        .join("rollout-2026-08-14T00-00-00-ffffffff-ffff-4fff-8fff-ffffffffffff.jsonl");
    write_codex_session(
        &base_raw,
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        &[("user_message", "base metadata")],
    );
    write_codex_session(
        &history_raw,
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
        &[("user_message", "history metadata")],
    );
    let base_selector = Selector::All {
        source: SourceId::Codex,
        root: base_root.to_string_lossy().into_owned(),
    };
    let history_selector = Selector::All {
        source: SourceId::Codex,
        root: history_root.to_string_lossy().into_owned(),
    };
    let catalog = SourceCatalog;
    let base_scan = catalog
        .scan(&base_selector, &SourceMetadataCache::default())
        .unwrap();
    let history_scan = catalog
        .scan(&history_selector, &SourceMetadataCache::default())
        .unwrap();
    assert_eq!(base_scan.files.len(), 1);
    assert_eq!(history_scan.files.len(), 1);

    let paths = resolved_paths(&directory, &base_root);
    std::fs::create_dir_all(&paths.data_dir).unwrap();
    seed_index(&paths.db_path, &base_root);
    let mut writer = IndexWriter::open_v8(&paths.db_path).unwrap();
    let mut transaction = writer.begin().unwrap();
    transaction
        .upsert_source_file(&cached_source_file_state(&base_scan.files[0], &base_root))
        .unwrap();
    transaction
        .upsert_source_file(&cached_source_file_state(
            &history_scan.files[0],
            &history_root,
        ))
        .unwrap();
    transaction
        .replace_coverage(&CoverageWrite {
            selector: history_selector.clone(),
            source_fingerprint: history_scan.snapshot.fingerprint.clone(),
            source_file_set_fingerprint: history_scan.snapshot.file_set_fingerprint.clone(),
            source_file_count: history_scan.snapshot.file_count,
            indexed_session_count: 0,
            indexed_document_count: 0,
            source_generation: "cached-status-fixture".to_owned(),
            completed_at: Some("2026-08-15T00:02:00Z".to_owned()),
            index_version: INDEX_VERSION.to_owned(),
            projection_epoch: PROJECTION_EPOCH,
            analyzer_epoch: ANALYZER_EPOCH,
            coverage_epoch: COVERAGE_EPOCH,
        })
        .unwrap();
    transaction.commit().unwrap();
    drop(writer);

    let _base_failure = inject_metadata_failure(&base_raw);
    let _history_failure = inject_metadata_failure(&history_raw);
    let mut services = NativeAppServices::new(paths.clone(), directory.path().to_path_buf());
    let status = json_output(|stdout, stderr| {
        services.status(
            &StatusArgs {
                source: Some("codex".to_owned()),
                root: None,
                selector: Some(serde_json::to_string(&history_selector).unwrap()),
                cwd: None,
                database: DatabaseArg {
                    db: paths.db_path.clone(),
                },
                inventory: true,
                json: true,
            },
            stdout,
            stderr,
        )
    });
    assert_eq!(status["sourceInventory"]["cwdGroups"][0]["cwd"], "/repo");
    assert_eq!(status["requestedCoverage"]["freshness"], "fresh");
    let history_root_text = history_root.to_string_lossy();
    let history_coverage = status["coverage"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["selector"]["root"] == history_root_text.as_ref())
        .unwrap();
    assert_eq!(history_coverage["freshness"], "fresh");
}
