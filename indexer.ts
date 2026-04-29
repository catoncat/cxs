import { DEFAULT_DB_PATH, INDEX_VERSION, ensureDataDir, resolveCodexDir } from "./env";
import {
  countSessionsForSelector,
  deleteSessionsForSelectorExceptFilePaths,
  deleteSessionByFilePath,
  getIndexedSessionMeta,
  openWriteDb,
  replaceCoverage,
  replaceSession,
} from "./db";
import { parseCodexSession } from "./parser";
import { canonicalizeSelector } from "./selector";
import { collectSourceSnapshot } from "./source-inventory";
import { withSyncLock } from "./sync-lock";
import type { CoverageWriteSummary, ParsedSession, Selector, SyncErrorDetail, SyncSummary } from "./types";

interface SyncOptions {
  dbPath?: string;
  rootDir?: string;
  selector?: Selector;
  bestEffort?: boolean;
}

type SyncOperation =
  | {
      kind: "replace";
      filePath: string;
      session: ParsedSession;
      rawFileMtime: number;
      rawFileSize: number;
      pathDate: string;
      isUpdate: boolean;
    }
  | {
      kind: "filtered";
      filePath: string;
    };

export class SyncError extends Error {
  summary: SyncSummary;

  constructor(summary: SyncSummary) {
    super(buildSyncErrorMessage(summary));
    this.name = "SyncError";
    this.summary = summary;
  }
}

export async function syncSessions(options: SyncOptions = {}): Promise<SyncSummary> {
  ensureDataDir();
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
  const selector = canonicalizeSelector(options.selector ?? { kind: "all", root: resolveCodexDir(options.rootDir) });
  return withSyncLock(dbPath, async () => {
    const db = openWriteDb(dbPath);
    const sourceSnapshot = collectSourceSnapshot(selector);
    const operations: SyncOperation[] = [];
    const unchangedFilePaths = new Set<string>();

    const summary: SyncSummary = {
      scanned: sourceSnapshot.fileCount,
      added: 0,
      updated: 0,
      skipped: 0,
      filtered: 0,
      removed: 0,
      errors: 0,
      errorDetails: [],
      selector,
      coverage: skippedCoverage(selector, sourceSnapshot.fingerprint, sourceSnapshot.fileCount, "not_written"),
    };

    try {
      for (const file of sourceSnapshot.files) {
        const filePath = file.filePath;
        try {
          const indexed = getIndexedSessionMeta(db, filePath);
          if (isUnchanged(indexed, file.mtimeMs, file.size)) {
            summary.skipped += 1;
            unchangedFilePaths.add(filePath);
            continue;
          }

          const parsed = await parseCodexSession(filePath);
          if (parsed.kind === "filtered") {
            operations.push({ kind: "filtered", filePath });
            continue;
          }
          if (parsed.kind === "skipped") {
            summary.skipped += 1;
            continue;
          }

          operations.push({
            kind: "replace",
            filePath,
            session: parsed.session,
            rawFileMtime: file.mtimeMs,
            rawFileSize: file.size,
            pathDate: file.pathDate ?? "",
            isUpdate: Boolean(indexed),
          });
        } catch (error) {
          recordSyncError(summary, filePath, error);
        }
      }

      if (summary.errors > 0 && !options.bestEffort) {
        throw new SyncError(summary);
      }

      if (!options.bestEffort) {
        const afterSnapshot = collectSourceSnapshot(selector);
        if (afterSnapshot.fingerprint !== sourceSnapshot.fingerprint) {
          recordSyncError(summary, "(selector)", new Error("source changed during strict sync"));
          throw new SyncError(summary);
        }
      }

      const bestEffort = Boolean(options.bestEffort);
      const retainedFilePaths = retainedIndexedFilePaths(unchangedFilePaths, operations);
      summary.coverage = applyOperations(
        db,
        operations,
        summary,
        bestEffort,
        selector,
        sourceSnapshot,
        retainedFilePaths,
      );
      if (summary.errors > 0 && !options.bestEffort) {
        throw new SyncError(summary);
      }

      return summary;
    } finally {
      db.close();
    }
  });
}

