import { tool } from "@opencode-ai/plugin";

import { RepoPluginError, toRepoPluginError } from "../lib/errors";
import {
  checkoutRef,
  cloneRepo,
  directoryExists,
  ensureGitAvailable,
  fetchOrigin,
  getCurrentRef,
  getDefaultBranch,
  getHeadSha,
  getOriginUrl,
  hardResetToOriginBranch,
  isGitRepository,
  isWorktreeDirty,
  pullFfOnlyForBranch,
} from "../lib/git";
import { buildRepoPath, resolveCloneRoot } from "../lib/paths";
import { logRepoEnsureFailure, logRepoEnsureSuccess } from "../lib/telemetry";
import type {
  RepoEnsureLocalArgs,
  RepoEnsureResult,
  RepoEnsureStatus,
  UpdateMode,
} from "../lib/types";
import { parseRepoUrl } from "../lib/url";

const UPDATE_MODES: ReadonlySet<string> = new Set([
  "ff-only",
  "fetch-only",
  "reset-clean",
]);

const REPO_TOOL_ARGS = {
  repo: tool.schema
    .string()
    .describe(
      "Repository URL to clone/update locally. Use this when a user references a GitHub repo or any remote repo outside the current workspace, including repo-specific conceptual questions that need grounded code inspection."
    ),
  ref: tool.schema
    .string()
    .optional()
    .describe("Optional branch/tag/sha to checkout after clone/fetch."),
  clone_root: tool.schema
    .string()
    .optional()
    .describe("Optional absolute clone root path override."),
  depth: tool.schema
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional shallow clone depth."),
  update_mode: tool.schema
    .string()
    .optional()
    .describe("Update policy: ff-only (default), fetch-only, or reset-clean."),
  allow_ssh: tool.schema
    .boolean()
    .optional()
    .describe(
      "Allow git@host:owner/repo.git URLs. Defaults to false unless OPENCODE_REPO_ALLOW_SSH=true."
    ),
} as const;

const ALLOWED_KEYS = new Set(Object.keys(REPO_TOOL_ARGS));

function normalizeUpdateMode(value: string | undefined): UpdateMode {
  const mode = (value ?? "ff-only").trim();
  if (!UPDATE_MODES.has(mode)) {
    throw new RepoPluginError(
      "INVALID_UPDATE_MODE",
      `Unsupported update_mode: ${mode}`
    );
  }
  return mode as UpdateMode;
}

function formatFailure(error: unknown): never {
  const parsed = toRepoPluginError(error);
  const detailSuffix = parsed.details ? `\n${parsed.details}` : "";
  throw new Error(`[${parsed.code}] ${parsed.message}${detailSuffix}`);
}

function toResultText(result: RepoEnsureResult): string {
  return JSON.stringify(result, null, 2);
}

function assertKnownArgs(args: RepoEnsureLocalArgs): void {
  const extraKeys = Object.keys(args ?? {}).filter(
    (key) => !ALLOWED_KEYS.has(key)
  );
  if (extraKeys.length > 0) {
    throw new RepoPluginError(
      "INVALID_ARGS",
      `Unknown arguments: ${extraKeys.join(", ")}`
    );
  }
}

async function checkoutIfRequested(
  localPath: string,
  ref: string | undefined,
  actions: string[]
): Promise<void> {
  if (!ref) {
    return;
  }

  await checkoutRef(localPath, ref);
  actions.push(`checked_out_${ref}`);
}

async function runFastForward(
  localPath: string,
  actions: string[]
): Promise<void> {
  if (await isWorktreeDirty(localPath)) {
    throw new RepoPluginError(
      "DIRTY_WORKTREE",
      "Cannot fast-forward because working tree has local changes",
      "Commit/stash changes or use update_mode=fetch-only"
    );
  }

  const currentRef = await getCurrentRef(localPath);
  if (currentRef === "HEAD") {
    actions.push("detached_head_no_pull");
    return;
  }

  await pullFfOnlyForBranch(localPath, currentRef);
  actions.push(`fast_forwarded_${currentRef}`);
}

async function runResetClean(
  localPath: string,
  actions: string[]
): Promise<void> {
  const currentRef = await getCurrentRef(localPath);
  if (currentRef === "HEAD") {
    throw new RepoPluginError(
      "DETACHED_HEAD",
      "Cannot use reset-clean while repository is in detached HEAD state"
    );
  }

  await hardResetToOriginBranch(localPath, currentRef);
  actions.push(`reset_clean_${currentRef}`);
}

