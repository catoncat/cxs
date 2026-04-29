import type { CwdCount } from "../types";
import type { Db } from "./shared";

export function getStatsCounts(db: Db): {
  sessionCount: number;
  messageCount: number;
  earliestStartedAt: string | null;
  latestEndedAt: string | null;
  lastSyncAt: string | null;
} {
  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS sessionCount,
        COALESCE(SUM(message_count), 0) AS messageCount,
        MIN(started_at) AS earliestStartedAt,
        MAX(ended_at) AS latestEndedAt,
        MAX(updated_at) AS lastSyncAt
      FROM sessions
    `)
    .get() as {
      sessionCount: number;
      messageCount: number;
      earliestStartedAt: string | null;
      latestEndedAt: string | null;
      lastSyncAt: string | null;
    };
  return row;
}

export function getTopCwds(db: Db, limit: number): CwdCount[] {
  return db
    .prepare<[number], CwdCount>(`
      SELECT cwd, COUNT(*) AS count
      FROM sessions
      WHERE cwd != ''
      GROUP BY cwd
      ORDER BY count DESC, cwd ASC
      LIMIT ?
    `)
    .all(limit) as CwdCount[];
}
