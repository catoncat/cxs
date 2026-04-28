import { resolve } from "node:path";
import { compareEvalBatches } from "./compare";

const beforeDir = process.argv[2];
const afterDir = process.argv[3];

if (!beforeDir || !afterDir) {
  console.error("usage: npm run eval:compare -- <beforeDir> <afterDir>");
  process.exit(1);
}

const summary = compareEvalBatches(resolve(beforeDir), resolve(afterDir));
console.log(JSON.stringify(summary, null, 2));
