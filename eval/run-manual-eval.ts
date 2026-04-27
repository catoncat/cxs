#!/usr/bin/env -S node --import tsx

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn as childSpawn } from "node:child_process";
import { join, resolve } from "node:path";
import { evaluateManualQuery, type ManualQuery, type PassMark } from "./manual-eval-core";
import type { FindResult } from "../types";

interface FindOutput {
  query: string;
  results: FindResult[];
}

const ROOT = resolve(import.meta.dirname, "..");
const QUERY_FILE = resolve(import.meta.dirname, "manual-queries.json");
const OUT_BASE = resolve(ROOT, "data", "cxs-eval");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(OUT_BASE, stamp);
mkdirSync(outDir, { recursive: true });

const queries = JSON.parse(readFileSync(QUERY_FILE, "utf8")) as ManualQuery[];
const indexLines: string[] = [
  "# cxs 手动评测批次",
  "",
  `- generated_at: ${new Date().toISOString()}`,
  `- out_dir: \`${outDir}\``,
  "",
];

interface Scoreboard {
  total: number;
  pass1: number;
  pass5: number;
  skipped: number;
}

const scoreboard: Scoreboard = { total: 0, pass1: 0, pass5: 0, skipped: 0 };
const perQuery: Array<{
  id: string;
  query: string;
  category?: string;
  pass1: PassMark;
  pass5: PassMark;
  pass1Predicates: Array<{ label: string; needle: string; matched: boolean }>;
  pass5Predicates: Array<{ label: string; needle: string; matched: boolean }>;
  top1Title: string;
}> = [];

for (const [index, item] of queries.entries()) {
  const prefix = String(index + 1).padStart(2, "0");
  const findJson = await runCommand([process.execPath, "--import", "tsx", "cli.ts", "find", item.query, "--limit", "5", "--json"]);
  const findText = await runCommand([process.execPath, "--import", "tsx", "cli.ts", "find", item.query, "--limit", "5"]);
  const findJsonPath = join(outDir, `${prefix}-${item.id}.find.json`);
  const findTxtPath = join(outDir, `${prefix}-${item.id}.find.txt`);
  writeFileSync(findJsonPath, findJson);
  writeFileSync(findTxtPath, findText);

  const parsed = JSON.parse(findJson) as FindOutput;
  const top = parsed.results[0];

  const eval1 = evaluateManualQuery(item, parsed.results.slice(0, 1));
  const eval5 = evaluateManualQuery(item, parsed.results.slice(0, 5));
  const pass1 = eval1.mark;
  const pass5 = eval5.mark;
  scoreboard.total += 1;
  if (pass1 === "skip") scoreboard.skipped += 1;
  if (pass1 === "pass") scoreboard.pass1 += 1;
  if (pass5 === "pass") scoreboard.pass5 += 1;
  perQuery.push({
    id: item.id,
    query: item.query,
    category: item.category,
    pass1,
    pass5,
    pass1Predicates: eval1.predicateResults,
    pass5Predicates: eval5.predicateResults,
    top1Title: top?.title ?? "(none)",
  });

  let contextJsonPath = "";
  let contextTxtPath = "";
  let contextKind = "";
  if (top) {
    const contextCommand = buildTopContextCommand(top);
    const contextJson = await runCommand([...contextCommand.args, "--json"]);
    const contextText = await runCommand(contextCommand.args);
    contextKind = contextCommand.kind;
    contextJsonPath = join(outDir, `${prefix}-${item.id}.${contextKind}.json`);
    contextTxtPath = join(outDir, `${prefix}-${item.id}.${contextKind}.txt`);
    writeFileSync(contextJsonPath, contextJson);
    writeFileSync(contextTxtPath, contextText);
  }

  indexLines.push(`## ${prefix}. ${item.query}`);
  indexLines.push("");
  indexLines.push(`- intent: ${item.intent}`);
  if (item.category) indexLines.push(`- category: ${item.category}`);
  indexLines.push(`- pass@1: ${pass1}`);
  indexLines.push(`- pass@5: ${pass5}`);
  if (eval1.predicateResults.length > 0) {
    indexLines.push(`- pass@1 predicates: ${formatPredicateResults(eval1.predicateResults)}`);
  }
  if (eval5.predicateResults.length > 0) {
    indexLines.push(`- pass@5 predicates: ${formatPredicateResults(eval5.predicateResults)}`);
  }
  indexLines.push(`- find_json: \`${rel(findJsonPath)}\``);
  indexLines.push(`- find_txt: \`${rel(findTxtPath)}\``);
  if (top) {
    indexLines.push(`- top1_session_uuid: \`${top.sessionUuid}\``);
    indexLines.push(`- top1_title: ${top.title}`);
    indexLines.push(`- top1_cwd: ${top.cwd || "-"}`);
    indexLines.push(`- top1_match_source: ${top.matchSource}`);
    indexLines.push(`- top1_seq: ${top.matchSeq}`);
    indexLines.push(`- top1_context_kind: ${contextKind}`);
    indexLines.push(`- top1_context_json: \`${rel(contextJsonPath)}\``);
    indexLines.push(`- top1_context_txt: \`${rel(contextTxtPath)}\``);
  } else {
    indexLines.push("- top1: (none)");
  }
  indexLines.push("");
}

