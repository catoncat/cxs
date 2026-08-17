//! Single-writer ingest state machine.
//!
//! `run` is the only public operation. It owns the strict snapshot A ->
//! bounded projection -> snapshot B -> atomic commit sequence; callers never
//! assemble source and index operations themselves.

mod cold;
mod cold_state;
mod cutover;
mod lock;
mod pipeline;
mod stage;
mod transition;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::INDEX_VERSION;
use crate::identity::SessionIdentity;
use crate::index::{
    ANALYZER_EPOCH, COVERAGE_EPOCH, CoverageWrite, IndexLayout, IndexReader, IndexTransaction,
    IndexWriter, MessageWrite, PROJECTION_EPOCH, SessionWrite, SourceFileState,
};
use crate::model::{
    CoverageWriteStaleReason, CoverageWriteSummary, RecommendedAction, SourceKind, SyncErrorDetail,
};
use crate::selector::Selector;
use crate::sources::{
    CachedSourceMetadata, EmptyProjection, FileStamp, ProjectedSource, ProjectionCheckpoint,
    ProjectionMode, ProjectionOutcome, ReadProof, SourceCatalog, SourceFile, SourceMetadataCache,
    SourceScan,
};

use cold::collect_cold_native_ids;
use cold_state::normalize_pending_roots;
pub use cold_state::{
    ColdRootMutation, PendingColdRoot, RegisteredColdRoot, SyncStateError, add_cold_root,
    add_cold_root_with_cutover, list_cold_roots, remove_cold_root, remove_cold_root_with_cutover,
};
pub use cutover::LegacyCutover;
use cutover::NoopLegacyCutover;
pub(crate) use lock::SyncLock;
use pipeline::{ProjectionInput, project_bounded};
use stage::{ProjectionStage, StagedProjection};
pub use transition::SnapshotTransition;
use transition::{
    PersistedPrefixProof, ProjectionProof, TransitionAssessment, classify_transition,
};

static SCRATCH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
pub struct SyncRequest {
    pub db_path: PathBuf,
    pub selector: Selector,
    pub best_effort: bool,
    pub prune: bool,
    /// Extra roots for this invocation. Registered v8 cold roots are merged in
    /// automatically before an explicit prune.
    pub cold_roots: Vec<PathBuf>,
    /// One-shot legacy/config registrations for every source in a first
    /// scratch-v8 sync. Existing v8 databases ignore this field so stale
    /// bootstrap JSON cannot resurrect a removed registration.
    pub pending_cold_roots: Vec<PendingColdRoot>,
    pub worker_count: usize,
}

impl SyncRequest {
    pub fn new(db_path: impl Into<PathBuf>, selector: Selector) -> Self {
        Self {
            db_path: db_path.into(),
            selector,
            best_effort: false,
            prune: false,
            cold_roots: Vec::new(),
            pending_cold_roots: Vec::new(),
            worker_count: 16,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub scanned: u64,
    pub added: u64,
    pub updated: u64,
    pub skipped: u64,
    pub filtered: u64,
    pub removed: u64,
    pub retained_cold: u64,
    pub errors: u64,
    pub error_details: Vec<SyncErrorDetail>,
    pub selector: Selector,
    pub coverage: CoverageWriteSummary,
}

impl SyncReport {
    fn empty(selector: Selector, reason: &str) -> Self {
        Self {
            scanned: 0,
            added: 0,
            updated: 0,
            skipped: 0,
            filtered: 0,
            removed: 0,
            retained_cold: 0,
            errors: 0,
            error_details: Vec::new(),
            coverage: skipped_coverage(&selector, "", "", 0, reason),
            selector,
        }
    }

    fn record_error(&mut self, file_path: impl Into<String>, message: impl Into<String>) {
        self.errors = self.errors.saturating_add(1);
        self.error_details.push(SyncErrorDetail {
            file_path: file_path.into(),
            message: message.into(),
        });
    }
}

#[derive(Debug)]
pub struct SyncFailure {
    pub report: Box<SyncReport>,
}

impl fmt::Display for SyncFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(
            formatter,
            "sync failed with {} error(s)",
            self.report.errors
        )?;
        for detail in &self.report.error_details {
            writeln!(formatter, "{}: {}", detail.file_path, detail.message)?;
        }
        Ok(())
    }
}

impl std::error::Error for SyncFailure {}

fn sync_failure(report: SyncReport) -> SyncFailure {
    SyncFailure {
        report: Box::new(report),
    }
}

pub fn run(request: SyncRequest) -> Result<SyncReport, SyncFailure> {
    run_with_cutover(request, &mut NoopLegacyCutover)
}

pub fn run_with_cutover(
    request: SyncRequest,
    cutover: &mut impl LegacyCutover,
) -> Result<SyncReport, SyncFailure> {
    run_with_catalog(request, SourceCatalog, cutover)
}

fn run_with_catalog(
    request: SyncRequest,
    catalog: SourceCatalog,
    cutover: &mut impl LegacyCutover,
) -> Result<SyncReport, SyncFailure> {
    run_with_snapshot_hook_and_cutover(request, catalog, || {}, cutover)
}

#[cfg(test)]
fn run_with_snapshot_hook(
    request: SyncRequest,
    catalog: SourceCatalog,
    before_snapshot_b: impl FnOnce(),
) -> Result<SyncReport, SyncFailure> {
    run_with_snapshot_hook_and_cutover(request, catalog, before_snapshot_b, &mut NoopLegacyCutover)
}

