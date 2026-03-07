import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RepoEnsureResult } from "../src/lib/types";
import { repoEnsureLocal } from "../src/tools/repo-ensure-local";

const ERROR_CODE_PATTERN = /^\[([A-Z0-9_]+)]/;

interface CaseOutcome {
  name: string;
  ok: boolean;
  status: string;
  freshness: string;
  actions: string[];
  errorCode: string | null;
  errorMessage: string | null;
}

function readExpectation(name: string): string | null {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return null;
  }

  if (raw.toLowerCase() === "success") {
    return "success";
  }

  return raw.toUpperCase();
}

function parseErrorCode(error: unknown): string {
  if (!(error instanceof Error)) {
    return "UNKNOWN_ERROR";
  }

  const match = error.message.match(ERROR_CODE_PATTERN);
  return match?.[1] ?? "UNKNOWN_ERROR";
}

function buildErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function assertExpected(
  name: string,
  expected: string | null,
  outcome: CaseOutcome
): void {
  if (!expected) {
    return;
  }

  if (expected === "success") {
    if (!outcome.ok) {
      throw new Error(
        `${name} expected success but failed with ${outcome.errorCode}`
      );
    }
    return;
  }

  if (outcome.ok) {
    throw new Error(`${name} expected ${expected} but succeeded`);
  }

  if (outcome.errorCode !== expected) {
    throw new Error(
      `${name} expected ${expected} but got ${outcome.errorCode}`
    );
  }
}

async function runCase(
  name: string,
  action: () => Promise<RepoEnsureResult>
): Promise<CaseOutcome> {
  try {
    const result = await action();
    return {
      name,
      ok: true,
      status: result.status,
      freshness: result.freshness,
      actions: result.actions,
      errorCode: null,
      errorMessage: null,
    };
  } catch (error) {
    return {
      name,
      ok: false,
      status: "error",
      freshness: "unknown",
      actions: [],
      errorCode: parseErrorCode(error),
      errorMessage: buildErrorMessage(error),
    };
  }
}

async function main(): Promise<void> {
  const httpsRepo = process.env.OPENCODE_REPO_PRIVATE_HTTPS_REPO?.trim();
  const sshRepo = process.env.OPENCODE_REPO_PRIVATE_SSH_REPO?.trim();
  const providedRoot = process.env.OPENCODE_REPO_INTEGRATION_ROOT?.trim();
  const keep = process.env.OPENCODE_REPO_INTEGRATION_KEEP === "true";

  if (!(httpsRepo || sshRepo)) {
    console.log(
      "Skipping private auth integration test (set OPENCODE_REPO_PRIVATE_HTTPS_REPO and/or OPENCODE_REPO_PRIVATE_SSH_REPO)."
    );
    return;
  }

  const createdTempRoot = !providedRoot;
  const cloneRoot =
    providedRoot ||
    (await mkdtemp(path.join(os.tmpdir(), "opencode-repo-local-private-")));

  const outcomes: CaseOutcome[] = [];

  try {
    if (httpsRepo) {
      outcomes.push(
        await runCase("https", () =>
          repoEnsureLocal({
            repo: httpsRepo,
            clone_root: cloneRoot,
            update_mode: "fetch-only",
            auth_mode: "https",
          })
        )
      );

      outcomes.push(
        await runCase("auto", () =>
          repoEnsureLocal({
            repo: httpsRepo,
            clone_root: cloneRoot,
            update_mode: "fetch-only",
            auth_mode: "auto",
            allow_ssh: true,
          })
        )
      );
    }

    if (sshRepo) {
      outcomes.push(
        await runCase("ssh", () =>
          repoEnsureLocal({
            repo: sshRepo,
            clone_root: cloneRoot,
            update_mode: "fetch-only",
            auth_mode: "ssh",
            allow_ssh: true,
          })
        )
      );
    }

    const expectedHttps = readExpectation("OPENCODE_REPO_PRIVATE_EXPECT_HTTPS");
    const expectedAuto = readExpectation("OPENCODE_REPO_PRIVATE_EXPECT_AUTO");
    const expectedSsh = readExpectation("OPENCODE_REPO_PRIVATE_EXPECT_SSH");

    for (const outcome of outcomes) {
      let expected = expectedSsh;
      if (outcome.name === "https") {
        expected = expectedHttps;
      }

      if (outcome.name === "auto") {
        expected = expectedAuto;
      }

      assertExpected(outcome.name, expected, outcome);
    }

    console.log("Private auth integration test completed");
    console.log(
      JSON.stringify(
        {
          cloneRoot,
          outcomes,
        },
        null,
        2
      )
    );
  } finally {
    if (createdTempRoot && !keep) {
      await rm(cloneRoot, { recursive: true, force: true });
    }
  }
}

await main();
