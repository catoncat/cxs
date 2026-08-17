import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import packageJson from "../package.json" with { type: "json" };
import {
  SHLOG_BIN_UNDER_TEST,
  SHLOG_CLI_ARGV_JSON,
  resolveCliUnderTest,
  runCliUnderTest,
  type CliRunResult,
  type CliUnderTest,
} from "./cli-under-test";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE_SOURCE = resolve(import.meta.dirname, "fixtures", "contract");
// Keep fixture sessions outside ranking's 120-day recency window so two
// executables started milliseconds apart still expose exactly the same score.
const FIXED_FILE_TIME = new Date("2020-01-15T00:00:00.000Z");
const CODEX_SESSION = "10000000-0000-4000-8000-000000000001";
const CODEX_PRUNE_SESSION = "10000000-0000-4000-8000-000000000002";
const CLAUDE_SESSION_REF = "claude-code:contract-claude-session";
const PI_SESSION_REF = "pi:contract-pi-session";
const NATIVE_V8_INDEX_VERSION = "shlog-v8-unicode-word-cjk-scalar";

const VOLATILE_JSON_FIELDS = new Map<string, string>([
  ["elapsedMs", "<ELAPSED_MS>"],
  ["completedAt", "<RUNTIME_TIMESTAMP>"],
  ["lastSyncAt", "<RUNTIME_TIMESTAMP>"],
  ["addedAt", "<RUNTIME_TIMESTAMP>"],
  ["dbSizeBytes", "<SQLITE_FILE_SIZE>"],
]);

// Public, structurally required values whose exact bytes belong to a storage
// epoch. The Rust v8 cutover intentionally changes these values from the v7
// TypeScript oracle; consumers may compare them within one epoch but must not
// hard-code the old bytes.
const OPAQUE_EPOCH_JSON_FIELDS = new Map<string, string>([
  ["indexVersion", "<INDEX_VERSION>"],
  ["sourceFingerprint", "<SOURCE_FINGERPRINT>"],
  ["currentSourceFingerprint", "<SOURCE_FINGERPRINT>"],
  ["sourceFileSetFingerprint", "<SOURCE_FILE_SET_FINGERPRINT>"],
  ["currentSourceFileSetFingerprint", "<SOURCE_FILE_SET_FINGERPRINT>"],
  ["score", "<RANK_SCORE>"],
  ["layout", "<INDEX_LAYOUT>"],
]);

