import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { RepoPluginError } from "./errors";

interface RunGitOptions {
  cwd?: string;
  timeoutMs?: number;
}

interface RunGitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface AheadBehindCounts {
  aheadBy: number;
  behindBy: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const WHITESPACE_PATTERN = /\s+/;
const AUTH_FAILURE_PATTERNS: readonly RegExp[] = [
  /authentication failed/i,
  /could not read (?:username|password) for 'https?:\/\//i,
  /invalid username or token/i,
  /repository not found/i,
  /support for password authentication was removed/i,
];
const REMOTE_COMMANDS: ReadonlySet<string> = new Set([
  "clone",
  "fetch",
  "pull",
  "ls-remote",
]);

function summarizeGitOutput(stdout: string, stderr: string): string {
  return [stderr, stdout].filter(Boolean).join("\n").trim();
}

function looksLikeAuthFailure(args: string[], output: string): boolean {
  const command = args[0] ?? "";
  if (!REMOTE_COMMANDS.has(command)) {
    return false;
  }

  return AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(output));
}

export function createGitFailureError(
  args: string[],
  stdout: string,
  stderr: string,
  timedOut: boolean
): RepoPluginError {
  const command = `git ${args.join(" ")}`;
  const output = summarizeGitOutput(stdout, stderr);

  if (timedOut) {
    const details = [command, output || "No output captured", "timed_out=true"]
      .filter(Boolean)
      .join("\n");
    return new RepoPluginError("GIT_TIMEOUT", "git command timed out", details);
  }

  if (looksLikeAuthFailure(args, output)) {
    const details = [
      command,
      output,
      "Authentication is required for this remote. Configure HTTPS credentials (`gh auth login && gh auth setup-git`) or use SSH with `allow_ssh=true` and an SSH URL (for example, git@github.com:owner/repo.git).",
    ]
      .filter(Boolean)
      .join("\n");
    return new RepoPluginError(
      "GIT_AUTH",
      "Git authentication failed for remote repository",
      details
    );
  }

  const details = [command, output || "No output captured"]
    .filter(Boolean)
    .join("\n");
  return new RepoPluginError("GIT_FAILURE", "git command failed", details);
}

function runGitRaw(
  args: string[],
  options: RunGitOptions = {}
): Promise<RunGitResult> {
  const cwd = options.cwd;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let timedOut = false;
    const processRef = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GCM_INTERACTIVE: "never",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        processRef.kill("SIGTERM");
      }, timeoutMs);
    }

    processRef.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    processRef.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    processRef.on("error", (error) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new RepoPluginError("GIT_NOT_FOUND", "git binary not found on PATH")
        );
        return;
      }

      reject(
        new RepoPluginError(
          "GIT_FAILURE",
          "Failed to start git command",
          String(error)
        )
      );
    });

    processRef.on("close", (exitCode) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: exitCode ?? 1,
        timedOut,
      });
    });
  });
}

async function runGit(
  args: string[],
  options: RunGitOptions = {}
): Promise<string> {
  const result = await runGitRaw(args, options);
  if (result.exitCode !== 0) {
    throw createGitFailureError(
      args,
      result.stdout,
      result.stderr,
      result.timedOut
    );
  }
  return result.stdout;
}

export async function ensureGitAvailable(): Promise<void> {
  await runGit(["--version"]);
}

export async function directoryExists(target: string): Promise<boolean> {
  try {
    const info = await stat(target);
    return info.isDirectory();
  } catch {
    return false;
  }
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  const result = await runGitRaw(["rev-parse", "--is-inside-work-tree"], {
    cwd,
  });
  return result.exitCode === 0 && result.stdout === "true";
}

export async function cloneRepo(
  repoUrl: string,
  targetPath: string,
  depth?: number
): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const args = ["clone", "--origin", "origin"];
  if (depth !== undefined) {
    args.push("--depth", String(depth));
  }
  args.push(repoUrl, targetPath);
  await runGit(args);
}

export async function fetchOrigin(cwd: string): Promise<void> {
  await runGit(["fetch", "--prune", "origin"], { cwd });
}

export async function checkoutRef(cwd: string, ref: string): Promise<void> {
  await runGit(["checkout", ref], { cwd });
}

export async function pullFfOnlyForBranch(
  cwd: string,
  branch: string
): Promise<void> {
  await runGit(["pull", "--ff-only", "--prune", "origin", branch], { cwd });
}

export async function hardResetToOriginBranch(
  cwd: string,
  branch: string
): Promise<void> {
  await runGit(["reset", "--hard", `origin/${branch}`], { cwd });
  await runGit(["clean", "-fd"], { cwd });
}

export function getHeadSha(cwd: string): Promise<string> {
  return runGit(["rev-parse", "HEAD"], { cwd });
}

export function getCurrentRef(cwd: string): Promise<string> {
  return runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
}

export async function getDefaultBranch(cwd: string): Promise<string | null> {
  const result = await runGitRaw(
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { cwd }
  );
  if (result.exitCode !== 0 || !result.stdout) {
    return null;
  }

  const prefix = "origin/";
  return result.stdout.startsWith(prefix)
    ? result.stdout.slice(prefix.length)
    : result.stdout;
}

export function getOriginUrl(cwd: string): Promise<string> {
  return runGit(["remote", "get-url", "origin"], { cwd });
}

export async function setOriginUrl(
  cwd: string,
  originUrl: string
): Promise<void> {
  await runGit(["remote", "set-url", "origin", originUrl], { cwd });
}

export async function isWorktreeDirty(cwd: string): Promise<boolean> {
  const output = await runGit(["status", "--porcelain"], { cwd });
  return output.length > 0;
}

export async function getUpstreamRef(cwd: string): Promise<string | null> {
  const result = await runGitRaw(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { cwd }
  );
  if (result.exitCode !== 0 || !result.stdout) {
    return null;
  }

  return result.stdout;
}

export async function getRefSha(
  cwd: string,
  ref: string
): Promise<string | null> {
  const result = await runGitRaw(["rev-parse", ref], { cwd });
  if (result.exitCode !== 0 || !result.stdout) {
    return null;
  }

  return result.stdout;
}

export async function getAheadBehindCounts(
  cwd: string,
  localRef: string,
  remoteRef: string
): Promise<AheadBehindCounts | null> {
  const result = await runGitRaw(
    ["rev-list", "--left-right", "--count", `${localRef}...${remoteRef}`],
    { cwd }
  );
  if (result.exitCode !== 0 || !result.stdout) {
    return null;
  }

  const [leftCountRaw, rightCountRaw] = result.stdout.split(WHITESPACE_PATTERN);
  const aheadBy = Number.parseInt(leftCountRaw ?? "", 10);
  const behindBy = Number.parseInt(rightCountRaw ?? "", 10);
  if (Number.isNaN(aheadBy) || Number.isNaN(behindBy)) {
    return null;
  }

  return {
    aheadBy,
    behindBy,
  };
}
