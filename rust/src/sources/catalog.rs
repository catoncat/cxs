use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::{LazyLock, Mutex};

use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::identity::SourceId;
use crate::model::{DateRange, SourceInventory, SourceInventoryCwdGroup, SourceSnapshot};
use crate::selector::{Selector, SelectorFile, selector_contains_file};

use super::jsonl::{file_identity, io_error, metadata_times};
use super::{
    ProjectionCheckpoint, ProjectionOutcome, SourceError, SourceFile, SourceMetadataCache,
    SourceScan, SourceScanFailure,
};
use super::{claude_code, codex, dsh, pi};

const CODEX_ACCEPTED_PREFIX: &str = "accepted-v1:codex:";
const CLAUDE_ACCEPTED_PREFIX: &str = "accepted-v1:claude-code:";
const PI_ACCEPTED_PREFIX: &str = "accepted-v1:pi:";
const DSH_ACCEPTED_PREFIX: &str = "accepted-v1:dsh:";

#[derive(Clone, Debug)]
pub(crate) struct AcceptedMetadata {
    pub cwd: String,
    pub path_date: Option<String>,
    pub fingerprint: String,
}

/// Registry and source gateway. Adapters are intentionally static and private;
/// adding a source is a product/schema change, not runtime plugin discovery.
#[derive(Clone, Copy, Debug, Default)]
pub struct SourceCatalog;

#[cfg(test)]
static INJECTED_METADATA_FAILURES: LazyLock<Mutex<std::collections::HashSet<PathBuf>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

#[cfg(test)]
pub(crate) struct InjectedMetadataFailureGuard {
    path: PathBuf,
}

#[cfg(test)]
impl Drop for InjectedMetadataFailureGuard {
    fn drop(&mut self) {
        INJECTED_METADATA_FAILURES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.path);
    }
}

#[cfg(test)]
pub(crate) fn inject_metadata_failure(path: impl Into<PathBuf>) -> InjectedMetadataFailureGuard {
    let path = path.into();
    let inserted = INJECTED_METADATA_FAILURES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(path.clone());
    assert!(inserted, "metadata failure already injected for {path:?}");
    InjectedMetadataFailureGuard { path }
}

#[cfg(test)]
fn metadata_failure_injected(path: &Path) -> bool {
    INJECTED_METADATA_FAILURES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains(path)
}

#[cfg(not(test))]
fn metadata_failure_injected(_path: &Path) -> bool {
    false
}

impl SourceCatalog {
    pub fn scan(
        &self,
        selector: &Selector,
        cache: &SourceMetadataCache,
    ) -> Result<SourceScan, SourceError> {
        let source_id = selector.source();
        let root = PathBuf::from(selector.root());
        let mut files = Vec::new();
        let mut failures = Vec::new();

        let root_metadata = fs::metadata(&root)
            .map_err(|source| io_error("stat source root", root.clone(), source))?;
        if !root_metadata.is_dir() {
            return Err(io_error(
                "open source root",
                root,
                std::io::Error::new(
                    std::io::ErrorKind::NotADirectory,
                    "source root is not a directory",
                ),
            ));
        }

        for item in WalkDir::new(&root).follow_links(false) {
            let entry = item.map_err(|error| {
                let path = error
                    .path()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| root.clone());
                io_error(
                    "walk source root",
                    path,
                    error
                        .into_io_error()
                        .unwrap_or_else(|| std::io::Error::other("source traversal failed")),
                )
            })?;
            if !entry.file_type().is_file() || !source_file_accepted(source_id, entry.path()) {
                continue;
            }
            if entry.path().to_str().is_none() {
                failures.push(scan_failure(
                    entry.path(),
                    "decode source path",
                    SourceError::NonUtf8Path(entry.path().to_path_buf()),
                ));
                continue;
            }

            let metadata = match fs::metadata(entry.path()) {
                Ok(metadata) => metadata,
                Err(source) => {
                    failures.push(scan_failure(
                        entry.path(),
                        "stat source file",
                        io_error("stat source file", entry.path().to_path_buf(), source),
                    ));
                    continue;
                }
            };
            let (mtime_ns, mtime_ms) = metadata_times(&metadata);
            let size = metadata.len();
            let identity = file_identity(entry.path(), &metadata);
            let accepted = if let Some(cached) = cache
                .matching(source_id, entry.path(), mtime_ns, size, &identity)
                .filter(|cached| {
                    accepted_fingerprint_is_current(source_id, &cached.accepted_fingerprint)
                }) {
                Ok(Some(AcceptedMetadata {
                    cwd: cached.cwd.clone(),
                    path_date: cached.path_date.clone(),
                    fingerprint: cached.accepted_fingerprint.clone(),
                }))
            } else {
                accepted_metadata(source_id, entry.path())
            };
            let accepted = match accepted {
                Ok(accepted) => accepted,
                Err(error) => {
                    failures.push(scan_failure(
                        entry.path(),
                        "read accepted source metadata",
                        error,
                    ));
                    continue;
                }
            };
            let Some(accepted) = accepted else {
                continue;
            };
            let accepted = version_accepted_metadata(source_id, accepted);

            files.push(SourceFile {
                source_id,
                file_path: entry.path().to_path_buf(),
                path_date: accepted.path_date,
                cwd: accepted.cwd,
                mtime_ms,
                mtime_ns,
                size,
                identity,
                accepted_fingerprint: accepted.fingerprint,
            });
        }

