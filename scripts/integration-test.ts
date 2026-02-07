import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { repoEnsureLocal } from "../src/tools/repo-ensure-local";

interface IntegrationSummary {
  repoInputs: string[];
  cloneRoot: string;
  firstStatus: string;
  secondStatus: string;
  localPath: string;
  additionalFormats: {
    repo: string;
    status: string;
    localPath: string;
  }[];
}

function assertValidStatus(value: string): void {
  const valid = new Set(["cloned", "updated", "already-current", "fetched"]);
  if (!valid.has(value)) {
    throw new Error(`Unexpected repo_ensure_local status: ${value}`);
  }
}

async function main(): Promise<void> {
  const explicitRepo =
    process.argv[2] || process.env.OPENCODE_REPO_INTEGRATION_REPO;
  const keep = process.env.OPENCODE_REPO_INTEGRATION_KEEP === "true";
  const providedRoot = process.env.OPENCODE_REPO_INTEGRATION_ROOT;
  const defaultRepoBase = "Aureatus/opencode-repo-local-plugin";

  const repoInputs = explicitRepo
    ? [explicitRepo]
    : [
        defaultRepoBase,
        `github.com/${defaultRepoBase}`,
        `https://github.com/${defaultRepoBase}`,
        `https://github.com/${defaultRepoBase}.git`,
        `https://github.com/${defaultRepoBase}/tree/main`,
      ];

  const createdTempRoot = !providedRoot;
  const cloneRoot =
    providedRoot ||
    (await mkdtemp(path.join(os.tmpdir(), "opencode-repo-local-plugin-")));

  try {
    const primaryRepo = repoInputs[0];
    const first = await repoEnsureLocal({
      repo: primaryRepo,
      clone_root: cloneRoot,
      update_mode: "fetch-only",
      allow_ssh: true,
    });

    const second = await repoEnsureLocal({
      repo: primaryRepo,
      clone_root: cloneRoot,
      update_mode: "fetch-only",
      allow_ssh: true,
    });

    const additionalFormats: IntegrationSummary["additionalFormats"] = [];
    for (const repo of repoInputs.slice(1)) {
      const result = await repoEnsureLocal({
        repo,
        clone_root: cloneRoot,
        update_mode: "fetch-only",
        allow_ssh: true,
      });

      assertValidStatus(result.status);
      if (result.local_path !== first.local_path) {
        throw new Error(
          `Expected shared local_path across formats, got ${result.local_path}`
        );
      }

      additionalFormats.push({
        repo,
        status: result.status,
        localPath: result.local_path,
      });
    }

    assertValidStatus(first.status);
    assertValidStatus(second.status);

    if (!first.local_path.startsWith(path.resolve(cloneRoot))) {
      throw new Error("local_path does not resolve under clone root");
    }

    const summary: IntegrationSummary = {
      repoInputs,
      cloneRoot,
      firstStatus: first.status,
      secondStatus: second.status,
      localPath: first.local_path,
      additionalFormats,
    };

    console.log("Integration test passed");
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (createdTempRoot && !keep) {
      await rm(cloneRoot, { recursive: true, force: true });
    }
  }
}

await main();
