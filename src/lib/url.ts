import { RepoPluginError } from "./errors";
import type { ParsedRepoUrl } from "./types";

const SSH_PATTERN = /^git@([^:/]+):(.+)$/;
const GIT_SUFFIX_PATTERN = /\.git$/i;
const HTTP_OR_HTTPS_PATTERN = /^https?:\/\//i;
const GITHUB_WEB_MARKERS: ReadonlySet<string> = new Set([
  "tree",
  "blob",
  "commit",
  "pull",
  "issues",
  "actions",
  "releases",
  "wiki",
]);

function normalizePathSegments(host: string, segments: string[]): string[] {
  if (host.toLowerCase() !== "github.com") {
    return segments;
  }

  if (segments.length >= 3 && GITHUB_WEB_MARKERS.has(segments[2])) {
    return segments.slice(0, 2);
  }

  return segments;
}

function splitPathSegments(input: string): string[] {
  const trimmed = input.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return [];
  }

  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length === 0) {
    return [];
  }

  const lastIndex = segments.length - 1;
  segments[lastIndex] = segments[lastIndex].replace(GIT_SUFFIX_PATTERN, "");
  return segments;
}

function validateSegments(segments: string[]): void {
  if (segments.length < 2) {
    throw new RepoPluginError(
      "INVALID_URL",
      "Repository URL must include owner and repository name"
    );
  }

  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new RepoPluginError(
        "INVALID_URL",
        "Repository URL contains an invalid path segment"
      );
    }
  }
}

function makeRepoKey(host: string, segments: string[]): string {
  return `${host.toLowerCase()}/${segments.join("/").toLowerCase()}`;
}

function buildParsed(
  raw: string,
  host: string,
  segmentsInput: string[] | string,
  protocol: "https" | "ssh"
): ParsedRepoUrl {
  const splitSegments = Array.isArray(segmentsInput)
    ? segmentsInput
    : splitPathSegments(segmentsInput);
  const segments = normalizePathSegments(host, splitSegments);
  validateSegments(segments);

  const normalizedHost = host.toLowerCase();
  const canonicalPath = segments.join("/");
  const canonicalUrl =
    protocol === "https"
      ? `https://${normalizedHost}/${canonicalPath}.git`
      : `git@${normalizedHost}:${canonicalPath}.git`;

  return {
    raw,
    host: normalizedHost,
    pathSegments: segments,
    canonicalUrl,
    key: makeRepoKey(normalizedHost, segments),
  };
}

function parseHttpLikeUrl(raw: string): ParsedRepoUrl {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new RepoPluginError(
      "INVALID_URL",
      "Repository URL must use https:// format"
    );
  }

  return buildParsed(
    raw,
    url.hostname,
    splitPathSegments(url.pathname),
    "https"
  );
}

function parseHostWithPath(raw: string): ParsedRepoUrl | null {
  if (raw.includes("://") || raw.startsWith("git@")) {
    return null;
  }

  const firstSlash = raw.indexOf("/");
  if (firstSlash <= 0) {
    return null;
  }

  const host = raw.slice(0, firstSlash).trim();
  const pathValue = raw.slice(firstSlash + 1).trim();
  if (!(host && pathValue)) {
    return null;
  }

  if (!(host.includes(".") || host.includes(":"))) {
    return null;
  }

  return buildParsed(raw, host, splitPathSegments(pathValue), "https");
}

function parseGitHubShorthand(raw: string): ParsedRepoUrl | null {
  if (raw.includes("://") || raw.startsWith("git@")) {
    return null;
  }

  const segments = splitPathSegments(raw);
  if (segments.length < 2) {
    return null;
  }

  return buildParsed(raw, "github.com", segments, "https");
}

function invalidUrlErrorMessage(allowSsh: boolean): string {
  if (allowSsh) {
    return "Repository must be one of: https://host/owner/repo(.git), git@host:owner/repo.git, host/owner/repo, or owner/repo (GitHub shorthand)";
  }

  return "Repository must be one of: https://host/owner/repo(.git), host/owner/repo, or owner/repo (GitHub shorthand)";
}

export function parseRepoUrl(repo: string, allowSsh: boolean): ParsedRepoUrl {
  const raw = repo.trim();
  if (!raw) {
    throw new RepoPluginError("INVALID_URL", "Repository URL is required");
  }

  if (HTTP_OR_HTTPS_PATTERN.test(raw)) {
    return parseHttpLikeUrl(raw);
  }

  const hostWithPathParsed = parseHostWithPath(raw);
  if (hostWithPathParsed) {
    return hostWithPathParsed;
  }

  const gitHubShorthandParsed = parseGitHubShorthand(raw);
  if (gitHubShorthandParsed) {
    return gitHubShorthandParsed;
  }

  if (allowSsh) {
    const match = raw.match(SSH_PATTERN);
    if (match) {
      const host = match[1];
      const path = match[2] ?? "";
      return buildParsed(raw, host, splitPathSegments(path), "ssh");
    }

    if (raw.startsWith("ssh://")) {
      const url = new URL(raw);
      if (url.protocol === "ssh:") {
        return buildParsed(
          raw,
          url.hostname,
          splitPathSegments(url.pathname),
          "ssh"
        );
      }
    }
  }

  throw new RepoPluginError("INVALID_URL", invalidUrlErrorMessage(allowSsh));
}