fn run_with_snapshot_hook_and_cutover(
    request: SyncRequest,
    catalog: SourceCatalog,
    before_snapshot_b: impl FnOnce(),
    cutover: &mut impl LegacyCutover,
) -> Result<SyncReport, SyncFailure> {
    let mut report = SyncReport::empty(request.selector.clone(), "not_written");
    if let Err(error) = require_source_root(request.selector.root()) {
        report.coverage.reason = Some("source_unavailable".to_owned());
        report.record_error(request.selector.root(), error.to_string());
        if request.db_path.exists() {
            match SyncLock::acquire(&request.db_path) {
                Ok(_lock) => {
                    return Err(sync_failure_after_invalidation(&request, report));
                }
                Err(error) => {
                    report.record_error(request.db_path.to_string_lossy(), error.to_string());
                }
            }
        }
        return Err(sync_failure(report));
    }
    let _lock = match SyncLock::acquire(&request.db_path) {
        Ok(lock) => lock,
        Err(error) => {
            report.record_error(request.db_path.to_string_lossy(), error.to_string());
            return Err(sync_failure(report));
        }
    };
    if let Err(error) = require_source_root(request.selector.root()) {
        report.coverage.reason = Some("source_unavailable".to_owned());
        report.record_error(request.selector.root(), error.to_string());
        return Err(sync_failure_after_invalidation(&request, report));
    }
    if let Err(error) = cutover.preflight() {
        report.record_error("(legacy cutover)", format!("preflight failed: {error}"));
        return Err(sync_failure_after_invalidation(&request, report));
    }

    let existing = match load_existing_state(&request) {
        Ok(existing) => existing,
        Err(error) => {
            report.record_error(request.db_path.to_string_lossy(), error);
            return Err(sync_failure_after_invalidation(&request, report));
        }
    };
    // Legacy JSON is a one-shot bootstrap input. Once a v8 database exists,
    // SQLite is the only truth and stale JSON must never resurrect a root that
    // a locked v8 writer removed.
    let pending_cold_roots = if existing.index_exists {
        Vec::new()
    } else {
        match normalize_pending_roots(&request.pending_cold_roots) {
            Ok(roots) => roots,
            Err(error) => {
                report.record_error("(cold roots)", error.to_string());
                return Err(sync_failure_after_invalidation(&request, report));
            }
        }
    };
    let cache = metadata_cache(&existing.source_files);
    let before_scan = match catalog.scan(&request.selector, &cache) {
        Ok(scan) => scan,
        Err(error) => {
            report.coverage.reason = Some("source_unavailable".to_owned());
            report.record_error(request.selector.root(), error.to_string());
            return Err(sync_failure_after_invalidation(&request, report));
        }
    };
    let before_files = selected_files(&before_scan);
    report.scanned = before_scan.snapshot.file_count;
    report.coverage = skipped_coverage(
        &request.selector,
        &before_scan.snapshot.fingerprint,
        &before_scan.snapshot.file_set_fingerprint,
        before_scan.snapshot.file_count,
        "not_written",
    );
    let mut scan_error_keys = BTreeSet::new();
    record_scan_failures(&mut report, &before_scan, &mut scan_error_keys);
    if !before_scan.failures.is_empty() && !request.best_effort {
        report.coverage.reason = Some("source_scan_incomplete".to_owned());
        return Err(sync_failure_after_invalidation(&request, report));
    }

    let state_by_path = existing
        .source_files
        .into_iter()
        .map(|state| (state.file_path.clone(), state))
        .collect::<HashMap<_, _>>();
    let (inputs, unchanged_paths, state_refreshes) =
        projection_inputs(&before_files, &state_by_path);
    report.skipped = unchanged_paths.len() as u64;

    let stage_parent = request
        .db_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut stage = match ProjectionStage::create(stage_parent) {
        Ok(stage) => stage,
        Err(error) => {
            report.record_error("(staging)", error.to_string());
            return Err(sync_failure_after_invalidation(&request, report));
        }
    };
    let projection_failures =
        match project_bounded(catalog, &inputs, request.worker_count, &mut stage) {
            Ok(failures) => failures,
            Err(error) => {
                report.record_error("(staging)", error.to_string());
                return Err(sync_failure_after_invalidation(&request, report));
            }
        };
    for failure in projection_failures {
        report.record_error(failure.file_path, failure.message);
    }
    if report.errors > 0 && !request.best_effort {
        return Err(sync_failure_after_invalidation(&request, report));
    }

    before_snapshot_b();
    // Snapshot B can trust metadata from snapshot A only when the exact
    // mtime/size/file identity still match. This avoids a second full logical
    // metadata pass for stable files without weakening concurrent-change
    // detection.
    let after_cache =
        SourceMetadataCache::from_entries(before_scan.files.iter().map(CachedSourceMetadata::from));
    let after_scan = match catalog.scan(&request.selector, &after_cache) {
        Ok(scan) => scan,
        Err(error) => {
            report.coverage.reason = Some("source_unavailable".to_owned());
            report.record_error(request.selector.root(), error.to_string());
            return Err(sync_failure_after_invalidation(&request, report));
        }
    };
    record_scan_failures(&mut report, &after_scan, &mut scan_error_keys);
    if !after_scan.failures.is_empty() && !request.best_effort {
        report.coverage.reason = Some("source_scan_incomplete".to_owned());
        return Err(sync_failure_after_invalidation(&request, report));
    }
    let after_files = selected_files(&after_scan);
    let validation =
        match validate_projection_stage(&stage, &before_files, &after_files, &state_by_path) {
            Ok(validation) => validation,
            Err(error) => {
                report.record_error("(staging)", error.to_string());
                return Err(sync_failure_after_invalidation(&request, report));
            }
        };
    for detail in &validation.errors {
        report.record_error(detail.file_path.clone(), detail.message.clone());
    }
    if !validation.errors.is_empty() && !request.best_effort {
        return Err(sync_failure_after_invalidation(&request, report));
    }

    let persisted_proofs = persisted_append_proofs(
        &before_files,
        &after_files,
        &state_by_path,
        &validation.staged_paths,
    );
    let assessment = classify_transition(
        request.selector.source(),
        &before_files,
        &before_scan.snapshot.file_set_fingerprint,
        &after_files,
        &after_scan.snapshot.file_set_fingerprint,
        &validation.changed_proofs,
        &persisted_proofs,
    );
    if assessment.kind == SnapshotTransition::Rejected && !request.best_effort {
        report.record_error(
            "(selector)",
            format!(
                "source changed during strict sync ({})",
                assessment.reason.unwrap_or("unproven_change")
            ),
        );
        return Err(sync_failure_after_invalidation(&request, report));
    }

    let mut omitted_paths = validation.invalid_paths;
    omitted_paths.extend(assessment.deferred_paths.iter().cloned());
    let existing_cold_roots = existing
        .cold_roots
        .into_iter()
        .map(|root| root.to_string_lossy().into_owned())
        .collect::<HashSet<_>>();
    let scan_complete = before_scan.failures.is_empty() && after_scan.failures.is_empty();
    let allow_prune = request.prune && scan_complete;
    let cold_ids = if allow_prune {
        let roots = merge_cold_roots(
            existing_cold_roots
                .iter()
                .map(PathBuf::from)
                .chain(
                    pending_cold_roots
                        .iter()
                        .filter(|entry| entry.source_id == request.selector.source())
                        .map(|entry| PathBuf::from(&entry.root)),
                )
                .collect(),
            request.cold_roots.clone(),
        );
        match collect_cold_native_ids(request.selector.source(), &roots) {
            Ok(ids) => ids.into_iter().collect::<HashSet<_>>(),
            Err(error) => {
                report.record_error("(cold roots)", error.to_string());
                return Err(sync_failure_after_invalidation(&request, report));
            }
        }
    } else {
        HashSet::new()
    };

    let retained_hot_paths = before_files
        .iter()
        .map(|file| file.file_path.to_string_lossy().into_owned())
        .collect::<HashSet<_>>();
    let write_result = write_index(
        &request,
        &stage,
        &state_by_path,
        &state_refreshes,
        &omitted_paths,
        &retained_hot_paths,
        &cold_ids,
        &pending_cold_roots,
        &existing_cold_roots,
        &before_scan,
        &assessment,
        allow_prune,
        cutover,
    );
    let applied = match write_result {
        Ok(applied) => applied,
        Err(error) => {
            report.record_error("(index)", error);
            return Err(sync_failure_after_invalidation(&request, report));
        }
    };

    report.added = applied.added;
    report.updated = applied.updated;
    report.filtered = applied.filtered;
    report.skipped = report.skipped.saturating_add(applied.skipped);
    report.removed = applied.removed;
    report.retained_cold = applied.retained_cold;
    report.coverage = applied.coverage;
    if assessment.kind == SnapshotTransition::AppendOnly
        && report.coverage.written
        && before_scan.snapshot.fingerprint != after_scan.snapshot.fingerprint
    {
        report.coverage.stale_reason = Some(CoverageWriteStaleReason::SourceContentChanged);
        report.coverage.recommended_action = Some(RecommendedAction::Query);
    }
    if assessment.kind == SnapshotTransition::Deferred {
        report.coverage.reason = Some("active_source_deferred".to_owned());
        report.coverage.recommended_action = Some(RecommendedAction::Sync);
    }
    Ok(report)
}