export interface ContractGateOptions {
  keepTemp?: boolean;
  requireCandidateOverride?: boolean;
  referenceArgvJson?: string;
  candidateArgvJson?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ContractExecutables {
  reference: CliUnderTest;
  candidate: CliUnderTest;
}

export type ContractOutputKind = "text" | "json-stdout" | "json-stderr";

export interface ContractObservation {
  exitCode: number;
  stdout: unknown;
  stderr: unknown;
}

export interface ContractCaseResult {
  id: string;
  argv: string[];
  outputKind: ContractOutputKind;
  expectedExitCode: number;
  matched: boolean;
  mismatchPaths: string[];
  reference: ContractObservation;
  candidate: ContractObservation;
}

export interface ContractGateResult {
  referenceCli: CliUnderTest;
  candidateCli: CliUnderTest;
  fixtureRoot: string;
  normalization: {
    volatileJsonFields: string[];
    opaqueEpochJsonFields: string[];
    pathTokens: string[];
    intentionalPolicies: string[];
  };
  total: number;
  passed: number;
  failed: number;
  cases: ContractCaseResult[];
}

interface ContractFixture {
  root: string;
  home: string;
  codexRoot: string;
  claudeRoot: string;
  piRoot: string;
  syncErrorRoot: string;
  unreadablePath: string;
  prunePath: string;
  rewritePath: string;
  coldRoot: string;
}

interface ContractSide {
  cli: CliUnderTest;
  stateRoot: string;
  dbPath: string;
  strictErrorDbPath: string;
  bestEffortDbPath: string;
  missingDbPath: string;
  env: NodeJS.ProcessEnv;
  pathReplacements: ContractPathReplacement[];
}

export interface ContractPathReplacement {
  from: string;
  to: string;
}

interface CaseDefinition {
  id: string;
  args: (side: ContractSide) => string[];
  outputKind: ContractOutputKind;
  expectedExitCode: number;
}

export function resolveContractExecutables(options: ContractGateOptions = {}): ContractExecutables {
  const env = options.env ?? process.env;
  const reference = resolveCliUnderTest({
    ...(options.referenceArgvJson !== undefined ? { argvJson: options.referenceArgvJson } : {}),
    // The reference is deliberately stable: ambient candidate overrides must
    // never silently replace the checkout TypeScript implementation.
    env: {},
  });
  const candidate = resolveCliUnderTest({
    ...(options.candidateArgvJson !== undefined ? { argvJson: options.candidateArgvJson } : {}),
    env,
  });
  return { reference, candidate };
}

export async function runContractGate(options: ContractGateOptions = {}): Promise<ContractGateResult> {
  const executables = resolveContractExecutables(options);
  if (options.requireCandidateOverride && executables.candidate.source === "typescript-reference") {
    throw new Error("contract gate requires an explicit candidate executable override");
  }
  const base = mkdtempSync(join(tmpdir(), "sherlog-contract-"));
  const fixture = prepareContractFixture(base);
  const reference = prepareSide(base, "reference", executables.reference, fixture, options.env);
  const candidate = prepareSide(base, "candidate", executables.candidate, fixture, options.env);
  const cases: ContractCaseResult[] = [];

  const run = async (definition: CaseDefinition): Promise<void> => {
    const referenceArgv = definition.args(reference);
    const candidateArgv = definition.args(candidate);
    const [referenceRaw, candidateRaw] = await Promise.all([
      runCliUnderTest(reference.cli, referenceArgv, { cwd: ROOT, env: reference.env }),
      runCliUnderTest(candidate.cli, candidateArgv, { cwd: ROOT, env: candidate.env }),
    ]);
    const referenceBase = normalizeObservation(
      referenceRaw,
      definition.outputKind,
      reference.pathReplacements,
    );
    const candidateBase = normalizeObservation(
      candidateRaw,
      definition.outputKind,
      candidate.pathReplacements,
    );
    assertContractObservation(definition, referenceBase, "reference");
    assertContractObservation(definition, candidateBase, "candidate");
    assertNativeV8Contract(definition, candidateBase, candidate.cli);
    const referenceObservation = normalizeIntentionalV8Differences(definition.id, referenceBase);
    const candidateObservation = normalizeIntentionalV8Differences(definition.id, candidateBase);
    const matched = isDeepStrictEqual(referenceObservation, candidateObservation);
    cases.push({
      id: definition.id,
      argv: normalizeContractValue(referenceArgv, reference.pathReplacements) as string[],
      outputKind: definition.outputKind,
      expectedExitCode: definition.expectedExitCode,
      matched,
      mismatchPaths: matched ? [] : collectMismatchPaths(referenceObservation, candidateObservation),
      reference: referenceObservation,
      candidate: candidateObservation,
    });
  };

  try {
    await run(textCase("version", ["--version"]));
    await run(textCase("help", ["--help"]));
    await run(textCase("error-missing-find-query", ["find", "--json"], 1));
    await run(jsonCase("status-empty-index", (side) => [
      "status", "--source", "codex", "--db", side.dbPath, "--json",
    ]));

    await run(jsonCase("sync-strict-codex", (side) => [
      "sync", "--source", "codex", "--db", side.dbPath, "--json",
    ]));
    await run(jsonCase("sync-strict-claude-code", (side) => [
      "sync", "--source", "claude-code", "--db", side.dbPath, "--json",
    ]));
    await run(jsonCase("sync-strict-pi", (side) => [
      "sync", "--source", "pi", "--db", side.dbPath, "--json",
    ]));

    await run(jsonCase("status-indexed-selector", (side) => [
      "status",
      "--source", "codex",
      "--selector", JSON.stringify({ source: "codex", kind: "all", root: fixture.codexRoot }),
      "--db", side.dbPath,
      "--json",
    ]));

    await run(jsonCase("cold-add", (side) => [
      "cold", "add", "--root", fixture.coldRoot, "--source", "codex", "--db", side.dbPath, "--json",
    ]));
    await run(jsonCase("cold-list", (side) => [
      "cold", "list", "--source", "codex", "--db", side.dbPath, "--json",
    ]));
    await run(jsonCase("cold-remove", (side) => [
      "cold", "remove", "--root", fixture.coldRoot, "--source", "codex", "--db", side.dbPath, "--json",
    ]));

    await run(jsonCase("find-single-source", (side) => [
      "find", "contract shared beacon", "--source", "claude-code", "--db", side.dbPath, "--json",
    ]));
    await run(jsonCase("find-all-sources", (side) => [
      "find", "contract shared beacon", "--source", "all", "--db", side.dbPath, "--json",
    ]));
    await run(jsonCase("find-unscoped-default-root", (side) => [
      "find", "contract shared beacon", "--db", side.dbPath, "--json",
    ]));
    await run(jsonCase("read-range", (side) => [
      "read-range", CLAUDE_SESSION_REF, "--seq", "0", "--before", "0", "--after", "1", "--db", side.dbPath, "--json",
    ]));
    await run(jsonCase("error-anchor-not-found", (side) => [
      "read-range", CODEX_SESSION, "--query", "no such contract anchor", "--before", "0", "--after", "0", "--db", side.dbPath, "--json",
    ], 1));
    await run(jsonCase("read-page", (side) => [
      "read-page", PI_SESSION_REF, "--offset", "0", "--limit", "1", "--db", side.dbPath, "--json",
    ]));
    await run(jsonCase("list", (side) => [
      "list", "--source", "codex", "--sort", "messages", "--limit", "10", "--db", side.dbPath, "--json",
    ]));
    await run(jsonCase("stats", (side) => [
      "stats", "--source", "pi", "--db", side.dbPath, "--json",
    ]));

    await run(jsonCase("error-unknown-source", (side) => [
      "status", "--source", "unknown-contract-source", "--db", side.dbPath, "--json",
    ], 1));
    await run(jsonCase("error-invalid-selector", (side) => [
      "status", "--selector", "not-json", "--db", side.dbPath, "--json",
    ], 1));
    await run(jsonCase("error-index-unavailable", (side) => [
      "stats", "--db", side.missingDbPath, "--json",
    ], 1));
    await run(jsonCase("error-session-not-found", (side) => [
      "read-page", "claude-code:missing-contract-session", "--db", side.dbPath, "--json",
    ], 1));

    await run({
      id: "sync-strict-error",
      args: (side) => [
        "sync", "--source", "codex", "--root", fixture.syncErrorRoot, "--db", side.strictErrorDbPath, "--json",
      ],
      outputKind: "json-stderr",
      expectedExitCode: 1,
    });
    await run(jsonCase("sync-best-effort", (side) => [
      "sync", "--source", "codex", "--root", fixture.syncErrorRoot,
      "--best-effort", "--db", side.bestEffortDbPath, "--json",
    ]));

    unlinkSync(fixture.prunePath);
    await run(jsonCase("sync-prune", (side) => [
      "sync", "--source", "codex", "--prune", "--db", side.dbPath, "--json",
    ]));

    // P0.5: a destructive rewrite (truncate) of an indexed file must stop
    // being an advisory "query anyway" content change. The native candidate
    // proves append-only via persisted prefix digests and recommends sync;
    // the legacy TypeScript oracle cannot express that proof and remains
    // advisory. The semantic divergence is intentional for this case.
    truncateToFirstLine(fixture.rewritePath);
    await run(jsonCase("status-destructive-change", (side) => [
      "status",
      "--source", "codex",
      "--selector", JSON.stringify({ source: "codex", kind: "all", root: fixture.codexRoot }),
      "--db", side.dbPath,
      "--json",
    ]));

    return {
      referenceCli: executables.reference,
      candidateCli: executables.candidate,
      fixtureRoot: fixture.root,
      normalization: {
        volatileJsonFields: [...VOLATILE_JSON_FIELDS.keys()],
        opaqueEpochJsonFields: [...OPAQUE_EPOCH_JSON_FIELDS.keys()],
        pathTokens: ["<STATE>", "<HOME>", "<FIXTURE_ROOT>", "<TEMP_ROOT>"],
        intentionalPolicies: [
          "help prose -> fixed command surface",
          "find live freshness -> query-only stored coverage",
          "runtime parser and permission-denied prose -> typed semantic fields",
          "strict incomplete reason -> native source_scan_incomplete",
          "destructive content change -> native prefix-proof sync recommendation (legacy advisory stays query)",
        ],
      },
      total: cases.length,
      passed: cases.filter((entry) => entry.matched).length,
      failed: cases.filter((entry) => !entry.matched).length,
      cases,
    };
  } finally {
    chmodSync(fixture.unreadablePath, 0o644);
    if (!options.keepTemp) rmSync(base, { recursive: true, force: true });
  }
}

function textCase(id: string, argv: string[], expectedExitCode = 0): CaseDefinition {
  return { id, args: () => argv, outputKind: "text", expectedExitCode };
}

function jsonCase(
  id: string,
  args: (side: ContractSide) => string[],
  expectedExitCode = 0,
): CaseDefinition {
  return { id, args, outputKind: "json-stdout", expectedExitCode };
}

function prepareContractFixture(base: string): ContractFixture {
  const root = join(base, "fixtures");
  const home = join(root, "home");
  const codexRoot = join(home, ".codex", "sessions");
  const claudeRoot = join(home, ".claude", "projects");
  const piRoot = join(home, ".pi", "agent", "sessions");
  const syncErrorRoot = join(root, "sync-errors");
  const coldRoot = join(home, "cold-archive");

  copyFixtureDirectory(join(FIXTURE_SOURCE, "codex"), codexRoot);
  copyFixtureDirectory(join(FIXTURE_SOURCE, "claude-code"), claudeRoot);
  copyFixtureDirectory(join(FIXTURE_SOURCE, "pi"), piRoot);
  copyFixtureDirectory(join(FIXTURE_SOURCE, "sync-errors"), syncErrorRoot);
  mkdirSync(coldRoot, { recursive: true });
  setFixedFileTimes(root);

  const unreadablePath = join(
    syncErrorRoot,
    "2020", "01", "15",
    "rollout-2020-01-15T04-10-00-10000000-0000-4000-8000-000000000011.jsonl",
  );
  chmodSync(unreadablePath, 0o000);

  return {
    root,
    home,
    codexRoot,
    claudeRoot,
    piRoot,
    syncErrorRoot,
    unreadablePath,
    prunePath: join(
      codexRoot,
      "2020", "01", "15",
      `rollout-2020-01-15T01-10-00-${CODEX_PRUNE_SESSION}.jsonl`,
    ),
    rewritePath: join(
      codexRoot,
      "2020", "01", "15",
      `rollout-2020-01-15T01-00-00-${CODEX_SESSION}.jsonl`,
    ),
    coldRoot,
  };
}

function copyFixtureDirectory(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

function truncateToFirstLine(path: string): void {
  const lines = readFileSync(path, "utf8").split("\n");
  const first = lines.find((line) => line.trim().length > 0) ?? "";
  writeFileSync(path, `${first}\n`);
}

function setFixedFileTimes(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      setFixedFileTimes(path);
    } else if (entry.isFile()) {
      utimesSync(path, FIXED_FILE_TIME, FIXED_FILE_TIME);
    }
  }
}

