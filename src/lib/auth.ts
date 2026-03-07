import { RepoPluginError } from "./errors";
import type { AuthMode, ParsedRepoUrl } from "./types";

const AUTH_MODES: ReadonlySet<string> = new Set(["auto", "https", "ssh"]);

export interface RepoRemotePlan {
  authMode: AuthMode;
  primaryUrl: string;
  fallbackUrl: string | null;
}

function toHttpsUrl(parsedRepo: ParsedRepoUrl): string {
  const canonicalPath = parsedRepo.pathSegments.join("/");
  return `https://${parsedRepo.host}/${canonicalPath}.git`;
}

function toSshUrl(parsedRepo: ParsedRepoUrl): string | null {
  if (parsedRepo.host.includes(":")) {
    return null;
  }

  const canonicalPath = parsedRepo.pathSegments.join("/");
  return `git@${parsedRepo.host}:${canonicalPath}.git`;
}

export function normalizeAuthMode(value: string | undefined): AuthMode {
  const mode = (value ?? "auto").trim();
  if (!AUTH_MODES.has(mode)) {
    throw new RepoPluginError(
      "INVALID_AUTH_MODE",
      `Unsupported auth_mode: ${mode}`
    );
  }

  return mode as AuthMode;
}

export function resolveRepoRemotePlan(
  parsedRepo: ParsedRepoUrl,
  authMode: AuthMode
): RepoRemotePlan {
  const httpsUrl = toHttpsUrl(parsedRepo);
  const sshUrl = toSshUrl(parsedRepo);
  const isSshInput =
    parsedRepo.raw.startsWith("git@") || parsedRepo.raw.startsWith("ssh://");

  if (authMode === "https") {
    return {
      authMode,
      primaryUrl: httpsUrl,
      fallbackUrl: null,
    };
  }

  if (authMode === "ssh") {
    if (!sshUrl) {
      throw new RepoPluginError(
        "INVALID_AUTH_MODE",
        "auth_mode=ssh is not supported for this repository host"
      );
    }

    return {
      authMode,
      primaryUrl: sshUrl,
      fallbackUrl: null,
    };
  }

  if (isSshInput && sshUrl) {
    return {
      authMode,
      primaryUrl: sshUrl,
      fallbackUrl: null,
    };
  }

  return {
    authMode,
    primaryUrl: httpsUrl,
    fallbackUrl: sshUrl,
  };
}