        files.sort_by(|left, right| left.file_path.cmp(&right.file_path));
        failures.sort_by(|left, right| left.file_path.cmp(&right.file_path));
        let inventory = build_inventory(&root, &files, failures.len());
        let selected: Vec<&SourceFile> = files
            .iter()
            .filter(|file| {
                selector_contains_file(
                    selector,
                    SelectorFile {
                        path_date: file.path_date.as_deref(),
                        cwd: &file.cwd,
                    },
                )
            })
            .collect();
        let snapshot = SourceSnapshot {
            selector: selector.clone(),
            fingerprint: fingerprint_files(&root, &selected, &failures, true),
            file_set_fingerprint: fingerprint_files(&root, &selected, &failures, false),
            file_count: (selected.len() + failures.len()) as u64,
            files: selected.into_iter().map(SourceFile::as_file_meta).collect(),
        };

        Ok(SourceScan {
            files,
            inventory,
            snapshot,
            failures,
        })
    }

    pub fn project(
        &self,
        file: &SourceFile,
        read_limit: u64,
        checkpoint: Option<&ProjectionCheckpoint>,
    ) -> Result<ProjectionOutcome, SourceError> {
        match file.source_id {
            SourceId::Codex => codex::project(file, read_limit, checkpoint),
            SourceId::ClaudeCode => claude_code::project(file, read_limit, checkpoint),
            SourceId::Pi => pi::project(file, read_limit, checkpoint),
            SourceId::Dsh => dsh::project(file, read_limit, checkpoint),
        }
    }
}

fn source_file_accepted(source_id: SourceId, path: &Path) -> bool {
    let extension = path.extension().and_then(|value| value.to_str());
    match source_id {
        // DSH sessions are always zstd-compressed; the adapter decodes every
        // accepted file as zstd, so accepting a plain `.jsonl` here would turn
        // format drift into a hard sync failure instead of a skip.
        SourceId::Dsh => matches!(extension, Some("zstd" | "zst")),
        _ => extension == Some("jsonl"),
    }
}

fn accepted_metadata(
    source_id: SourceId,
    path: &Path,
) -> Result<Option<AcceptedMetadata>, SourceError> {
    if metadata_failure_injected(path) {
        return Err(io_error(
            "read accepted source metadata",
            path,
            std::io::Error::other("injected accepted metadata failure"),
        ));
    }
    match source_id {
        SourceId::Codex => codex::inventory_metadata(path).map(Some),
        SourceId::ClaudeCode => claude_code::inventory_metadata(path),
        SourceId::Pi => pi::inventory_metadata(path),
        SourceId::Dsh => dsh::inventory_metadata(path),
    }
}

fn accepted_fingerprint_prefix(source_id: SourceId) -> &'static str {
    match source_id {
        SourceId::Codex => CODEX_ACCEPTED_PREFIX,
        SourceId::ClaudeCode => CLAUDE_ACCEPTED_PREFIX,
        SourceId::Pi => PI_ACCEPTED_PREFIX,
        SourceId::Dsh => DSH_ACCEPTED_PREFIX,
    }
}

fn accepted_fingerprint_is_current(source_id: SourceId, fingerprint: &str) -> bool {
    fingerprint.starts_with(accepted_fingerprint_prefix(source_id))
}

