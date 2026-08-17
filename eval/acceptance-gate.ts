import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCliUnderTest, runCliUnderTest, type CliUnderTest } from "./cli-under-test";
import { buildDogfoodScoreboard, desiredContextMode, evaluateDogfoodItem, type DogfoodEvaluation, type DogfoodScoreboard } from "./dogfood-eval-core";
import type { DogfoodGolden } from "./dogfood-schema";
import { measureReturnedContext, summarizeReturnedContext, type ReturnedContextMetric, type ReturnedContextSummary } from "./returned-context";
import type { FindResult, SessionSourceId, SyncSummary } from "../src/types";

const MESSAGE_HIT_SESSION = "11111111-1111-4111-8111-111111111111";
const SESSION_HIT_SESSION = "22222222-2222-4222-8222-222222222222";
const CJK_HIT_SESSION = "33333333-3333-4333-8333-333333333333";
const NOISE_SESSION = "44444444-4444-4444-8444-444444444444";
// Duplicate transcript family (resume/fork-like near copies) plus one
// distinct session sharing the same needle: the diversity case (#92).
const DUP_FAMILY_SESSIONS = [
  "55555555-5555-4555-8555-555555555551",
  "55555555-5555-4555-8555-555555555552",
  "55555555-5555-4555-8555-555555555553",
] as const;
const DIVERSE_HIT_SESSION = "66666666-6666-4666-8666-666666666666";
const CLAUDE_CODE_HIT_SESSION = "claude-code:claude-eval-session";
const PI_HIT_SESSION = "pi:pi-eval-session";
const COMMAND_EXEC_SESSION = "77777777-7777-4777-8777-777777777777";
const COMMAND_RESTATE_SESSION = "88888888-8888-4888-8888-888888888888";
const QUERY_WINDOW_SESSION = "99999999-9999-4999-8999-999999999999";

// Sources with synthetic acceptance fixtures. dsh is deliberately absent:
// its transcripts are zstd-compressed and the TS oracle stub cannot parse
// them, so dsh coverage lives in the native Rust e2e tests instead.
const ACCEPTANCE_SOURCE_IDS = ["codex", "claude-code", "pi"] as const;
type AcceptanceSourceId = (typeof ACCEPTANCE_SOURCE_IDS)[number];

export type AcceptanceFixtureRoots = Record<AcceptanceSourceId, string>;
const ROOT = resolve(import.meta.dirname, "..");

export interface AcceptanceGateOptions {
  keepTemp?: boolean;
  requireCandidateOverride?: boolean;
  /** Explicit command prefix as JSON argv; overrides SHLOG_BIN_UNDER_TEST. */
  cliArgvJson?: string;
}

/**
 * Top-result diversity metrics (#92). Sherlog already returns one row per
 * session, so diversity failures show up as duplicate transcript *families*
 * (near-identical title/cwd) crowding out distinct sessions. The runner
 * reports the observable spread; it does not (yet) drive ranking changes.
 */
export interface TopResultDiversity {
  topK: number;
  resultCount: number;
  distinctSessions: number;
  distinctTitles: number;
  distinctCwds: number;
}

export interface AcceptanceGateRow {
  id: string;
  query: string;
  status: DogfoodGolden["status"];
  mark: DogfoodEvaluation["mark"];
  blocking: boolean;
  selectedRank: number | null;
  selectedSessionRef: string | null;
  selectedMatchSource: FindResult["matchSource"] | null;
  selectedMatchSeq: number | null;
  contextKind?: "read-range" | "read-page";
  assertionMark: DogfoodEvaluation["assertionMark"];
  facetMark: DogfoodEvaluation["facetMark"];
  failureClasses: DogfoodEvaluation["failureClasses"];
  predicates: DogfoodEvaluation["predicateResults"];
  diversity: TopResultDiversity;
  returnedContext: ReturnedContextMetric;
}

export interface AcceptanceGateResult {
  cliUnderTest: CliUnderTest;
  fixtureRoot: string;
  sourceRoots: AcceptanceFixtureRoots;
  dbPath: string;
  sync: SyncSummary;
  sourceSyncs: Record<AcceptanceSourceId, SyncSummary>;
  scoreboard: DogfoodScoreboard;
  returnedContext: ReturnedContextSummary;
  rows: AcceptanceGateRow[];
}

