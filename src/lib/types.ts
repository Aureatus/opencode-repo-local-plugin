export type UpdateMode = "ff-only" | "fetch-only" | "reset-clean";
export type AuthMode = "auto" | "https" | "ssh";

export type RepoEnsureStatus =
  | "cloned"
  | "updated"
  | "already-current"
  | "fetched";

export type RepoFreshnessStatus =
  | "current"
  | "stale"
  | "ahead"
  | "diverged"
  | "unknown";

export interface RepoEnsureLocalArgs {
  repo: string;
  ref?: string;
  clone_root?: string;
  depth?: number;
  update_mode?: string;
  allow_ssh?: boolean;
  auth_mode?: string;
}

export interface ParsedRepoUrl {
  raw: string;
  host: string;
  pathSegments: string[];
  canonicalUrl: string;
  key: string;
}

export interface RepoEnsureResult {
  status: RepoEnsureStatus;
  repo_url: string;
  local_path: string;
  current_ref: string;
  default_branch: string | null;
  head_sha: string;
  comparison_ref: string | null;
  remote_head_sha: string | null;
  ahead_by: number | null;
  behind_by: number | null;
  freshness: RepoFreshnessStatus;
  actions: string[];
  instructions: string[];
}
