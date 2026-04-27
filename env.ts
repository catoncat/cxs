import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Default data dir resolution:
//   1. $CXS_DATA_DIR (explicit override) — wins
//   2. $XDG_STATE_HOME/cxs              — XDG state convention
//   3. ~/.local/state/cxs               — XDG fallback
//
// Why state and not cache: cxs's index is rebuildable but rebuilding takes
// minutes on real corpora, so it's "warm state", not throwaway cache.
// XDG_STATE_HOME is exactly the bucket for "data that should persist
// between application runs but is not important enough to be put in
// XDG_DATA_HOME".
//
// macOS gets the same Unix-style path on purpose — dev CLIs blend better
// with the rest of the user's tooling there than under
// ~/Library/Application Support/.
//
// Windows is unsupported (see package.json `os` field). If the code
// somehow runs there it'll still produce a path under homedir().
const LEGACY_CACHE_DIR = join(homedir(), ".cache", "cxs");

function defaultDataDir(): string {
  const xdgState = process.env.XDG_STATE_HOME;
  if (xdgState) return resolve(xdgState, "cxs");
  return join(homedir(), ".local", "state", "cxs");
}

const DATA_DIR = process.env.CXS_DATA_DIR
  ? resolve(process.env.CXS_DATA_DIR)
  : defaultDataDir();

export const DEFAULT_DB_PATH = resolve(DATA_DIR, "index.sqlite");
export const DEFAULT_CODEX_DIR = resolve(homedir(), ".codex", "sessions");
export const CODEX_TITLE_INDEX_PATH = resolve(homedir(), ".codex", "session_index.jsonl");
export const DEFAULT_CODEX_STATE_DB_PATH = resolve(homedir(), ".codex", "state_5.sqlite");
export const INDEX_VERSION = "cxs-v5-session-field-weights";

export function ensureDataDir(): void {
  migrateLegacyCacheDir(LEGACY_CACHE_DIR, DATA_DIR);
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function resolveCodexDir(override?: string): string {
  return override ? resolve(override) : DEFAULT_CODEX_DIR;
}

// Convenience wrapper called once from cli.ts entry — keeps the migration
// out of env.ts's top-level so vitest importing env.ts doesn't touch user
// home as a side effect. Safe to call multiple times (idempotent).
export function migrateLegacyCacheDirIfNeeded(): boolean {
  return migrateLegacyCacheDir(LEGACY_CACHE_DIR, DATA_DIR);
}

// One-shot migration from the old ~/.cache/cxs/ default to whatever DATA_DIR
// resolves to now. No-op when:
//   - dest already has data (we don't clobber)
//   - legacy doesn't exist (clean install)
//   - user opted into a custom dir via CXS_DATA_DIR pointing at the legacy
//     cache (they're consciously using cache; respect that)
//
// Failure (e.g. cross-device rename, perm error) is swallowed — the worst
// case is the user re-running `cxs sync`, which is cheap and idempotent.
// Exported for unit tests.
export function migrateLegacyCacheDir(legacyDir: string, destDir: string): boolean {
  if (legacyDir === destDir) return false;
  if (!existsSync(legacyDir)) return false;
  if (existsSync(destDir)) return false;

  try {
    mkdirSync(resolve(destDir, ".."), { recursive: true });
    renameSync(legacyDir, destDir);
    return true;
  } catch {
    return false;
  }
}
