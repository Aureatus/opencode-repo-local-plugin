import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface TelemetryEvent {
  event: "repo_ensure_local";
  ok: boolean;
  repo_input: string;
  local_path: string | null;
}

interface RepoTarget {
  name: string;
  base: string;
}

interface RepoCase {
  target: RepoTarget;
  input: string;
}

interface RepoCaseContext {
  repoCase: RepoCase;
  telemetryPath: string;
}

interface TargetSummary {
  target: string;
  testedInputs: string[];
  resolvedLocalPath: string;
  telemetryEvents: number;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const E2E_REPO_TARGETS: readonly RepoTarget[] = [
  {
    name: "self",
    base: "Aureatus/opencode-repo-local-plugin",
  },
  {
    name: "fixture",
    base: "ghoulr/opencode-websearch-cited",
  },
];

const COMMAND_TIMEOUT_MS = 180_000;
const COMMAND_RETRY_DELAY_MS = 5000;
const MAX_COMMAND_ATTEMPTS = Number.parseInt(
  process.env.OPENCODE_REPO_E2E_MAX_ATTEMPTS ?? "2",
  10
);
const RETRYABLE_FAILURE_PATTERN =
  /timed out|timeout|rate limit|429|502|503|504|econnreset|etimedout|enotfound|eai_again|network/i;

function buildPrompt(repo: string, cloneRoot: string): string {
  return `You must call repo_ensure_local first. Use repo='${repo}', clone_root='${cloneRoot}', update_mode='fetch-only', and allow_ssh=false. After calling the tool, respond with exactly OK.`;
}

function buildInputsForTarget(base: string): string[] {
  return [
    base,
    `github.com/${base}`,
    `https://github.com/${base}`,
    `https://github.com/${base}.git`,
    `https://github.com/${base}/tree/main`,
  ];
}

function buildRepoCases(): RepoCase[] {
  const output: RepoCase[] = [];
  for (const target of E2E_REPO_TARGETS) {
    const inputs = buildInputsForTarget(target.base);
    for (const input of inputs) {
      output.push({ target, input });
    }
  }
  return output;
}

function runOpencodeCommand(
  prompt: string,
  telemetryPath: string
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", ["run", prompt], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCODE_REPO_TELEMETRY_PATH: telemetryPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`opencode run timed out after ${COMMAND_TIMEOUT_MS}ms`));
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldRetryFailure(stdout: string, stderr: string): boolean {
  return RETRYABLE_FAILURE_PATTERN.test(`${stdout}\n${stderr}`);
}

async function readTelemetryEventsForPath(
  telemetryPath: string
): Promise<TelemetryEvent[]> {
  try {
    const telemetryRaw = await readFile(telemetryPath, "utf8");
    return parseTelemetry(telemetryRaw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function hasSuccessfulEventForInput(
  telemetryEvents: TelemetryEvent[],
  repoInput: string
): boolean {
  return telemetryEvents.some(
    (event) => event.repo_input === repoInput && event.ok
  );
}

function isFinalAttempt(attempt: number): boolean {
  return attempt >= MAX_COMMAND_ATTEMPTS;
}

function shouldRetryResult(attempt: number, result: CommandResult): boolean {
  return (
    !isFinalAttempt(attempt) && shouldRetryFailure(result.stdout, result.stderr)
  );
}

function shouldRetryError(attempt: number, error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return !isFinalAttempt(attempt) && RETRYABLE_FAILURE_PATTERN.test(message);
}

async function hasTelemetryEvent(
  telemetryPath: string,
  repoInput: string
): Promise<boolean> {
  const telemetryEvents = await readTelemetryEventsForPath(telemetryPath);
  return hasSuccessfulEventForInput(telemetryEvents, repoInput);
}

function throwMissingTelemetryError(
  repoInput: string,
  result: CommandResult
): never {
  throw new Error(
    `opencode run returned success but no telemetry event for ${repoInput}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

async function runOpencodeCommandWithRetry(
  prompt: string,
  telemetryPath: string,
  repoInput: string
): Promise<CommandResult> {
  let attempt = 1;

  while (attempt <= MAX_COMMAND_ATTEMPTS) {
    try {
      const result = await runOpencodeCommand(prompt, telemetryPath);
      if (result.code === 0) {
        if (await hasTelemetryEvent(telemetryPath, repoInput)) {
          return result;
        }

        if (isFinalAttempt(attempt)) {
          throwMissingTelemetryError(repoInput, result);
        }

        console.warn(
          `Retrying opencode run for ${repoInput} because no successful telemetry event was recorded`
        );
      } else if (shouldRetryResult(attempt, result)) {
        console.warn(
          `Retrying opencode run for ${repoInput} after attempt ${attempt}/${MAX_COMMAND_ATTEMPTS}`
        );
      } else {
        return result;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (shouldRetryError(attempt, error)) {
        console.warn(
          `Retrying opencode run for ${repoInput} after transient error: ${message}`
        );
      } else {
        throw error;
      }
    }

    await sleep(COMMAND_RETRY_DELAY_MS * attempt);
    attempt += 1;
  }

  throw new Error(`Failed to run opencode for ${repoInput}`);
}

function parseTelemetry(text: string): TelemetryEvent[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const output: TelemetryEvent[] = [];

  for (const line of lines) {
    const parsed = JSON.parse(line) as TelemetryEvent;
    if (parsed.event === "repo_ensure_local") {
      output.push(parsed);
    }
  }

  return output;
}

async function assertLocalPathExists(localPath: string): Promise<void> {
  const info = await stat(localPath);
  if (!info.isDirectory()) {
    throw new Error(`Expected local_path to be a directory: ${localPath}`);
  }
}

async function main(): Promise<void> {
  const keep = process.env.OPENCODE_REPO_E2E_KEEP === "true";
  const repoCases = buildRepoCases();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-repo-e2e-"));
  const cloneRoot = path.join(tempRoot, "clones");
  const telemetryContexts: RepoCaseContext[] = repoCases.map(
    (repoCase, index) => {
      return {
        repoCase,
        telemetryPath: path.join(tempRoot, `telemetry-${index}.jsonl`),
      };
    }
  );

  try {
    await Promise.all(
      telemetryContexts.map(async ({ repoCase, telemetryPath }) => {
        const prompt = buildPrompt(repoCase.input, cloneRoot);
        const result = await runOpencodeCommandWithRetry(
          prompt,
          telemetryPath,
          repoCase.input
        );
        if (result.code !== 0) {
          throw new Error(
            `opencode run failed for ${repoCase.input}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
          );
        }
      })
    );

    const telemetryEventGroups = await Promise.all(
      telemetryContexts.map(async ({ telemetryPath }) => {
        const telemetryRaw = await readFile(telemetryPath, "utf8");
        return parseTelemetry(telemetryRaw);
      })
    );
    const telemetryEvents = telemetryEventGroups.flat();
    if (telemetryEvents.length < repoCases.length) {
      throw new Error(
        `Expected at least ${repoCases.length} telemetry events, got ${telemetryEvents.length}`
      );
    }

    const targetSummaries: TargetSummary[] = [];
    for (const target of E2E_REPO_TARGETS) {
      const targetInputs = buildInputsForTarget(target.base);
      const matched: TelemetryEvent[] = [];

      for (const input of targetInputs) {
        const event = telemetryEvents.findLast(
          (item) => item.repo_input === input && item.ok
        );
        if (!event) {
          throw new Error(
            `No successful telemetry event found for target=${target.name} input=${input}`
          );
        }

        if (!event.local_path) {
          throw new Error(
            `Missing local_path in telemetry event for target=${target.name} input=${input}`
          );
        }

        await assertLocalPathExists(event.local_path);
        matched.push(event);
      }

      const uniquePaths = new Set(matched.map((item) => item.local_path));
      if (uniquePaths.size !== 1) {
        throw new Error(
          `Expected one local path for target=${target.name}, got ${JSON.stringify([...uniquePaths])}`
        );
      }

      targetSummaries.push({
        target: target.base,
        testedInputs: targetInputs,
        resolvedLocalPath: [...uniquePaths][0] ?? "",
        telemetryEvents: matched.length,
      });
    }

    console.log("E2E test passed");
    console.log(
      JSON.stringify(
        {
          cloneRoot,
          telemetryDirectory: tempRoot,
          testedTargets: E2E_REPO_TARGETS.map((target) => target.base),
          targetSummaries,
          telemetryEvents: repoCases.length,
        },
        null,
        2
      )
    );
  } finally {
    if (!keep) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

await main();
