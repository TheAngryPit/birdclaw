// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
	getDefaultXJsonIssuesImportAuditLogPath,
	importXJsonIssuesEffect,
	X_JSON_IMPORT_FAILED_LABEL,
	type GhIssue,
	type GhIssueRunner,
} from "./x-json-issue-import";
import { useTestHome } from "../test/test-home";

const testHome = useTestHome({
	prefix: "birdclaw-x-json-issues-",
	seedDemoData: false,
});

const SYNTH_AUTHOR = "synth_bot_a";

function tweetBody(
	overrides: { id?: string; text?: string; authorLogin?: string } = {},
) {
	const id = overrides.id ?? "990001";
	return JSON.stringify({
		data: {
			id,
			author_id: "910001",
			text: overrides.text ?? "synth inbox needle one",
			created_at: "2026-03-02T12:00:00.000Z",
		},
		includes: {
			users: [
				{
					id: "910001",
					username: "synth_lab_a",
					name: "Synth Lab A",
				},
			],
		},
	});
}

function issue(overrides: Partial<GhIssue> & { number: number }): GhIssue {
	return {
		number: overrides.number,
		title: overrides.title ?? `inbox ${String(overrides.number)}`,
		body: overrides.body ?? tweetBody(),
		author: overrides.author ?? { login: SYNTH_AUTHOR },
		labels: overrides.labels ?? [],
	};
}

class RecordingGhRunner implements GhIssueRunner {
	readonly comments: Array<{ number: number; body: string }> = [];
	readonly closed: number[] = [];
	readonly labelled: Array<{ number: number; label: string }> = [];
	openIssues: GhIssue[];

	constructor(openIssues: GhIssue[]) {
		this.openIssues = openIssues;
	}

	async listOpenIssues() {
		return [...this.openIssues];
	}

	async createComment(_repo: string, issueNumber: number, body: string) {
		this.comments.push({ number: issueNumber, body: body });
	}

	async closeIssue(_repo: string, issueNumber: number) {
		this.closed.push(issueNumber);
		this.openIssues = this.openIssues.filter(
			(candidate) => candidate.number !== issueNumber,
		);
	}

	async addLabel(_repo: string, issueNumber: number, label: string) {
		this.labelled.push({ number: issueNumber, label });
		const target = this.openIssues.find(
			(candidate) => candidate.number === issueNumber,
		);
		if (target) {
			target.labels = [...target.labels, { name: label }];
		}
	}
}

