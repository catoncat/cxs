//! Raw agent-session source gateway.
//!
//! The public seam is deliberately narrow: one scan derives the file list,
//! inventory, and selector snapshot, while one projection call turns a
//! byte-bounded source file into privacy-reviewed documents. Source-specific
//! record formats and allowlists remain private to this module.

mod catalog;
mod claude_code;
mod codex;
mod dsh;
mod jsonl;
mod pi;

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::identity::SourceId;
use crate::model::{MessageRole, SourceFileMeta, SourceInventory, SourceKind, SourceSnapshot};

pub use catalog::SourceCatalog;
#[cfg(test)]
pub(crate) use catalog::inject_metadata_failure;

/// SHA-256 of the first `byte_count` bytes of a file, hex-encoded.
///
/// Shared by sync (bounded projection proofs) and status (append-vs-destructive
/// classification against the persisted `boundary_digest`).
pub(crate) fn prefix_sha256(path: &Path, byte_count: u64) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut remaining = byte_count;
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        let limit = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
        let read = file.read(&mut buffer[..limit])?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "source prefix shortened during verification",
            ));
        }
        hasher.update(&buffer[..read]);
        remaining -= read as u64;
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Exact file identity captured by a source scan.
///
/// Unix device/inode identity detects same-path replacement. Other platforms
/// retain a deterministic path digest, so callers always have a stable value
/// even when the operating system exposes no portable file identifier.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FileIdentity {
    Unix { device: u64, inode: u64 },
    PathDigest { digest: String },
}

/// A source file accepted by its source-specific inventory policy.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFile {
    pub source_id: SourceId,
    pub file_path: PathBuf,
    pub path_date: Option<String>,
    pub cwd: String,
    pub mtime_ms: f64,
    pub mtime_ns: i128,
    pub size: u64,
    pub identity: FileIdentity,
    /// Versioned digest of source-specific fields accepted by projection.
    /// Raw bytes, mtime, size, and rejected/private records are excluded.
    pub accepted_fingerprint: String,
}

impl SourceFile {
    pub fn as_file_meta(&self) -> SourceFileMeta {
        SourceFileMeta {
            file_path: self.file_path.to_string_lossy().into_owned(),
            path_date: self.path_date.clone(),
            cwd: self.cwd.clone(),
            mtime_ms: self.mtime_ms,
            size: self.size,
        }
    }
}

/// Cache entry trusted only when source, path, exact identity, size, and
/// nanosecond mtime all match the current scan. Rejected files are
/// intentionally not cached.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedSourceMetadata {
    pub source_id: SourceId,
    pub file_path: PathBuf,
    pub mtime_ns: i128,
    pub size: u64,
    pub file_identity: FileIdentity,
    pub path_date: Option<String>,
    pub cwd: String,
    pub accepted_fingerprint: String,
}

#[derive(Clone, Debug, Default)]
pub struct SourceMetadataCache {
    entries: HashMap<(SourceId, PathBuf), CachedSourceMetadata>,
}

impl SourceMetadataCache {
    pub fn from_entries(entries: impl IntoIterator<Item = CachedSourceMetadata>) -> Self {
        let mut cache = Self::default();
        for entry in entries {
            cache.insert(entry);
        }
        cache
    }

    pub fn insert(&mut self, entry: CachedSourceMetadata) {
        self.entries
            .insert((entry.source_id, entry.file_path.clone()), entry);
    }

    fn matching(
        &self,
        source_id: SourceId,
        file_path: &Path,
        mtime_ns: i128,
        size: u64,
        file_identity: &FileIdentity,
    ) -> Option<&CachedSourceMetadata> {
        self.entries
            .get(&(source_id, file_path.to_path_buf()))
            .filter(|entry| {
                entry.mtime_ns == mtime_ns
                    && entry.size == size
                    && &entry.file_identity == file_identity
            })
    }
}

/// All scan products derived from one traversal and one metadata pass.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceScan {
    pub files: Vec<SourceFile>,
    pub inventory: SourceInventory,
    pub snapshot: SourceSnapshot,
    /// Candidate files whose inventory/stat/accepted-metadata pass could not
    /// be completed. A scan with failures is never complete coverage.
    pub failures: Vec<SourceScanFailure>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceScanFailure {
    pub file_path: PathBuf,
    pub operation: String,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentKind {
    Message,
}

/// Accepted user/assistant projection. Raw source format details never leave
/// the sources module.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageProjection {
    pub role: MessageRole,
    pub content_text: String,
    pub timestamp: String,
    pub seq: i64,
    pub source_kind: SourceKind,
}

/// One searchable projection with an end-exclusive raw byte locator.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDocument {
    pub kind: DocumentKind,
    pub message: MessageProjection,
    pub raw_start: u64,
    pub raw_end: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProjection {
    pub source_id: SourceId,
    pub native_session_id: String,
    pub session_key: String,
    pub session_uuid: String,
    pub file_path: String,
    pub title: String,
    pub summary_text: String,
    pub compact_text: String,
    pub reasoning_summary_text: String,
    pub cwd: String,
    pub model: String,
    pub started_at: String,
    pub ended_at: String,
    pub document_count: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStamp {
    pub mtime_ns: i128,
    pub size: u64,
    pub identity: FileIdentity,
}

/// Proof that projection consumed only the captured byte range.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadProof {
    pub requested_limit: u64,
    pub effective_limit: u64,
    pub byte_count: u64,
    /// End of the last fully newline-terminated JSONL record.
    pub safe_offset: u64,
    pub content_fingerprint: String,
    pub safe_prefix_fingerprint: String,
    pub opened: FileStamp,
    pub completed: FileStamp,
}

impl ReadProof {
    pub fn stable(&self) -> bool {
        self.opened == self.completed && self.byte_count == self.effective_limit
    }
}

