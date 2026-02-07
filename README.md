# opencode-repo-local

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
  "plugin": ["opencode-repo-local"]
}
```

### Local development

1. Install dependencies:

```bash
bun install
```

2. For local OpenCode testing in this repo, use the included local plugin wiring:

- `.opencode/plugins/repo-local-plugin.ts` imports `src/index.ts` directly for fast iteration (no build step required)
- `.opencode/package.json` installs plugin runtime dependencies for OpenCode

3. For a publishable artifact check, run `bun run build` before release.

4. Or publish and install via npm for regular usage.

## Tool: `repo_ensure_local`

Arguments:

- `repo` (required): repository reference in one of these forms:
  - `https://host/owner/repo(.git)`
  - `git@host:owner/repo.git` (when `allow_ssh` is true)
  - `host/owner/repo`
  - `owner/repo` (GitHub shorthand)
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
- `comparison_ref`
- `remote_head_sha`
- `ahead_by`
- `behind_by`
- `freshness`: `current` | `stale` | `ahead` | `diverged` | `unknown`
- `actions`
- `instructions`

Freshness semantics:

- Default `update_mode=ff-only` is the recommended one-call path for agents: it updates when safe and returns freshness metadata.
- Use `update_mode=fetch-only` when you explicitly want non-mutating freshness/version checks.

## Environment variables

- `OPENCODE_REPO_CLONE_ROOT`: default clone root (fallback is `~/.opencode/repos`)
- `OPENCODE_REPO_ALLOW_SSH=true`: default SSH URL allowance
- `OPENCODE_REPO_TELEMETRY_PATH`: optional telemetry JSONL path override

## Telemetry

- `repo_ensure_local` writes invocation telemetry on every run.
- Default file: `~/.local/share/opencode/plugins/opencode-repo-local/telemetry.jsonl`
- Event fields include `repo_input`, `canonical_repo_url`, `status`, `local_path`, and error metadata.

## OpenCode permissions

- This repo includes `opencode.json` with:
  - `permission.external_directory["~/.opencode/repos/**"] = "allow"`
- This lets OpenCode built-in tools access cloned repos under `~/.opencode/repos` without repeated approval prompts.
- Recommended for users of this plugin: add the same permission rule to your own global or project OpenCode config.

## Local OpenCode smoke test

Use this to validate the plugin in a real OpenCode session.

1. Confirm OpenCode loads the local plugin shim:

```bash
opencode debug config
```

Verify plugin list includes `.opencode/plugins/repo-local-plugin.ts`.

2. Forced tool smoke test (deterministic):

```bash
opencode run "You must call repo_ensure_local first. Use repo='Aureatus/opencode-repo-local' and update_mode='fetch-only'. Then report only: status, repo_url, local_path, head_sha."
```

3. Natural-intent smoke test (agent should choose the tool):

```bash
opencode run "Please inspect ghoulr/opencode-websearch-cited, find the custom tool it exports, and report the file path where it is defined."
```

Important:

- Run the natural-intent test against a repo that is not your current workspace.
- If you reference the current repo, OpenCode may correctly skip `repo_ensure_local` because local files are already available.

Expected behavior:

- OpenCode chooses `repo_ensure_local` for external repo references.
- Output includes a valid `local_path` under `~/.opencode/repos/...`.
- Follow-up inspection uses built-in tools (`Read`, `Glob`, `Grep`, `Bash`) against that local path.

## Safety behavior

- Rejects malformed/unsupported repo URLs
- Prevents clone path escape outside clone root
- Validates existing clone remote against requested repository
- Avoids destructive sync by default (`ff-only`)

## Development

```bash
bun install
bun run fix
bun run check
bun run lint
bun run typecheck
bun run test
bun run test:integration
bun run test:e2e
bun run build
```

## Releasing

- This project uses tag-driven publishing to npm via GitHub Actions.
- Use release helper scripts:
  - `bun run release:verify`
  - `bun run release:patch|minor|major`
  - `bun run release:beta:first` / `bun run release:beta:next`
- Push version commit and tag with `git push origin main --follow-tags`.
- GitHub Release notes are created automatically from pushed release tags.
- Full runbook: see `RELEASING.md`.

Integration script notes:

- Default run validates multiple allowed input formats against `Aureatus/opencode-repo-local`.
- Override to a single repo input: `bun run test:integration -- https://github.com/OWNER/REPO.git`
- Keep clone directory for inspection: `OPENCODE_REPO_INTEGRATION_KEEP=true bun run test:integration`
- Set custom clone root: `OPENCODE_REPO_INTEGRATION_ROOT=/abs/path bun run test:integration`

E2E script notes:

- `bun run test:e2e` runs real `opencode run` prompts and asserts tool usage via telemetry.
- It validates all supported repo input formats across two required targets:
  - `Aureatus/opencode-repo-local`
  - `ghoulr/opencode-websearch-cited`
- It checks each target's formats resolve to one normalized local path.
- Keep temporary artifacts for inspection: `OPENCODE_REPO_E2E_KEEP=true bun run test:e2e`
- The test is valid because each run uses:
  - a fresh temporary clone root (`/tmp/opencode-repo-e2e-.../clones`), not the current workspace,
  - a run-specific telemetry file,
  - real OpenCode prompts that must trigger `repo_ensure_local`.
- This verifies end-to-end behavior (tool invocation, clone/update, and normalized path resolution) without depending on local workspace files.

## Git hooks

- This repo uses Husky for pre-commit and pre-push hooks.
- Full local check command: `bun run check` (runs no-ignore guard, `lint`, `typecheck`, `test`, `build`, and `test:integration` in parallel where possible).
- Build command: `bun run build` (`tsdown --fail-on-warn`, warnings fail the build).
- Lint command: `bun run lint` (Ultracite/Biome with `--error-on-warnings`).
- Fix command: `bun run fix` (Ultracite safe + unsafe fixes, then no-ignore guard).
- Pre-commit command: `bun run check`.
- Pre-push command: `bun run check`.
- Hooks are installed by running `bun install` via the `prepare` script.
