import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { canonicalizeSelector, selectorContainsFile } from "./selector";
import type {
  DateRange,
  Selector,
  SourceFileMeta,
  SourceInventory,
  SourceInventoryCwdGroup,
  SourceSnapshot,
} from "./types";

const CWD_SCAN_BYTES = 64 * 1024;

export function collectSourceInventory(root: string): SourceInventory {
  const resolvedRoot = resolve(root);
  const files = collectSourceFiles(resolvedRoot);
  return {
    root: resolvedRoot,
    totalFiles: files.length,
    pathDateRange: dateRange(files.map((file) => file.pathDate)),
    cwdGroups: buildCwdGroups(files),
  };
}

export function collectSourceSnapshot(selector: Selector): SourceSnapshot {
  const canonical = canonicalizeSelector(selector);
  const files = collectSourceFiles(canonical.root).filter((file) => selectorContainsFile(canonical, file));
  return {
    selector: canonical,
    fingerprint: fingerprintFiles(canonical.root, files),
    fileCount: files.length,
    files,
  };
}

export function collectSourceFiles(root: string): SourceFileMeta[] {
  const files: SourceFileMeta[] = [];
  walk(resolve(root), files);
  files.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return files;
}

export function extractPathDate(filePath: string): string | null {
  const pathMatch = filePath.match(/(?:^|\/)(\d{4})\/(\d{2})\/(\d{2})(?:\/|$)/);
  if (pathMatch) return `${pathMatch[1]}-${pathMatch[2]}-${pathMatch[3]}`;
  const nameMatch = filePath.match(/rollout-(\d{4})-(\d{2})-(\d{2})T/);
  if (nameMatch) return `${nameMatch[1]}-${nameMatch[2]}-${nameMatch[3]}`;
  return null;
}

function walk(currentDir: string, files: SourceFileMeta[]): void {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = `${currentDir}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(fullPath, files);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

    try {
      const stats = statSync(fullPath);
      files.push({
        filePath: fullPath,
        pathDate: extractPathDate(fullPath),
        cwd: readCwdMetadata(fullPath),
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      });
    } catch {
      continue;
    }
  }
}

function readCwdMetadata(filePath: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(CWD_SCAN_BYTES);
    const bytesRead = readSync(fd, buffer, 0, CWD_SCAN_BYTES, 0);
    const prefix = buffer.subarray(0, bytesRead).toString("utf8");
    for (const rawLine of prefix.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const payload = isRecord(record.payload) ? record.payload : null;
      if (!payload) continue;
      if ((record.type === "session_meta" || record.type === "turn_context") && typeof payload.cwd === "string") {
        return payload.cwd;
      }
    }
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore inventory-only close failures.
      }
    }
  }
  return "";
}

function buildCwdGroups(files: SourceFileMeta[]): SourceInventoryCwdGroup[] {
  const groups = new Map<string, SourceFileMeta[]>();
  for (const file of files) {
    if (!file.cwd) continue;
    const group = groups.get(file.cwd) ?? [];
    group.push(file);
    groups.set(file.cwd, group);
  }
  return [...groups.entries()]
    .map(([cwd, groupFiles]) => ({
      cwd,
      fileCount: groupFiles.length,
      pathDateRange: dateRange(groupFiles.map((file) => file.pathDate)),
    }))
    .sort((a, b) => b.fileCount - a.fileCount || a.cwd.localeCompare(b.cwd));
}

function dateRange(values: Array<string | null>): DateRange {
  const dates = values.filter((value): value is string => Boolean(value)).sort();
  return {
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
  };
}

function fingerprintFiles(root: string, files: SourceFileMeta[]): string {
  const hash = createHash("sha256");
  hash.update(resolve(root));
  for (const file of files) {
    hash.update("\0");
    hash.update(relative(root, file.filePath));
    hash.update("\0");
    hash.update(String(file.mtimeMs));
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
    hash.update(file.pathDate ?? "");
    hash.update("\0");
    hash.update(file.cwd);
  }
  return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
