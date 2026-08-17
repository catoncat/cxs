use std::path::Path;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::identity::SourceId;
use crate::model::{MessageRole, SourceKind};

use super::catalog::AcceptedMetadata;
use super::jsonl::{
    object, read_bounded_zstd_lines, scan_zstd_json_records, string, timestamp_date,
};
use super::{
    DocumentKind, EmptyProjection, FullProjectionReason, MessageProjection, ProjectedSource,
    ProjectionCheckpoint, ProjectionMode, ProjectionOutcome, SessionProjection, SourceDocument,
    SourceError, SourceFile, build_session_summary, fallback_session_id, fallback_timestamp,
    first_user_title, time_range, truncate_chars,
};

#[derive(Debug)]
struct AcceptedSession {
    session_id: String,
    cwd: String,
    timestamp: String,
}

#[derive(Debug)]
struct AcceptedMessage {
    role: MessageRole,
    content_text: String,
    timestamp: String,
}

pub(crate) fn inventory_metadata(path: &Path) -> Result<Option<AcceptedMetadata>, SourceError> {
    let mut cwd = String::new();
    let mut path_date = None;
    let mut accepted_count = 0_usize;
    let mut hasher = Sha256::new();
    hasher.update(b"sherlog:dsh:accepted:v1");

    scan_zstd_json_records(path, |record| {
        if let Some(session) = accepted_session(record) {
            if cwd.is_empty() {
                cwd = session.cwd.clone();
            }
            if path_date.is_none() {
                path_date = timestamp_date(&session.timestamp);
            }
            hash_fields(
                &mut hasher,
                "session",
                &[&session.session_id, &session.cwd, &session.timestamp],
            );
            return true;
        }
        if let Some(title) = accepted_title(record) {
            hash_fields(&mut hasher, "title", &[&title]);
            return true;
        }
        if let Some(model) = accepted_model(record) {
            hash_fields(&mut hasher, "model", &[&model]);
            return true;
        }
        if let Some(message) = accepted_user_message(record) {
            accepted_count += 1;
            if path_date.is_none() {
                path_date = timestamp_date(&message.timestamp);
            }
            hash_fields(
                &mut hasher,
                "user",
                &[&message.timestamp, &message.content_text],
            );
            return true;
        }
        if let Some(message) = accepted_assistant_message(record) {
            accepted_count += 1;
            if path_date.is_none() {
                path_date = timestamp_date(&message.timestamp);
            }
            hash_fields(
                &mut hasher,
                "assistant",
                &[&message.timestamp, &message.content_text],
            );
            return true;
        }
        true
    })?;

    Ok((accepted_count > 0).then(|| AcceptedMetadata {
        cwd,
        path_date,
        fingerprint: hex::encode(hasher.finalize()),
    }))
}

pub(crate) fn project(
    file: &SourceFile,
    read_limit: u64,
    checkpoint: Option<&ProjectionCheckpoint>,
) -> Result<ProjectionOutcome, SourceError> {
    if let Some(checkpoint) = checkpoint {
        return Ok(ProjectionOutcome::FullRequired {
            reason: if checkpoint.source_id == SourceId::Dsh {
                FullProjectionReason::DeltaUnsupported
            } else {
                FullProjectionReason::SourceMismatch
            },
            read_proof: None,
        });
    }

    let mut documents = Vec::new();
    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut model = String::new();
    let mut session_timestamp = String::new();
    let mut title = String::new();
    let read = read_bounded_zstd_lines(file, read_limit, |record| {
        if let Some(session) = accepted_session(record) {
            if session_id.is_empty() && !session.session_id.is_empty() {
                session_id = session.session_id;
            }
            if cwd.is_empty() {
                cwd = session.cwd;
            }
            if session_timestamp.is_empty() {
                session_timestamp = session.timestamp;
            }
            return Ok(());
        }
        // Latest wins: DSH first writes a truncated paste of the first user
        // message as the title, then replaces it with the LLM-refined title.
        if let Some(candidate) = accepted_title(record) {
            title = candidate;
            return Ok(());
        }
        // Latest wins: the model can switch mid-session.
        if let Some(candidate) = accepted_model(record) {
            model = candidate;
            return Ok(());
        }
        let Some(message) =
            accepted_user_message(record).or_else(|| accepted_assistant_message(record))
        else {
            return Ok(());
        };
        let seq = documents.len() as i64;
        documents.push(SourceDocument {
            kind: DocumentKind::Message,
            message: MessageProjection {
                role: message.role,
                content_text: message.content_text,
                timestamp: message.timestamp,
                seq,
                source_kind: SourceKind::EventMsg,
            },
            raw_start: 0,
            raw_end: 0,
        });
        Ok(())
    })?;

    if read.proof.opened.identity != file.identity {
        return Ok(ProjectionOutcome::FullRequired {
            reason: FullProjectionReason::FileIdentityChanged,
            read_proof: Some(read.proof),
        });
    }
    let checkpoint = ProjectionCheckpoint {
        source_id: SourceId::Dsh,
        file_identity: read.proof.opened.identity.clone(),
        indexed_bytes: read.proof.safe_offset,
        prefix_digest: read.safe_prefix_digest,
        next_seq: documents.len() as i64,
        reducer_state: r#"{"version":1,"mode":"full_only"}"#.to_owned(),
    };
    if documents.is_empty() {
        return Ok(ProjectionOutcome::Skipped(EmptyProjection {
            read_proof: read.proof,
            checkpoint,
        }));
    }

    let native_session_id = if session_id.is_empty() {
        // The DSH layout keeps the native id in the parent directory:
        // <root>/<encoded-cwd>/<session-id>/session.jsonl.zstd. The shared
        // file-stem fallback would see only "session.jsonl".
        file.file_path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| fallback_session_id(file))
    } else {
        session_id
    };
    let session_key = format!("dsh:{native_session_id}");
    let fallback = fallback_timestamp(file);
    let additional = std::iter::once(session_timestamp);
    let (started_at, ended_at) = time_range(&documents, additional, &fallback);
    let session = SessionProjection {
        source_id: SourceId::Dsh,
        native_session_id,
        session_key: session_key.clone(),
        session_uuid: session_key,
        file_path: file.file_path.to_string_lossy().into_owned(),
        title: if title.is_empty() {
            first_user_title(&documents).unwrap_or_else(|| "(no title)".to_owned())
        } else {
            truncate_chars(&title, 120)
        },
        summary_text: build_session_summary(&documents),
        compact_text: String::new(),
        reasoning_summary_text: String::new(),
        cwd: if cwd.is_empty() {
            file.cwd.clone()
        } else {
            cwd
        },
        model,
        started_at,
        ended_at,
        document_count: documents.len() as u64,
    };
    Ok(ProjectionOutcome::Projected(Box::new(ProjectedSource {
        mode: ProjectionMode::Full,
        session,
        documents,
        read_proof: read.proof,
        checkpoint,
    })))
}