export async function runAcceptanceGate(options: AcceptanceGateOptions = {}): Promise<AcceptanceGateResult> {
  const cliUnderTest = resolveCliUnderTest({ argvJson: options.cliArgvJson });
  if (options.requireCandidateOverride && cliUnderTest.source === "typescript-reference") {
    throw new Error("acceptance gate requires an explicit candidate executable override");
  }
  const base = mkdtempSync(join(tmpdir(), "sherlog-acceptance-"));
  try {
    const dbPath = join(base, "index.sqlite");
    const sourceRoots = writeAcceptanceFixtures(base);
    const sourceSyncs = {
      codex: await syncSource(cliUnderTest, dbPath, "codex", sourceRoots.codex),
      "claude-code": await syncSource(cliUnderTest, dbPath, "claude-code", sourceRoots["claude-code"]),
      pi: await syncSource(cliUnderTest, dbPath, "pi", sourceRoots.pi),
    };
    const rows = await evaluateAcceptanceItems(cliUnderTest, dbPath, sourceRoots, acceptanceGoldens(sourceRoots));
    return {
      cliUnderTest,
      fixtureRoot: sourceRoots.codex,
      sourceRoots,
      dbPath,
      sync: sourceSyncs.codex,
      sourceSyncs,
      scoreboard: buildDogfoodScoreboard(rows.map((row) => ({ status: row.status, evaluation: row }))),
      returnedContext: summarizeReturnedContext(rows.map((row) => row.returnedContext)),
      rows,
    };
  } finally {
    if (!options.keepTemp) rmSync(base, { recursive: true, force: true });
  }
}

function acceptanceFixtureRoot(
  roots: AcceptanceFixtureRoots,
  sourceId: SessionSourceId,
  caseId: string,
): string {
  if ((ACCEPTANCE_SOURCE_IDS as readonly string[]).includes(sourceId)) {
    return roots[sourceId as AcceptanceSourceId];
  }
  throw new Error(
    `acceptance case ${caseId} targets source "${sourceId}", which has no acceptance fixture root; ` +
    "pass find.root explicitly or add a real fixture",
  );
}

async function syncSource(
  cli: CliUnderTest,
  dbPath: string,
  sourceId: AcceptanceSourceId,
  root: string,
): Promise<SyncSummary> {
  return runJsonCli<SyncSummary>(cli, [
    "sync",
    "--source", sourceId,
    "--root", root,
    "--db", dbPath,
    "--json",
  ]);
}

async function evaluateAcceptanceItems(
  cli: CliUnderTest,
  dbPath: string,
  roots: AcceptanceFixtureRoots,
  items: DogfoodGolden[],
): Promise<AcceptanceGateRow[]> {
  return Promise.all(items.map(async (item) => {
    const limit = Math.max(item.expected.topK ?? 5, item.find?.limit ?? 0, 5);
    const results = await findViaCli(cli, dbPath, roots, item, limit);
    const preselected = evaluateDogfoodItem({ item, results }).selected;
    const context = await readContextIfNeeded(cli, dbPath, item, preselected.hit);
    const evaluation = evaluateDogfoodItem({
      item,
      results,
      contextText: context.text,
      contextKind: context.kind,
      contextUnavailableReason: context.unavailableReason,
    });

    return {
      id: item.id,
      query: item.query,
      status: item.status,
      mark: evaluation.mark,
      blocking: evaluation.blocking,
      selectedRank: evaluation.selected.rank,
      selectedSessionRef: evaluation.selected.hit?.sessionRef ?? null,
      selectedMatchSource: evaluation.selected.hit?.matchSource ?? null,
      selectedMatchSeq: evaluation.selected.hit?.matchSeq ?? null,
      ...(context.kind ? { contextKind: context.kind } : {}),
      assertionMark: evaluation.assertionMark,
      facetMark: evaluation.facetMark,
      failureClasses: evaluation.failureClasses,
      predicates: evaluation.predicateResults,
      diversity: topResultDiversity(results, item.expected.topK ?? limit),
      returnedContext: measureReturnedContext(context),
    };
  }));
}

