import { readFile } from "node:fs/promises";
import path from "node:path";
import { ensureBirdclawDirs, getBirdclawPaths } from "./config";
import { mergeImportedXurlDmEventsIntoLocalStore } from "./dms-live";
import { resolveLiveSyncAccount } from "./live-sync-engine";
import { resolveUserPath } from "./launchd";
import { appendScheduledJobAudit, startScheduledJobRun } from "./scheduled-job";
import type { Database } from "./sqlite";
import type { XurlDmEvent, XurlDmEventsResponse } from "./types";

export const DM_JSON_SKIP_REASONS = [
	"error-row",
	"system-notice",
	"non-message-event",
	"non-text-content",
	"reaction",
	"edit",
	"group-conversation",
	"invalid-row",
] as const;

export type DmJsonSkipReason = (typeof DM_JSON_SKIP_REASONS)[number];

export interface DmJsonImportError {
	line: number;
	message: string;
}

export interface DmJsonImportResult {
	ok: boolean;
	imported: number;
	skipped: Record<DmJsonSkipReason, number>;
	conversationsTouched: number;
	errors: DmJsonImportError[];
}

export interface DmJsonConversationMetadata {
	participant_ids: string[];
	inbox_kind?: "accepted" | "request";
}

type JsonRecord = Record<string, unknown>;

function emptySkipCounts(): Record<DmJsonSkipReason, number> {
	return {
		"error-row": 0,
		"system-notice": 0,
		"non-message-event": 0,
		"non-text-content": 0,
		reaction: 0,
		edit: 0,
		"group-conversation": 0,
		"invalid-row": 0,
	};
}

function isRecord(value: unknown): value is JsonRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeConversationId(value: string) {
	return value.trim().replaceAll(":", "-");
}

