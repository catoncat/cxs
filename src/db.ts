export type { Db, SqlParams } from "./db/shared";
export { IndexUnavailableError, openReadDb, openWriteDb, withReadDb } from "./db/connection";
export { getIndexedSessionMeta, deleteSessionByFilePath, replaceSession, getSessionRecord } from "./db/session-store";
export { getMessagesForPage, getMessagesForRange } from "./db/message-store";
export { listSessions } from "./db/list-store";
export { getStatsCounts, getTopCwds } from "./db/stats-store";
export {
  coverageEntriesForSession,
  coverageStatusForSelector,
  countSessionsForSelector,
  deleteSessionsForSelectorExceptFilePaths,
  listCoverageRecords,
  replaceCoverage,
} from "./db/coverage-store";
export { selectorWhereSql } from "./db/sql";
