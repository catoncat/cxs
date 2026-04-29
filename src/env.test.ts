import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyCacheDir } from "./env";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("migrateLegacyCacheDir", () => {
  test("moves the legacy directory to dest when dest is absent", () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-mig-"));
    tempDirs.push(base);
    const legacy = join(base, "legacy");
    const dest = join(base, "state", "cxs");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "index.sqlite"), "stub");

    expect(migrateLegacyCacheDir(legacy, dest)).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(dest, "index.sqlite"), "utf8")).toBe("stub");
  });

  test("does nothing when legacy is missing (clean install)", () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-mig-"));
    tempDirs.push(base);
    const legacy = join(base, "legacy");
    const dest = join(base, "state", "cxs");

    expect(migrateLegacyCacheDir(legacy, dest)).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });

  test("refuses to clobber when dest already has data", () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-mig-"));
    tempDirs.push(base);
    const legacy = join(base, "legacy");
    const dest = join(base, "state", "cxs");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "index.sqlite"), "old");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "index.sqlite"), "new");

    expect(migrateLegacyCacheDir(legacy, dest)).toBe(false);
    // both still in place; user can decide which to keep
    expect(readFileSync(join(legacy, "index.sqlite"), "utf8")).toBe("old");
    expect(readFileSync(join(dest, "index.sqlite"), "utf8")).toBe("new");
  });

  test("no-op when legacy === dest (CXS_DATA_DIR points back to legacy)", () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-mig-"));
    tempDirs.push(base);
    const same = join(base, "shared");
    mkdirSync(same);
    writeFileSync(join(same, "index.sqlite"), "stub");

    expect(migrateLegacyCacheDir(same, same)).toBe(false);
    expect(readFileSync(join(same, "index.sqlite"), "utf8")).toBe("stub");
  });
});
