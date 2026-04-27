import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir);
const DATA_DIR = resolve(ROOT, "data");

export const DEFAULT_DB_PATH = resolve(DATA_DIR, "index.sqlite");
export const DEFAULT_CODEX_DIR = resolve(homedir(), ".codex", "sessions");
export const CODEX_TITLE_INDEX_PATH = resolve(homedir(), ".codex", "session_index.jsonl");
export const DEFAULT_CODEX_STATE_DB_PATH = resolve(homedir(), ".codex", "state_5.sqlite");
export const INDEX_VERSION = "cxs-v5-session-field-weights";

export function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function resolveCodexDir(override?: string): string {
  return override ? resolve(override) : DEFAULT_CODEX_DIR;
}
