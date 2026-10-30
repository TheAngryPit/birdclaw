// @vitest-environment node
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCliMain } from "../cli";
import { listDmConversations } from "./dm-read-model";
import {
	classifyDecryptRow,
	importDmJsonText,
	normalizeDecryptConversationId,
	parseDmJsonConversationsFile,
	validateDmJsonImport,
} from "./dm-json-import";
import { buildExternalProfileId } from "./x-profile";
import { useTestHome } from "../test/test-home";

const testHome = useTestHome({
	prefix: "birdclaw-dm-json-",
	seedDemoData: false,
});

const LOCAL_X_ID = "910100";
const PEER_X_ID = "910101";
const GROUP_X_ID = "910102";
const ACCOUNT_ID = "acct_dm_synth";
const CONVERSATION_RAW = "9001:abc";
const CONVERSATION_ID = normalizeDecryptConversationId(CONVERSATION_RAW);
const PEER_HANDLE = "peer_synth_handle";
const PEER_NAME = "Peer Synth Name";
const PEER_FOLLOWERS = 4242;

function syntheticPeerUser() {
	return {
		id: PEER_X_ID,
		username: PEER_HANDLE,
		name: PEER_NAME,
		public_metrics: {
			followers_count: PEER_FOLLOWERS,
			following_count: 42,
		},
	};
}

function seedArchivePlaceholderProfile(
	db: ReturnType<typeof testHome>["db"],
	externalUserId: string,
) {
	const profileId = buildExternalProfileId(externalUserId);
	db.prepare(
		`insert into profiles (
      id, handle, display_name, bio, followers_count, following_count,
      public_metrics_json, avatar_hue, avatar_url, entities_json, raw_json, created_at
    ) values (?, ?, ?, '', 0, 0, '{}', 1, null, '{}', ?, ?)`,
	).run(
		profileId,
		`id${externalUserId}`,
		`id${externalUserId}`,
		JSON.stringify({ id: externalUserId }),
		"2026-01-01T00:00:00.000Z",
	);
	return profileId;
}

function readProfile(
	db: ReturnType<typeof testHome>["db"],
	externalUserId: string,
) {
	return db
		.prepare(
			`select handle, display_name, followers_count
       from profiles where id = ?`,
		)
		.get(buildExternalProfileId(externalUserId)) as {
		handle: string;
		display_name: string;
		followers_count: number;
	};
}

function readConversationTitle(
	db: ReturnType<typeof testHome>["db"],
	conversationId: string,
) {
	return (
		db
			.prepare("select title from dm_conversations where id = ?")
			.get(conversationId) as { title: string } | undefined
	)?.title;
}

function seedDmImportAccount(db: ReturnType<typeof testHome>["db"]) {
	db.prepare(
		`insert into accounts (
      id, name, handle, external_user_id, transport, is_default, created_at
    ) values (?, 'Synth DM Owner', '@dm_owner_synth', ?, 'xurl', 1, ?)`,
	).run(ACCOUNT_ID, LOCAL_X_ID, "2026-01-01T00:00:00.000Z");
}

function messageRow(
	overrides: {
		id?: string;
		text?: string;
		senderId?: string;
		conversationId?: string;
		contentType?: string;
		eventType?: string;
		attachments?: unknown[];
		error?: string;
		notice?: string;
		change?: unknown;
		original_b64?: string;
	} = {},
) {
	return {
		event: {
			type: overrides.eventType ?? "Message",
			id: overrides.id ?? "880001",
			sender_id: overrides.senderId ?? PEER_X_ID,
			conversation_id: overrides.conversationId ?? CONVERSATION_RAW,
			created_at_msec: 1_704_000_000_000,
			content: {
				content_type: overrides.contentType ?? "text",
			},
			...(overrides.attachments ? { attachments: overrides.attachments } : {}),
			...(overrides.change !== undefined ? { change: overrides.change } : {}),
		},
		text: overrides.text ?? "synth dm alpha",
		status: "verified",
		...(overrides.error ? { error: overrides.error } : {}),
		...(overrides.notice ? { notice: overrides.notice } : {}),
		...(overrides.original_b64 ? { original_b64: overrides.original_b64 } : {}),
	};
}

function conversationsMap(
	overrides: Partial<{
		participant_ids: string[];
		inbox_kind: "accepted" | "request";
	}> = {},
) {
	return parseDmJsonConversationsFile({
		[CONVERSATION_ID]: {
			participant_ids: overrides.participant_ids ?? [LOCAL_X_ID, PEER_X_ID],
			inbox_kind: overrides.inbox_kind ?? "accepted",
		},
	});
}

