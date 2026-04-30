#!/usr/bin/env -S node --import tsx

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn as childSpawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { desiredContextMode, evaluateDogfoodItem, type DogfoodEvaluation } from "./dogfood-eval-core";
import { parseDogfoodJsonl, type DogfoodGolden } from "./dogfood-schema";
import type { FindResult } from "../src/types";

interface FindOutput {
  query: string;
  results: FindResult[];
}

interface Args {
  goldenPath: string;
  includeStale: boolean;
}

const ROOT = resolve(import.meta.dirname, "..");
const CLI_ENTRY = resolve(ROOT, "src", "cli.ts");
const OUT_BASE = resolve(ROOT, "data", "cxs-dogfood-eval");
const args = parseArgs(process.argv.slice(2));

const parsed = parseDogfoodJsonl(readFileSync(args.goldenPath, "utf8"), args.goldenPath);
if (parsed.errors.length > 0) {
  console.error(parsed.errors.join("\n"));
  process.exit(1);
}

const entries = parsed.entries.filter((entry) => args.includeStale || entry.status !== "stale");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(OUT_BASE, stamp);
mkdirSync(outDir, { recursive: true });

interface DogfoodEvalRow {
  item: DogfoodGolden;
  evaluation: DogfoodEvaluation;
  top1Title: string;
  selectedTitle: string;
  findJsonPath: string;
  contextTxtPath?: string;
}

const rows: DogfoodEvalRow[] = [];

for (const [index, item] of entries.entries()) {
  const prefix = String(index + 1).padStart(2, "0");
  const safeId = item.id.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  const limit = Math.max(item.expected.topK ?? 5, 5);

  const findJson = await runCommand([process.execPath, "--import", "tsx", CLI_ENTRY, "find", item.query, "--limit", String(limit), "--json"]);
  const findText = await runCommand([process.execPath, "--import", "tsx", CLI_ENTRY, "find", item.query, "--limit", String(limit)]);
  const findJsonPath = join(outDir, `${prefix}-${safeId}.find.json`);
  const findTxtPath = join(outDir, `${prefix}-${safeId}.find.txt`);
  writeFileSync(findJsonPath, findJson);
  writeFileSync(findTxtPath, findText);

  const parsedFind = JSON.parse(findJson) as FindOutput;
  const preselected = evaluateDogfoodItem({ item, results: parsedFind.results }).selected;
  const context = await readContextIfNeeded(item, preselected.hit, prefix, safeId, outDir);
  const evaluation = evaluateDogfoodItem({
    item,
    results: parsedFind.results,
    contextText: context.text,
    contextKind: context.kind,
    contextUnavailableReason: context.unavailableReason,
  });

  rows.push({
    item,
    evaluation,
    top1Title: parsedFind.results[0]?.title ?? "(none)",
    selectedTitle: evaluation.selected.hit?.title ?? "(none)",
    findJsonPath,
    contextTxtPath: context.textPath,
  });
}

const scoreboard = buildScoreboard(rows);
const readmePath = join(outDir, "README.md");
const scorecardPath = join(outDir, "scorecard.json");
writeFileSync(readmePath, renderReadme(args.goldenPath, scoreboard, rows));
writeFileSync(scorecardPath, `${JSON.stringify({ source: args.goldenPath, scoreboard, rows }, null, 2)}\n`);

console.log(JSON.stringify({ outDir, readme: readmePath, scorecard: scorecardPath, scoreboard }, null, 2));
if (scoreboard.hardFail > 0) process.exitCode = 1;

async function readContextIfNeeded(
  item: DogfoodGolden,
  hit: FindResult | null,
  prefix: string,
  safeId: string,
  outDir: string,
): Promise<{ kind?: "read-range" | "read-page"; text?: string; textPath?: string; unavailableReason?: string }> {
  const mode = desiredContextMode(item, hit);
  if (!mode) return {};
  if (!hit) return { unavailableReason: "no selected hit for context read" };
  if (mode === "read-range" && typeof hit.matchSeq !== "number") {
    return { kind: "read-range", unavailableReason: "selected hit has no numeric matchSeq" };
  }

  const command = buildContextCommand(item, hit, mode);
  const contextJson = await runCommand([...command, "--json"]);
  const contextText = await runCommand(command);
  const jsonPath = join(outDir, `${prefix}-${safeId}.${mode}.json`);
  const txtPath = join(outDir, `${prefix}-${safeId}.${mode}.txt`);
  writeFileSync(jsonPath, contextJson);
  writeFileSync(txtPath, contextText);
  return { kind: mode, text: contextText, textPath: txtPath };
}

