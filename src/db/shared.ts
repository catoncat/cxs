import Database from "better-sqlite3";

export type Db = Database.Database;
export type SqlParams = unknown[];

export const BUSY_TIMEOUT_MS = 5000;