fn accepted_session(record: &Map<String, Value>) -> Option<AcceptedSession> {
    if record.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    let cwd = string(record, "cwd");
    let timestamp = millis_timestamp(record, "createdAt");
    if cwd.is_empty() || timestamp.is_empty() {
        return None;
    }
    Some(AcceptedSession {
        session_id: string(record, "id"),
        cwd,
        timestamp,
    })
}

fn accepted_user_message(record: &Map<String, Value>) -> Option<AcceptedMessage> {
    if record.get("type").and_then(Value::as_str) != Some("user/message") {
        return None;
    }
    let data = object(record, "data")?;
    let source = object(data, "source")?;
    if string(source, "kind") != "user" {
        return None;
    }
    let content_text = text_from_content(data.get("content")?);
    let timestamp = millis_timestamp(record, "time");
    if content_text.is_empty() || timestamp.is_empty() {
        return None;
    }
    Some(AcceptedMessage {
        role: MessageRole::User,
        content_text,
        timestamp,
    })
}

fn accepted_assistant_message(record: &Map<String, Value>) -> Option<AcceptedMessage> {
    if record.get("type").and_then(Value::as_str) != Some("assistant/message") {
        return None;
    }
    let data = object(record, "data")?;
    let message = object(data, "message")?;
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let content_text = text_from_content(message.get("content")?);
    let timestamp = millis_timestamp(record, "time");
    if content_text.is_empty() || timestamp.is_empty() {
        return None;
    }
    Some(AcceptedMessage {
        role: MessageRole::Assistant,
        content_text,
        timestamp,
    })
}

fn accepted_title(record: &Map<String, Value>) -> Option<String> {
    if record.get("type").and_then(Value::as_str) != Some("session/title") {
        return None;
    }
    let title = string(object(record, "data")?, "title");
    (!title.is_empty()).then_some(title)
}

fn accepted_model(record: &Map<String, Value>) -> Option<String> {
    if record.get("type").and_then(Value::as_str) != Some("request/header") {
        return None;
    }
    let header = object(object(record, "data")?, "header")?;
    let config = object(header, "config")?;
    let model = string(config, "model");
    (!model.is_empty()).then_some(model)
}

fn text_from_content(value: &Value) -> String {
    let Some(items) = value.as_array() else {
        return String::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let item = item.as_object()?;
            if item.get("type").and_then(Value::as_str) != Some("text") {
                return None;
            }
            item.get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn millis_timestamp(record: &Map<String, Value>, key: &str) -> String {
    let Some(millis) = record.get(key).and_then(Value::as_i64) else {
        return String::new();
    };
    jiff::Timestamp::from_millisecond(millis)
        .map(|timestamp| timestamp.to_string())
        .unwrap_or_default()
}

fn hash_fields(hasher: &mut Sha256, tag: &str, fields: &[&str]) {
    hash_value(hasher, tag);
    for field in fields {
        hash_value(hasher, field);
    }
}

fn hash_value(hasher: &mut Sha256, value: &str) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value.as_bytes());
}
