import { describe, expect, test } from "bun:test";

import { createGitFailureError } from "../src/lib/git";

describe("createGitFailureError", () => {
  test("maps HTTPS credential prompts to GIT_AUTH", () => {
    const error = createGitFailureError(
      ["fetch", "--prune", "origin"],
      "",
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      false
    );

    expect(error.code).toBe("GIT_AUTH");
    expect(error.message).toBe(
      "Git authentication failed for remote repository"
    );
    expect(error.details).toContain("allow_ssh=true");
  });

  test("maps timeouts to GIT_TIMEOUT", () => {
    const error = createGitFailureError(
      ["clone", "https://github.com/acme/private.git", "/tmp/private"],
      "",
      "",
      true
    );

    expect(error.code).toBe("GIT_TIMEOUT");
    expect(error.message).toBe("git command timed out");
    expect(error.details).toContain("timed_out=true");
  });

  test("keeps non-auth failures as GIT_FAILURE", () => {
    const error = createGitFailureError(
      ["checkout", "missing-branch"],
      "",
      "error: pathspec 'missing-branch' did not match any file(s) known to git",
      false
    );

    expect(error.code).toBe("GIT_FAILURE");
    expect(error.message).toBe("git command failed");
  });
});
