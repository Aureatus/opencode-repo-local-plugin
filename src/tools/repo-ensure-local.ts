import { rm } from "node:fs/promises";
import { tool } from "@opencode-ai/plugin";

import { normalizeAuthMode, resolveRepoRemotePlan } from "../lib/auth";
import { RepoPluginError, toRepoPluginError } from "../lib/errors";
import {
  type AheadBehindCounts,
  checkoutRef,
  cloneRepo,
  directoryExists,
  ensureGitAvailable,
  fetchOrigin,
  getAheadBehindCounts,
  getCurrentRef,
  getDefaultBranch,
  getHeadSha,
  getOriginUrl,
  getRefSha,
  getUpstreamRef,
  hardResetToOriginBranch,
  isGitRepository,
  isWorktreeDirty,
  pullFfOnlyForBranch,
  setOriginUrl,
} from "../lib/git";
import { buildRepoPath, resolveCloneRoot } from "../lib/paths";
import { logRepoEnsureFailure, logRepoEnsureSuccess } from "../lib/telemetry";
import type {
  AuthMode,
  RepoEnsureLocalArgs,
  RepoEnsureResult,
  RepoEnsureStatus,
  RepoFreshnessStatus,
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
      "Remote repository reference to prepare locally. Use this FIRST when a user references a GitHub/remote repo outside the current workspace and the agent needs grounded code inspection. Accepted forms include owner/repo, host/owner/repo, and https URLs. For private repos, verify whether the user has HTTPS credentials configured or prefers SSH URLs."
    ),
  ref: tool.schema
    .string()
    .optional()
    .describe("Optional branch/tag/sha to checkout after clone/fetch."),
  clone_root: tool.schema
    .string()
    .optional()
    .describe(
      "Optional absolute clone root path override. Useful in tests and CI for isolated temporary clone directories."
    ),
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
      "Allow git@host:owner/repo.git URLs. Defaults to false unless OPENCODE_REPO_ALLOW_SSH=true. Set true when the user relies on SSH auth."
    ),
  auth_mode: tool.schema
    .string()
    .optional()
    .describe(
      "Authentication strategy for remote URLs: auto (default), https, or ssh. auto uses HTTPS first and falls back to SSH on auth failure when possible."
    ),
} as const;

const ALLOWED_KEYS = new Set(Object.keys(REPO_TOOL_ARGS));

interface RepoFreshnessDetails {
  comparisonRef: string | null;
  remoteHeadSha: string | null;
  aheadBy: number | null;
  behindBy: number | null;
  freshness: RepoFreshnessStatus;
}

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

function deriveFreshnessFromCounts(
  counts: AheadBehindCounts | null
): RepoFreshnessStatus {
  if (!counts) {
    return "unknown";
  }

  if (counts.aheadBy === 0 && counts.behindBy === 0) {
    return "current";
  }

  if (counts.aheadBy > 0 && counts.behindBy === 0) {
    return "ahead";
  }

  if (counts.aheadBy === 0 && counts.behindBy > 0) {
    return "stale";
  }

  return "diverged";
}

async function resolveComparisonRef(
  localPath: string,
  currentRef: string
): Promise<string | null> {
  const upstreamRef = await getUpstreamRef(localPath);
  if (upstreamRef) {
    return upstreamRef;
  }

  if (currentRef === "HEAD") {
    return null;
  }

  const fallback = `origin/${currentRef}`;
  const fallbackSha = await getRefSha(localPath, fallback);
  if (!fallbackSha) {
    return null;
  }

  return fallback;
}

async function computeFreshnessDetails(
  localPath: string,
  currentRef: string
): Promise<RepoFreshnessDetails> {
  const comparisonRef = await resolveComparisonRef(localPath, currentRef);
  if (!comparisonRef) {
    return {
      comparisonRef: null,
      remoteHeadSha: null,
      aheadBy: null,
      behindBy: null,
      freshness: "unknown",
    };
  }

  const remoteHeadSha = await getRefSha(localPath, comparisonRef);
  const counts = await getAheadBehindCounts(localPath, "HEAD", comparisonRef);
  return {
    comparisonRef,
    remoteHeadSha,
    aheadBy: counts?.aheadBy ?? null,
    behindBy: counts?.behindBy ?? null,
    freshness: deriveFreshnessFromCounts(counts),
  };
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
  primaryRepoUrl: string,
  fallbackRepoUrl: string | null,
  depth: number | undefined,
  ref: string | undefined,
  actions: string[]
): Promise<RepoEnsureStatus> {
  try {
    await cloneRepo(primaryRepoUrl, localPath, depth);
  } catch (error) {
    const parsedError = toRepoPluginError(error);
    const canFallback = parsedError.code === "GIT_AUTH" && fallbackRepoUrl;
    if (!canFallback) {
      throw error;
    }

    await rm(localPath, { force: true, recursive: true });
    await cloneRepo(fallbackRepoUrl, localPath, depth);
    actions.push("auth_fallback_to_ssh");
  }

  actions.push("cloned_repository");
  await checkoutIfRequested(localPath, ref, actions);
  return "cloned";
}