function prepareSide(
  base: string,
  name: "reference" | "candidate",
  cli: CliUnderTest,
  fixture: ContractFixture,
  inputEnv: NodeJS.ProcessEnv | undefined,
): ContractSide {
  const stateRoot = join(base, name);
  mkdirSync(stateRoot, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...(inputEnv ?? process.env),
    HOME: fixture.home,
    SHLOG_DATA_DIR: join(stateRoot, "data"),
    XDG_STATE_HOME: join(stateRoot, "xdg-state"),
    SHLOG_DEBUG_TIMING: "0",
    SHLOG_STATS: "0",
    TZ: "UTC",
  };
  delete env.CXS_DATA_DIR;
  delete env.CXS_STATS;
  delete env[SHLOG_BIN_UNDER_TEST];
  delete env[SHLOG_CLI_ARGV_JSON];

  return {
    cli,
    stateRoot,
    dbPath: join(stateRoot, "main.sqlite"),
    strictErrorDbPath: join(stateRoot, "strict-error.sqlite"),
    bestEffortDbPath: join(stateRoot, "best-effort.sqlite"),
    missingDbPath: join(stateRoot, "missing.sqlite"),
    env,
    pathReplacements: [
      { from: stateRoot, to: "<STATE>" },
      { from: fixture.home, to: "<HOME>" },
      { from: fixture.root, to: "<FIXTURE_ROOT>" },
      { from: base, to: "<TEMP_ROOT>" },
    ],
  };
}