function readString(value: unknown) {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function readMillis(value: unknown) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

export function normalizeDecryptConversationId(raw: string) {
	return normalizeConversationId(raw);
}

export function parseDmJsonConversationsFile(raw: unknown) {
	if (!isRecord(raw)) {
		throw new Error("conversations file must be a JSON object");
	}
	const map = new Map<string, DmJsonConversationMetadata>();
	for (const [key, value] of Object.entries(raw)) {
		if (!isRecord(value)) {
			throw new Error(`conversations.${key} must be an object`);
		}
		const participantIdsRaw = value.participant_ids;
		if (!Array.isArray(participantIdsRaw) || participantIdsRaw.length === 0) {
			throw new Error(
				`conversations.${key}.participant_ids must be a non-empty array`,
			);
		}
		const participant_ids = participantIdsRaw
			.map((entry) => readString(entry))
			.filter((entry): entry is string => Boolean(entry));
		if (participant_ids.length === 0) {
			throw new Error(
				`conversations.${key}.participant_ids must contain string ids`,
			);
		}
		const inboxKindRaw = readString(value.inbox_kind)?.toLowerCase();
		const inbox_kind =
			inboxKindRaw === "request"
				? "request"
				: inboxKindRaw === "accepted"
					? "accepted"
					: inboxKindRaw === undefined
						? undefined
						: (() => {
								throw new Error(
									`conversations.${key}.inbox_kind must be accepted or request`,
								);
							})();
		const metadata: DmJsonConversationMetadata = {
			participant_ids,
			...(inbox_kind ? { inbox_kind } : {}),
		};
		map.set(normalizeConversationId(key), metadata);
		map.set(key.trim(), metadata);
	}
	return map;
}

export async function readDmJsonConversationsMap(pathValue: string) {
	const input = await readFile(pathValue, "utf8");
	return parseDmJsonConversationsFile(JSON.parse(input) as unknown);
}

function attachmentPlaceholder(attachments: unknown) {
	if (!Array.isArray(attachments) || attachments.length === 0) return "";
	return ` [${String(attachments.length)} attachment(s)]`;
}

function uniqueParticipantIds(values: string[]) {
	return [...new Set(values.filter((value) => value.length > 0))];
}

export function classifyDecryptRow(
	row: unknown,
	line: number,
	localExternalUserId: string,
	conversations: Map<string, DmJsonConversationMetadata> | undefined,
):
	| { event: XurlDmEvent; conversationId: string }
	| { skip: DmJsonSkipReason }
	| { error: string } {
	if (!isRecord(row)) {
		return { error: `Line ${String(line)}: expected a JSON object` };
	}
	if (row.error !== undefined && row.error !== null) {
		return { skip: "error-row" };
	}
	if (row.notice !== undefined && row.notice !== null) {
		return { skip: "system-notice" };
	}
	const event = row.event;
	if (!isRecord(event)) {
		return { skip: "invalid-row" };
	}
	const eventType = readString(event.type)?.toLowerCase();
	if (eventType === "reaction") return { skip: "reaction" };
	if (eventType === "edit" || event.change !== undefined)
		return { skip: "edit" };
	if (eventType !== "message") {
		return { skip: "non-message-event" };
	}
	const content = event.content;
	const contentType = isRecord(content)
		? readString(content.content_type)?.toLowerCase()
		: undefined;
	if (contentType === "reaction") return { skip: "reaction" };
	if (contentType === "edit") return { skip: "edit" };
	if (contentType !== "text") return { skip: "non-text-content" };

	const id = readString(event.id);
	const senderId = readString(event.sender_id);
	const conversationRaw = readString(event.conversation_id);
	const text = readString(row.text);
	const createdAtMsec = readMillis(event.created_at_msec);
	if (
		!id ||
		!senderId ||
		!conversationRaw ||
		!text ||
		createdAtMsec === undefined
	) {
		return { skip: "invalid-row" };
	}

	const conversationId = normalizeConversationId(conversationRaw);
	const metadata = conversations?.get(conversationId);
	const participantIds =
		metadata?.participant_ids ??
		uniqueParticipantIds([localExternalUserId, senderId]);
	const otherParticipants = participantIds.filter(
		(participantId) => participantId !== localExternalUserId,
	);
	if (otherParticipants.length > 1) {
		return { skip: "group-conversation" };
	}

	return {
		event: {
			id,
			event_type: "MessageCreate",
			text: `${text}${attachmentPlaceholder(event.attachments)}`,
			created_at: new Date(createdAtMsec).toISOString(),
			dm_conversation_id: conversationId,
			sender_id: senderId,
			participant_ids: participantIds,
		},
		conversationId,
	};
}

function splitDecryptDocuments(input: string): {
	rows: Array<{ line: number; raw: unknown }>;
	errors: DmJsonImportError[];
} {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("import input is empty");
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (isRecord(parsed) && Array.isArray(parsed.messages)) {
			return {
				rows: parsed.messages.map((raw, index) => ({
					line: index + 1,
					raw,
				})),
				errors: [],
			};
		}
		if (isRecord(parsed)) {
			return { rows: [{ line: 1, raw: parsed }], errors: [] };
		}
	} catch {
		// JSONL fallback
	}
	const rows: Array<{ line: number; raw: unknown }> = [];
	const errors: DmJsonImportError[] = [];
	let lineNumber = 0;
	for (const line of trimmed.split(/\r?\n/u)) {
		lineNumber += 1;
		const slice = line.trim();
		if (!slice) continue;
		try {
			rows.push({ line: lineNumber, raw: JSON.parse(slice) as unknown });
		} catch {
			errors.push({
				line: lineNumber,
				message: `Line ${String(lineNumber)}: invalid JSON`,
			});
		}
	}
	if (rows.length === 0 && errors.length === 0) {
		throw new Error("import input is empty");
	}
	return { rows, errors };
}

function buildInboxKindMap(
	events: XurlDmEvent[],
	conversations: Map<string, DmJsonConversationMetadata> | undefined,
) {
	const map = new Map<string, "accepted" | "request">();
	for (const event of events) {
		const conversationId = event.dm_conversation_id;
		if (!conversationId) continue;
		map.set(
			conversationId,
			conversations?.get(conversationId)?.inbox_kind ?? "accepted",
		);
	}
	return map;
}

function resolveLocalExternalUserId(db: Database, account?: string) {
	const accountRow = resolveLiveSyncAccount(db, account);
	const localExternalUserId = accountRow.externalUserId?.trim();
	if (!localExternalUserId) {
		throw new Error(
			`Account ${accountRow.accountId} has no external_user_id; required for DM import`,
		);
	}
	return { accountRow, localExternalUserId };
}

function messageExists(db: Database, messageId: string) {
	return Boolean(
		db.prepare("select 1 as ok from dm_messages where id = ?").get(messageId),
	);
}

export function getDefaultDmJsonImportAuditLogPath() {
	return path.join(getBirdclawPaths().rootDir, "audit", "dm-json-import.jsonl");
}

