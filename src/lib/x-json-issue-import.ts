import type { Database } from "./sqlite";
import { runSubprocess } from "./subprocess";
import {
	importXJsonText,
	unwrapMarkdownJsonFence,
	validateXJsonText,
	type XJsonImportResult,
} from "./x-json-import";

export const X_JSON_IMPORT_FAILED_LABEL = "import-failed";
export const DEFAULT_GH_ISSUE_LIST_LIMIT = 100;

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface GhIssueLabel {
	name: string;
}

export interface GhIssueAuthor {
	login: string;
}

export interface GhIssue {
	number: number;
	title: string;
	body: string;
	author: GhIssueAuthor;
	labels: GhIssueLabel[];
}

export interface GhIssueRunner {
	listOpenIssues(repo: string): Promise<GhIssue[]>;
	createComment(repo: string, issueNumber: number, body: string): Promise<void>;
	closeIssue(repo: string, issueNumber: number): Promise<void>;
	addLabel(repo: string, issueNumber: number, label: string): Promise<void>;
}

export interface XJsonIssuesImportOptions {
	repo: string;
	allowedAuthors?: readonly string[];
	dryRun?: boolean;
}

export type XJsonIssueAction =
	| "skipped-author"
	| "skipped-failed-label"
	| "dry-run"
	| "imported"
	| "failed";

export interface XJsonIssueImportItem {
	number: number;
	title: string;
	action: XJsonIssueAction;
	result?: XJsonImportResult;
	closed?: boolean;
	commented?: boolean;
	labelled?: boolean;
}

export interface XJsonIssuesImportSummary {
	ok: boolean;
	repo: string;
	dryRun: boolean;
	issues: XJsonIssueImportItem[];
}

export function resolveGhExecutable(explicitPath?: string) {
	const configured =
		explicitPath?.trim() || process.env.BIRDCLAW_GH_PATH?.trim();
	return configured && configured.length > 0 ? configured : "gh";
}

export function parseGithubRepo(repo: string) {
	const trimmed = repo.trim();
	if (!REPO_PATTERN.test(trimmed)) {
		throw new Error(
			"--repo must be a GitHub repository in owner/name form (for example org/inbox)",
		);
	}
	return trimmed;
}

export function resolveImportAuthorPolicy(options: {
	authors?: readonly string[];
	anyAuthor?: boolean;
}) {
	if (options.anyAuthor) {
		return { allowedAuthors: undefined as string[] | undefined };
	}
	const authors = options.authors ?? [];
	if (authors.length === 0) {
		throw new Error(
			"Pass at least one --author or use --any-author to import issues from any opener",
		);
	}
	return { allowedAuthors: [...authors] };
}

export function requireLaunchdAuthors(authors?: readonly string[]) {
	if (!authors || authors.length === 0) {
		throw new Error(
			"--author is required for install-x-json-issues-launchd (repeatable)",
		);
	}
	return [...authors];
}

function normalizeAuthorLogin(login: string) {
	return login.trim().toLowerCase();
}

function isAuthorAllowed(
	login: string,
	allowedAuthors: readonly string[] | undefined,
) {
	if (!allowedAuthors || allowedAuthors.length === 0) return true;
	const normalized = normalizeAuthorLogin(login);
	return allowedAuthors.some(
		(candidate) => normalizeAuthorLogin(candidate) === normalized,
	);
}

function issueHasFailedLabel(issue: GhIssue) {
	return issue.labels.some(
		(label) => label.name === X_JSON_IMPORT_FAILED_LABEL,
	);
}

function formatImportComment(result: XJsonImportResult) {
	return JSON.stringify(result, null, 2);
}

function importIssueBody(
	db: Database | null,
	body: string,
	dryRun: boolean,
): XJsonImportResult {
	const payload = unwrapMarkdownJsonFence(body);
	if (dryRun) return validateXJsonText(payload);
	if (!db) {
		throw new Error("database is required for non-dry-run x-json issue import");
	}
	return importXJsonText(db, payload);
}

export async function importXJsonIssuesEffect(
	db: Database | null,
	options: XJsonIssuesImportOptions,
	gh: GhIssueRunner,
): Promise<XJsonIssuesImportSummary> {
	const repo = parseGithubRepo(options.repo);
	const dryRun = Boolean(options.dryRun);
	const issues: XJsonIssueImportItem[] = [];
	let ok = true;

	for (const issue of await gh.listOpenIssues(repo)) {
		if (issueHasFailedLabel(issue)) {
			issues.push({
				number: issue.number,
				title: issue.title,
				action: "skipped-failed-label",
			});
			continue;
		}
		if (!isAuthorAllowed(issue.author.login, options.allowedAuthors)) {
			issues.push({
				number: issue.number,
				title: issue.title,
				action: "skipped-author",
			});
			continue;
		}

		const result = importIssueBody(db, issue.body, dryRun);
		const hasErrors = result.errors.length > 0;
		if (hasErrors) ok = false;

		const item: XJsonIssueImportItem = {
			number: issue.number,
			title: issue.title,
			action: dryRun ? "dry-run" : hasErrors ? "failed" : "imported",
			result,
		};

		if (!dryRun) {
			const comment = formatImportComment(result);
			await gh.createComment(repo, issue.number, comment);
			item.commented = true;
			if (hasErrors) {
				await gh.addLabel(repo, issue.number, X_JSON_IMPORT_FAILED_LABEL);
				item.labelled = true;
			} else {
				await gh.closeIssue(repo, issue.number);
				item.closed = true;
			}
		}

		issues.push(item);
	}

	return { ok, repo, dryRun, issues };
}

export function createGhIssueRunner(
	ghPath?: string,
	options: { limit?: number } = {},
): GhIssueRunner {
	const resolvedGh = resolveGhExecutable(ghPath);
	const limit = options.limit ?? DEFAULT_GH_ISSUE_LIST_LIMIT;

	async function runGhJson(args: readonly string[]) {
		const result = await runSubprocess({
			command: resolvedGh,
			args,
			maxBufferBytes: 16 * 1024 * 1024,
		});
		const stdout = result.stdout.trim();
		if (!stdout) return [];
		return JSON.parse(stdout) as unknown;
	}

	return {
		async listOpenIssues(repo) {
			const parsed = await runGhJson([
				"issue",
				"list",
				"--repo",
				repo,
				"--state",
				"open",
				"--limit",
				String(limit),
				"--json",
				"number,title,body,author,labels",
			]);
			if (!Array.isArray(parsed)) {
				throw new Error("gh issue list returned unexpected JSON");
			}
			return parsed as GhIssue[];
		},
		async createComment(repo, issueNumber, body) {
			await runSubprocess({
				command: resolvedGh,
				args: [
					"issue",
					"comment",
					String(issueNumber),
					"--repo",
					repo,
					"--body",
					body,
				],
			});
		},
		async closeIssue(repo, issueNumber) {
			await runSubprocess({
				command: resolvedGh,
				args: ["issue", "close", String(issueNumber), "--repo", repo],
			});
		},
		async addLabel(repo, issueNumber, label) {
			await runSubprocess({
				command: resolvedGh,
				args: [
					"issue",
					"edit",
					String(issueNumber),
					"--repo",
					repo,
					"--add-label",
					label,
				],
			});
		},
	};
}