describe("import dm-json", () => {
	it("maps decrypt rows into xurl-shaped DM events", () => {
		const classified = classifyDecryptRow(
			messageRow({ text: "synth mapped text" }),
			1,
			LOCAL_X_ID,
			conversationsMap(),
		);
		expect(classified).toMatchObject({
			event: {
				id: "880001",
				event_type: "MessageCreate",
				text: "synth mapped text",
				dm_conversation_id: CONVERSATION_ID,
				sender_id: PEER_X_ID,
			},
			conversationId: CONVERSATION_ID,
		});
		expect("event" in classified && classified.event.created_at).toEqual(
			new Date(1_704_000_000_000).toISOString(),
		);
	});

	it("skips every v1 exclusion reason", () => {
		const cases: Array<[Parameters<typeof messageRow>[0], string]> = [
			[{ error: "decrypt failed" }, "error-row"],
			[{ notice: "system" }, "system-notice"],
			[{ eventType: "ParticipantsJoin" }, "non-message-event"],
			[{ contentType: "media" }, "non-text-content"],
			[{ eventType: "Reaction" }, "reaction"],
			[{ eventType: "Message", change: { edited: true } }, "edit"],
		];
		for (const [row, reason] of cases) {
			const classified = classifyDecryptRow(
				messageRow(row),
				1,
				LOCAL_X_ID,
				conversationsMap(),
			);
			expect(classified).toEqual({ skip: reason });
		}
		const group = classifyDecryptRow(
			messageRow(),
			1,
			LOCAL_X_ID,
			parseDmJsonConversationsFile({
				[CONVERSATION_ID]: {
					participant_ids: [LOCAL_X_ID, PEER_X_ID, GROUP_X_ID],
				},
			}),
		);
		expect(group).toEqual({ skip: "group-conversation" });
	});

	it("imports JSON and JSONL payloads idempotently without storing original_b64", async () => {
		const home = testHome();
		const db = home.db;
		seedDmImportAccount(db);
		const payload = JSON.stringify({
			messages: [
				messageRow({
					id: "880010",
					text: "synth inbox dm one",
					original_b64: "c3RlYWw=",
					attachments: [{ kind: "photo" }],
				}),
			],
		});
		const first = await importDmJsonText(db, payload, {
			account: ACCOUNT_ID,
			conversations: conversationsMap(),
			logPath: path.join(home.root, "audit", "dm.jsonl"),
		});
		expect(first).toMatchObject({
			ok: true,
			imported: 1,
			conversationsTouched: 1,
		});
		const stored = db
			.prepare("select text from dm_messages where id = ?")
			.get("880010") as { text: string };
		expect(stored.text).toContain("synth inbox dm one");
		expect(stored.text).toContain("[1 attachment(s)]");
		expect(stored.text).not.toContain("c3RlYWw=");
		expect(
			db.prepare("select count(*) as count from dm_messages").get(),
		).toEqual({ count: 1 });

		const second = await importDmJsonText(
			db,
			`${JSON.stringify(messageRow({ id: "880010", text: "synth inbox dm one" }))}\n`,
			{ account: ACCOUNT_ID, conversations: conversationsMap() },
		);
		expect(second.imported).toBe(0);

		const auditLine = readFileSync(
			path.join(home.root, "audit", "dm.jsonl"),
			"utf8",
		).trim();
		expect(auditLine).toContain('"job":"dm-json-import"');
		expect(auditLine).not.toContain("synth inbox dm one");
		expect(auditLine).toContain('"imported":1');
	});

	it("supports dry-run validation without merging", async () => {
		const home = testHome();
		seedDmImportAccount(home.db);
		const dry = validateDmJsonImport(
			JSON.stringify({ messages: [messageRow({ id: "880020" })] }),
			{
				localExternalUserId: LOCAL_X_ID,
				conversations: conversationsMap(),
			},
		);
		expect(dry.imported).toBe(1);
		expect(
			home.db.prepare("select count(*) as count from dm_messages").get(),
		).toEqual({ count: 0 });
	});

	it("imports from stdin via CLI and lists the conversation", async () => {
		const home = testHome();
		seedDmImportAccount(home.db);
		const input = JSON.stringify({
			messages: [
				messageRow({
					id: "880030",
					text: "synth cli dm needle",
				}),
			],
		});
		const stdin = Readable.from([input]);
		const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
		Object.defineProperty(process, "stdin", {
			configurable: true,
			value: stdin,
		});
		try {
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			await runCliMain([
				"node",
				"birdclaw",
				"import",
				"dm-json",
				"-",
				"--account",
				ACCOUNT_ID,
				"--json",
			]);
			expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
				ok: true,
				imported: 1,
			});
			log.mockClear();
			await runCliMain(["node", "birdclaw", "dms", "list", "--json"]);
			const rows = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
			expect(rows.length).toBeGreaterThan(0);
			expect(listDmConversations({ limit: 5 }).length).toBeGreaterThan(0);
		} finally {
			if (stdinDescriptor) {
				Object.defineProperty(process, "stdin", stdinDescriptor);
			}
		}
	});
});

