import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { ensureSchema } from "./schema";
import { BUSY_TIMEOUT_MS, type Db } from "./shared";

export class IndexUnavailableError extends Error {
  constructor(public readonly dbPath: string) {
    super(`index not found: ${dbPath}`);
    this.name = "IndexUnavailableError";
  }
}

export function openReadDb(dbPath: string): Db {
  if (!existsSync(dbPath)) {
    throw new IndexUnavailableError(dbPath);
  }

  const db = new Database(dbPath, { readonly: true });
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma("query_only = ON");
  db.pragma("temp_store = MEMORY");
  return db;
}

// Why: callers used to do `const db = openReadDb(...); ... db.close();` which
// leaks the connection if work in between throws. Wrapping in try/finally at
// every callsite is noise — fold it once.
export function withReadDb<T>(dbPath: string, fn: (db: Db) => T): T {
  const db = openReadDb(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function openWriteDb(dbPath: string): Db {
  const db = new Database(dbPath);
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  db.pragma("foreign_keys = ON");
  ensureSchema(db);
  return db;
}
