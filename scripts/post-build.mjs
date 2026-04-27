#!/usr/bin/env node
// Adds the Node shebang to dist/cli.js and marks it executable, so that npm's
// bin field can point straight at the compiled file. Cross-platform; chmod is
// a no-op on Windows but npm wraps the bin with a cmd shim there anyway.

import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const distCli = resolve(here, "..", "dist", "cli.js");

const SHEBANG = "#!/usr/bin/env node\n";
const original = readFileSync(distCli, "utf8");

// Source file may carry its own shebang (e.g. #!/usr/bin/env bun for dev).
// Always normalize to node for the published artifact.
const stripped = original.startsWith("#!") ? original.slice(original.indexOf("\n") + 1) : original;
writeFileSync(distCli, SHEBANG + stripped);

chmodSync(distCli, 0o755);
console.log(`post-build: prepared ${distCli}`);