async function ensureExistingCloneMatchesRemote(
  localPath: string,
  requestedRepo: ReturnType<typeof parseRepoUrl>
): Promise<void> {
  if (!(await isGitRepository(localPath))) {
    throw new RepoPluginError(
      "NOT_GIT_REPO",
      `Target path exists but is not a git repository: ${localPath}`
    );
  }

  const originUrl = await getOriginUrl(localPath);
  const existingOrigin = parseRepoUrl(originUrl, true);
  if (existingOrigin.key === requestedRepo.key) {
    return;
  }

  throw new RepoPluginError(
    "REPO_URL_MISMATCH",
    "Existing clone origin does not match requested repository",
    `requested=${requestedRepo.canonicalUrl}\nexisting=${existingOrigin.canonicalUrl}`
  );
}

async function cloneMissingRepo(
  localPath: string,
  repoUrl: string,
  depth: number | undefined,
  ref: string | undefined,
  actions: string[]
): Promise<RepoEnsureStatus> {
  await cloneRepo(repoUrl, localPath, depth);
  actions.push("cloned_repository");
  await checkoutIfRequested(localPath, ref, actions);
  return "cloned";
}

async function updateExistingRepo(
  localPath: string,
  requestedRepo: ReturnType<typeof parseRepoUrl>,
  mode: UpdateMode,
  ref: string | undefined,
  actions: string[]
): Promise<RepoEnsureStatus> {
  await ensureExistingCloneMatchesRemote(localPath, requestedRepo);

  const beforeSha = await getHeadSha(localPath);
  await fetchOrigin(localPath);
  actions.push("fetched_origin");

  await checkoutIfRequested(localPath, ref, actions);

  if (mode === "ff-only") {
    await runFastForward(localPath, actions);
  }

  if (mode === "reset-clean") {
    await runResetClean(localPath, actions);
  }

  if (mode === "fetch-only") {
    return "fetched";
  }

  const afterSha = await getHeadSha(localPath);
  return beforeSha === afterSha ? "already-current" : "updated";
}

export async function repoEnsureLocal(
  args: RepoEnsureLocalArgs
): Promise<RepoEnsureResult> {
  assertKnownArgs(args);

  const repoInput = args.repo?.trim();
  if (!repoInput) {
    throw new RepoPluginError("INVALID_URL", "repo argument cannot be empty");
  }

  const ref = args.ref?.trim() || undefined;
  const mode = normalizeUpdateMode(args.update_mode);
  const allowSsh =
    args.allow_ssh ?? process.env.OPENCODE_REPO_ALLOW_SSH === "true";
  const parsedRepo = parseRepoUrl(repoInput, allowSsh);

  await ensureGitAvailable();

  const cloneRoot = await resolveCloneRoot(args.clone_root);
  const localPath = buildRepoPath(cloneRoot, parsedRepo);
  const actions: string[] = [];

  const status = (await directoryExists(localPath))
    ? await updateExistingRepo(localPath, parsedRepo, mode, ref, actions)
    : await cloneMissingRepo(
        localPath,
        parsedRepo.canonicalUrl,
        args.depth,
        ref,
        actions
      );

  return {
    status,
    repo_url: parsedRepo.canonicalUrl,
    local_path: localPath,
    current_ref: await getCurrentRef(localPath),
    default_branch: await getDefaultBranch(localPath),
    head_sha: await getHeadSha(localPath),
    actions,
    instructions: [
      `Use built-in tools with local_path: ${localPath}`,
      `Example: run Grep/Read/Glob with files under ${localPath}`,
    ],
  };
}

export const repoEnsureLocalTool = tool({
  description:
    "When a user references a GitHub/remote repository, clone or update it locally so OpenCode can investigate with built-in tools (Read, Grep, Glob, Bash). Also useful for repo-specific conceptual analysis when grounding answers in real source code improves reliability. Returns absolute local_path.",
  args: REPO_TOOL_ARGS,
  async execute(args) {
    const typedArgs = args as RepoEnsureLocalArgs;
    try {
      const result = await repoEnsureLocal(typedArgs);
      await logRepoEnsureSuccess(typedArgs, result);
      return toResultText(result);
    } catch (error) {
      await logRepoEnsureFailure(typedArgs, error);
      formatFailure(error);
    }
  },
});
