import type { Db } from "./shared";

export function ensureSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_uuid TEXT NOT NULL UNIQUE,
      file_path TEXT NOT NULL UNIQUE,
      source_root TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      summary_text TEXT NOT NULL DEFAULT '',
      compact_text TEXT NOT NULL DEFAULT '',
      reasoning_summary_text TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      path_date TEXT NOT NULL DEFAULT '',
      message_count INTEGER NOT NULL DEFAULT 0,
      raw_file_mtime INTEGER NOT NULL DEFAULT 0,
      raw_file_size INTEGER NOT NULL DEFAULT 0,
      index_version TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  ensureTextColumn(db, "sessions", "summary_text");
  ensureTextColumn(db, "sessions", "compact_text");
  ensureTextColumn(db, "sessions", "reasoning_summary_text");
  ensureTextColumn(db, "sessions", "path_date");
  ensureTextColumn(db, "sessions", "source_root");

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      session_uuid TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content_text TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      UNIQUE(session_uuid, seq)
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_uuid, seq)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC)");

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content_text,
      session_uuid UNINDEXED,
      seq UNINDEXED,
      role UNINDEXED,
      timestamp UNINDEXED,
      tokenize='unicode61 remove_diacritics 1'
    )
  `);

  ensureSessionsFtsTable(db);
  ensureCoverageTable(db);

  dropLegacyTrigramTable(db);
}

function ensureCoverageTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS coverage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      selector_key TEXT NOT NULL UNIQUE,
      selector_json TEXT NOT NULL,
      selector_kind TEXT NOT NULL,
      root TEXT NOT NULL,
      cwd TEXT,
      from_date TEXT,
      to_date TEXT,
      source_fingerprint TEXT NOT NULL,
      source_file_count INTEGER NOT NULL,
      indexed_session_count INTEGER NOT NULL,
      completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      index_version TEXT NOT NULL
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_coverage_root ON coverage(root)");
}

function dropLegacyTrigramTable(db: Db): void {
  // cxs <= v2 shipped a second FTS5 virtual table for CJK trigram search.
  // The hybrid bigram+Segmenter tokenizer in tokenize.ts replaces it, so
  // drop the old table and its shadow rows if they still exist.
  db.exec("DROP TABLE IF EXISTS messages_fts_trigram");
}

function ensureSessionsFtsTable(db: Db): void {
  const existing = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'sessions_fts' LIMIT 1")
    .get();

  if (existing) {
    const columns = db
      .prepare("PRAGMA table_info(sessions_fts)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("compact_text") || !names.has("reasoning_summary_text")) {
      db.exec("DROP TABLE sessions_fts");
    }
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      title,
      summary_text,
      compact_text,
      reasoning_summary_text,
      session_uuid UNINDEXED,
      tokenize='unicode61 remove_diacritics 1'
    )
  `);
}

function ensureTextColumn(db: Db, tableName: string, columnName: string): void {
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name?: string }>;

  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} TEXT NOT NULL DEFAULT ''`);
}