// Summary block at the top for quick scanning.
const summaryLines = [
  `## summary`,
  "",
  `- queries: ${scoreboard.total}`,
  `- skipped (no assertion): ${scoreboard.skipped}`,
  `- pass@1: ${scoreboard.pass1} / ${scoreboard.total - scoreboard.skipped}`,
  `- pass@5: ${scoreboard.pass5} / ${scoreboard.total - scoreboard.skipped}`,
  "",
  "| id | category | pass@1 | pass@5 | top1_title |",
  "|----|----------|--------|--------|------------|",
  ...perQuery.map((row) =>
    `| ${row.id} | ${row.category ?? ""} | ${row.pass1} | ${row.pass5} | ${row.top1Title.slice(0, 60).replaceAll("|", "¦")} |`
  ),
  "",
];
const combined = [...indexLines.slice(0, 5), ...summaryLines, ...indexLines.slice(5)];

const readmePath = join(outDir, "README.md");
writeFileSync(readmePath, combined.join("\n"));

const scorecardPath = join(outDir, "scorecard.json");
writeFileSync(scorecardPath, `${JSON.stringify({ scoreboard, perQuery }, null, 2)}\n`);

console.log(JSON.stringify({
  outDir,
  readme: readmePath,
  queryCount: queries.length,
  scoreboard,
}, null, 2));

function rel(path: string): string {
  return path.replace(`${ROOT}/`, "");
}

function formatPredicateResults(
  predicateResults: Array<{ label: string; needle: string; matched: boolean }>,
): string {
  return predicateResults
    .map((predicate) => `${predicate.label}=${predicate.matched ? "ok" : "miss"}(${predicate.needle})`)
    .join(", ");
}

function buildTopContextCommand(top: FindResult): { kind: "read-range" | "read-page"; args: string[] } {
  if (typeof top.matchSeq === "number") {
    return {
      kind: "read-range",
      args: [
        process.execPath, "--import", "tsx", "cli.ts",
        "read-range",
        top.sessionUuid,
        "--seq",
        String(top.matchSeq),
        "--before",
        "2",
        "--after",
        "2",
      ],
    };
  }

  return {
    kind: "read-page",
    args: [
      process.execPath, "--import", "tsx", "cli.ts",
      "read-page",
      top.sessionUuid,
      "--offset",
      "0",
      "--limit",
      "20",
    ],
  };
}

function runCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = childSpawn(args[0]!, args.slice(1), {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => { stdout += chunk; });
    proc.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`command failed: ${args.join(" ")}\n${stderr}`));
      } else {
        resolve(stdout);
      }
    });
  });
}