function normalizeObservation(
  result: CliRunResult,
  outputKind: ContractOutputKind,
  pathReplacements: ContractPathReplacement[],
): ContractObservation {
  if (outputKind === "json-stdout") {
    return {
      exitCode: result.exitCode,
      stdout: normalizeContractValue(parseJsonOutput(result.stdout, "stdout"), pathReplacements),
      stderr: normalizeContractText(result.stderr, pathReplacements),
    };
  }
  if (outputKind === "json-stderr") {
    return {
      exitCode: result.exitCode,
      stdout: normalizeContractText(result.stdout, pathReplacements),
      stderr: normalizeContractValue(parseJsonOutput(result.stderr, "stderr"), pathReplacements),
    };
  }
  return {
    exitCode: result.exitCode,
    stdout: normalizeContractText(result.stdout, pathReplacements),
    stderr: normalizeContractText(result.stderr, pathReplacements),
  };
}

function parseJsonOutput(value: string, stream: "stdout" | "stderr"): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`contract command emitted invalid JSON on ${stream}: ${message}\n${value}`);
  }
}

export function normalizeContractValue(
  value: unknown,
  pathReplacements: ContractPathReplacement[],
): unknown {
  if (typeof value === "string") return normalizeContractText(value, pathReplacements);
  if (Array.isArray(value)) return value.map((entry) => normalizeContractValue(entry, pathReplacements));
  if (!isRecord(value)) return value;

  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const placeholder = VOLATILE_JSON_FIELDS.get(key);
    normalized[key] = placeholder ?? normalizeContractValue(entry, pathReplacements);
  }
  return normalized;
}