struct ExistingState {
    index_exists: bool,
    source_files: Vec<SourceFileState>,
    cold_roots: Vec<PathBuf>,
}

fn load_existing_state(request: &SyncRequest) -> Result<ExistingState, String> {
    if !request.db_path.exists() {
        return Ok(ExistingState {
            index_exists: false,
            source_files: Vec::new(),
            cold_roots: Vec::new(),
        });
    }
    let reader = IndexReader::open(&request.db_path).map_err(|error| error.to_string())?;
    if reader.layout() != IndexLayout::V8 {
        return Err("v7 index requires explicit copy migration before Rust sync".to_owned());
    }
    let source_files = reader
        .source_files_for_selector(&request.selector)
        .map_err(|error| error.to_string())?;
    let cold_roots = reader
        .cold_roots(Some(request.selector.source()))
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|root| PathBuf::from(root.root))
        .collect();
    Ok(ExistingState {
        index_exists: true,
        source_files,
        cold_roots,
    })
}

/// Remove every proof for the failed source/root. A partial broad sync can
/// mutate rows covered by a narrow proof, and a partial narrow sync can
/// invalidate a broad proof, so selector implication is insufficient in both
/// directions. This never creates a database or mutates searchable content.
/// The caller already holds `SyncLock`, ordering it with every other v8 writer.
fn invalidate_existing_coverage(request: &SyncRequest) -> Result<(), String> {
    if !request.db_path.exists() {
        return Ok(());
    }
    let mut writer = IndexWriter::open_v8(&request.db_path).map_err(|error| error.to_string())?;
    let mut transaction = writer.begin().map_err(|error| error.to_string())?;
    transaction
        .invalidate_coverage_for_source_root(request.selector.source(), request.selector.root())
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

fn sync_failure_after_invalidation(request: &SyncRequest, mut report: SyncReport) -> SyncFailure {
    if let Err(error) = invalidate_existing_coverage(request) {
        report.record_error(
            "(coverage)",
            format!("failed to invalidate incomplete coverage: {error}"),
        );
    }
    sync_failure(report)
}

fn metadata_cache(states: &[SourceFileState]) -> SourceMetadataCache {
    SourceMetadataCache::from_entries(states.iter().filter_map(|state| {
        if state.projection_epoch != PROJECTION_EPOCH
            || state.analyzer_epoch != ANALYZER_EPOCH
            || state.coverage_epoch != COVERAGE_EPOCH
        {
            return None;
        }
        let mtime_ns = i128::from(state.mtime_ns.filter(|value| *value > 0)?);
        let checkpoint = state
            .reducer_checkpoint
            .as_deref()
            .and_then(|value| serde_json::from_slice::<ProjectionCheckpoint>(value).ok())?;
        if checkpoint.source_id != state.source_id {
            return None;
        }
        Some(CachedSourceMetadata {
            source_id: state.source_id,
            file_path: PathBuf::from(&state.file_path),
            mtime_ns,
            size: state.size,
            file_identity: checkpoint.file_identity,
            path_date: state.path_date.clone(),
            cwd: state.cwd.clone(),
            accepted_fingerprint: state.extra_fingerprint.clone(),
        })
    }))
}

fn selected_files(scan: &SourceScan) -> Vec<SourceFile> {
    let selected = scan
        .snapshot
        .files
        .iter()
        .map(|file| file.file_path.as_str())
        .collect::<HashSet<_>>();
    scan.files
        .iter()
        .filter(|file| selected.contains(file.file_path.to_string_lossy().as_ref()))
        .cloned()
        .collect()
}

fn projection_inputs(
    files: &[SourceFile],
    states: &HashMap<String, SourceFileState>,
) -> (
    Vec<ProjectionInput>,
    BTreeSet<PathBuf>,
    Vec<SourceFileState>,
) {
    let mut inputs = Vec::new();
    let mut unchanged = BTreeSet::new();
    let mut refreshes = Vec::new();
    for file in files {
        let path = file.file_path.to_string_lossy();
        let state = states.get(path.as_ref());
        if state.is_some_and(|state| source_file_unchanged(state, file)) {
            unchanged.insert(file.file_path.clone());
            continue;
        }
        if let Some(refreshed) = state.and_then(|state| identity_only_refresh(state, file)) {
            unchanged.insert(file.file_path.clone());
            refreshes.push(refreshed);
            continue;
        }
        let checkpoint = state
            .filter(|state| state.projection_epoch == PROJECTION_EPOCH)
            .and_then(|state| state.reducer_checkpoint.as_deref())
            .and_then(|value| serde_json::from_slice::<ProjectionCheckpoint>(value).ok());
        inputs.push(ProjectionInput {
            file: file.clone(),
            checkpoint,
        });
    }
    (inputs, unchanged, refreshes)
}

fn source_file_unchanged(state: &SourceFileState, file: &SourceFile) -> bool {
    source_file_projection_metadata_matches(state, file)
        && state.file_path == file.file_path.to_string_lossy()
        && state
            .mtime_ns
            .is_some_and(|mtime_ns| mtime_ns > 0 && i128::from(mtime_ns) == file.mtime_ns)
        && persisted_checkpoint(state)
            .is_some_and(|checkpoint| checkpoint.file_identity == file.identity)
}

fn source_file_projection_metadata_matches(state: &SourceFileState, file: &SourceFile) -> bool {
    state.source_id == file.source_id
        && state.file_path == file.file_path.to_string_lossy()
        && state.size == file.size
        && state.cwd == file.cwd
        && state.path_date == file.path_date
        && state.extra_fingerprint == file.accepted_fingerprint
        && state.projection_epoch == PROJECTION_EPOCH
        && state.analyzer_epoch == ANALYZER_EPOCH
        && state.coverage_epoch == COVERAGE_EPOCH
}

fn persisted_checkpoint(state: &SourceFileState) -> Option<ProjectionCheckpoint> {
    state
        .reducer_checkpoint
        .as_deref()
        .and_then(|value| serde_json::from_slice(value).ok())
}

/// Refresh filesystem identity only after proving the raw bytes are identical.
/// The accepted projection fingerprint alone is insufficient because rejected
/// records and JSON formatting still affect persisted raw byte locators.
fn identity_only_refresh(state: &SourceFileState, file: &SourceFile) -> Option<SourceFileState> {
    if !source_file_projection_metadata_matches(state, file)
        || state.head_digest.is_empty()
        || fingerprint_prefix(&file.file_path, file.size).ok()? != state.head_digest
    {
        return None;
    }
    let mut checkpoint = persisted_checkpoint(state)?;
    if checkpoint.source_id != file.source_id
        || checkpoint.indexed_bytes != state.indexed_bytes
        || checkpoint.prefix_digest != state.boundary_digest
        || checkpoint.next_seq != state.next_seq
    {
        return None;
    }
    checkpoint.file_identity = file.identity.clone();
    let mut refreshed = state.clone();
    refreshed.mtime_ms = file.mtime_ms;
    refreshed.mtime_ns = exact_mtime_ns(file.mtime_ns);
    refreshed.cwd.clone_from(&file.cwd);
    refreshed.path_date.clone_from(&file.path_date);
    refreshed
        .extra_fingerprint
        .clone_from(&file.accepted_fingerprint);
    refreshed.reducer_checkpoint = Some(serde_json::to_vec(&checkpoint).ok()?);
    Some(refreshed)
}

struct StageValidation {
    changed_proofs: Vec<ProjectionProof>,
    staged_paths: BTreeSet<PathBuf>,
    invalid_paths: BTreeSet<PathBuf>,
    errors: Vec<SyncErrorDetail>,
}

fn validate_projection_stage(
    stage: &ProjectionStage,
    before_files: &[SourceFile],
    after_files: &[SourceFile],
    states: &HashMap<String, SourceFileState>,
) -> io::Result<StageValidation> {
    let before = before_files
        .iter()
        .map(|file| (file.file_path.clone(), file))
        .collect::<BTreeMap<_, _>>();
    let after = after_files
        .iter()
        .map(|file| (file.file_path.clone(), file))
        .collect::<BTreeMap<_, _>>();
    let mut changed_proofs = Vec::new();
    let mut staged_paths = BTreeSet::new();
    let mut invalid_paths = BTreeSet::new();
    let mut errors = Vec::new();

    stage.read_all(|record| {
        let path = record.file.file_path.clone();
        staged_paths.insert(path.clone());
        let Some(before_file) = before.get(&path).copied() else {
            invalid_paths.insert(path.clone());
            errors.push(detail(&path, "staged file was not present in snapshot A"));
            return Ok(());
        };
        let Some(after_file) = after.get(&path).copied() else {
            invalid_paths.insert(path.clone());
            errors.push(detail(&path, "staged file disappeared before snapshot B"));
            return Ok(());
        };
        let (read, checkpoint, mode) = outcome_proof(&record.outcome);
        let current_prefix_matches = fingerprint_prefix(&path, checkpoint.indexed_bytes)
            .is_ok_and(|digest| digest == checkpoint.prefix_digest);
        let common_valid = read.requested_limit == before_file.size
            && read.effective_limit == before_file.size
            && read.byte_count == before_file.size
            && read.safe_offset == checkpoint.indexed_bytes
            && read.opened.identity == before_file.identity
            && read.completed.identity == before_file.identity
            && current_prefix_matches;
        if !common_valid {
            invalid_paths.insert(path.clone());
            errors.push(detail(&path, "bounded projection proof did not verify"));
            return Ok(());
        }
        if same_file_stamp(before_file, after_file) {
            if stamp(before_file) != read.opened || stamp(before_file) != read.completed {
                invalid_paths.insert(path.clone());
                errors.push(detail(&path, "source changed during bounded projection"));
            }
            return Ok(());
        }
        changed_proofs.push(ProjectionProof {
            path: path.clone(),
            read: read.clone(),
            mode,
            was_indexed: states
                .get(path.to_string_lossy().as_ref())
                .and_then(|state| state.session.as_ref())
                .is_some(),
            current_prefix_matches,
        });
        Ok(())
    })?;
    Ok(StageValidation {
        changed_proofs,
        staged_paths,
        invalid_paths,
        errors,
    })
}

fn persisted_append_proofs(
    before_files: &[SourceFile],
    after_files: &[SourceFile],
    states: &HashMap<String, SourceFileState>,
    staged_paths: &BTreeSet<PathBuf>,
) -> Vec<PersistedPrefixProof> {
    let after = after_files
        .iter()
        .map(|file| (file.file_path.as_path(), file))
        .collect::<HashMap<_, _>>();
    before_files
        .iter()
        .filter(|file| {
            !staged_paths.contains(&file.file_path)
                && after
                    .get(file.file_path.as_path())
                    .is_some_and(|right| !same_file_stamp(file, right))
        })
        .map(|file| {
            let state = states.get(file.file_path.to_string_lossy().as_ref());
            let current_prefix_matches = state.is_some_and(|state| {
                !state.boundary_digest.is_empty()
                    && fingerprint_prefix(&file.file_path, state.indexed_bytes)
                        .is_ok_and(|digest| digest == state.boundary_digest)
            });
            PersistedPrefixProof {
                path: file.file_path.clone(),
                current_prefix_matches,
            }
        })
        .collect()
}

struct AppliedCounts {
    added: u64,
    updated: u64,
    filtered: u64,
    skipped: u64,
    removed: u64,
    retained_cold: u64,
    coverage: CoverageWriteSummary,
}

#[allow(clippy::too_many_arguments)]
fn write_index(
    request: &SyncRequest,
    stage: &ProjectionStage,
    states: &HashMap<String, SourceFileState>,
    state_refreshes: &[SourceFileState],
    omitted_paths: &BTreeSet<PathBuf>,
    retained_hot_paths: &HashSet<String>,
    cold_ids: &HashSet<String>,
    pending_cold_roots: &[RegisteredColdRoot],
    existing_cold_roots: &HashSet<String>,
    before_scan: &SourceScan,
    assessment: &TransitionAssessment,
    allow_prune: bool,
    cutover: &mut impl LegacyCutover,
) -> Result<AppliedCounts, String> {
    let active_exists = request.db_path.exists();
    let scratch = (!active_exists).then(|| scratch_index_path(&request.db_path));
    let write_path = scratch.as_deref().unwrap_or(&request.db_path);
    let mut writer = if active_exists {
        IndexWriter::open_v8(write_path)
    } else {
        IndexWriter::create_v8(write_path)
    }
    .map_err(|error| error.to_string())?;
    let mut applied = AppliedCounts {
        added: 0,
        updated: 0,
        filtered: 0,
        skipped: 0,
        removed: 0,
        retained_cold: 0,
        coverage: skipped_coverage(
            &request.selector,
            &before_scan.snapshot.fingerprint,
            &before_scan.snapshot.file_set_fingerprint,
            before_scan.snapshot.file_count,
            if request.best_effort {
                "best_effort"
            } else if assessment.kind == SnapshotTransition::Deferred {
                "active_source_deferred"
            } else {
                "not_written"
            },
        ),
    };
    let transaction_result = (|| {
        let mut transaction = writer.begin().map_err(|error| error.to_string())?;
        for refresh in state_refreshes {
            if omitted_paths.contains(Path::new(&refresh.file_path)) {
                continue;
            }
            let mut refresh = refresh.clone();
            refresh
                .source_generation
                .clone_from(&before_scan.snapshot.fingerprint);
            transaction
                .refresh_source_file(&refresh, rounded_mtime_ms(refresh.mtime_ms))
                .map_err(|error| error.to_string())?;
        }
        stage
            .read_all(|record| {
                if omitted_paths.contains(&record.file.file_path) {
                    return Ok(());
                }
                apply_staged(
                    &mut transaction,
                    request,
                    states,
                    &before_scan.snapshot.fingerprint,
                    record,
                    &mut applied,
                )
                .map_err(io::Error::other)
            })
            .map_err(|error| error.to_string())?;

        for root in pending_cold_roots {
            let added_at =
                (!existing_cold_roots.contains(&root.root)).then_some(root.added_at.as_str());
            transaction
                .upsert_cold_root(root.source_id, &root.root, added_at)
                .map_err(|error| error.to_string())?;
        }

        if allow_prune {
            let pruned = transaction
                .prune(&request.selector, retained_hot_paths, cold_ids)
                .map_err(|error| error.to_string())?;
            applied.removed = pruned.removed;
            applied.retained_cold = pruned.retained_cold;
            for state in states.values() {
                if !retained_hot_paths.contains(&state.file_path) {
                    transaction
                        .delete_source_file(state.source_id, &state.file_path)
                        .map_err(|error| error.to_string())?;
                }
            }
        }
        let counts = transaction
            .selector_counts(&request.selector)
            .map_err(|error| error.to_string())?;
        let write_coverage = !request.best_effort
            && assessment.kind != SnapshotTransition::Deferred
            && assessment.kind != SnapshotTransition::Rejected;
        if write_coverage {
            let coverage = CoverageWrite {
                selector: request.selector.clone(),
                source_fingerprint: before_scan.snapshot.fingerprint.clone(),
                source_file_set_fingerprint: before_scan.snapshot.file_set_fingerprint.clone(),
                source_file_count: before_scan.snapshot.file_count,
                indexed_session_count: counts.session_count,
                indexed_document_count: counts.document_count,
                source_generation: before_scan.snapshot.fingerprint.clone(),
                completed_at: None,
                index_version: INDEX_VERSION.to_owned(),
                projection_epoch: PROJECTION_EPOCH,
                analyzer_epoch: ANALYZER_EPOCH,
                coverage_epoch: COVERAGE_EPOCH,
            };
            transaction
                .replace_coverage(&coverage)
                .map_err(|error| error.to_string())?;
            applied.coverage = CoverageWriteSummary {
                written: true,
                selector: request.selector.clone(),
                source_fingerprint: coverage.source_fingerprint,
                source_file_set_fingerprint: coverage.source_file_set_fingerprint,
                source_file_count: coverage.source_file_count,
                indexed_session_count: coverage.indexed_session_count,
                reason: None,
                stale_reason: None,
                recommended_action: None,
            };
        } else {
            transaction
                .invalidate_coverage_for_source_root(
                    request.selector.source(),
                    request.selector.root(),
                )
                .map_err(|error| error.to_string())?;
        }
        cutover
            .publish()
            .map_err(|error| format!("publish legacy cutover: {error}"))?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok::<(), String>(())
    })();
    drop(writer);

    if let Err(error) = transaction_result {
        if let Some(path) = scratch.as_deref() {
            remove_sqlite_scratch(path);
        }
        return Err(error);
    }
    let publish_error = scratch
        .as_deref()
        .and_then(|path| publish_scratch_index(path, &request.db_path).err());
    let complete_error = cutover.complete().err();
    if let Some(error) = committed_cutover_error(publish_error, complete_error) {
        return Err(error);
    }
    Ok(applied)
}

fn apply_staged(
    transaction: &mut IndexTransaction<'_>,
    request: &SyncRequest,
    states: &HashMap<String, SourceFileState>,
    generation: &str,
    record: StagedProjection,
    applied: &mut AppliedCounts,
) -> Result<(), String> {
    let path = record.file.file_path.to_string_lossy().into_owned();
    let prior = states.get(&path);
    match record.outcome {
        ProjectionOutcome::Projected(projected) => {
            let identity = projection_identity(&projected)?;
            let session = session_write(request, &record.file, &projected, identity.clone());
            let messages = message_writes(&projected);
            match projected.mode {
                ProjectionMode::Delta => {
                    let prior = prior.ok_or_else(|| {
                        "delta projection has no persisted source cursor".to_owned()
                    })?;
                    if prior.session.as_ref() != Some(&identity) {
                        return Err("delta session identity differs from stored cursor".to_owned());
                    }
                    transaction
                        .append_session(&session, prior.next_seq, &messages)
                        .map_err(|error| error.to_string())?;
                    applied.updated = applied.updated.saturating_add(1);
                }
                ProjectionMode::Full => {
                    transaction
                        .replace_session(&session, &messages)
                        .map_err(|error| error.to_string())?;
                    if prior.and_then(|state| state.session.as_ref()).is_some() {
                        applied.updated = applied.updated.saturating_add(1);
                    } else {
                        applied.added = applied.added.saturating_add(1);
                    }
                }
            }
            let state = source_file_state(
                request,
                &record.file,
                generation,
                &projected.read_proof,
                &projected.checkpoint,
                Some(identity),
            )?;
            transaction
                .upsert_source_file(&state)
                .map_err(|error| error.to_string())?;
        }
        ProjectionOutcome::Filtered(empty) => {
            transaction
                .delete_filtered_file(record.file.source_id, &path)
                .map_err(|error| error.to_string())?;
            upsert_empty_state(transaction, request, &record.file, generation, &empty)?;
            applied.filtered = applied.filtered.saturating_add(1);
        }
        ProjectionOutcome::Skipped(empty) => {
            // A rewrite from accepted content to no accepted content must not
            // leave stale searchable evidence under complete coverage.
            transaction
                .delete_filtered_file(record.file.source_id, &path)
                .map_err(|error| error.to_string())?;
            upsert_empty_state(transaction, request, &record.file, generation, &empty)?;
            applied.skipped = applied.skipped.saturating_add(1);
        }
        ProjectionOutcome::FullRequired { .. } => {
            return Err("unresolved full projection fallback reached commit".to_owned());
        }
    }
    Ok(())
}

fn upsert_empty_state(
    transaction: &mut IndexTransaction<'_>,
    request: &SyncRequest,
    file: &SourceFile,
    generation: &str,
    empty: &EmptyProjection,
) -> Result<(), String> {
    let state = source_file_state(
        request,
        file,
        generation,
        &empty.read_proof,
        &empty.checkpoint,
        None,
    )?;
    transaction
        .upsert_source_file(&state)
        .map_err(|error| error.to_string())
}

fn projection_identity(projected: &ProjectedSource) -> Result<SessionIdentity, String> {
    let identity = SessionIdentity::new(
        projected.session.source_id,
        projected.session.native_session_id.clone(),
    );
    if identity.session_key != projected.session.session_key {
        return Err("source projection returned a non-canonical session key".to_owned());
    }
    Ok(identity)
}

fn session_write(
    request: &SyncRequest,
    file: &SourceFile,
    projected: &ProjectedSource,
    identity: SessionIdentity,
) -> SessionWrite {
    SessionWrite {
        identity,
        session_uuid: projected.session.session_uuid.clone(),
        file_path: projected.session.file_path.clone(),
        source_root: request.selector.root().to_owned(),
        title: projected.session.title.clone(),
        summary_text: projected.session.summary_text.clone(),
        compact_text: projected.session.compact_text.clone(),
        reasoning_summary_text: projected.session.reasoning_summary_text.clone(),
        cwd: projected.session.cwd.clone(),
        model: projected.session.model.clone(),
        started_at: projected.session.started_at.clone(),
        ended_at: projected.session.ended_at.clone(),
        path_date: file.path_date.clone().unwrap_or_default(),
        raw_file_mtime: rounded_mtime_ms(file.mtime_ms),
        raw_file_size: file.size,
        index_version: INDEX_VERSION.to_owned(),
    }
}

fn message_writes(projected: &ProjectedSource) -> Vec<MessageWrite> {
    projected
        .documents
        .iter()
        .map(|document| MessageWrite {
            seq: document.message.seq,
            role: document.message.role,
            timestamp: document.message.timestamp.clone(),
            source_kind: match document.message.source_kind {
                SourceKind::EventMsg => "event_msg".to_owned(),
            },
            body_text: document.message.content_text.clone(),
            raw_start: Some(document.raw_start),
            raw_end: Some(document.raw_end),
            projection_epoch: PROJECTION_EPOCH,
        })
        .collect()
}

fn source_file_state(
    request: &SyncRequest,
    file: &SourceFile,
    generation: &str,
    read: &ReadProof,
    checkpoint: &ProjectionCheckpoint,
    session: Option<SessionIdentity>,
) -> Result<SourceFileState, String> {
    let reducer_checkpoint = serde_json::to_vec(checkpoint).map_err(|error| error.to_string())?;
    Ok(SourceFileState {
        source_id: file.source_id,
        file_path: file.file_path.to_string_lossy().into_owned(),
        source_root: request.selector.root().to_owned(),
        source_generation: generation.to_owned(),
        mtime_ms: file.mtime_ms,
        mtime_ns: exact_mtime_ns(file.mtime_ns),
        size: file.size,
        indexed_bytes: checkpoint.indexed_bytes,
        head_digest: read.content_fingerprint.clone(),
        boundary_digest: checkpoint.prefix_digest.clone(),
        next_seq: checkpoint.next_seq,
        reducer_checkpoint: Some(reducer_checkpoint),
        cwd: file.cwd.clone(),
        path_date: file.path_date.clone(),
        extra_fingerprint: file.accepted_fingerprint.clone(),
        projection_epoch: PROJECTION_EPOCH,
        analyzer_epoch: ANALYZER_EPOCH,
        coverage_epoch: COVERAGE_EPOCH,
        session,
    })
}

fn outcome_proof(
    outcome: &ProjectionOutcome,
) -> (&ReadProof, &ProjectionCheckpoint, ProjectionMode) {
    match outcome {
        ProjectionOutcome::Projected(projected) => {
            (&projected.read_proof, &projected.checkpoint, projected.mode)
        }
        ProjectionOutcome::Filtered(empty) | ProjectionOutcome::Skipped(empty) => {
            (&empty.read_proof, &empty.checkpoint, ProjectionMode::Full)
        }
        ProjectionOutcome::FullRequired { .. } => {
            unreachable!("pipeline rejects unresolved FullRequired outcomes")
        }
    }
}

fn fingerprint_prefix(path: &Path, byte_count: u64) -> io::Result<String> {
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

fn same_file_stamp(left: &SourceFile, right: &SourceFile) -> bool {
    left.mtime_ns == right.mtime_ns
        && left.size == right.size
        && left.identity == right.identity
        && left.cwd == right.cwd
        && left.path_date == right.path_date
        && left.accepted_fingerprint == right.accepted_fingerprint
}

fn stamp(file: &SourceFile) -> FileStamp {
    FileStamp {
        mtime_ns: file.mtime_ns,
        size: file.size,
        identity: file.identity.clone(),
    }
}

fn detail(path: &Path, message: &str) -> SyncErrorDetail {
    SyncErrorDetail {
        file_path: path.to_string_lossy().into_owned(),
        message: message.to_owned(),
    }
}

fn record_scan_failures(
    report: &mut SyncReport,
    scan: &SourceScan,
    seen: &mut BTreeSet<(String, String)>,
) {
    for failure in &scan.failures {
        let path = failure.file_path.to_string_lossy().into_owned();
        // SourceError Display already embeds the operation; only prepend it
        // for bare messages that lack it.
        let message = if failure.message.starts_with(&failure.operation) {
            failure.message.clone()
        } else {
            format!("{}: {}", failure.operation, failure.message)
        };
        if seen.insert((path.clone(), message.clone())) {
            report.record_error(path, message);
        }
    }
}

fn merge_cold_roots(existing: Vec<PathBuf>, extra: Vec<PathBuf>) -> Vec<PathBuf> {
    existing
        .into_iter()
        .chain(extra)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn require_source_root(root: &str) -> io::Result<()> {
    let metadata = fs::metadata(root)?;
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotADirectory,
            "source root is not a directory",
        ));
    }
    Ok(())
}