describe("import dm-json optional users", () => {
	it("upgrades stub and archive placeholder profiles and refreshes titles", async () => {
		const home = testHome();
		const db = home.db;
		seedDmImportAccount(db);
		await importDmJsonText(
			db,
			JSON.stringify({
				messages: [messageRow({ id: "880040", text: "synth dm with users" })],
			}),
			{ account: ACCOUNT_ID, conversations: conversationsMap() },
		);
		expect(readProfile(db, PEER_X_ID).handle).toMatch(/^birdclaw_stub_/);

		seedArchivePlaceholderProfile(db, "910103");
		const archiveConversationId =
			normalizeDecryptConversationId("9002:archive");
		const archiveProfileId = buildExternalProfileId("910103");
		db.prepare(
			`insert into dm_conversations (
        id, account_id, participant_profile_id, title, last_message_at, unread_count, needs_reply
      ) values (?, ?, ?, ?, ?, 0, 0)`,
		).run(
			archiveConversationId,
			ACCOUNT_ID,
			archiveProfileId,
			"id910103",
			"2026-01-02T00:00:00.000Z",
		);

		await importDmJsonText(db, JSON.stringify({ messages: [] }), {
			account: ACCOUNT_ID,
			users: [
				syntheticPeerUser(),
				{
					id: "910103",
					username: "archive_peer_handle",
					name: "Archive Peer Synth",
					public_metrics: { followers_count: 9001 },
				},
			],
		});
		expect(readProfile(db, PEER_X_ID)).toMatchObject({
			handle: PEER_HANDLE,
			display_name: PEER_NAME,
			followers_count: PEER_FOLLOWERS,
		});
		expect(readConversationTitle(db, CONVERSATION_ID)).toBe(PEER_HANDLE);
		expect(readProfile(db, "910103")).toMatchObject({
			handle: "archive_peer_handle",
			display_name: "Archive Peer Synth",
			followers_count: 9001,
		});
		expect(readConversationTitle(db, archiveConversationId)).toBe(
			"archive_peer_handle",
		);
	});

	it("supports a users-only pass with no messages", async () => {
		const home = testHome();
		const db = home.db;
		seedDmImportAccount(db);
		const profileId = seedArchivePlaceholderProfile(db, PEER_X_ID);
		db.prepare(
			`insert into dm_conversations (
        id, account_id, participant_profile_id, title, last_message_at, unread_count, needs_reply
      ) values (?, ?, ?, ?, ?, 0, 0)`,
		).run(
			CONVERSATION_ID,
			ACCOUNT_ID,
			profileId,
			`id${PEER_X_ID}`,
			"2026-01-02T00:00:00.000Z",
		);
		await importDmJsonText(db, JSON.stringify({ messages: [] }), {
			account: ACCOUNT_ID,
			users: [syntheticPeerUser()],
		});
		expect(readProfile(db, PEER_X_ID)).toMatchObject({
			handle: PEER_HANDLE,
			display_name: PEER_NAME,
			followers_count: PEER_FOLLOWERS,
		});
		expect(readConversationTitle(db, CONVERSATION_ID)).toBe(PEER_HANDLE);
	});

	it("leaves placeholder profiles unchanged when users are omitted", async () => {
		const home = testHome();
		const db = home.db;
		seedDmImportAccount(db);
		seedArchivePlaceholderProfile(db, PEER_X_ID);
		await importDmJsonText(
			db,
			JSON.stringify({ messages: [messageRow({ id: "880050" })] }),
			{ account: ACCOUNT_ID, conversations: conversationsMap() },
		);
		const afterImport = readProfile(db, PEER_X_ID);
		expect(afterImport.handle).toBe(`id${PEER_X_ID}`);
		await importDmJsonText(db, JSON.stringify({ messages: [] }), {
			account: ACCOUNT_ID,
		});
		expect(readProfile(db, PEER_X_ID)).toEqual(afterImport);
	});

	it("loads users from a sidecar JSON file", async () => {
		const home = testHome();
		const db = home.db;
		seedDmImportAccount(db);
		seedArchivePlaceholderProfile(db, PEER_X_ID);
		const usersPath = path.join(home.root, "peer-users.json");
		writeFileSync(usersPath, JSON.stringify({ users: [syntheticPeerUser()] }));
		const { readDmJsonUsersFromPath } = await import("./dm-json-import");
		await importDmJsonText(db, JSON.stringify({ messages: [] }), {
			account: ACCOUNT_ID,
			usersPath,
			users: await readDmJsonUsersFromPath(usersPath),
		});
		expect(readProfile(db, PEER_X_ID).handle).toBe(PEER_HANDLE);
	});
});