fn version_accepted_metadata(
    source_id: SourceId,
    mut metadata: AcceptedMetadata,
) -> AcceptedMetadata {
    if !accepted_fingerprint_is_current(source_id, &metadata.fingerprint) {
        metadata.fingerprint = format!(
            "{}{}",
            accepted_fingerprint_prefix(source_id),
            metadata.fingerprint
        );
    }
    metadata
}

fn scan_failure(path: &Path, fallback_operation: &str, error: SourceError) -> SourceScanFailure {
    let operation = match &error {
        SourceError::Io { operation, .. } => (*operation).to_owned(),
        SourceError::NonUtf8Path(_) => "decode source path".to_owned(),
        _ => fallback_operation.to_owned(),
    };
    SourceScanFailure {
        file_path: path.to_path_buf(),
        operation,
        message: error.to_string(),
    }
}

fn build_inventory(root: &Path, files: &[SourceFile], failure_count: usize) -> SourceInventory {
    let mut by_cwd: HashMap<&str, Vec<&SourceFile>> = HashMap::new();
    for file in files {
        if !file.cwd.is_empty() {
            by_cwd.entry(&file.cwd).or_default().push(file);
        }
    }
    let mut cwd_groups: Vec<SourceInventoryCwdGroup> = by_cwd
        .into_iter()
        .map(|(cwd, files)| SourceInventoryCwdGroup {
            cwd: cwd.to_owned(),
            file_count: files.len() as u64,
            path_date_range: date_range(
                files
                    .into_iter()
                    .filter_map(|file| file.path_date.as_deref()),
            ),
        })
        .collect();
    cwd_groups.sort_by(|left, right| {
        right
            .file_count
            .cmp(&left.file_count)
            .then_with(|| left.cwd.cmp(&right.cwd))
    });

    SourceInventory {
        root: root.to_string_lossy().into_owned(),
        total_files: (files.len() + failure_count) as u64,
        path_date_range: date_range(files.iter().filter_map(|file| file.path_date.as_deref())),
        cwd_groups,
    }
}

fn date_range<'a>(dates: impl IntoIterator<Item = &'a str>) -> DateRange {
    let mut from: Option<&str> = None;
    let mut to: Option<&str> = None;
    for date in dates {
        if from.is_none_or(|current| date < current) {
            from = Some(date);
        }
        if to.is_none_or(|current| date > current) {
            to = Some(date);
        }
    }
    DateRange {
        from: from.map(str::to_owned),
        to: to.map(str::to_owned),
    }
}

fn fingerprint_files(
    root: &Path,
    files: &[&SourceFile],
    failures: &[SourceScanFailure],
    include_content: bool,
) -> String {
    enum Member<'a> {
        File(&'a SourceFile),
        Failure(&'a SourceScanFailure),
    }

    impl Member<'_> {
        fn path(&self) -> &Path {
            match self {
                Self::File(file) => &file.file_path,
                Self::Failure(failure) => &failure.file_path,
            }
        }
    }

    let mut hasher = Sha256::new();
    hasher.update(root.to_string_lossy().as_bytes());
    let mut members = files
        .iter()
        .copied()
        .map(Member::File)
        .chain(failures.iter().map(Member::Failure))
        .collect::<Vec<_>>();
    members.sort_by(|left, right| left.path().cmp(right.path()));

    for member in members {
        let relative = member.path().strip_prefix(root).unwrap_or(member.path());
        hasher.update([0]);
        hasher.update(relative.to_string_lossy().as_bytes());
        match member {
            Member::File(file) if include_content => {
                hasher.update([0]);
                hasher.update(file.path_date.as_deref().unwrap_or_default().as_bytes());
                hasher.update([0]);
                hasher.update(file.cwd.as_bytes());
                hasher.update([0]);
                hasher.update(file.accepted_fingerprint.as_bytes());
            }
            Member::Failure(failure) => {
                hasher.update([0]);
                hasher.update(b"source_scan_failure");
                hasher.update([0]);
                hasher.update(failure.operation.as_bytes());
            }
            Member::File(_) => {}
        }
    }
    hex::encode(hasher.finalize())
}

impl From<&SourceFile> for super::CachedSourceMetadata {
    fn from(file: &SourceFile) -> Self {
        Self {
            source_id: file.source_id,
            file_path: file.file_path.clone(),
            mtime_ns: file.mtime_ns,
            size: file.size,
            file_identity: file.identity.clone(),
            path_date: file.path_date.clone(),
            cwd: file.cwd.clone(),
            accepted_fingerprint: file.accepted_fingerprint.clone(),
        }
    }
}
