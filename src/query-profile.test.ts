import { describe, expect, test } from "vitest";
import { classifyQueryProfile } from "./query";

describe("query profile", () => {
  test("classifies broad concept query separately from exact troubleshooting query", () => {
    expect(classifyQueryProfile("deploy").kind).toBe("broad");
    expect(classifyQueryProfile("health check 500").kind).toBe("exact");
    expect(classifyQueryProfile("src/background.ts remoteHosts").kind).toBe("exact");
  });
});