function isUnchanged(
  indexed: { rawFileMtime: number; rawFileSize: number; indexVersion: string } | null,
  mtimeMs: number,
  size: number,
): boolean {
  if (!indexed) return false;
  return indexed.rawFileMtime === mtimeMs
    && indexed.rawFileSize === size
    && indexed.indexVersion === INDEX_VERSION;
}

function applyOperations(
  db: ReturnType<typeof openWriteDb>,
  operations: SyncOperation[],
  summary: SyncSummary,
  bestEffort: boolean,
  selector: Selector,
  sourceSnapshot: { fingerprint: string; fileCount: number },
  retainedFilePaths: Set<string>,
): CoverageWriteSummary {
  if (bestEffort) {
    for (const operation of operations) {
      try {
        applyOperation(db, operation);
        recordAppliedOperation(summary, operation);
      } catch (error) {
        recordSyncError(summary, operation.filePath, error);
      }
    }
    return skippedCoverage(selector, sourceSnapshot.fingerprint, sourceSnapshot.fileCount, "best_effort");
  }

  let currentFilePath = "";
  let coverage: CoverageWriteSummary | null = null;
  const tx = db.transaction(() => {
    for (const operation of operations) {
      currentFilePath = operation.filePath;
      applyOperation(db, operation, selector.root);
    }
    summary.removed += deleteSessionsForSelectorExceptFilePaths(db, selector, retainedFilePaths);
    const indexedSessionCount = countSessionsForSelector(db, selector);
    const record = replaceCoverage(
      db,
      selector,
      sourceSnapshot.fingerprint,
      sourceSnapshot.fileCount,
      indexedSessionCount,
      INDEX_VERSION,
    );
    coverage = {
      written: true,
      selector: record.selector,
      sourceFingerprint: record.sourceFingerprint,
      sourceFileCount: record.sourceFileCount,
      indexedSessionCount: record.indexedSessionCount,
    };
  });

  try {
    tx();
  } catch (error) {
    recordSyncError(summary, currentFilePath || "(unknown file)", error);
    throw new SyncError(summary);
  }

  for (const operation of operations) {
    recordAppliedOperation(summary, operation);
  }
  return coverage ?? skippedCoverage(selector, sourceSnapshot.fingerprint, sourceSnapshot.fileCount, "not_written");
}

function applyOperation(db: ReturnType<typeof openWriteDb>, operation: SyncOperation, sourceRoot?: string): void {
  if (operation.kind === "filtered") {
    deleteSessionByFilePath(db, operation.filePath);
    return;
  }

  replaceSession(
    db,
    operation.session,
    operation.rawFileMtime,
    operation.rawFileSize,
    INDEX_VERSION,
    operation.pathDate,
    sourceRoot,
  );
}

function retainedIndexedFilePaths(
  unchangedFilePaths: Set<string>,
  operations: SyncOperation[],
): Set<string> {
  const retained = new Set(unchangedFilePaths);
  for (const operation of operations) {
    if (operation.kind === "replace") {
      retained.add(operation.filePath);
    }
  }
  return retained;
}

function recordAppliedOperation(summary: SyncSummary, operation: SyncOperation): void {
  if (operation.kind === "filtered") {
    summary.filtered += 1;
    return;
  }

  if (operation.isUpdate) {
    summary.updated += 1;
    return;
  }

  summary.added += 1;
}

function recordSyncError(summary: SyncSummary, filePath: string, error: unknown): void {
  summary.errors += 1;
  summary.errorDetails.push({
    filePath,
    message: describeError(error),
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function buildSyncErrorMessage(summary: SyncSummary): string {
  const details = summary.errorDetails.map((detail: SyncErrorDetail) =>
    `${detail.filePath}: ${detail.message}`
  );
  return `sync failed with ${summary.errors} error(s)\n${details.join("\n")}`;
}

function skippedCoverage(
  selector: Selector,
  sourceFingerprint: string,
  sourceFileCount: number,
  reason: string,
): CoverageWriteSummary {
  return {
    written: false,
    selector,
    sourceFingerprint,
    sourceFileCount,
    indexedSessionCount: 0,
    reason,
  };
}