function buildContextCommand(item: DogfoodGolden, hit: FindResult, mode: "read-range" | "read-page"): string[] {
  const context = item.expected.context ?? {};
  if (mode === "read-range") {
    return [
      process.execPath, "--import", "tsx", CLI_ENTRY,
      "read-range", hit.sessionUuid,
      "--seq", String(hit.matchSeq),
      "--before", String(context.before ?? 2),
      "--after", String(context.after ?? 2),
    ];
  }

  return [
    process.execPath, "--import", "tsx", CLI_ENTRY,
    "read-page", hit.sessionUuid,
    "--offset", String(context.offset ?? 0),
    "--limit", String(context.limit ?? 20),
  ];
}

function buildScoreboard(rows: Array<{ item: DogfoodGolden; evaluation: DogfoodEvaluation }>): Record<string, number> {
  const scoreboard = { total: rows.length, pass: 0, fail: 0, skip: 0, hardFail: 0, candidateFail: 0 };
  for (const row of rows) {
    scoreboard[row.evaluation.mark] += 1;
    if (row.item.status === "hard" && row.evaluation.mark === "fail") scoreboard.hardFail += 1;
    if (row.item.status === "candidate" && row.evaluation.mark === "fail") scoreboard.candidateFail += 1;
  }
  return scoreboard;
}

function renderReadme(
  sourcePath: string,
  scoreboard: Record<string, number>,
  rows: DogfoodEvalRow[],
): string {
  const lines = [
    "# cxs dogfood eval batch",
    "",
    `- generated_at: ${new Date().toISOString()}`,
    `- source: \`${sourcePath}\``,
    `- source_file: \`${basename(sourcePath)}\``,
    "",
    "## summary",
    "",
    `- total: ${scoreboard.total}`,
    `- pass: ${scoreboard.pass}`,
    `- fail: ${scoreboard.fail}`,
    `- skip: ${scoreboard.skip}`,
    `- hard_fail: ${scoreboard.hardFail}`,
    `- candidate_fail: ${scoreboard.candidateFail}`,
    "",
    "| id | status | mark | blocking | selected_rank | selected_title |",
    "|----|--------|------|----------|---------------|----------------|",
  ];

  for (const row of rows) {
    lines.push(`| ${row.item.id} | ${row.item.status} | ${row.evaluation.mark} | ${row.evaluation.blocking} | ${row.evaluation.selected.rank ?? "-"} | ${row.selectedTitle.replaceAll("|", "¦").slice(0, 60)} |`);
  }

  for (const row of rows) {
    lines.push("", `## ${row.item.id}`, "");
    lines.push(`- intent: ${row.item.intent}`);
    lines.push(`- query: ${row.item.query}`);
    lines.push(`- status: ${row.item.status}`);
    lines.push(`- mark: ${row.evaluation.mark}`);
    lines.push(`- top1_title: ${row.top1Title}`);
    lines.push(`- selected_title: ${row.selectedTitle}`);
    lines.push(`- find_json: \`${rel(row.findJsonPath)}\``);
    if (row.contextTxtPath) lines.push(`- context_txt: \`${rel(row.contextTxtPath)}\``);
    lines.push(`- predicates: ${formatPredicates(row.evaluation.predicateResults)}`);
  }

  return lines.join("\n");
}

function formatPredicates(predicates: DogfoodEvaluation["predicateResults"]): string {
  if (predicates.length === 0) return "(none)";
  return predicates.map((predicate) => `${predicate.label}=${predicate.matched ? "ok" : "miss"}(${predicate.expected})`).join(", ");
}

function rel(path: string): string {
  return path.replace(`${ROOT}/`, "");
}

function parseArgs(argv: string[]): Args {
  const includeStale = argv.includes("--include-stale");
  const goldenPath = argv.find((arg) => !arg.startsWith("--"));
  if (!goldenPath) {
    console.error("usage: npm run eval:dogfood -- <goldens.local.jsonl> [--include-stale]");
    process.exit(1);
  }
  return { goldenPath: resolve(goldenPath), includeStale };
}

function runCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = childSpawn(args[0]!, args.slice(1), { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => { stdout += chunk; });
    proc.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`command failed: ${args.join(" ")}\n${stderr || stdout}`));
    });
  });
}
