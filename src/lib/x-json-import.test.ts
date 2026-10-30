// @vitest-environment node
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCliMain } from "../cli";
import { exportBackup, importBackup } from "./backup";
import { listTimelineItems } from "./timeline-read-model";
import type { Database } from "./sqlite";
import { importXJsonText } from "./x-json-import";
import { useTestHome } from "../test/test-home";

const testHome = useTestHome({
	prefix: "birdclaw-x-json-",
	seedDemoData: false,
});

const SYNTH_AUTHOR = {
	id: "900001",
	username: "synth_lab",
	name: "Synth Lab",
};

const SYNTH_OWNER_ACCOUNT_ID = "acct_synth_owner";
const SYNTH_OWNER_HANDLE = "owner_synth";

function seedSynthOwnerAccount(db: Database) {
	db.prepare(
		`insert into accounts (
      id, name, handle, external_user_id, transport, is_default, created_at
    ) values (?, 'Synth Owner', ?, '910000', 'xurl', 1, ?)`,
	).run(
		SYNTH_OWNER_ACCOUNT_ID,
		`@${SYNTH_OWNER_HANDLE}`,
		"2026-01-01T00:00:00.000Z",
	);
}

function botShapedTweet(
	overrides: {
		id?: string;
		text?: string;
		url?: string;
	} = {},
) {
	const id = overrides.id ?? "881001";
	return {
		id,
		author_id: SYNTH_AUTHOR.id,
		text: overrides.text ?? "synth bot payload",
		created_at: "2026-03-01T12:00:00.000Z",
		edit_history_post_ids: [id],
		public_metrics: { repost_count: 3, like_count: 1 },
		...(overrides.url ? { url: overrides.url } : {}),
	};
}

function kindDocument(
	kind: "home" | "bookmark" | "like" | "mention" | "authored",
	tweet: ReturnType<typeof botShapedTweet>,
	account?: string,
) {
	return {
		kind,
		...(account ? { account } : {}),
		data: tweet,
		includes: { users: [SYNTH_AUTHOR], posts: [tweet] },
	};
}

function singleTweetResponse(
	overrides: {
		id?: string;
		text?: string;
		url?: string;
	} = {},
) {
	const id = overrides.id ?? "880001";
	return {
		data: {
			id,
			author_id: SYNTH_AUTHOR.id,
			text: overrides.text ?? "synth needle alpha",
			created_at: "2026-03-01T12:00:00.000Z",
			...(overrides.url ? { url: overrides.url } : {}),
		},
		includes: { users: [SYNTH_AUTHOR] },
	};
}

