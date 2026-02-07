import { describe, expect, test } from "bun:test";

import { parseRepoUrl } from "../src/lib/url";

describe("parseRepoUrl", () => {
  test("parses https repository URLs", () => {
    const parsed = parseRepoUrl(
      "https://github.com/anomalyco/opencode.git",
      false
    );
    expect(parsed.host).toBe("github.com");
    expect(parsed.pathSegments).toEqual(["anomalyco", "opencode"]);
    expect(parsed.canonicalUrl).toBe(
      "https://github.com/anomalyco/opencode.git"
    );
  });

  test("parses ssh repository URLs when enabled", () => {
    const parsed = parseRepoUrl("git@github.com:anomalyco/opencode.git", true);
    expect(parsed.host).toBe("github.com");
    expect(parsed.pathSegments).toEqual(["anomalyco", "opencode"]);
  });

  test("parses ssh:// URLs when enabled", () => {
    const parsed = parseRepoUrl(
      "ssh://git@github.com/anomalyco/opencode.git",
      true
    );
    expect(parsed.host).toBe("github.com");
    expect(parsed.pathSegments).toEqual(["anomalyco", "opencode"]);
  });

  test("parses host/path shorthand as https", () => {
    const parsed = parseRepoUrl("github.com/anomalyco/opencode", false);
    expect(parsed.host).toBe("github.com");
    expect(parsed.pathSegments).toEqual(["anomalyco", "opencode"]);
    expect(parsed.canonicalUrl).toBe(
      "https://github.com/anomalyco/opencode.git"
    );
  });

  test("parses owner/repo shorthand as github", () => {
    const parsed = parseRepoUrl("anomalyco/opencode", false);
    expect(parsed.host).toBe("github.com");
    expect(parsed.pathSegments).toEqual(["anomalyco", "opencode"]);
    expect(parsed.canonicalUrl).toBe(
      "https://github.com/anomalyco/opencode.git"
    );
  });

  test("normalizes github web tree URL to repo root", () => {
    const parsed = parseRepoUrl(
      "https://github.com/anomalyco/opencode/tree/main/packages",
      false
    );
    expect(parsed.pathSegments).toEqual(["anomalyco", "opencode"]);
    expect(parsed.canonicalUrl).toBe(
      "https://github.com/anomalyco/opencode.git"
    );
  });

  test("rejects ssh repository URLs when disabled", () => {
    expect(() =>
      parseRepoUrl("git@github.com:anomalyco/opencode.git", false)
    ).toThrow();
  });

  test("rejects http URLs", () => {
    expect(() =>
      parseRepoUrl("http://github.com/anomalyco/opencode.git", false)
    ).toThrow();
  });
});
