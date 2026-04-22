import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

interface FindResult {
  rank: number;
  sessionUuid: string;
  title: string;
}

interface FindOutput {
  query: string;
  results: FindResult[];
}

export interface EvalBatchComparison {
  beforeDir: string;
  afterDir: string;
  totalQueries: number;
  top1Changed: number;
  changedQueries: Array<{
    query: string;
    beforeTop1: string;
    afterTop1: string;
    beforeTitle: string;
    afterTitle: string;
  }>;
}

export function compareEvalBatches(beforeDir: string, afterDir: string): EvalBatchComparison {
  const beforeMap = loadFindOutputs(beforeDir);
  const afterMap = loadFindOutputs(afterDir);
  const sharedKeys = Array.from(beforeMap.keys())
    .filter((key) => afterMap.has(key))
    .sort();

  const changedQueries: EvalBatchComparison["changedQueries"] = [];

  for (const key of sharedKeys) {
    const before = beforeMap.get(key);
    const after = afterMap.get(key);
    if (!before || !after) continue;

    const beforeTop = before.results[0];
    const afterTop = after.results[0];
    if (!beforeTop || !afterTop) continue;
    if (beforeTop.sessionUuid === afterTop.sessionUuid) continue;

    changedQueries.push({
      query: after.query,
      beforeTop1: beforeTop.sessionUuid,
      afterTop1: afterTop.sessionUuid,
      beforeTitle: beforeTop.title,
      afterTitle: afterTop.title,
    });
  }

  return {
    beforeDir,
    afterDir,
    totalQueries: sharedKeys.length,
    top1Changed: changedQueries.length,
    changedQueries,
  };
}

function loadFindOutputs(dir: string): Map<string, FindOutput> {
  const outputs = new Map<string, FindOutput>();
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".find.json")) continue;
    const filePath = join(dir, entry.name);
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as FindOutput;
    outputs.set(basename(entry.name, ".find.json"), parsed);
  }

  return outputs;
}
