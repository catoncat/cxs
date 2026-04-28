#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { Command } from "commander";
import packageJson from "./package.json" with { type: "json" };
import {
  DEFAULT_CODEX_STATE_DB_PATH,
  DEFAULT_DB_PATH,
  migrateLegacyCacheDirIfNeeded,
  resolveCodexDir,
} from "./env";
import { IndexUnavailableError } from "./db";

// One-shot migration from legacy ~/.cache/cxs/ to ~/.local/state/cxs/. Runs
// before any subcommand so `cxs stats` etc. see the migrated db, not just
// `cxs sync`. Idempotent + silent on failure (worst case is a re-sync).
migrateLegacyCacheDirIfNeeded();
import {
  printCurrentSessions,
  printFindResults,
  printReadPage,
  printReadRangeResult,
  printSessionList,
  printStats,
  printSyncSummary,
} from "./format";
import { SyncError, syncSessions } from "./indexer";
import {
  collectStats,
  CurrentStateDbError,
  findSessions,
  getCurrentSessions,
  getMessagePage,
  getMessageRange,
  listSessionSummaries,
} from "./query";
import { SyncLockTimeoutError } from "./sync-lock";
import type { SessionListSort } from "./types";

const program = new Command();

program
  .name("cxs")
  .description("Codex sessions 渐进式检索 CLI")
  .version(packageJson.version);

program
  .command("current")
  .description("按 cwd 返回当前候选 session，不做全文检索")
  .option("--cwd <path>", "显式指定 cwd，默认当前工作目录")
  .option("-n, --limit <n>", "返回条数上限", "100")
  .option("--state-db <path>", "覆盖默认 Codex state SQLite 路径", DEFAULT_CODEX_STATE_DB_PATH)
  .option("--json", "输出 JSON")
  .action((options) => {
    const cwd = options.cwd ?? process.cwd();
    const jsonMode = Boolean(options.json);
    try {
      if (!existsSync(options.stateDb)) {
        throw new CurrentStateDbError(`state db not found: ${options.stateDb}`);
      }
      const result = getCurrentSessions(options.stateDb, cwd, parsePositiveInt(options.limit, 100));
      if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printCurrentSessions(result.cwd, result.candidates);
    } catch (error) {
      if (error instanceof CurrentStateDbError) {
        emitCurrentError(error, jsonMode);
        return;
      }
      throw error;
    }
  });