describe("importXJsonText", () => {
	it("imports a single-object data payload with provenance", () => {
		const home = testHome();
		const db = home.db;
		const result = importXJsonText(
			db,
			JSON.stringify(
				singleTweetResponse({
					url: "https://example.test/status/880001",
				}),
			),
		);
		expect(result).toEqual({ imported: 1, skipped: 0, errors: [] });
		expect(
			db.prepare("select id, text from tweets where id = ?").get("880001"),
		).toMatchObject({ id: "880001", text: "synth needle alpha" });
		expect(
			db
				.prepare("select handle from profiles where handle = ?")
				.get("synth_lab"),
		).toEqual({ handle: "synth_lab" });
		expect(
			db
				.prepare(
					"select source, source_url from tweet_sources where tweet_id = ?",
				)
				.get("880001"),
		).toEqual({
			source: "grokbot",
			source_url: "https://example.test/status/880001",
		});
		expect(
			db
				.prepare(
					"select tweet_id from tweets_fts where tweets_fts match 'needle'",
				)
				.all(),
		).toEqual([{ tweet_id: "880001" }]);
	});

	it("imports array data with includes users, media, tweets, and note_tweet", () => {
		const home = testHome();
		const db = home.db;
		const payload = {
			data: [
				{
					id: "880010",
					author_id: SYNTH_AUTHOR.id,
					text: "short",
					created_at: "2026-03-01T12:00:00.000Z",
					note_tweet: {
						text: "synth longform needle beta",
						entities: { hashtags: [{ tag: "synth" }] },
					},
					attachments: { media_keys: ["media_1"] },
					referenced_tweets: [{ type: "quoted", id: "880011" }],
				},
			],
			includes: {
				users: [SYNTH_AUTHOR],
				media: [
					{
						media_key: "media_1",
						type: "photo",
						url: "https://example.test/photo.jpg",
					},
				],
				tweets: [
					{
						id: "880011",
						author_id: SYNTH_AUTHOR.id,
						text: "quoted synth context",
						created_at: "2026-03-01T11:00:00.000Z",
					},
				],
			},
		};
		const result = importXJsonText(db, JSON.stringify(payload));
		expect(result.errors).toEqual([]);
		expect(result.imported).toBe(1);
		expect(
			db
				.prepare("select quoted_tweet_id from tweets where id = ?")
				.get("880010"),
		).toEqual({ quoted_tweet_id: "880011" });
		const noteRow = db
			.prepare("select note_tweet_json from tweets where id = ?")
			.get("880010") as { note_tweet_json: string | null } | undefined;
		expect(noteRow?.note_tweet_json).toContain("longform");
		expect(
			listTimelineItems({ resource: "home", search: "longform", limit: 5 }, db),
		).toHaveLength(1);
	});

	it("rejects malformed JSONL lines without ingesting them", () => {
		const home = testHome();
		const db = home.db;
		const good = JSON.stringify(singleTweetResponse({ id: "880020" }));
		const result = importXJsonText(db, `${good}\n{not json}\n`);
		expect(result.imported).toBe(1);
		expect(result.errors).toEqual([
			{ line: 2, message: "Line 2: invalid JSON" },
		]);
		expect(db.prepare("select count(*) as count from tweets").get()).toEqual({
			count: 1,
		});
	});

	it("rejects documents with invalid tweet fields", () => {
		const home = testHome();
		const db = home.db;
		const result = importXJsonText(
			db,
			JSON.stringify({
				data: { id: "880030", author_id: "900001", text: "", created_at: "x" },
			}),
		);
		expect(result.imported).toBe(0);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(db.prepare("select count(*) as count from tweets").get()).toEqual({
			count: 0,
		});
	});

	it("accepts native timeline kind alias for home membership", () => {
		const home = testHome();
		const db = home.db;
		seedSynthOwnerAccount(db);
		const tweet = botShapedTweet({
			id: "881120",
			text: "synth timeline alias needle",
		});
		const result = importXJsonText(
			db,
			JSON.stringify({
				kind: "timeline",
				account: SYNTH_OWNER_HANDLE,
				data: tweet,
				includes: { users: [SYNTH_AUTHOR] },
			}),
		);
		expect(result.errors).toEqual([]);
		expect(
			db
				.prepare(
					"select account_id, kind from tweet_account_edges where tweet_id = ?",
				)
				.get("881120"),
		).toEqual({ account_id: SYNTH_OWNER_ACCOUNT_ID, kind: "home" });
	});

	it("imports kind home on the resolved account with bot field renames", () => {
		const home = testHome();
		const db = home.db;
		seedSynthOwnerAccount(db);
		const tweet = botShapedTweet({
			id: "881100",
			text: "synth home kind needle",
		});
		const result = importXJsonText(
			db,
			JSON.stringify(kindDocument("home", tweet)),
		);
		expect(result).toEqual({ imported: 1, skipped: 0, errors: [] });
		expect(
			db
				.prepare(
					"select account_id, kind from tweet_account_edges where tweet_id = ?",
				)
				.get("881100"),
		).toEqual({ account_id: SYNTH_OWNER_ACCOUNT_ID, kind: "home" });
		expect(
			listTimelineItems(
				{ resource: "home", search: "home kind", limit: 5 },
				db,
			),
		).toHaveLength(1);
	});

	it("imports kind mention with mention edge membership", () => {
		const home = testHome();
		const db = home.db;
		seedSynthOwnerAccount(db);
		const tweet = botShapedTweet({
			id: "881101",
			text: "synth mention kind needle",
		});
		expect(
			importXJsonText(db, JSON.stringify(kindDocument("mention", tweet)))
				.errors,
		).toEqual([]);
		expect(
			db
				.prepare(
					"select account_id, kind from tweet_account_edges where tweet_id = ?",
				)
				.get("881101"),
		).toEqual({ account_id: SYNTH_OWNER_ACCOUNT_ID, kind: "mention" });
		expect(
			listTimelineItems(
				{ resource: "mentions", search: "mention kind", limit: 5 },
				db,
			),
		).toHaveLength(1);
	});

	it("imports kind authored with authored edge membership", () => {
		const home = testHome();
		const db = home.db;
		seedSynthOwnerAccount(db);
		const tweet = botShapedTweet({
			id: "881102",
			text: "synth authored kind needle",
		});
		importXJsonText(db, JSON.stringify(kindDocument("authored", tweet)));
		expect(
			db
				.prepare(
					"select account_id, kind from tweet_account_edges where tweet_id = ?",
				)
				.get("881102"),
		).toEqual({ account_id: SYNTH_OWNER_ACCOUNT_ID, kind: "authored" });
		expect(
			listTimelineItems(
				{ resource: "authored", search: "authored kind", limit: 5 },
				db,
			),
		).toHaveLength(1);
	});

	it("imports kind bookmark into tweet_collections bookmarks", () => {
		const home = testHome();
		const db = home.db;
		seedSynthOwnerAccount(db);
		const tweet = botShapedTweet({
			id: "881103",
			text: "synth bookmark kind needle",
		});
		importXJsonText(db, JSON.stringify(kindDocument("bookmark", tweet)));
		expect(
			db
				.prepare(
					"select account_id, kind from tweet_collections where tweet_id = ?",
				)
				.get("881103"),
		).toEqual({ account_id: SYNTH_OWNER_ACCOUNT_ID, kind: "bookmarks" });
		expect(
			listTimelineItems(
				{
					resource: "home",
					bookmarkedOnly: true,
					search: "bookmark kind",
					limit: 5,
				},
				db,
			),
		).toHaveLength(1);
	});

	it("imports kind like into tweet_collections likes", () => {
		const home = testHome();
		const db = home.db;
		seedSynthOwnerAccount(db);
		const tweet = botShapedTweet({
			id: "881104",
			text: "synth like kind needle",
		});
		importXJsonText(db, JSON.stringify(kindDocument("like", tweet)));
		expect(
			db
				.prepare(
					"select account_id, kind from tweet_collections where tweet_id = ?",
				)
				.get("881104"),
		).toEqual({ account_id: SYNTH_OWNER_ACCOUNT_ID, kind: "likes" });
		expect(
			listTimelineItems(
				{ resource: "home", likedOnly: true, search: "like kind", limit: 5 },
				db,
			),
		).toHaveLength(1);
	});

	it("keeps documents without kind on the public home path", () => {
		const home = testHome();
		const db = home.db;
		const tweet = singleTweetResponse({
			id: "881105",
			text: "synth legacy public needle",
		});
		importXJsonText(db, JSON.stringify(tweet));
		expect(
			db
				.prepare(
					"select account_id, kind from tweet_account_edges where tweet_id = ?",
				)
				.get("881105"),
		).toEqual({ account_id: "public", kind: "home" });
	});

	it("errors when kind is set but the account cannot be resolved", () => {
		const home = testHome();
		const db = home.db;
		const tweet = botShapedTweet({
			id: "881106",
			text: "synth missing account",
		});
		const result = importXJsonText(
			db,
			JSON.stringify({
				kind: "home",
				account: "no_such_account",
				data: tweet,
				includes: { users: [SYNTH_AUTHOR] },
			}),
		);
		expect(result.imported).toBe(0);
		expect(result.errors[0]?.message).toContain("Unknown account");
		expect(
			db.prepare("select id from tweets where id = ?").get("881106"),
		).toBeUndefined();
	});

	it("is idempotent on duplicate re-import", () => {
		const home = testHome();
		const db = home.db;
		const input = JSON.stringify(singleTweetResponse({ id: "880040" }));
		expect(importXJsonText(db, input)).toEqual({
			imported: 1,
			skipped: 0,
			errors: [],
		});
		expect(importXJsonText(db, input)).toEqual({
			imported: 0,
			skipped: 1,
			errors: [],
		});
	});

	it("rejects non-numeric author_id without aborting later valid lines", () => {
		const home = testHome();
		const db = home.db;
		const bad = JSON.stringify({
			data: {
				id: "880060",
				author_id: "abc",
				text: "bad author",
				created_at: "2026-03-01T12:00:00.000Z",
			},
		});
		const good = JSON.stringify(singleTweetResponse({ id: "880061" }));
		const result = importXJsonText(db, `${bad}\n${good}`);
		expect(result.imported).toBe(1);
		expect(result.errors).toEqual([
			expect.objectContaining({
				line: 1,
				message: expect.stringContaining("author_id must be a numeric string"),
			}),
		]);
		expect(
			db.prepare("select id from tweets where id = ?").get("880061"),
		).toEqual({ id: "880061" });
		expect(
			db.prepare("select id from tweets where id = ?").get("880060"),
		).toBeUndefined();
	});

	it("rejects invalid referenced_tweets before ingestion", () => {
		const home = testHome();
		const db = home.db;
		const result = importXJsonText(
			db,
			JSON.stringify({
				data: {
					id: "880070",
					author_id: SYNTH_AUTHOR.id,
					text: "broken reference",
					created_at: "2026-03-01T12:00:00.000Z",
					referenced_tweets: [{ type: "quoted", id: "not-a-tweet-id" }],
				},
				includes: { users: [SYNTH_AUTHOR] },
			}),
		);
		expect(result.imported).toBe(0);
		expect(result.errors[0]?.message).toContain("referenced_tweets.id");
		expect(db.prepare("select count(*) as count from tweets").get()).toEqual({
			count: 0,
		});
	});

	it("counts distinct primary tweet ids when data repeats an id", () => {
		const home = testHome();
		const db = home.db;
		const tweet = {
			id: "880080",
			author_id: SYNTH_AUTHOR.id,
			text: "duplicate primary",
			created_at: "2026-03-01T12:00:00.000Z",
		};
		const result = importXJsonText(
			db,
			JSON.stringify({
				data: [tweet, { ...tweet }],
				includes: { users: [SYNTH_AUTHOR] },
			}),
		);
		expect(result).toMatchObject({ imported: 1, skipped: 0, errors: [] });
		expect(db.prepare("select count(*) as count from tweets").get()).toEqual({
			count: 1,
		});
	});

	it("preserves original JSONL line numbers when leading lines are blank", () => {
		const home = testHome();
		const db = home.db;
		const good = JSON.stringify(singleTweetResponse({ id: "880090" }));
		const input = `\n\n${good}\n{not json}\n`;
		const result = importXJsonText(db, input);
		expect(result.imported).toBe(1);
		expect(result.errors).toEqual([
			{ line: 4, message: "Line 4: invalid JSON" },
		]);
	});
});

