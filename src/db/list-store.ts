import type { SessionListEntry, SessionListQuery } from "../types";
import type { Db, SqlParams } from "./shared";
import { escapeLike, selectorWhereSql } from "./sql";

export function listSessions(db: Db, query: SessionListQuery): SessionListEntry[] {
  const conditions: string[] = [];
  const params: SqlParams = [];
  if (query.selector) {
    const selectorWhere = selectorWhereSql(query.selector, "sessions");
    conditions.push(...selectorWhere.conditions);
    params.push(...selectorWhere.params);
  }
  if (query.cwd) {
    // Substring match rather than prefix/equality: agent callers often pass
    // the trailing segment of a project path, not the full canonical path.
    conditions.push("lower(cwd) LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(query.cwd.toLowerCase())}%`);
  }
  if (query.since) {
    conditions.push("ended_at >= ?");
    params.push(query.since);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const orderColumn = query.sort === "started"
    ? "started_at"
    : query.sort === "messages"
      ? "message_count"
      : "ended_at";

  params.push(query.limit);

  return db
    .prepare<typeof params, SessionListEntry>(`
      SELECT
        session_uuid AS sessionUuid,
        title,
        summary_text AS summaryText,
        cwd,
        started_at AS startedAt,
        ended_at AS endedAt,
        path_date AS pathDate,
        message_count AS messageCount
      FROM sessions
      ${where}
      ORDER BY ${orderColumn} DESC
      LIMIT ?
    `)
    .all(...params) as SessionListEntry[];
}
