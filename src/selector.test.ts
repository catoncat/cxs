import { describe, expect, test } from "vitest";
import { canonicalizeSelector, selectorImplies } from "./selector";

describe("selector", () => {
  test("canonicalizes selector roots to absolute paths", () => {
    expect(canonicalizeSelector({ kind: "all", root: "/tmp/../tmp/cxs-root" })).toEqual({
      kind: "all",
      root: "/tmp/cxs-root",
    });
  });

  test("rejects date ranges with fromDate after toDate", () => {
    expect(() =>
      canonicalizeSelector({
        kind: "date_range",
        root: "/tmp/cxs-root",
        fromDate: "2026-04-23",
        toDate: "2026-04-22",
      })
    ).toThrow("fromDate must be <= toDate");
  });

  test("computes selector implication for root cwd and date scopes", () => {
    const root = "/tmp/cxs-root";
    expect(selectorImplies({ kind: "all", root }, { kind: "cwd", root, cwd: "/tmp/project" })).toBe(true);
    expect(selectorImplies(
      { kind: "cwd", root, cwd: "/tmp/project" },
      { kind: "cwd_date_range", root, cwd: "/tmp/project", fromDate: "2026-04-21", toDate: "2026-04-22" },
    )).toBe(true);
    expect(selectorImplies(
      { kind: "date_range", root, fromDate: "2026-04-01", toDate: "2026-04-30" },
      { kind: "date_range", root, fromDate: "2026-04-10", toDate: "2026-04-20" },
    )).toBe(true);
    expect(selectorImplies(
      { kind: "cwd", root, cwd: "/tmp/other" },
      { kind: "cwd_date_range", root, cwd: "/tmp/project", fromDate: "2026-04-21", toDate: "2026-04-22" },
    )).toBe(false);
  });
});
