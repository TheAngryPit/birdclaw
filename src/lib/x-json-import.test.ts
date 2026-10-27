// @vitest-environment node
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCliMain } from "../cli";
import { listTimelineItems } from "./timeline-read-model";
import { importXJsonText } from "./x-json-import";
import { useTestHome } from "../test/test-home";

const testHome = useTestHome({ prefix: "birdclaw-x-json-", seedDemoData: false });

const SYNTH_AUTHOR = {
	id: "900001",
	username: "synth_lab",
	name: "Synth Lab",
};

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
			db.prepare("select quoted_tweet_id from tweets where id = ?").get("880010"),
		).toEqual({ quoted_tweet_id: "880011" });
		expect(
			db
				.prepare("select note_tweet_json from tweets where id = ?")
				.get("880010")?.note_tweet_json,
		).toContain("longform");
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
		expect(
			db.prepare("select count(*) as count from tweets").get(),
		).toEqual({ count: 1 });
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
});

describe("import x-json CLI", () => {
	it("imports from stdin and finds the tweet via search tweets", async () => {
		const home = testHome();
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
});