export interface DmJsonImportAuditEntry {
	job: "dm-json-import";
	ok: boolean;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	host: string;
	pid: number;
	options: {
		account?: string;
		dryRun: boolean;
		conversationsPath?: string;
	};
	imported: number;
	skipped: Record<DmJsonSkipReason, number>;
	conversationsTouched: number;
	errors: number;
}

export function validateDmJsonImport(
	input: string,
	options: {
		localExternalUserId: string;
		conversations?: Map<string, DmJsonConversationMetadata>;
	},
): DmJsonImportResult {
	const result: DmJsonImportResult = {
		ok: true,
		imported: 0,
		skipped: emptySkipCounts(),
		conversationsTouched: 0,
		errors: [],
	};
	const split = splitDecryptDocuments(input);
	result.errors.push(...split.errors);
	const conversationIds = new Set<string>();
	for (const row of split.rows) {
		const classified = classifyDecryptRow(
			row.raw,
			row.line,
			options.localExternalUserId,
			options.conversations,
		);
		if ("error" in classified) {
			result.ok = false;
			result.errors.push({ line: row.line, message: classified.error });
			continue;
		}
		if ("skip" in classified) {
			result.skipped[classified.skip] += 1;
			continue;
		}
		result.imported += 1;
		conversationIds.add(classified.conversationId);
	}
	result.conversationsTouched = conversationIds.size;
	if (result.errors.length > 0) result.ok = false;
	return result;
}

export async function importDmJsonText(
	db: Database,
	input: string,
	options: {
		account?: string;
		conversations?: Map<string, DmJsonConversationMetadata>;
		dryRun?: boolean;
		logPath?: string;
		conversationsPath?: string;
	},
): Promise<DmJsonImportResult> {
	const run = startScheduledJobRun();
	const { localExternalUserId } = resolveLocalExternalUserId(
		db,
		options.account,
	);
	const split = splitDecryptDocuments(input);
	const result: DmJsonImportResult = {
		ok: split.errors.length === 0,
		imported: 0,
		skipped: emptySkipCounts(),
		conversationsTouched: 0,
		errors: [...split.errors],
	};
	const events: XurlDmEvent[] = [];
	const conversationIds = new Set<string>();

	for (const row of split.rows) {
		const classified = classifyDecryptRow(
			row.raw,
			row.line,
			localExternalUserId,
			options.conversations,
		);
		if ("error" in classified) {
			result.ok = false;
			result.errors.push({ line: row.line, message: classified.error });
			continue;
		}
		if ("skip" in classified) {
			result.skipped[classified.skip] += 1;
			continue;
		}
		events.push(classified.event);
		conversationIds.add(classified.conversationId);
	}
	result.conversationsTouched = conversationIds.size;

	if (options.dryRun) {
		result.imported = events.length;
		if (result.errors.length > 0) result.ok = false;
		return result;
	}

	const existingCount = events.filter((event) =>
		messageExists(db, event.id),
	).length;
	const newCount = events.length - existingCount;

	if (events.length > 0) {
		const payload: XurlDmEventsResponse = { data: events };
		mergeImportedXurlDmEventsIntoLocalStore(db, options.account, payload, {
			conversationInboxKinds: buildInboxKindMap(events, options.conversations),
		});
	}

	result.imported = newCount;
	if (result.errors.length > 0) result.ok = false;

	ensureBirdclawDirs();
	const resolvedLogPath = resolveUserPath(
		options.logPath ?? getDefaultDmJsonImportAuditLogPath(),
	);
	const entry: DmJsonImportAuditEntry = {
		job: "dm-json-import",
		ok: result.ok,
		...run.finish(),
		options: {
			dryRun: false,
			...(options.account ? { account: options.account } : {}),
			...(options.conversationsPath
				? { conversationsPath: options.conversationsPath }
				: {}),
		},
		imported: result.imported,
		skipped: result.skipped,
		conversationsTouched: result.conversationsTouched,
		errors: result.errors.length,
	};
	await appendScheduledJobAudit(resolvedLogPath, entry);

	return result;
}

export async function readDmJsonImportInput(pathValue: string) {
	if (pathValue === "-") {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		return Buffer.concat(chunks).toString("utf8");
	}
	return readFile(pathValue, "utf8");
}

export async function importDmJsonFromPath(
	db: Database,
	pathValue: string,
	options: {
		account?: string;
		conversations?: Map<string, DmJsonConversationMetadata>;
		conversationsPath?: string;
		dryRun?: boolean;
		logPath?: string;
	},
): Promise<DmJsonImportResult> {
	const input = await readDmJsonImportInput(pathValue);
	return importDmJsonText(db, input, options);
}