fn skipped_coverage(
    selector: &Selector,
    source_fingerprint: &str,
    file_set_fingerprint: &str,
    file_count: u64,
    reason: &str,
) -> CoverageWriteSummary {
    CoverageWriteSummary {
        written: false,
        selector: selector.clone(),
        source_fingerprint: source_fingerprint.to_owned(),
        source_file_set_fingerprint: file_set_fingerprint.to_owned(),
        source_file_count: file_count,
        indexed_session_count: 0,
        reason: Some(reason.to_owned()),
        stale_reason: None,
        recommended_action: None,
    }
}

pub(super) fn scratch_index_path(db_path: &Path) -> PathBuf {
    let name = db_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("index.sqlite");
    let sequence = SCRATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    db_path.with_file_name(format!(
        ".{name}.sync-{}-{sequence}.next",
        std::process::id()
    ))
}

pub(super) fn remove_sqlite_scratch(path: &Path) {
    let _ = fs::remove_file(path);
    let _ = fs::remove_file(PathBuf::from(format!("{}-wal", path.to_string_lossy())));
    let _ = fs::remove_file(PathBuf::from(format!("{}-shm", path.to_string_lossy())));
}

pub(super) fn publish_scratch_index(scratch: &Path, active: &Path) -> Result<(), String> {
    if active.exists() {
        remove_sqlite_scratch(scratch);
        return Err("active index appeared while publishing scratch sync".to_owned());
    }
    fs::rename(scratch, active).map_err(|error| {
        remove_sqlite_scratch(scratch);
        format!("publish scratch index: {error}")
    })?;
    if let Some(parent) = active.parent() {
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                format!(
                    "active index was published but parent-directory durability is unknown: {error}"
                )
            })?;
    }
    Ok(())
}

pub(super) fn committed_cutover_error(
    publish_error: Option<String>,
    complete_error: Option<String>,
) -> Option<String> {
    match (publish_error, complete_error) {
        (None, None) => None,
        (Some(publish), None) => Some(format!(
            "legacy fence published but index publication was not confirmed: {publish}"
        )),
        (None, Some(complete)) => Some(format!(
            "index committed but legacy cutover confirmation failed: {complete}"
        )),
        (Some(publish), Some(complete)) => Some(format!(
            "legacy fence published but index publication was not confirmed: {publish}; cutover confirmation also failed: {complete}"
        )),
    }
}

fn rounded_mtime_ms(value: f64) -> i64 {
    if !value.is_finite() {
        return 0;
    }
    value.round().clamp(i64::MIN as f64, i64::MAX as f64) as i64
}

fn exact_mtime_ns(value: i128) -> Option<i64> {
    i64::try_from(value).ok().filter(|value| *value > 0)
}

#[cfg(test)]
mod tests;
