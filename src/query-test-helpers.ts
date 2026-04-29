import { afterEach } from "vitest";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

export const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

export function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: new Date("2026-04-21T00:00:00.000Z").toISOString(),
    type,
    payload,
  });
}

export function runReadChild(
  queryModuleUrl: string,
  dbPath: string,
  command: "find" | "stats",
  query?: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const script = `
      const [moduleUrl, dbPath, command, query = ""] = process.argv.slice(1);
      const queryModule = await import(moduleUrl);
      if (command === "stats") {
        queryModule.collectStats(dbPath);
      } else {
        queryModule.findSessions(dbPath, query, 5);
      }
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--eval", script, queryModuleUrl, dbPath, command, query ?? ""],
      { cwd: import.meta.dirname, stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr });
    });
  });
}

export function holdExclusiveLock(
  dbPath: string,
  holdMs: number,
): Promise<{ done: Promise<number | null> }> {
  return new Promise((resolve, reject) => {
    const script = `
      import Database from "better-sqlite3";
      const [dbPath, holdMs] = process.argv.slice(1);
      const db = new Database(dbPath);
      db.pragma("busy_timeout = 5000");
      db.pragma("locking_mode = EXCLUSIVE");
      db.exec("BEGIN EXCLUSIVE");
      console.log("locked");
      setTimeout(() => {
        db.exec("COMMIT");
        db.close();
      }, Number(holdMs));
    `;
    const child = spawn(
      process.execPath,
      ["--eval", script, dbPath, String(holdMs)],
      { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "pipe"] },
    );

    let settled = false;
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (!settled && code !== 0) {
        settled = true;
        reject(new Error(stderr || `lock holder exited with code ${code}`));
      }
    });
    child.stdout.on("data", (chunk) => {
      if (settled || !chunk.includes("locked")) return;
      settled = true;
      resolve({
        done: new Promise((doneResolve, doneReject) => {
          child.on("error", doneReject);
          child.on("close", (code) => {
            if (code === 0) {
              doneResolve(code);
              return;
            }
            doneReject(new Error(stderr || `lock holder exited with code ${code}`));
          });
        }),
      });
    });
  });
}