describe("importXJsonText backup compatibility", () => {
	const populatedHome = useTestHome({
		prefix: "birdclaw-x-json-backup-",
		seedDemoData: true,
	});

	it("survives backup export and restore in a populated workspace", async () => {
		const home = populatedHome();
		const db = home.db;
		const tweetsBefore = (
			db.prepare("select count(*) as count from tweets").get() as {
				count: number;
			}
		).count;
		const importResult = importXJsonText(
			db,
			JSON.stringify(
				singleTweetResponse({
					id: "880100",
					text: "backup needle",
					url: "https://example.test/status/880100",
				}),
			),
		);
		expect(importResult.errors).toEqual([]);
		expect(importResult.imported).toBe(1);
		const tweetsAfterImport = (
			db.prepare("select count(*) as count from tweets").get() as {
				count: number;
			}
		).count;
		expect(tweetsAfterImport).toBe(tweetsBefore + 1);

		const backupRoot = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-x-json-backup-repo-"),
		);
		await exportBackup({ repoPath: backupRoot, db });
		home.switchHome("birdclaw-x-json-restored-");
		await importBackup({ repoPath: backupRoot, mode: "replace" });
		const restoredDb = home.db;
		expect(
			restoredDb.prepare("select count(*) as count from tweets").get(),
		).toEqual({ count: tweetsAfterImport });
		expect(
			restoredDb
				.prepare("select id, text from tweets where id = ?")
				.get("880100"),
		).toMatchObject({ id: "880100", text: "backup needle" });
		expect(
			restoredDb
				.prepare(
					"select source from tweet_sources where tweet_id = ? and source = ?",
				)
				.get("880100", "grokbot"),
		).toEqual({ source: "grokbot" });
	});
});

