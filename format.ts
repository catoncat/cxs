import chalk from "chalk";
import type {
  CwdCount,
  FindResult,
  MessageRecord,
  SessionListEntry,
  SessionRecord,
  StatsSummary,
  SyncSummary,
} from "./types";

export function printSyncSummary(summary: SyncSummary): void {
  console.log(chalk.bold.cyan("cxs sync"));
  console.log(`scanned:  ${summary.scanned}`);
  console.log(`added:    ${summary.added}`);
  console.log(`updated:  ${summary.updated}`);
  console.log(`skipped:  ${summary.skipped}`);
  console.log(`filtered: ${summary.filtered}`);
  console.log(`errors:   ${summary.errors}`);
  if (summary.errorDetails.length > 0) {
    console.log();
    console.log(chalk.bold.red("sync errors"));
    for (const detail of summary.errorDetails) {
      console.log(chalk.red(detail.filePath));
      console.log(chalk.red(`  ${detail.message}`));
    }
  }
}

export function printFindResults(query: string, results: FindResult[]): void {
  console.log(chalk.bold.cyan(`cxs find "${query}"`));
  if (results.length === 0) {
    console.log(chalk.yellow("没有找到结果"));
    return;
  }

  for (const result of results) {
    console.log();
    console.log(chalk.bold(`[${result.rank}] ${result.title || "(no title)"}`));
    console.log(chalk.gray(`${result.startedAt} · ${result.cwd || "-"}`));
    console.log(chalk.gray(`uuid=${result.sessionUuid} · seq=${result.matchSeq} · matches=${result.matchCount}`));
    if (result.summaryText) {
      console.log(chalk.gray(trimMessage(result.summaryText)));
    }
    console.log(stripMarks(result.snippet));
    console.log(chalk.gray(`next: cxs read-range ${result.sessionUuid} --seq ${result.matchSeq}`));
  }
}

export function printReadRangeResult(
  session: SessionRecord,
  anchorSeq: number,
  messages: MessageRecord[],
  rangeStartSeq: number,
  rangeEndSeq: number,
): void {
  console.log(chalk.bold.cyan(`cxs read-range ${session.sessionUuid}`));
  console.log(chalk.gray(`${session.title || "(no title)"} · ${session.cwd || "-"}`));
  console.log(chalk.gray(`anchor=${anchorSeq} · range=${rangeStartSeq}-${rangeEndSeq}`));
  console.log();

  for (const message of messages) {
    const marker = message.seq === anchorSeq ? chalk.green(">>") : "  ";
    const role = message.role === "user" ? chalk.blue("U") : chalk.white("A");
    console.log(`${marker} [${message.seq}] ${role} ${trimMessage(message.contentText)}`);
  }
}

export function printReadPage(
  session: SessionRecord,
  offset: number,
  limit: number,
  totalCount: number,
  hasMore: boolean,
  messages: MessageRecord[],
): void {
  console.log(chalk.bold.cyan(`cxs read-page ${session.sessionUuid}`));
  console.log(chalk.gray(`${session.title || "(no title)"} · total=${totalCount} · offset=${offset} · limit=${limit} · hasMore=${hasMore}`));
  console.log();

  for (const message of messages) {
    const role = message.role === "user" ? chalk.blue("U") : chalk.white("A");
    console.log(`[${message.seq}] ${role} ${trimMessage(message.contentText)}`);
  }
}

export function printSessionList(results: SessionListEntry[]): void {
  console.log(chalk.bold.cyan(`cxs list`));
  if (results.length === 0) {
    console.log(chalk.yellow("没有匹配的 session"));
    return;
  }
  for (const [index, entry] of results.entries()) {
    console.log();
    console.log(chalk.bold(`[${index + 1}] ${entry.title || "(no title)"}`));
    console.log(chalk.gray(`${entry.endedAt} · ${entry.cwd || "-"} · msgs=${entry.messageCount}`));
    console.log(chalk.gray(`uuid=${entry.sessionUuid}`));
    if (entry.summaryText) {
      console.log(chalk.gray(trimMessage(entry.summaryText)));
    }
  }
}

export function printStats(stats: StatsSummary): void {
  console.log(chalk.bold.cyan(`cxs stats`));
  console.log(`sessions:        ${stats.sessionCount}`);
  console.log(`messages:        ${stats.messageCount}`);
  console.log(`earliest:        ${stats.earliestStartedAt ?? "-"}`);
  console.log(`latest:          ${stats.latestEndedAt ?? "-"}`);
  console.log(`last_sync_at:    ${stats.lastSyncAt ?? "-"}`);
  console.log(`index_version:   ${stats.indexVersion}`);
  console.log(`db_path:         ${stats.dbPath}`);
  console.log(`db_size_bytes:   ${stats.dbSizeBytes}`);
  if (stats.topCwds.length > 0) {
    console.log();
    console.log(chalk.bold("top cwds"));
    const width = Math.max(...stats.topCwds.map((row: CwdCount) => row.cwd.length));
    for (const row of stats.topCwds) {
      console.log(`  ${row.cwd.padEnd(width)}  ${row.count}`);
    }
  }
}

function trimMessage(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 220 ? `${normalized.slice(0, 220)}…` : normalized;
}

function stripMarks(snippet: string): string {
  return snippet.replaceAll("<mark>", "").replaceAll("</mark>", "");
}