program
  .command("sync")
  .description("扫描并同步本地 Codex sessions 到 SQLite 索引")
  .option("--root <dir>", "覆盖默认 sessions 根目录")
  .option("--db <path>", "覆盖默认数据库路径", DEFAULT_DB_PATH)
  .option("--best-effort", "即使部分文件失败也继续写入可成功部分")
  .option("--json", "输出 JSON")
  .action(async (options) => {
    try {
      const summary = await syncSessions({
        dbPath: options.db,
        rootDir: resolveCodexDir(options.root),
        bestEffort: options.bestEffort,
      });
      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      printSyncSummary(summary);
    } catch (error) {
      if (error instanceof SyncError) {
        if (options.json) {
          console.error(JSON.stringify(error.summary, null, 2));
        } else {
          printSyncSummary(error.summary);
        }
        process.exitCode = 1;
        return;
      }
      if (error instanceof SyncLockTimeoutError) {
        if (options.json) {
          console.error(JSON.stringify({ error: error.message }, null, 2));
        } else {
          console.error(error.message);
        }
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  });

program
  .command("find <query>")
  .description("搜索相关 session，返回最小必要命中")
  .option("-n, --limit <n>", "返回条数", "10")
  .option("--db <path>", "覆盖默认数据库路径", DEFAULT_DB_PATH)
  .option("--json", "输出 JSON")
  .action((query, options) => {
    runReadCommand(Boolean(options.json), () => {
      const limit = parsePositiveInt(options.limit, 10);
      const result = findSessions(options.db, query, limit);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printFindResults(result.query, result.results);
    });
  });

program
  .command("read-range <sessionUuid>")
  .description("围绕命中点读取局部上下文；必须显式传 session_uuid")
  .option("--seq <n>", "显式指定锚点 seq")
  .option("--query <query>", "用 query 在该 session 内重新定位命中点")
  .option("--before <n>", "前文条数", "2")
  .option("--after <n>", "后文条数", "2")
  .option("--db <path>", "覆盖默认数据库路径", DEFAULT_DB_PATH)
  .option("--json", "输出 JSON")
  .action((sessionUuid, options) => {
    runReadCommand(Boolean(options.json), () => {
      const result = getMessageRange(options.db, sessionUuid, {
        seq: optionalInt(options.seq),
        query: options.query,
        before: parsePositiveInt(options.before, 2),
        after: parsePositiveInt(options.after, 2),
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printReadRangeResult(
        result.session,
        result.anchorSeq,
        result.messages,
        result.rangeStartSeq,
        result.rangeEndSeq,
      );
    });
  });

program
  .command("read-page <sessionUuid>")
  .description("顺序分页读取某个 session 的消息")
  .option("--offset <n>", "起始 offset", "0")
  .option("--limit <n>", "页大小", "20")
  .option("--db <path>", "覆盖默认数据库路径", DEFAULT_DB_PATH)
  .option("--json", "输出 JSON")
  .action((sessionUuid, options) => {
    runReadCommand(Boolean(options.json), () => {
      const result = getMessagePage(
        options.db,
        sessionUuid,
        parseNonNegativeInt(options.offset, 0),
        parsePositiveInt(options.limit, 20),
      );
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printReadPage(
        result.session,
        result.offset,
        result.limit,
        result.totalCount,
        result.hasMore,
        result.messages,
      );
    });
  });

program
  .command("list")
  .description("列出已索引的 session（不做全文检索）")
  .option("--cwd <needle>", "cwd 子串过滤（大小写不敏感）")
  .option("--since <iso>", "只看 ended_at >= 指定时间的 session")
  .option("--sort <key>", "排序键：ended|started|messages", "ended")
  .option("-n, --limit <n>", "返回条数", "20")
  .option("--db <path>", "覆盖默认数据库路径", DEFAULT_DB_PATH)
  .option("--json", "输出 JSON")
  .action((options) => {
    runReadCommand(Boolean(options.json), () => {
      const sort = normalizeListSort(options.sort);
      const result = listSessionSummaries(options.db, {
        cwd: options.cwd,
        since: options.since,
        sort,
        limit: parsePositiveInt(options.limit, 20),
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printSessionList(result.results);
    });
  });

program
  .command("stats")
  .description("展示索引状态统计")
  .option("--db <path>", "覆盖默认数据库路径", DEFAULT_DB_PATH)
  .option("--json", "输出 JSON")
  .action((options) => {
    runReadCommand(Boolean(options.json), () => {
      const summary = collectStats(options.db);
      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      printStats(summary);
    });
  });

program.parse();

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function optionalInt(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeListSort(value: string | undefined): SessionListSort {
  if (value === "started" || value === "messages") return value;
  return "ended";
}

function runReadCommand(jsonMode: boolean, action: () => void): void {
  try {
    action();
  } catch (error) {
    if (error instanceof IndexUnavailableError) {
      emitIndexUnavailableError(error, jsonMode);
      return;
    }
    throw error;
  }
}

function emitIndexUnavailableError(error: IndexUnavailableError, jsonMode: boolean): void {
  const hint =
    "Run `cxs sync` first to create the index. No separate init command is needed; sync initializes and updates it.";
  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          error: {
            code: "index_unavailable",
            message: error.message,
            dbPath: error.dbPath,
            hint,
          },
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`${error.message}\n${hint}`);
  }
  process.exitCode = 1;
}

function emitCurrentError(error: CurrentStateDbError, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(
      JSON.stringify(
        { error: { code: "state_db_unavailable", message: error.message } },
        null,
        2,
      ),
    );
  } else {
    console.error(error.message);
  }
  process.exitCode = 1;
}