describe("import x-json CLI", () => {
	it("imports from stdin and finds the tweet via search tweets", async () => {
		const input = JSON.stringify(
			singleTweetResponse({
				id: "880050",
				text: "stdin synth needle gamma",
			}),
		);
		const stdin = Readable.from([input]);
		const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
		Object.defineProperty(process, "stdin", {
			configurable: true,
			value: stdin,
		});
		try {
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			await runCliMain(["node", "birdclaw", "import", "x-json", "-", "--json"]);
			expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
				imported: 1,
				skipped: 0,
				errors: [],
			});
			log.mockClear();
			await runCliMain([
				"node",
				"birdclaw",
				"search",
				"tweets",
				"gamma",
				"--json",
			]);
			const rows = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
			expect(rows.map((row: { id: string }) => row.id)).toContain("880050");
		} finally {
			if (stdinDescriptor) {
				Object.defineProperty(process, "stdin", stdinDescriptor);
			}
		}
	});

	it("exits non-zero when errors are present but still prints JSON", async () => {
		const stdin = Readable.from(['{"data":{"id":"1"}}\n']);
		const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
		Object.defineProperty(process, "stdin", {
			configurable: true,
			value: stdin,
		});
		try {
			process.exitCode = 0;
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			await runCliMain(["node", "birdclaw", "import", "x-json", "-", "--json"]);
			const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
			expect(payload.errors.length).toBeGreaterThan(0);
			expect(payload).toMatchObject({
				imported: 0,
				skipped: 0,
			});
			expect(process.exitCode).toBe(1);
		} finally {
			if (stdinDescriptor) {
				Object.defineProperty(process, "stdin", stdinDescriptor);
			}
		}
	});
});