/// Opaque source reducer checkpoint plus the source-independent append proof.
/// Callers may persist this value but must not interpret reducer_state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionCheckpoint {
    pub source_id: SourceId,
    pub file_identity: FileIdentity,
    pub indexed_bytes: u64,
    pub prefix_digest: String,
    pub next_seq: i64,
    pub reducer_state: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionMode {
    Full,
    Delta,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedSource {
    pub mode: ProjectionMode,
    pub session: SessionProjection,
    /// Full mode returns every accepted document. Delta mode returns only
    /// newly appended documents while session contains the updated reduction.
    pub documents: Vec<SourceDocument>,
    pub read_proof: ReadProof,
    pub checkpoint: ProjectionCheckpoint,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmptyProjection {
    pub read_proof: ReadProof,
    pub checkpoint: ProjectionCheckpoint,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FullProjectionReason {
    DeltaUnsupported,
    SourceMismatch,
    FileIdentityChanged,
    CursorBeyondReadLimit,
    InvalidReducerState,
    PrefixChanged,
    CursorNotOnLineBoundary,
    SessionIdentityChanged,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionOutcome {
    Projected(Box<ProjectedSource>),
    Filtered(EmptyProjection),
    Skipped(EmptyProjection),
    FullRequired {
        reason: FullProjectionReason,
        read_proof: Option<ReadProof>,
    },
}

#[derive(Debug, Error)]
pub enum SourceError {
    #[error("selector source {actual} does not match source file {expected}")]
    SourceMismatch {
        expected: SourceId,
        actual: SourceId,
    },
    #[error("source path is not valid UTF-8: {0:?}")]
    NonUtf8Path(PathBuf),
    #[error("{operation} failed for {path:?}: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("serialize source checkpoint: {0}")]
    Checkpoint(#[from] serde_json::Error),
}

pub(crate) fn normalize_summary_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

pub(crate) fn build_session_summary(documents: &[SourceDocument]) -> String {
    let first_user = documents
        .iter()
        .find(|document| document.message.role == MessageRole::User);
    let first_assistant = documents
        .iter()
        .find(|document| document.message.role == MessageRole::Assistant);
    let latest_user = documents
        .iter()
        .rev()
        .find(|document| document.message.role == MessageRole::User);
    let latest_assistant = documents
        .iter()
        .rev()
        .find(|document| document.message.role == MessageRole::Assistant);

    let mut parts = Vec::with_capacity(4);
    if let Some(document) = first_user {
        parts.push(format!(
            "user: {}",
            normalize_summary_text(&truncate_chars(&document.message.content_text, 5_000))
        ));
    }
    if let Some(document) = first_assistant {
        parts.push(format!(
            "assistant: {}",
            normalize_summary_text(&truncate_chars(&document.message.content_text, 5_000))
        ));
    }
    if let Some(document) = latest_user
        && Some(document.message.seq) != first_user.map(|value| value.message.seq)
    {
        parts.push(format!(
            "follow-up: {}",
            normalize_summary_text(&truncate_chars(&document.message.content_text, 5_000))
        ));
    }
    if let Some(document) = latest_assistant
        && Some(document.message.seq) != first_assistant.map(|value| value.message.seq)
    {
        parts.push(format!(
            "latest: {}",
            normalize_summary_text(&truncate_chars(&document.message.content_text, 5_000))
        ));
    }
    truncate_chars(&parts.join(" | "), 480)
}

pub(crate) fn first_user_title(documents: &[SourceDocument]) -> Option<String> {
    documents
        .iter()
        .find(|document| document.message.role == MessageRole::User)
        .map(|document| truncate_chars(&document.message.content_text, 120))
}

pub(crate) fn time_range(
    documents: &[SourceDocument],
    additional: impl IntoIterator<Item = String>,
    fallback: &str,
) -> (String, String) {
    let mut started: Option<String> = None;
    let mut ended: Option<String> = None;
    for timestamp in additional.into_iter().chain(
        documents
            .iter()
            .map(|document| document.message.timestamp.clone()),
    ) {
        if timestamp.is_empty() {
            continue;
        }
        if started.as_ref().is_none_or(|value| timestamp < *value) {
            started = Some(timestamp.clone());
        }
        if ended.as_ref().is_none_or(|value| timestamp > *value) {
            ended = Some(timestamp);
        }
    }
    let started = started.unwrap_or_else(|| fallback.to_owned());
    let ended = ended.unwrap_or_else(|| started.clone());
    (started, ended)
}

pub(crate) fn fallback_timestamp(file: &SourceFile) -> String {
    if let Some(date) = &file.path_date {
        return format!("{date}T00:00:00.000Z");
    }
    // A mutable file mtime would make a rejected/private append alter the
    // projected session metadata. Keep the no-timestamp fallback stable.
    "1970-01-01T00:00:00.000Z".to_owned()
}

pub(crate) fn fallback_session_id(file: &SourceFile) -> String {
    use sha2::{Digest, Sha256};

    let stem = file
        .file_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("session");
    let digest = Sha256::digest(file.file_path.to_string_lossy().as_bytes());
    format!("{stem}-{}", hex::encode(digest))
}

/// Test-only writer shared by the source adapter tests and the app e2e
/// tests so zstd fixtures are encoded exactly one way.
#[cfg(test)]
pub(crate) fn write_zstd_lines(path: &std::path::Path, lines: &[String]) {
    use std::io::Write;

    let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), 0).unwrap();
    for line in lines {
        encoder.write_all(line.as_bytes()).unwrap();
        encoder.write_all(b"\n").unwrap();
    }
    let bytes = encoder.finish().unwrap();
    std::fs::write(path, bytes).unwrap();
}

#[cfg(test)]
mod tests;