async function findViaCli(
  cli: CliUnderTest,
  dbPath: string,
  roots: AcceptanceFixtureRoots,
  item: DogfoodGolden,
  limit: number,
): Promise<FindResult[]> {
  const sourceId = item.expected.sourceId ?? "codex";
  const args = ["find", item.query, "--source", sourceId, "--limit", String(limit)];
  if (item.find?.selector) {
    args.push("--selector", JSON.stringify(item.find.selector));
  } else {
    args.push("--root", item.find?.root ?? acceptanceFixtureRoot(roots, sourceId, item.id));
    if (item.find?.cwd) args.push("--cwd", item.find.cwd);
  }
  if (item.find?.sort) args.push("--sort", item.find.sort);
  for (const sessionUuid of item.find?.excludeSessionUuids ?? []) {
    args.push("--exclude-session", sessionUuid);
  }
  args.push("--db", dbPath, "--json");

  const payload = await runJsonCli<{ results?: FindResult[] }>(cli, args);
  if (!Array.isArray(payload.results)) {
    throw new Error(`CLI under test returned no results array for acceptance case ${item.id}`);
  }
  return payload.results;
}

function topResultDiversity(results: FindResult[], topK: number): TopResultDiversity {
  const top = results.slice(0, topK);
  return {
    topK,
    resultCount: top.length,
    distinctSessions: new Set(top.map((result) => `${result.sourceId}\0${result.sessionRef}`)).size,
    distinctTitles: new Set(top.map((result) => result.title.trim().toLowerCase())).size,
    distinctCwds: new Set(top.map((result) => result.cwd)).size,
  };
}

async function readContextIfNeeded(
  cli: CliUnderTest,
  dbPath: string,
  item: DogfoodGolden,
  hit: FindResult | null,
): Promise<{ kind?: "read-range" | "read-page"; text?: string; unavailableReason?: string }> {
  const mode = desiredContextMode(item, hit);
  if (!mode) return {};
  if (!hit) return { unavailableReason: "no selected hit for context read" };
  const context = item.expected.context ?? {};
  if (mode === "read-range") {
    const query = context.query ?? item.query;
    if (typeof hit.matchSeq !== "number" && !query) {
      return { kind: "read-range", unavailableReason: "selected hit has no numeric matchSeq and no query available" };
    }
    // Keep --seq and --query together so around_query can preserve evidence
    // the same way evidenceRead.argv / the dogfood runner do.
    const args = ["read-range", hit.sessionRef];
    if (typeof hit.matchSeq === "number") args.push("--seq", String(hit.matchSeq));
    if (query) args.push("--query", query);
    args.push(
      "--before", String(context.before ?? 2),
      "--after", String(context.after ?? 2),
      "--db", dbPath,
      "--json",
    );
    const range = await runCliUnderTest(cli, args, { cwd: ROOT });
    if (range.exitCode !== 0) {
      // A profile-only hit has no message anchor: the typed anchor_not_found
      // error is the contract, and the agent must fall back to the session
      // projection instead of trusting a fake seq 0.
      const payload = parseCliJson(range.stdout) as { error?: { code?: string } } | null;
      if (payload?.error?.code !== "anchor_not_found") {
        throw new Error(
          `CLI under test exited ${range.exitCode}: ${JSON.stringify([...cli.argv, ...args])}\n${range.stderr || range.stdout}`,
        );
      }
      return readPageFallback(cli, dbPath, hit.sessionRef, context);
    }
    const rangePayload = JSON.parse(range.stdout) as { messages?: Array<{ role: string; contentText: string }> };
    if (!Array.isArray(rangePayload.messages)) throw new Error(`CLI under test returned no messages array for ${item.id} read-range`);
    return { kind: "read-range", text: messagesText(rangePayload.messages) };
  }

  return readPageFallback(cli, dbPath, hit.sessionRef, context);
}

async function readPageFallback(
  cli: CliUnderTest,
  dbPath: string,
  sessionRef: string,
  context: { offset?: number; limit?: number },
): Promise<{ kind: "read-page"; text: string }> {
  const page = await runJsonCli<{ messages?: Array<{ role: string; contentText: string }> }>(cli, [
    "read-page", sessionRef,
    "--offset", String(context.offset ?? 0),
    "--limit", String(context.limit ?? 20),
    "--db", dbPath,
    "--json",
  ]);
  if (!Array.isArray(page.messages)) throw new Error(`CLI under test returned no messages array for read-page`);
  return { kind: "read-page", text: messagesText(page.messages) };
}

function parseCliJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function runJsonCli<T>(cli: CliUnderTest, args: string[]): Promise<T> {
  const result = await runCliUnderTest(cli, args, { cwd: ROOT });
  if (result.exitCode !== 0) {
    throw new Error(
      `CLI under test exited ${result.exitCode}: ${JSON.stringify([...cli.argv, ...args])}\n${result.stderr || result.stdout}`,
    );
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `CLI under test emitted invalid JSON: ${JSON.stringify([...cli.argv, ...args])}\n${message}\n${result.stdout}`,
    );
  }
}

function acceptanceGoldens(roots: AcceptanceFixtureRoots): DogfoodGolden[] {
  return [
    {
      id: "message-hit-context",
      query: "health check returned 500",
      intent: "message hits should identify the exact session and readable range context",
      status: "hard",
      expected: {
        topK: 1,
        sourceId: "codex",
        acceptableSessionUuids: [MESSAGE_HIT_SESSION],
        sessionRef: MESSAGE_HIT_SESSION,
        cwdContains: "/tmp/sherlog-acceptance/deploy",
        matchSource: "message",
        matchSeq: 1,
        context: {
          mode: "read-range",
          before: 1,
          after: 1,
          mustContain: ["health check returned 500", "rollback plan includes readback verification"],
        },
        answerFacets: [
          {
            label: "failure symptom and mitigation evidence",
            mustContain: ["health check returned 500", "rollback plan includes readback verification"],
          },
        ],
      },
    },
    {
      id: "session-only-compact-context",
      query: "durable output queue",
      intent: "session-level compact recall must fail closed to anchor_not_found, then lead to session-projection context via read-page",
      status: "hard",
      expected: {
        topK: 1,
        sourceId: "codex",
        acceptableSessionUuids: [SESSION_HIT_SESSION],
        sessionRef: SESSION_HIT_SESSION,
        cwdContains: "/tmp/sherlog-acceptance/handoff",
        matchSource: "session",
        matchSeq: null,
        context: {
          mode: "read-range",
          mustContain: ["Prepare release notes", "Use the existing checklist"],
        },
      },
    },
    {
      id: "cjk-message-hit",
      query: "回滚预案",
      intent: "CJK message recall should preserve evidence identity and range context",
      status: "hard",
      expected: {
        topK: 1,
        sourceId: "codex",
        acceptableSessionUuids: [CJK_HIT_SESSION],
        sessionRef: CJK_HIT_SESSION,
        cwdContains: "/tmp/sherlog-acceptance/cjk",
        matchSource: "message",
        matchSeq: 0,
        context: {
          mode: "read-range",
          before: 0,
          after: 1,
          mustContain: ["回滚预案", "健康检查恢复"],
        },
      },
    },
    {
      id: "duplicate-family-diversity",
      query: "familyneedle staging cutover",
      intent: "a duplicated transcript family should not crowd the distinct session out of the top results",
      // Candidate (non-blocking): ranking currently has no family collapse;
      // this case exists to keep the diversity metric observable so any
      // future ranking change is justified by a failing-before/passing-after
      // eval rather than intuition.
      status: "candidate",
      expected: {
        topK: 4,
        sourceId: "codex",
        acceptableSessionUuids: [DIVERSE_HIT_SESSION, ...DUP_FAMILY_SESSIONS],
        cwdContains: "/tmp/sherlog-acceptance",
        matchSource: "message",
      },
    },
    {
      id: "claude-code-message-range-context",
      query: "claude adapter needle",
      intent: "Claude Code source recall should preserve source-qualified session refs and readable range context",
      status: "hard",
      find: { selector: { source: "claude-code", kind: "all", root: roots["claude-code"] } },
      expected: {
        topK: 1,
        sourceId: "claude-code",
        acceptableSessionUuids: [CLAUDE_CODE_HIT_SESSION],
        sessionRef: CLAUDE_CODE_HIT_SESSION,
        cwdContains: "/tmp/sherlog-acceptance/claude",
        matchSource: "message",
        matchSeq: 0,
        context: {
          mode: "read-range",
          before: 0,
          after: 1,
          mustContain: ["claude adapter needle", "claude range evidence"],
        },
      },
    },
    {
      id: "pi-session-page-context",
      query: "pi compact queue",
      intent: "Pi compaction recall should preserve source-qualified session refs and readable page context",
      status: "hard",
      find: { selector: { source: "pi", kind: "all", root: roots.pi } },
      expected: {
        topK: 1,
        sourceId: "pi",
        acceptableSessionUuids: [PI_HIT_SESSION],
        sessionRef: PI_HIT_SESSION,
        cwdContains: "/tmp/sherlog-acceptance/pi",
        matchSource: "session",
        matchSeq: null,
        context: {
          mode: "read-page",
          offset: 0,
          limit: 10,
          mustContain: ["pi accepted user prompt", "pi accepted assistant reply"],
        },
      },
    },
    {
      id: "command-restatement-loses-to-execution",
      query: "node dist/cli.js publish",
      intent: "public mirror of the path-like command FP: a later title that restates the command must not beat the session that ran it",
      status: "hard",
      expected: {
        topK: 1,
        sourceId: "codex",
        acceptableSessionUuids: [COMMAND_EXEC_SESSION],
        sessionRef: COMMAND_EXEC_SESSION,
        cwdContains: "/tmp/sherlog-acceptance/what7",
        matchSource: "message",
      },
    },
    {
      id: "query-window-keeps-table-rows",
      query: "两个格式的关键差异",
      intent: "public mirror of the elision FN: around_query must keep the full query window so both comparison-table rows stay visible",
      status: "hard",
      expected: {
        topK: 1,
        sourceId: "codex",
        acceptableSessionUuids: [QUERY_WINDOW_SESSION],
        sessionRef: QUERY_WINDOW_SESSION,
        cwdContains: "/tmp/sherlog-acceptance/format-diff",
        matchSource: "message",
        matchSeq: 1,
        context: {
          mode: "read-range",
          before: 0,
          after: 0,
          mustContain: [
            "存储位置 │ ~/.codex/sessions/（扁平）",
            "对话结构 │ 线性 │ 树形（parentUuid 分支）",
          ],
        },
      },
    },
  ];
}