describe("importXJsonIssuesEffect", () => {
	it("imports a valid issue, comments, and closes it", async () => {
		const home = testHome();
		const runner = new RecordingGhRunner([issue({ number: 1 })]);
		const summary = await importXJsonIssuesEffect(
			home.db,
			{ repo: "synth-org/synth-inbox" },
			runner,
		);
		expect(summary.ok).toBe(true);
		expect(summary.issues[0]).toMatchObject({
			number: 1,
			action: "imported",
			closed: true,
			commented: true,
		});
		expect(runner.closed).toEqual([1]);
		expect(JSON.parse(runner.comments[0]!.body)).toMatchObject({
			imported: 1,
			errors: [],
		});
		expect(
			home.db.prepare("select id from tweets where id = ?").get("990001"),
		).toBeTruthy();
	});

	it("appends one JSONL audit entry with sync-style run metadata per issue", async () => {
		const home = testHome();
		const logPath = path.join(home.root, "audit", "inbox-audit.jsonl");
		const runner = new RecordingGhRunner([
			issue({
				number: 11,
				body: JSON.stringify({
					kind: "bookmarks",
					account: "acct_synth_owner",
					data: JSON.parse(tweetBody({ id: "990011" })).data,
					includes: JSON.parse(tweetBody({ id: "990011" })).includes,
				}),
			}),
		]);
		home.db
			.prepare(
				`insert into accounts (
          id, name, handle, external_user_id, transport, is_default, created_at
        ) values ('acct_synth_owner', 'Synth Owner', '@owner_synth', '910000', 'xurl', 1, ?)`,
			)
			.run("2026-01-01T00:00:00.000Z");
		await importXJsonIssuesEffect(
			home.db,
			{ repo: "synth-org/synth-inbox", logPath },
			runner,
		);
		const line = readFileSync(logPath, "utf8").trim();
		const entry = JSON.parse(line) as Record<string, unknown>;
		expect(entry).toMatchObject({
			job: "x-json-issues-import",
			ok: true,
			host: os.hostname(),
			pid: process.pid,
		});
		expect(entry.startedAt).toEqual(expect.any(String));
		expect(entry.finishedAt).toEqual(expect.any(String));
		expect(entry.durationMs).toEqual(expect.any(Number));
		expect(entry.options).toMatchObject({ repo: "synth-org/synth-inbox" });
		expect(entry.issues).toEqual([
			expect.objectContaining({
				issueNumber: 11,
				account: "acct_synth_owner",
				step: "bookmarks",
				imported: 1,
				skipped: 0,
				errors: [],
				ok: true,
				action: "imported",
			}),
		]);
		expect(getDefaultXJsonIssuesImportAuditLogPath()).toContain(
			"audit/x-json-issues-import.jsonl",
		);
	});

	it("keeps malformed issues open, comments, and labels import-failed", async () => {
		const home = testHome();
		const runner = new RecordingGhRunner([
			issue({ number: 2, body: '{"data":{"id":"bad"}}' }),
		]);
		const summary = await importXJsonIssuesEffect(
			home.db,
			{ repo: "synth-org/synth-inbox" },
			runner,
		);
		expect(summary.ok).toBe(false);
		expect(summary.issues[0]).toMatchObject({
			number: 2,
			action: "failed",
			commented: true,
			labelled: true,
		});
		expect(summary.issues[0]?.closed).toBeUndefined();
		expect(runner.closed).toEqual([]);
		expect(runner.labelled).toEqual([
			{ number: 2, label: X_JSON_IMPORT_FAILED_LABEL },
		]);
		expect(
			home.db.prepare("select count(*) as count from tweets").get(),
		).toEqual({ count: 0 });
	});

	it("unwraps fenced json bodies before import", async () => {
		const home = testHome();
		const runner = new RecordingGhRunner([
			issue({
				number: 3,
				body: `\`\`\`jsonl\n${tweetBody({ id: "990003" })}\n\`\`\``,
			}),
		]);
		const summary = await importXJsonIssuesEffect(
			home.db,
			{ repo: "synth-org/synth-inbox" },
			runner,
		);
		expect(summary.ok).toBe(true);
		expect(
			home.db.prepare("select id from tweets where id = ?").get("990003"),
		).toBeTruthy();
	});

	it("skips issues from non-allowlisted authors", async () => {
		const home = testHome();
		const runner = new RecordingGhRunner([
			issue({ number: 4, author: { login: "other_actor" } }),
		]);
		const summary = await importXJsonIssuesEffect(
			home.db,
			{
				repo: "synth-org/synth-inbox",
				allowedAuthors: [SYNTH_AUTHOR],
			},
			runner,
		);
		expect(summary.issues[0]?.action).toBe("skipped-author");
		expect(runner.comments).toHaveLength(0);
		expect(
			home.db.prepare("select count(*) as count from tweets").get(),
		).toEqual({ count: 0 });
	});

	it("dry-run validates without DB or GitHub writes", async () => {
		const home = testHome();
		const runner = new RecordingGhRunner([issue({ number: 5 })]);
		const createComment = vi.spyOn(runner, "createComment");
		const summary = await importXJsonIssuesEffect(
			home.db,
			{ repo: "synth-org/synth-inbox", dryRun: true },
			runner,
		);
		expect(summary.dryRun).toBe(true);
		expect(summary.issues[0]?.action).toBe("dry-run");
		expect(createComment).not.toHaveBeenCalled();
		expect(runner.closed).toEqual([]);
		expect(
			home.db.prepare("select count(*) as count from tweets").get(),
		).toEqual({ count: 0 });
	});

	it("skips issues that already have import-failed", async () => {
		const home = testHome();
		const runner = new RecordingGhRunner([
			issue({
				number: 6,
				labels: [{ name: X_JSON_IMPORT_FAILED_LABEL }],
			}),
		]);
		const summary = await importXJsonIssuesEffect(
			home.db,
			{ repo: "synth-org/synth-inbox" },
			runner,
		);
		expect(summary.issues[0]?.action).toBe("skipped-failed-label");
		expect(runner.comments).toHaveLength(0);
	});

	it("re-imports idempotently when the issue stays open", async () => {
		const home = testHome();
		const runner = new RecordingGhRunner([
			issue({ number: 7, body: tweetBody({ id: "990007" }) }),
		]);
		const first = await importXJsonIssuesEffect(
			home.db,
			{ repo: "synth-org/synth-inbox" },
			runner,
		);
		expect(first.issues[0]?.result).toMatchObject({
			imported: 1,
			skipped: 0,
			errors: [],
		});
		runner.openIssues = [
			issue({ number: 7, body: tweetBody({ id: "990007" }) }),
		];
		const second = await importXJsonIssuesEffect(
			home.db,
			{ repo: "synth-org/synth-inbox" },
			runner,
		);
		expect(second.issues[0]?.result).toMatchObject({
			imported: 0,
			skipped: 1,
			errors: [],
		});
		expect(
			home.db
				.prepare("select count(*) as count from tweets where id = ?")
				.get("990007"),
		).toEqual({ count: 1 });
	});
});
