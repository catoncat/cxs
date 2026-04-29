import type { Selector } from "../types";
import type { Db, SqlParams } from "./shared";

export function selectorWhereSql(selector: Selector, alias: string): { conditions: string[]; params: SqlParams } {
  const conditions = [`(${alias}.file_path = ? OR ${alias}.file_path LIKE ? ESCAPE '\\')`];
  const params: SqlParams = [selector.root, `${escapeLike(selector.root)}/%`];
  if (selector.kind === "cwd" || selector.kind === "cwd_date_range") {
    conditions.push(`${alias}.cwd = ?`);
    params.push(selector.cwd);
  }
  if (selector.kind === "date_range" || selector.kind === "cwd_date_range") {
    conditions.push(`${alias}.path_date >= ?`);
    conditions.push(`${alias}.path_date <= ?`);
    params.push(selector.fromDate, selector.toDate);
  }
  return { conditions, params };
}

export function tableExists(db: Db, tableName: string): boolean {
  const row = db.prepare<[string], unknown>("SELECT 1 FROM sqlite_master WHERE name = ? LIMIT 1").get(tableName);
  return Boolean(row);
}

export function sessionRootFromFile(filePath: string): string {
  const marker = "/sessions/";
  const index = filePath.indexOf(marker);
  if (index >= 0) return filePath.slice(0, index + marker.length - 1);
  return filePath.slice(0, Math.max(0, filePath.lastIndexOf("/")));
}

export function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
