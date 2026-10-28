// @vitest-environment node
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
