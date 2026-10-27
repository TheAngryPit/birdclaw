# Birdclaw stack (agent reference)

This document describes how the repository is built, verified, and extended. It matches what **`.github/workflows/ci.yml`** runs on pull requests.

## Languages and runtimes

| Piece | Version / pin | Notes |
| ----- | ------------- | ----- |
| **TypeScript** | `typescript` in `package.json` | `tsc --noEmit` via `check` |
| **Bun (primary)** | Exact canary in `toolchains/bun-canary.conf` | Installed to `.toolchains/bun` by `./scripts/install-bun-canary.sh`; invoked via `./scripts/bun-canary.sh` |
| **Node (compatibility)** | `.node-version` (CI also tests **26.5.1** package floor) | `engines.node` in `package.json` is `>=26.5.1 <27` |
| **SQLite** | Native / bundled driver in `src/lib/sqlite` | Local archive DB under configurable `BIRDCLAW_HOME` |

Day-to-day development and CI's **Bun primary** job use the pinned canary, not whatever `bun` happens to be on `PATH`.

## Application shape

- **CLI**: Commander-based entry in `src/cli.ts`, built to `bin/birdclaw.mjs` and `dist/cli/`.
- **Web UI**: Vite + TanStack Router/Start, React 19, Tailwind 4.
- **Effects**: `effect` for typed errors and services in core library code.
- **Validation**: `zod` at boundaries.

## Local commands

Install toolchain and dependencies once per machine (or rely on CI cache layout):

```bash
./scripts/install-bun-canary.sh
./scripts/bun-canary.sh install --frozen-lockfile
```

| Goal | Command | What it runs |
| ---- | ------- | ------------ |
| **Check** (format, lint, types) | `./scripts/bun-canary.sh run --bun check` | `format:check` (oxfmt), `lint` (oxlint), `typecheck` (tsc) |
| **Unit tests + coverage (Bun)** | `./scripts/bun-canary.sh run --bun coverage` | Vitest via `./scripts/run-vitest.mjs` with Istanbul thresholds |
| **Unit tests + coverage (Node)** | `./scripts/bun-canary.sh run coverage:node` | Same runner with V8 coverage (`BIRDCLAW_COVERAGE_PROVIDER=v8`) |
| **Build** | `./scripts/bun-canary.sh run --bun build` | Vite client build + `scripts/build-cli.mjs` |
| **Build (Node)** | `./scripts/bun-canary.sh run build:node` | Node vite + CLI build |
| **E2E** | `./scripts/bun-canary.sh run --bun e2e` | Production build + Playwright (`playwright.config.ts`) |
| **Dev server** | `./scripts/bun-canary.sh run dev` | Vite on `127.0.0.1:3000` with `BIRDCLAW_LOCAL_WEB=1` |

Shorthand if your shell already uses the pinned Bun via `scripts/bun-canary.sh`:

```bash
./scripts/bun-canary.sh run --bun check
./scripts/bun-canary.sh run --bun coverage
./scripts/bun-canary.sh run --bun build
```

## Vitest and isolated homes

- Config: `vitest.config.ts` (jsdom, `src/**/*.test.{ts,tsx}`, setup `src/test/setup.ts`).
- **Isolated data directory**: `createTestHome()` in `src/test/test-home.ts` creates a temp `BIRDCLAW_HOME`, resets DB singletons, and optionally seeds demo data. Use it for any test that touches the filesystem or SQLite instead of a developer's real archive.
- Helpers `withTestHome()` / `describeWithTestHome()` in the same module wire Vitest lifecycle hooks.

## Playwright

- Specs under `playwright/`; CI installs Chromium and runs `e2e` plus read-only permalink tests (`playwright/permalinks.spec.ts` with `BIRDCLAW_DEPLOYMENT_READ_ONLY=1`).
- Reports: `playwright-report/`, `test-results/` (gitignored).

## CI workflow (`.github/workflows/ci.yml`)

Four jobs on `ubuntu-latest`, concurrency group per ref:

1. **Bun primary** — install canary → `bun install --frozen-lockfile` → verify canary script → `check` → `coverage` → `build` → runtime perf smoke → upload coverage artifact.
2. **Node 26 compatibility** — same Bun for install; Node from `.node-version`; `coverage:node` → `build:node`.
3. **npm package under Node and Bun** — `package-smoke.mjs`, `bun pm pack` proof artifact.
4. **Playwright on Bun production server** — `e2e` + permalink spec; upload Playwright artifacts.

Environment flags set for CI include `CI=true`, `BIRDCLAW_BACKUP_AUTO_SYNC=0`, `BIRDCLAW_DISABLE_LIVE_WRITES=1`, `DO_NOT_TRACK=1`.

## Ingesting tweets (required path for importers)

All code that persists tweet payloads from X-style API shapes should go through **`ingestTweetPayload`** in `src/lib/tweet-repository.ts`.

```ts
ingestTweetPayload(db, {
  accountId,
  payload, // XurlMentionsResponse-shaped
  source,
  edgeKind?, // optional TweetAccountEdgeKind
  collectionKind?, // "likes" | "bookmarks"
  // ...
});
```

It normalizes users, writes tweet rows, edges, search index updates, and retention hooks. Do not duplicate insert SQL in new importers; extend this function or call it from your pipeline after parsing.

## Agent tooling in this repo

- **pstack**: plugin + `.cursor/rules/pstack-models.mdc` (small budget).
- **Matt Pocock engineering skills**: `.agents/skills/` + `skills-lock.json`; configuration in `docs/agents/*.md` and `AGENTS.md`.
- **Birdclaw domain skill**: `.agents/skills/birdclaw/` (unchanged by stack setup).