function writeAcceptanceFixtures(base: string): AcceptanceFixtureRoots {
  const roots: AcceptanceFixtureRoots = {
    codex: join(base, "sessions"),
    "claude-code": join(base, "claude-projects", "synthetic-project"),
    pi: join(base, "pi-sessions"),
  };

  writeCodexAcceptanceFixtures(roots.codex);
  writeClaudeCodeAcceptanceFixture(roots["claude-code"]);
  writePiAcceptanceFixture(roots.pi);
  return roots;
}

function writeCodexAcceptanceFixtures(root: string): void {
  const day = join(root, "2026", "06", "26");
  mkdirSync(day, { recursive: true });
  writeCodexSession(day, MESSAGE_HIT_SESSION, "/tmp/sherlog-acceptance/deploy", [
    event("user_message", "Investigate deploy failure"),
    event("agent_message", "The health check returned 500 after deploy."),
    event("user_message", "The rollback plan includes readback verification."),
  ]);
  writeCodexSession(day, SESSION_HIT_SESSION, "/tmp/sherlog-acceptance/handoff", [
    event("user_message", "Prepare release notes"),
    compacted("handoff says durable output queue needs final verification"),
    event("agent_message", "Use the existing checklist before publishing."),
  ]);
  writeCodexSession(day, CJK_HIT_SESSION, "/tmp/sherlog-acceptance/cjk", [
    event("user_message", "准备回滚预案"),
    event("agent_message", "先确认健康检查恢复，再继续发布。"),
  ]);
  writeCodexSession(day, NOISE_SESSION, "/tmp/sherlog-acceptance/noise", [
    event("user_message", "Refactor parser docs"),
    event("agent_message", "No deploy or handoff evidence here."),
  ]);
  // Near-identical resume/fork family: same cwd, same opening message, the
  // needle repeated across every member.
  for (const uuid of DUP_FAMILY_SESSIONS) {
    writeCodexSession(day, uuid, "/tmp/sherlog-acceptance/family", [
      event("user_message", "familyneedle staging cutover checklist"),
      event("agent_message", "familyneedle staging cutover repeated boilerplate from the duplicated transcript."),
    ]);
  }
  writeCodexSession(day, DIVERSE_HIT_SESSION, "/tmp/sherlog-acceptance/diverse", [
    event("user_message", "familyneedle staging cutover decision record"),
    event("agent_message", "The distinct session captures the actual cutover decision evidence."),
  ]);
  writeCodexSession(day, COMMAND_EXEC_SESSION, "/tmp/sherlog-acceptance/what7", [
    event("user_message", "怎么使用"),
    event("agent_message", "cd /tmp/sherlog-acceptance/what7 && node dist/cli.js publish fixtures/sample.jsonl --json"),
  ]);
  writeCodexSession(day, COMMAND_RESTATE_SESSION, "/tmp/sherlog-acceptance/play", [
    event("user_message", "cxs node dist/cli.js publish 搜下这个是哪个项目路径的", "2026-06-27T05:00:00.000Z"),
    event("agent_message", "这是在搜命令对应的仓库", "2026-06-27T05:00:01.000Z"),
  ]);
  writeCodexSession(day, QUERY_WINDOW_SESSION, "/tmp/sherlog-acceptance/format-diff", [
    event("user_message", "compare the two session transcript formats"),
    event("agent_message", [
      "两个格式的关键差异：\n",
      "存储位置 │ ~/.codex/sessions/（扁平） │ ~/.claude/projects/<hash>/<uuid>.jsonl（嵌套）\n",
      `${"x".repeat(500)}\n`,
      "对话结构 │ 线性 │ 树形（parentUuid 分支）\n",
      "y".repeat(400),
    ].join("")),
  ]);
}

