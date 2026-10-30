---
title: Public FxTwitter Import
description: "Explicitly import public tweets, threads, conversations, profiles, and bounded searches through the fixed read-only FxTwitter endpoint."
---

# Public FxTwitter import

Birdclaw can import selected public X data through FxTwitter without X credentials. This transport is off by default and runs only when `--fxtwitter` is present on that invocation:

```bash
birdclaw import tweet 20 2030857479001960633 --fxtwitter --json
birdclaw import thread 2030857479001960633 --fxtwitter --json
birdclaw import conversation 2030857479001960633 --fxtwitter --limit 200 --json
birdclaw import profile @jack --fxtwitter --json
birdclaw search tweets "local-first software" --fxtwitter --limit 50 --max-pages 3 --json
```

Tweet inputs must be numeric IDs or canonical HTTPS `x.com/<handle>/status/<id>` or `twitter.com/<handle>/status/<id>` URLs. Profile lookup accepts a public handle. Search accepts a non-empty query and the `latest`, `top`, or `media` feed.

Every request uses the hardcoded `https://api.fxtwitter.com` origin. There is no configuration, environment variable, or flag for a custom or self-hosted origin. Birdclaw sends no cookies or credentials, rejects redirects without following them, limits response size and total time, fetches sequentially, caps searches at 10 pages and 1,000 results, and applies capped Retry-After-aware backoff to rate limits and transient failures.

## Privacy and disclosure

FxTwitter is a third-party service. Passing `--fxtwitter` sends the requested tweet IDs, handles, or search queries to `api.fxtwitter.com`. The service and its hosting/network providers can also observe your IP address, request timing, and versioned Birdclaw user agent. Do not use this transport if that disclosure is unacceptable.

Birdclaw does not send X cookies, OAuth credentials, Birdclaw account data, DMs, unrelated local searches, or archive contents. It never falls back to FxTwitter from another transport, performs background polling, or turns an ordinary local read into a network request.

## Completeness and partial results

Every thread, conversation, and search result reports `collection.state`, `partialReasons`, `pagesFetched`, `itemsObserved`, retrieval time, and cursor/count evidence where available.

Thread and conversation responses are always `partial` with `endpoint_has_no_exhaustion_proof`: a clean `200`, a successful provider code, or a matching reply count cannot prove that FxTwitter did not silently omit a tail. Those rows remain useful and are imported.

Search is `complete` only when Birdclaw follows the documented bottom-cursor chain to an explicit terminal cursor. Caller limits, page budgets, timeouts, rate limits, upstream/decode failures, and missing, repeated, or cyclic cursors produce a successful `partial` result when at least one valid tweet was imported. If no usable item exists, JSON errors retain a typed `kind`, HTTP status, and `retryAfterMs` where applicable.

## Canonical persistence

Fetched tweets and profiles merge into the existing canonical tables and FTS index. Canonical tweet provenance remains in `tweet_sources` with `source = 'fxtwitter'`. Append-only fetch metadata and positive item observations live in `fxtwitter_fetches` and `fxtwitter_observations`; backups preserve them in `data/fxtwitter/fetches.jsonl` and `data/fxtwitter/observations.jsonl`.

Partial refreshes never delete rows, remove relationships, or interpret a missing result as negative evidence. Repeated and overlapping pages converge on the same canonical records while retaining endpoint, request context, retrieval, cursor, completeness, and per-item source evidence.

## Read-only boundary

The FxTwitter transport supports named public tweet, author-thread, conversation, profile-object, and bounded post-search reads only. It does not expose user timelines/status feeds, followers/following, trends, typeahead, standalone quote/repost products, bulk archival sync, DMs, home timelines, bookmarks, likes, authenticated mentions, private content, or any write.

## Grok Bot / X API v2 JSON import

Import offline X API v2 tweet responses (the `XurlTweetsResponse` shape) without network access or credentials. Each document may use `data` as one tweet object or an array; optional per-tweet `url` values are stored as `tweet_sources` provenance for `source = 'grokbot'`.

Optional document-level fields align imports with `birdclaw sync` membership on your own account (not the legacy `public` home path):

- `kind`: sync step name — `timeline`, `mentions`, `likes`, `bookmarks`, or `authored` (preferred), or the legacy aliases `home`, `bookmark`, `like`, `mention`, `authored`. When omitted, behavior is unchanged: tweets land on the `public` account with a `home` edge (existing GitHub inbox issues keep working).
- `account`: handle or account id. When `kind` is set, Birdclaw resolves the owning account the same way sync does (`resolveLiveSyncAccount` / default account). Unknown accounts fail with a clear error.

Grok Bot tool JSON is normalized before ingest: `includes.posts` → `includes.tweets`, `edit_history_post_ids` → `edit_history_tweet_ids`, `public_metrics.repost_count` → `retweet_count`, and per-tweet `url` stays provenance. In `referenced_tweets`, `type: "reposted"` is accepted as an alias for `"retweeted"`. Edges and collections use the same `ingestTweetPayload` paths as live sync (`home` / `mention` / `authored` edges; `bookmarks` / `likes` collections).