async function updateExistingRepo(
  localPath: string,
  requestedRepo: ReturnType<typeof parseRepoUrl>,
  primaryRepoUrl: string,
  fallbackRepoUrl: string | null,
  authMode: AuthMode,
  mode: UpdateMode,
  ref: string | undefined,
  actions: string[]
): Promise<RepoEnsureStatus> {
  await ensureExistingCloneMatchesRemote(localPath, requestedRepo);

  const configuredOriginUrl = await getOriginUrl(localPath);
  if (authMode !== "auto" && configuredOriginUrl !== primaryRepoUrl) {
    await setOriginUrl(localPath, primaryRepoUrl);
    actions.push(`set_origin_${authMode}`);
  }

  const beforeSha = await getHeadSha(localPath);
  try {
    await fetchOrigin(localPath);
  } catch (error) {
    const parsedError = toRepoPluginError(error);
    const canFallback = parsedError.code === "GIT_AUTH" && fallbackRepoUrl;
    if (!canFallback) {
      throw error;
    }

    await setOriginUrl(localPath, fallbackRepoUrl);
    actions.push("auth_fallback_to_ssh");
    await fetchOrigin(localPath);
  }
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
  const authMode = normalizeAuthMode(args.auth_mode);
  const allowSsh =
    args.allow_ssh ?? process.env.OPENCODE_REPO_ALLOW_SSH === "true";
  const shouldAllowSshInput = allowSsh || authMode !== "https";
  const parsedRepo = parseRepoUrl(repoInput, shouldAllowSshInput);
  const remotePlan = resolveRepoRemotePlan(parsedRepo, authMode);

  await ensureGitAvailable();

  const cloneRoot = await resolveCloneRoot(args.clone_root);
  const localPath = buildRepoPath(cloneRoot, parsedRepo);
  const actions: string[] = [];

  const status = (await directoryExists(localPath))
    ? await updateExistingRepo(
        localPath,
        parsedRepo,
        remotePlan.primaryUrl,
        remotePlan.fallbackUrl,
        remotePlan.authMode,
        mode,
        ref,
        actions
      )
    : await cloneMissingRepo(
        localPath,
        remotePlan.primaryUrl,
        remotePlan.fallbackUrl,
        args.depth,
        ref,
        actions
      );

  const currentRef = await getCurrentRef(localPath);
  const freshness = await computeFreshnessDetails(localPath, currentRef);

  return {
    status,
    repo_url: parseRepoUrl(await getOriginUrl(localPath), true).canonicalUrl,
    local_path: localPath,
    current_ref: currentRef,
    default_branch: await getDefaultBranch(localPath),
    head_sha: await getHeadSha(localPath),
    comparison_ref: freshness.comparisonRef,
    remote_head_sha: freshness.remoteHeadSha,
    ahead_by: freshness.aheadBy,
    behind_by: freshness.behindBy,
    freshness: freshness.freshness,
    actions,
    instructions: [
      `Use built-in tools with local_path: ${localPath}`,
      `Example: run Grep/Read/Glob with files under ${localPath}`,
    ],
  };
}

export const repoEnsureLocalTool = tool({
  description:
    "Prepare external repositories for investigation. If a request references a GitHub/remote repo not already in the workspace, call this tool before Read/Grep/Glob/Bash so analysis is grounded in local source code. If cloning/fetching fails for a private repo, verify whether the user has HTTPS credentials configured or should switch to SSH with auth_mode=ssh or allow_ssh. Returns absolute local_path plus freshness/version metadata (head SHA, remote SHA, ahead/behind).",
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
