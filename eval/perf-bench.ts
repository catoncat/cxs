#!/usr/bin/env -S node --import tsx

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { spawn as childSpawn } from "node:child_process";

interface PerQueryRecord {
  query: string;
  runs: number;
  samplesMs: number[];
  p50Ms: number;
  p95Ms: number;
}

interface Report {
  generatedAt: string;
  dbPath: string;
  rootDir: string;
  sessionCount: number;
  syncMs: number;
  dbSizeBytes: number;
  perQuery: PerQueryRecord[];
}

// Bench query 选取原则:
//  - 单 token 高频(hammerspoon/envchain): 检验最常见广义 fts 命中
//  - 短 token(sb): 检验 trigram fallback 路径
//  - 多 token 英文(fly deploy / edge tts): 检验多 term AND 路径
//  - CJK 短语(豆包输入法): 检验 CJK trigram 路径
//  - 中英混合(部署 health check): 检验 mixed match
const BENCH_QUERIES: string[] = [
  "hammerspoon",
  "envchain",
  "sb",
  "fly deploy",
  "edge tts",
  "豆包输入法",
  "部署 health check",
];

const RUNS_PER_QUERY = 5; // 第 1 次作为 warmup,统计后 4 次
const ROOT = resolve(import.meta.dirname, "..");
const OUT_BASE = resolve(ROOT, "data", "cxs-perf");

interface CliArgs {
  root: string;
  db: string;
  jsonOnly: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let root = join(homedir(), ".codex", "sessions");
  let db = join(tmpdir(), `cxs-perf-${Date.now()}.db`);
  let jsonOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") {
      root = resolve(argv[++i] ?? root);
    } else if (a === "--db") {
      db = resolve(argv[++i] ?? db);
    } else if (a === "--json-only") {
      jsonOnly = true;
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: npm run eval:perf -- [--root <dir>] [--db <path>] [--json-only]");
      process.exit(0);
    }
  }
  return { root, db, jsonOnly };
}

const args = parseArgs(process.argv.slice(2));

if (!existsSync(args.root)) {
  console.error(`error: --root not found: ${args.root}`);
  process.exit(1);
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  ms: number;
}

async function run(cmd: string[]): Promise<RunResult> {
  const t0 = performance.now();
  const result = await spawnAndCapture(cmd, ROOT);
  const ms = performance.now() - t0;
  return { ...result, ms };
}

function spawnAndCapture(cmd: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = childSpawn(cmd[0]!, cmd.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => { stdout += chunk; });
    proc.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

async function runOrThrow(cmd: string[]): Promise<RunResult> {
  const r = await run(cmd);
  if (r.exitCode !== 0) {
    throw new Error(`command failed (exit ${r.exitCode}): ${cmd.join(" ")}\n${r.stderr}`);
  }
  return r;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function percentile(samplesMs: number[], p: number): number {
  // 4 个样本下 p95 数学意义薄弱: 直接取 max 作为 worst-case 近似
  if (samplesMs.length === 0) return 0;
  if (p >= 0.99) return Math.max(...samplesMs);
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

function fmtMs(n: number): string {
  return n.toFixed(1).padStart(8);
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = args.jsonOnly ? "" : join(OUT_BASE, stamp);
if (!args.jsonOnly) {
  mkdirSync(outDir, { recursive: true });
}

// 1. sync
const syncRun = await runOrThrow([process.execPath, "--import", "tsx", "cli.ts", "sync", "--db", args.db, "--root", args.root, "--json"]);
const syncMs = syncRun.ms;
let sessionCount = 0;
try {
  const parsed = JSON.parse(syncRun.stdout) as { scanned?: number };
  sessionCount = typeof parsed.scanned === "number" ? parsed.scanned : 0;
} catch {
  // 解析失败保持 0
}

// 2. find x N runs per query
const perQuery: PerQueryRecord[] = [];
for (const q of BENCH_QUERIES) {
  const samplesAll: number[] = [];
  for (let i = 0; i < RUNS_PER_QUERY; i++) {
    const r = await runOrThrow([process.execPath, "--import", "tsx", "cli.ts", "find", q, "--db", args.db, "--limit", "10", "--json"]);
    samplesAll.push(r.ms);
  }
  // 丢弃首次 warmup
  const samples = samplesAll.slice(1);
  const sorted = [...samples].sort((a, b) => a - b);
  perQuery.push({
    query: q,
    runs: samples.length,
    samplesMs: samplesAll.map((x) => Number(x.toFixed(2))),
    p50Ms: Number(median(sorted).toFixed(2)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
  });
}

// 3. stats -> dbSizeBytes
const statsRun = await runOrThrow([process.execPath, "--import", "tsx", "cli.ts", "stats", "--db", args.db, "--json"]);
let dbSizeBytes = 0;
try {
  const parsed = JSON.parse(statsRun.stdout) as { dbSizeBytes?: number; sessionCount?: number };
  if (typeof parsed.dbSizeBytes === "number") dbSizeBytes = parsed.dbSizeBytes;
  if (typeof parsed.sessionCount === "number" && parsed.sessionCount > 0) {
    sessionCount = parsed.sessionCount;
  }
} catch {
  // 忽略
}

const report: Report = {
  generatedAt: new Date().toISOString(),
  dbPath: args.db,
  rootDir: args.root,
  sessionCount,
  syncMs: Number(syncMs.toFixed(2)),
  dbSizeBytes,
  perQuery,
};

if (!args.jsonOnly) {
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, "report.md"), buildMarkdown(report));
}

const slowest = [...perQuery].sort((a, b) => b.p95Ms - a.p95Ms)[0];
console.log(JSON.stringify({
  outDir: outDir || null,
  sessionCount,
  syncMs: Number(syncMs.toFixed(2)),
  dbSizeBytes,
  queryCount: perQuery.length,
  slowestQuery: slowest ? { query: slowest.query, p95Ms: slowest.p95Ms } : null,
}, null, 2));

function buildMarkdown(r: Report): string {
  const lines: string[] = [];
  lines.push("# cxs 性能基准报告");
  lines.push("");
  lines.push(`- generated_at: ${r.generatedAt}`);
  lines.push(`- root: \`${r.rootDir}\``);
  lines.push(`- db: \`${r.dbPath}\``);
  lines.push(`- session_count: ${r.sessionCount}`);
  lines.push(`- sync_ms: ${r.syncMs.toFixed(1)}`);
  lines.push(`- db_size: ${fmtBytes(r.dbSizeBytes)} (${r.dbSizeBytes} bytes)`);
  lines.push("");
  lines.push("## per-query find latency");
  lines.push("");
  lines.push(`运行配置: 每个 query ${RUNS_PER_QUERY} 次,丢弃首次 warmup,统计后 ${RUNS_PER_QUERY - 1} 次。`);
  lines.push("");
  lines.push("| query | runs | p50 ms | p95 ms | samples (incl. warmup) ms |");
  lines.push("|-------|-----:|-------:|-------:|---------------------------|");
  for (const row of r.perQuery) {
    const samples = row.samplesMs.map((x) => x.toFixed(1)).join(", ");
    lines.push(`| \`${row.query}\` | ${row.runs} |${fmtMs(row.p50Ms)} |${fmtMs(row.p95Ms)} | ${samples} |`);
  }
  lines.push("");
  lines.push("> 注: 4 个有效样本下 p95 取最大值作为 worst-case 近似,统计意义有限。");
  lines.push("");
  return lines.join("\n");
}