function normalizeIntentionalV8Differences(
  id: string,
  observation: ContractObservation,
): ContractObservation {
  const normalized = normalizeOpaqueEpochValues(structuredClone(observation)) as ContractObservation;
  if (id === "help") normalized.stdout = "<FIXED_COMMAND_SURFACE>\n";

  if (id === "find-single-source" || id === "find-all-sources" || id === "find-unscoped-default-root") {
    const output = isRecord(normalized.stdout) ? normalized.stdout : null;
    if (output) {
      normalizeQueryOnlyCoverage(output.coverage);
      if (Array.isArray(output.coverageBySource)) {
        for (const entry of output.coverageBySource) {
          if (isRecord(entry)) normalizeQueryOnlyCoverage(entry.coverage);
        }
      }
      // Intentional v8 divergence: the legacy oracle still wraps non-fresh
      // coverage into a check_coverage_then_retry nextAction, while native v8
      // emits find nextAction only for zero-result diagnosis and surfaces the
      // same state via coverageBySource. The dsh oracle adapter is a stub that
      // can never be synced in this fixture, so the oracle always emits the
      // coverage advice for the all-source and unscoped cases.
      delete output.nextAction;
    }
  }

  if (id === "status-destructive-change") {
    // P0.5: the native candidate downgrades an unproven content change from
    // advisory query to recommended sync using persisted prefix digests; the
    // legacy oracle stays advisory. Both sides agree on every other field.
    const output = isRecord(normalized.stdout) ? normalized.stdout : null;
    const requested = output && isRecord(output.requestedCoverage) ? output.requestedCoverage : null;
    if (requested) {
      requested.recommendedAction = "<RECOMMENDED_ACTION>";
      if (Array.isArray(requested.coveringSelectors)) {
        for (const entry of requested.coveringSelectors) {
          if (isRecord(entry)) delete entry.advisory;
        }
      }
    }
  }

  if (id === "error-invalid-selector") {
    const output = isRecord(normalized.stdout) ? normalized.stdout : null;
    if (output && isRecord(output.error)) output.error.message = "<INVALID_SELECTOR_MESSAGE>";
  }

  if (id === "sync-strict-error" || id === "sync-best-effort") {
    const output = id === "sync-strict-error" ? normalized.stderr : normalized.stdout;
    if (isRecord(output)) {
      if (Array.isArray(output.errorDetails)) {
        for (const detail of output.errorDetails) {
          if (isRecord(detail) && typeof detail.message === "string") {
            detail.message = "<SOURCE_IO_ERROR_MESSAGE>";
          }
        }
      }
      if (id === "sync-strict-error" && isRecord(output.coverage)) {
        output.coverage.reason = "<INCOMPLETE_COVERAGE_REASON>";
      }
    }
  }
  return normalized;
}

function normalizeOpaqueEpochValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeOpaqueEpochValues);
  if (!isRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    normalized[key] = OPAQUE_EPOCH_JSON_FIELDS.get(key) ?? normalizeOpaqueEpochValues(entry);
  }
  return normalized;
}

function normalizeQueryOnlyCoverage(value: unknown): void {
  if (!isRecord(value)) return;
  value.freshness = "<QUERY_COVERAGE_FRESHNESS>";
  value.staleReason = "<QUERY_COVERAGE_STALE_REASON>";
  if (!Array.isArray(value.coveringSelectors)) return;
  for (const selector of value.coveringSelectors) {
    if (!isRecord(selector)) continue;
    delete selector.advisory;
    delete selector.freshness;
    delete selector.staleReason;
    delete selector.currentSourceFingerprint;
    delete selector.currentSourceFileSetFingerprint;
    delete selector.currentSourceFileCount;
  }
}

function normalizeContractText(value: string, pathReplacements: ContractPathReplacement[]): string {
  return [...pathReplacements]
    .sort((left, right) => right.from.length - left.from.length)
    .reduce((text, replacement) => text.split(replacement.from).join(replacement.to), value);
}

function assertContractObservation(
  definition: CaseDefinition,
  observation: ContractObservation,
  side: "reference" | "candidate",
): void {
  if (observation.exitCode !== definition.expectedExitCode) {
    throw new Error(
      `${side} contract ${definition.id} exited ${observation.exitCode}; expected ${definition.expectedExitCode}`,
    );
  }
  if (definition.outputKind === "json-stdout" && observation.stderr !== "") {
    throw new Error(`${side} contract ${definition.id} unexpectedly wrote stderr`);
  }
  if (definition.outputKind === "json-stderr" && observation.stdout !== "") {
    throw new Error(`${side} contract ${definition.id} unexpectedly wrote stdout`);
  }

  const json = definition.outputKind === "json-stdout"
    ? asRecord(observation.stdout, definition.id, side)
    : definition.outputKind === "json-stderr"
      ? asRecord(observation.stderr, definition.id, side)
      : null;

  switch (definition.id) {
    case "version":
      expectContract(observation.stdout === `${packageJson.version}\n`, definition.id, "version text changed");
      break;
    case "help":
      for (const command of ["status", "sync", "cold", "find", "read-range", "read-page", "list", "stats"]) {
        expectContract(String(observation.stdout).includes(command), definition.id, `help omitted ${command}`);
      }
      break;
    case "status-empty-index":
      expectPath(json, ["index", "exists"], false, definition.id);
      expectPath(json, ["sourceInventory", "totalFiles"], 2, definition.id);
      break;
    case "sync-strict-codex":
      expectPath(json, ["scanned"], 2, definition.id);
      expectPath(json, ["added"], 2, definition.id);
      expectPath(json, ["errors"], 0, definition.id);
      expectPath(json, ["coverage", "written"], true, definition.id);
      break;
    case "sync-strict-claude-code":
    case "sync-strict-pi":
      expectPath(json, ["scanned"], 1, definition.id);
      expectPath(json, ["added"], 1, definition.id);
      expectPath(json, ["errors"], 0, definition.id);
      break;
    case "status-indexed-selector":
      expectPath(json, ["index", "exists"], true, definition.id);
      expectPath(json, ["index", "sessionCount"], 2, definition.id);
      expectPath(json, ["requestedCoverage", "freshness"], "fresh", definition.id);
      break;
    case "cold-add":
      expectPath(json, ["ok"], true, definition.id);
      expectPath(json, ["entry", "sourceId"], "codex", definition.id);
      break;
    case "cold-list":
      expectContract(Array.isArray(json?.roots) && json.roots.length === 1, definition.id, "expected one cold root");
      break;
    case "cold-remove":
      expectPath(json, ["removed"], true, definition.id);
      break;
    case "find-single-source":
      expectContract(deepPathEqual(json, ["sourceIds"], ["claude-code"]), definition.id, "single-source find sourceIds changed");
      expectPath(json, ["results", 0, "sessionRef"], CLAUDE_SESSION_REF, definition.id);
      break;
    case "find-all-sources": {
      expectContract(deepPathEqual(json, ["sourceIds"], ["codex", "claude-code", "pi", "dsh"]), definition.id, "all-source find sourceIds changed");
      const sources = Array.isArray(json?.results)
        ? json.results.map((entry) => isRecord(entry) ? entry.sourceId : null).sort()
        : [];
      expectContract(isDeepStrictEqual(sources, ["claude-code", "codex", "pi"]), definition.id, "all-source find did not return all fixtures");
      break;
    }
    case "read-range":
      expectPath(json, ["session", "sessionUuid"], CLAUDE_SESSION_REF, definition.id);
      expectPath(json, ["messages", 0, "contentText"], "contract shared beacon claude request", definition.id);
      break;
    case "read-page":
      expectPath(json, ["session", "sessionUuid"], PI_SESSION_REF, definition.id);
      expectPath(json, ["totalCount"], 2, definition.id);
      break;
    case "list":
      expectContract(Array.isArray(json?.results) && json.results.length === 2, definition.id, "expected two Codex list rows");
      expectPath(json, ["results", 0, "sessionUuid"], CODEX_SESSION, definition.id);
      break;
    case "stats":
      expectPath(json, ["sessionCount"], 1, definition.id);
      expectPath(json, ["messageCount"], 2, definition.id);
      break;
    case "error-unknown-source":
      expectPath(json, ["error", "code"], "unsupported_source", definition.id);
      break;
    case "error-invalid-selector":
      expectPath(json, ["error", "code"], "invalid_selector", definition.id);
      break;
    case "error-index-unavailable":
      expectPath(json, ["error", "code"], "index_unavailable", definition.id);
      break;
    case "error-session-not-found":
      expectPath(json, ["error", "code"], "session_not_found", definition.id);
      break;
    case "sync-strict-error":
      expectPath(json, ["errors"], 1, definition.id);
      expectPath(json, ["added"], 0, definition.id);
      expectPath(json, ["coverage", "written"], false, definition.id);
      break;
    case "sync-best-effort":
      expectPath(json, ["errors"], 1, definition.id);
      expectPath(json, ["added"], 1, definition.id);
      expectPath(json, ["coverage", "written"], false, definition.id);
      break;
    case "sync-prune":
      expectPath(json, ["removed"], 1, definition.id);
      expectPath(json, ["coverage", "indexedSessionCount"], 1, definition.id);
      break;
  }
}