function writeClaudeCodeAcceptanceFixture(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "claude-eval.jsonl"),
    `${[
      claudeLine({
        type: "user",
        sessionId: "claude-eval-session",
        cwd: "/tmp/sherlog-acceptance/claude",
        timestamp: "2026-06-26T05:01:00.000Z",
        message: { content: "claude adapter needle should rank this session first" },
      }),
      claudeLine({
        type: "assistant",
        sessionId: "claude-eval-session",
        cwd: "/tmp/sherlog-acceptance/claude",
        timestamp: "2026-06-26T05:01:01.000Z",
        message: { content: [{ type: "text", text: "claude range evidence remains readable after source-qualified find" }] },
      }),
    ].join("\n")}\n`,
  );
}

function writePiAcceptanceFixture(root: string): void {
  const projectDir = join(root, "--tmp-pi-project--");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, "pi-eval.jsonl"),
    `${[
      piLine({ type: "session", id: "pi-eval-session", cwd: "/tmp/sherlog-acceptance/pi", timestamp: "2026-06-26T05:02:00.000Z" }),
      piLine({
        type: "message",
        timestamp: "2026-06-26T05:02:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "pi accepted user prompt" }], timestamp: "2026-06-26T05:02:01.000Z" },
      }),
      piLine({
        type: "message",
        timestamp: "2026-06-26T05:02:02.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "pi accepted assistant reply" }], timestamp: "2026-06-26T05:02:02.000Z" },
      }),
      piLine({ type: "compaction", id: "c1", timestamp: "2026-06-26T05:02:03.000Z", summary: "pi compact queue handoff survives as session recall" }),
    ].join("\n")}\n`,
  );
}

function writeCodexSession(day: string, uuid: string, cwd: string, records: Record<string, unknown>[]): void {
  const filePath = join(day, `rollout-2026-06-26T05-00-00-${uuid}.jsonl`);
  const content = [line("session_meta", { id: uuid, cwd }), line("turn_context", { model: "gpt-5.4" }), ...records]
    .map((record) => JSON.stringify(record))
    .join("\n");
  // A completed JSONL record is newline-terminated. Rust intentionally leaves
  // an unterminated final line pending so a concurrent append cannot expose a
  // partial event; acceptance fixtures must model a closed transcript.
  writeFileSync(filePath, `${content}\n`);
}

function event(
  type: "user_message" | "agent_message",
  message: string,
  timestamp = "2026-06-26T05:00:00.000Z",
): Record<string, unknown> {
  return line("event_msg", { type, message }, timestamp);
}

function compacted(message: string): Record<string, unknown> {
  return line("compacted", { message });
}

function line(
  type: string,
  payload: Record<string, unknown>,
  timestamp = "2026-06-26T05:00:00.000Z",
): Record<string, unknown> {
  return {
    timestamp,
    type,
    payload,
  };
}

function claudeLine(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function piLine(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function messagesText(messages: Array<{ role: string; contentText: string }>): string {
  return messages.map((message) => `${message.role}: ${message.contentText}`).join("\n");
}
