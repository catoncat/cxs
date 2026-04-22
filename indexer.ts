import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DB_PATH, INDEX_VERSION, ensureDataDir, resolveCodexDir } from "./env";
import { deleteSessionByFilePath, getIndexedSessionMeta, openDb, replaceSession } from "./db";
import { parseCodexSession } from "./parser";
import type { ParsedSession, SyncErrorDetail, SyncSummary } from "./types";

interface SyncOptions {
  dbPath?: string;
  rootDir?: string;
  bestEffort?: boolean;
}

type SyncOperation =
  | {
      kind: "replace";
      filePath: string;
      session: ParsedSession;
      rawFileMtime: number;
      rawFileSize: number;
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
  const rootDir = resolveCodexDir(options.rootDir);
  const db = openDb(dbPath);
  const files = collectJsonlFiles(rootDir);
  const operations: SyncOperation[] = [];

  const summary: SyncSummary = {
    scanned: files.length,
    added: 0,
    updated: 0,
    skipped: 0,
    filtered: 0,
    errors: 0,
    errorDetails: [],
  };

  try {
    for (const filePath of files) {
      try {
        const stats = statSync(filePath);
        const indexed = getIndexedSessionMeta(db, filePath);
        if (isUnchanged(indexed, stats.mtimeMs, stats.size)) {
          summary.skipped += 1;
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
          rawFileMtime: stats.mtimeMs,
          rawFileSize: stats.size,
          isUpdate: Boolean(indexed),
        });
      } catch (error) {
        recordSyncError(summary, filePath, error);
      }
    }

    if (summary.errors > 0 && !options.bestEffort) {
      throw new SyncError(summary);
    }

    applyOperations(db, operations, summary, Boolean(options.bestEffort));
    if (summary.errors > 0 && !options.bestEffort) {
      throw new SyncError(summary);
    }

    return summary;
  } finally {
    db.close();
  }
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

function collectJsonlFiles(rootDir: string): string[] {
  const files: string[] = [];
  walk(rootDir, files);
  files.sort();
  return files;
}

function walk(currentDir: string, files: string[]): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
}

function applyOperations(
  db: ReturnType<typeof openDb>,
  operations: SyncOperation[],
  summary: SyncSummary,
  bestEffort: boolean,
): void {
  if (bestEffort) {
    for (const operation of operations) {
      try {
        applyOperation(db, operation);
        recordAppliedOperation(summary, operation);
      } catch (error) {
        recordSyncError(summary, operation.filePath, error);
      }
    }
    return;
  }

  let currentFilePath = "";
  const tx = db.transaction(() => {
    for (const operation of operations) {
      currentFilePath = operation.filePath;
      applyOperation(db, operation);
    }
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
}

function applyOperation(db: ReturnType<typeof openDb>, operation: SyncOperation): void {
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
  );
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