function assertNativeV8Contract(
  definition: CaseDefinition,
  observation: ContractObservation,
  cli: CliUnderTest,
): void {
  if (cli.source === "typescript-reference") return;
  const json = definition.outputKind === "json-stdout"
    ? (isRecord(observation.stdout) ? observation.stdout : null)
    : definition.outputKind === "json-stderr"
      ? (isRecord(observation.stderr) ? observation.stderr : null)
      : null;
  if (!json) return;

  if (definition.id === "status-empty-index" || definition.id === "status-indexed-selector") {
    expectPath(
      json,
      ["context", "indexVersion"],
      NATIVE_V8_INDEX_VERSION,
      definition.id,
    );
  }
  if (definition.id === "stats") {
    expectPath(json, ["indexVersion"], NATIVE_V8_INDEX_VERSION, definition.id);
  }
  if (definition.id.startsWith("sync-")) {
    expectHexDigestPath(json, ["coverage", "sourceFingerprint"], definition.id);
    expectHexDigestPath(json, ["coverage", "sourceFileSetFingerprint"], definition.id);
  }
  if (definition.id === "find-single-source" || definition.id === "find-all-sources") {
    expectPath(json, ["coverage", "freshness"], "not_checked", definition.id);
  }
  if (definition.id === "sync-strict-error") {
    expectPath(json, ["coverage", "reason"], "source_scan_incomplete", definition.id);
  }
}

