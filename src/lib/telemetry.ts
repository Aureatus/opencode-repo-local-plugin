import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { toRepoPluginError } from "./errors";
import type { RepoEnsureLocalArgs, RepoEnsureResult } from "./types";

interface RepoEnsureTelemetryEvent {
  event: "repo_ensure_local";
  timestamp: string;
  ok: boolean;
  repo_input: string;
  canonical_repo_url: string | null;
  local_path: string | null;
  status: string | null;
  update_mode: string | null;
  ref: string | null;
  error_code: string | null;
  error_message: string | null;
}

const TELEMETRY_RELATIVE_PATH =
  ".local/share/opencode/plugins/opencode-repo-local-plugin/telemetry.jsonl";

function defaultTelemetryPath(): string {
  return path.join(os.homedir(), TELEMETRY_RELATIVE_PATH);
}

function resolveTelemetryPath(): string {
  const fromEnv = process.env.OPENCODE_REPO_TELEMETRY_PATH?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  return defaultTelemetryPath();
}

async function appendEvent(event: RepoEnsureTelemetryEvent): Promise<void> {
  const telemetryPath = resolveTelemetryPath();
  await mkdir(path.dirname(telemetryPath), { recursive: true });
  await appendFile(telemetryPath, `${JSON.stringify(event)}\n`, "utf8");
}

export async function logRepoEnsureSuccess(
  args: RepoEnsureLocalArgs,
  result: RepoEnsureResult
): Promise<void> {
  const event: RepoEnsureTelemetryEvent = {
    event: "repo_ensure_local",
    timestamp: new Date().toISOString(),
    ok: true,
    repo_input: args.repo,
    canonical_repo_url: result.repo_url,
    local_path: result.local_path,
    status: result.status,
    update_mode: args.update_mode ?? "ff-only",
    ref: args.ref ?? null,
    error_code: null,
    error_message: null,
  };

  try {
    await appendEvent(event);
  } catch {
    // Telemetry must never block tool execution.
  }
}

export async function logRepoEnsureFailure(
  args: RepoEnsureLocalArgs,
  error: unknown
): Promise<void> {
  const parsedError = toRepoPluginError(error);
  const event: RepoEnsureTelemetryEvent = {
    event: "repo_ensure_local",
    timestamp: new Date().toISOString(),
    ok: false,
    repo_input: args.repo,
    canonical_repo_url: null,
    local_path: null,
    status: null,
    update_mode: args.update_mode ?? "ff-only",
    ref: args.ref ?? null,
    error_code: parsedError.code,
    error_message: parsedError.message,
  };

  try {
    await appendEvent(event);
  } catch {
    // Telemetry must never block tool execution.
  }
}
