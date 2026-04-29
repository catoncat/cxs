import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSourceInventory, collectSourceSnapshot } from "./source-inventory";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("source inventory", () => {
  test("returns path dates and cwd groups without indexing content", () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-source-inventory-"));
    tempDirs.push(base);
    const root = join(base, "sessions");
    const day = join(root, "2026", "04", "22");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, "rollout-2026-04-22T12-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl"),
      [
        line("session_meta", { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", cwd: "/tmp/alpha" }),
        line("event_msg", { type: "user_message", message: "do not use me for inventory" }),
      ].join("\n"),
    );

    const inventory = collectSourceInventory(root);

    expect(inventory.totalFiles).toBe(1);
    expect(inventory.pathDateRange).toEqual({ from: "2026-04-22", to: "2026-04-22" });
    expect(inventory.cwdGroups).toEqual([
      { cwd: "/tmp/alpha", fileCount: 1, pathDateRange: { from: "2026-04-22", to: "2026-04-22" } },
    ]);
  });

  test("builds selector snapshots from raw source metadata", () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-source-snapshot-"));
    tempDirs.push(base);
    const root = join(base, "sessions");
    const day = join(root, "2026", "04", "22");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, "rollout-2026-04-22T12-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl"),
      [
        line("session_meta", { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", cwd: "/tmp/alpha" }),
        line("event_msg", { type: "user_message", message: "alpha" }),
      ].join("\n"),
    );
    writeFileSync(
      join(day, "rollout-2026-04-22T13-00-00-cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl"),
      [
        line("session_meta", { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", cwd: "/tmp/beta" }),
        line("event_msg", { type: "user_message", message: "beta" }),
      ].join("\n"),
    );

    const snapshot = collectSourceSnapshot({ kind: "cwd", root, cwd: "/tmp/alpha" });

    expect(snapshot.fileCount).toBe(1);
    expect(snapshot.files[0]?.cwd).toBe("/tmp/alpha");
    expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});

function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: new Date("2026-04-22T00:00:00.000Z").toISOString(),
    type,
    payload,
  });
}