function expectHexDigestPath(
  value: unknown,
  path: Array<string | number>,
  id: string,
): void {
  const actual = valueAtPath(value, path);
  expectContract(
    typeof actual === "string" && /^[0-9a-f]{64}$/.test(actual),
    id,
    `${path.join(".")} expected a lowercase 64-hex digest, got ${JSON.stringify(actual)}`,
  );
}

function asRecord(
  value: unknown,
  id: string,
  side: "reference" | "candidate",
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${side} contract ${id} did not emit a JSON object`);
  return value;
}

function expectPath(
  value: unknown,
  path: Array<string | number>,
  expected: unknown,
  id: string,
): void {
  const actual = valueAtPath(value, path);
  expectContract(isDeepStrictEqual(actual, expected), id, `${path.join(".")} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function deepPathEqual(value: unknown, path: Array<string | number>, expected: unknown): boolean {
  return isDeepStrictEqual(valueAtPath(value, path), expected);
}

function valueAtPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function expectContract(condition: boolean, id: string, message: string): asserts condition {
  if (!condition) throw new Error(`reference contract ${id}: ${message}`);
}

function collectMismatchPaths(reference: unknown, candidate: unknown, path = "$", output: string[] = []): string[] {
  if (output.length >= 20 || isDeepStrictEqual(reference, candidate)) return output;
  if (Array.isArray(reference) && Array.isArray(candidate)) {
    if (reference.length !== candidate.length) output.push(`${path}.length`);
    const length = Math.min(reference.length, candidate.length);
    for (let index = 0; index < length && output.length < 20; index += 1) {
      collectMismatchPaths(reference[index], candidate[index], `${path}[${index}]`, output);
    }
    return output;
  }
  if (isRecord(reference) && isRecord(candidate)) {
    const keys = new Set([...Object.keys(reference), ...Object.keys(candidate)]);
    for (const key of [...keys].sort()) {
      if (output.length >= 20) break;
      if (!(key in reference) || !(key in candidate)) {
        output.push(`${path}.${key}`);
        continue;
      }
      collectMismatchPaths(reference[key], candidate[key], `${path}.${key}`, output);
    }
    return output;
  }
  output.push(path);
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
