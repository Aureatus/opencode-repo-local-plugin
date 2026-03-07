import { describe, expect, test } from "bun:test";

import { normalizeAuthMode, resolveRepoRemotePlan } from "../src/lib/auth";
import type { ParsedRepoUrl } from "../src/lib/types";

function makeParsedRepo(raw: string): ParsedRepoUrl {
  return {
    raw,
    host: "github.com",
    pathSegments: ["anomalyco", "opencode"],
    canonicalUrl: "https://github.com/anomalyco/opencode.git",
    key: "github.com/anomalyco/opencode",
  };
}

describe("normalizeAuthMode", () => {
  test("defaults to auto", () => {
    expect(normalizeAuthMode(undefined)).toBe("auto");
  });

  test("rejects unknown values", () => {
    expect(() => normalizeAuthMode("token")).toThrow();
  });
});

describe("resolveRepoRemotePlan", () => {
  test("uses HTTPS primary with SSH fallback in auto mode", () => {
    const plan = resolveRepoRemotePlan(
      makeParsedRepo("anomalyco/opencode"),
      "auto"
    );
    expect(plan.primaryUrl).toBe("https://github.com/anomalyco/opencode.git");
    expect(plan.fallbackUrl).toBe("git@github.com:anomalyco/opencode.git");
  });

  test("uses SSH primary in ssh mode", () => {
    const plan = resolveRepoRemotePlan(
      makeParsedRepo("anomalyco/opencode"),
      "ssh"
    );
    expect(plan.primaryUrl).toBe("git@github.com:anomalyco/opencode.git");
    expect(plan.fallbackUrl).toBeNull();
  });

  test("keeps SSH input as primary in auto mode", () => {
    const plan = resolveRepoRemotePlan(
      makeParsedRepo("git@github.com:anomalyco/opencode.git"),
      "auto"
    );
    expect(plan.primaryUrl).toBe("git@github.com:anomalyco/opencode.git");
    expect(plan.fallbackUrl).toBeNull();
  });

  test("uses HTTPS only in https mode", () => {
    const plan = resolveRepoRemotePlan(
      makeParsedRepo("anomalyco/opencode"),
      "https"
    );
    expect(plan.primaryUrl).toBe("https://github.com/anomalyco/opencode.git");
    expect(plan.fallbackUrl).toBeNull();
  });
});