```bash
birdclaw import x-json ./exports/grok-tweets.jsonl --json
cat grok-tweets.jsonl | birdclaw import x-json - --json
```

The import path itself does not call X or FxTwitter. Like other data-changing commands, a successful import still runs backup auto-sync when that preference is enabled, which can reconcile Git history and push your configured backup remote. For a strictly offline run with auto-sync disabled for one process:

```bash
BIRDCLAW_BACKUP_AUTO_SYNC=0 birdclaw import x-json ./exports/tweets.jsonl --json
```

The command prints `{ imported, skipped, errors }`. Malformed JSONL lines are rejected whole; re-importing the same tweet ids is idempotent.

## Grok Bot GitHub issue inbox (Mac)

Grok Bots can file tweet JSON into a **private** GitHub repository (one issue per batch). Issue bodies may include the same optional `kind` and `account` fields at the JSON root (inside the fenced block). On a Mac with `gh` already authenticated, Birdclaw can poll that inbox, import each open issue body through the same `x-json` path, comment `{ imported, skipped, errors }` on the issue, and close it only when `errors` is empty. Failed imports stay open, receive a comment, and get the `import-failed` label so they are not retried forever.

Homebrew/npm `birdclaw` builds from upstream and will not include fork-only inbox commands until they are released there. On a Mac, run this fork from a source checkout (same path as other scheduled jobs in `docs/jobs.md`):

```bash
git clone https://github.com/TheAngryPit/birdclaw.git
cd birdclaw
./scripts/bun-canary.sh install --frozen-lockfile
./scripts/bun-canary.sh run --bun build
test -f bin/birdclaw.mjs
```

Use `./scripts/bun-canary.sh bin/birdclaw.mjs …` (or `bin/birdclaw.mjs` after `build`) instead of `/opt/homebrew/bin/birdclaw` when testing inbox import or installing its LaunchAgent.

Try against a scratch home before touching production data:

```bash
export BIRDCLAW_HOME="$HOME/tmp/birdclaw-scratch"
./scripts/bun-canary.sh bin/birdclaw.mjs init
./scripts/bun-canary.sh bin/birdclaw.mjs import x-json-issues --repo YOUR_ORG/YOUR_INBOX --author YOUR_GITHUB_LOGIN --dry-run --json
./scripts/bun-canary.sh bin/birdclaw.mjs import x-json-issues --repo YOUR_ORG/YOUR_INBOX --author YOUR_GITHUB_LOGIN --json
```

Each successful `import x-json-issues` run appends one JSONL audit entry to `~/.birdclaw/audit/x-json-issues-import.jsonl` (override with `--log`, same pattern as `jobs sync-account`). Pass `--log` to match other scheduled jobs.

## Feeding the inbox from an agent

Outside agents should mirror native Birdclaw scheduling instead of inventing their own cadence:

1. Read the schedule: `birdclaw --json jobs presets show <name>` (for example `native` or `relaxed`, or a custom name from `jobs.presets` in `config.json`).
2. File **one GitHub issue per sync step** in your private inbox repo. Each issue body is a single JSON document (optionally fenced) with `kind` set to the native step (`timeline`, `mentions`, `likes`, `bookmarks`, `authored`) and `account` set to the Birdclaw account handle or id.
3. Include only tweets **newer than the agent's last successful filing** for that step (track timestamps locally; Birdclaw does not fetch from X on import).
4. Let `import x-json-issues` (or its LaunchAgent) drain the inbox; inspect `x-json-issues-import.jsonl` for per-issue `imported` / `skipped` / `errors` alongside `step` and `account`.

Optional `BIRDCLAW_GH_PATH` or `--gh /path/to/gh` selects the GitHub CLI binary (useful under launchd). Install a periodic LaunchAgent (manual step; nothing auto-installs):

```bash
BUN=$(./scripts/install-bun-canary.sh)
./scripts/bun-canary.sh bin/birdclaw.mjs jobs install-x-json-issues-launchd \
  --repo YOUR_ORG/YOUR_INBOX \
  --author YOUR_GITHUB_LOGIN \
  --runtime "$BUN" \
  --runtime-arg=--no-env-file \
  --program "$PWD/bin/birdclaw.mjs" \
  --gh "$(command -v gh)" \
  --interval-seconds 900 \
  --print-plist
./scripts/bun-canary.sh bin/birdclaw.mjs jobs install-x-json-issues-launchd \
  --repo YOUR_ORG/YOUR_INBOX \
  --author YOUR_GITHUB_LOGIN \
  --runtime "$BUN" \
  --runtime-arg=--no-env-file \
  --program "$PWD/bin/birdclaw.mjs" \
  --gh "$(command -v gh)" \
  --no-load
./scripts/bun-canary.sh bin/birdclaw.mjs jobs x-json-issues-launchd-status --json
./scripts/bun-canary.sh bin/birdclaw.mjs jobs uninstall-x-json-issues-launchd --json
```

`install-x-json-issues-launchd` requires at least one `--author`. The plist records `BIRDCLAW_HOME` and `BIRDCLAW_GH_PATH` so launchd imports into the same home as the log paths.
