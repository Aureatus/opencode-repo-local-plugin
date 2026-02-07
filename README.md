# opencode-repo-local-plugin

OpenCode plugin that ensures a repository exists locally (clone or update) and returns an absolute path so you can use OpenCode built-in tools directly.

## What it does

- Exposes one custom tool: `repo_ensure_local`
- Clones missing repositories into a deterministic local root
- Updates existing repositories with safe, non-destructive defaults
- Returns structured output including `local_path` for immediate `Read` / `Glob` / `Grep` / `Bash` usage

## Installation

### From npm

Add the package to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-repo-local-plugin"]
}
```

### Local development

1. Build this package:

```bash
bun install
bun run build
```

2. Add the local package path to your OpenCode plugin config (or publish and install via npm).

## Tool: `repo_ensure_local`

Arguments:

- `repo` (required): repository URL (`https://...`)
- `ref` (optional): branch/tag/SHA to checkout after clone/fetch
- `clone_root` (optional): absolute path override for clone root
- `depth` (optional): shallow clone depth
- `update_mode` (optional): `ff-only` (default), `fetch-only`, `reset-clean`
- `allow_ssh` (optional): allow `git@host:owner/repo.git` URLs

Output fields:

- `status`: `cloned` | `updated` | `already-current` | `fetched`
- `repo_url`
- `local_path`
- `current_ref`
- `default_branch`
- `head_sha`
- `actions`
- `instructions`

## Environment variables

- `OPENCODE_REPO_CLONE_ROOT`: default clone root (fallback is `~/.opencode/repos`)
- `OPENCODE_REPO_ALLOW_SSH=true`: default SSH URL allowance

## Safety behavior

- Rejects malformed/unsupported repo URLs
- Prevents clone path escape outside clone root
- Validates existing clone remote against requested repository
- Avoids destructive sync by default (`ff-only`)

## Development

```bash
bun install
bun run check
bun run typecheck
bun run test
bun run test:integration
bun run build
```

Integration script notes:

- Default repo: `https://github.com/anomalyco/opencode.git`
- Override repo: `bun run test:integration -- https://github.com/OWNER/REPO.git`
- Keep clone directory for inspection: `OPENCODE_REPO_INTEGRATION_KEEP=true bun run test:integration`
- Set custom clone root: `OPENCODE_REPO_INTEGRATION_ROOT=/abs/path bun run test:integration`

## Git hooks

- This repo uses Husky for pre-commit and pre-push hooks.
- Full local check command: `bun run check` (runs `typecheck`, `test`, `build`, and `test:integration`).
- Pre-commit command: `bun run check`.
- Pre-push command: `bun run check`.
- Hooks are installed by running `bun install` via the `prepare` script.
