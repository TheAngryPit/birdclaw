// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCliMain } from "../cli";
import { resetBirdclawPathsForTests } from "./config";
import { runEffectPromise } from "./effect-runtime";
import {
	createGhIssueRunner,
	importXJsonIssuesEffect,
	requireLaunchdAuthors,
	resolveImportAuthorPolicy,
	type GhIssue,
	type GhIssueRunner,
} from "./x-json-issue-import";
import { uninstallXJsonIssuesLaunchAgentEffect } from "./x-json-issues-job";

const runSubprocessMock = vi.hoisted(() => vi.fn());
const runSubprocessEffectMock = vi.hoisted(() => vi.fn());

vi.mock("./subprocess", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./subprocess")>();
	return {
		...actual,
		runSubprocess: runSubprocessMock,
		runSubprocessEffect: runSubprocessEffectMock,
	};
});

const tempDirs: string[] = [];

afterEach(() => {
	runSubprocessMock.mockReset();
	runSubprocessEffectMock.mockReset();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
	resetBirdclawPathsForTests();
	vi.unstubAllEnvs();
});

function makeHome() {
	const home = mkdtempSync(path.join(os.tmpdir(), "birdclaw-hardening-"));
	tempDirs.push(home);
	process.env.BIRDCLAW_HOME = home;
	resetBirdclawPathsForTests();
	return home;
}

class EmptyGhRunner implements GhIssueRunner {
	async listOpenIssues() {
		return [] as GhIssue[];
	}
	async createComment() {}
	async closeIssue() {}
	async addLabel() {}
}

describe("x-json issue import hardening", () => {
	it("requires --author or --any-author for one-shot imports", () => {
		expect(() => resolveImportAuthorPolicy({ authors: [] })).toThrow(
			"--any-author",
		);
		expect(resolveImportAuthorPolicy({ anyAuthor: true })).toEqual({
			allowedAuthors: undefined,
		});
		expect(
			resolveImportAuthorPolicy({ authors: ["synth_bot_a"] }).allowedAuthors,
		).toEqual(["synth_bot_a"]);
	});

	it("requires --author for launchd install", () => {
		expect(() => requireLaunchdAuthors([])).toThrow("--author is required");
	});

	it("passes --limit to gh issue list", async () => {
		runSubprocessMock.mockResolvedValue({
			stdout: "[]",
			stderr: "",
			exitCode: 0,
		});
		const runner = createGhIssueRunner("/opt/homebrew/bin/gh", { limit: 42 });
		await runner.listOpenIssues("synth-org/synth-inbox");
		expect(runSubprocessMock).toHaveBeenCalledWith({
			command: "/opt/homebrew/bin/gh",
			args: expect.arrayContaining(["issue", "list", "--limit", "42"]),
			maxBufferBytes: 16 * 1024 * 1024,
		});
	});

	it("dry-run does not create a database in an uninitialized home", async () => {
		const home = makeHome();
		await importXJsonIssuesEffect(
			null,
			{ repo: "synth-org/synth-inbox", dryRun: true },
			new EmptyGhRunner(),
		);
		expect(existsSync(path.join(home, "birdclaw.sqlite"))).toBe(false);
	});

	it("dry-run CLI does not create a database in an uninitialized home", async () => {
		const home = makeHome();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await runCliMain([
			"node",
			"birdclaw",
			"import",
			"x-json-issues",
			"--repo",
			"synth-org/synth-inbox",
			"--any-author",
			"--dry-run",
			"--json",
		]);
		log.mockRestore();
		expect(existsSync(path.join(home, "birdclaw.sqlite"))).toBe(false);
	});

	it("reports launchctl unload truthfully", async () => {
		runSubprocessEffectMock.mockReturnValue(Effect.succeed({}));
		const unloaded = await runEffectPromise(
			uninstallXJsonIssuesLaunchAgentEffect({
				launchAgentsDir: makeHome(),
				label: "com.example.test",
			}),
		);
		expect(unloaded.unloaded).toBe(true);

		runSubprocessEffectMock.mockReturnValue(
			Effect.fail(new Error("not loaded")),
		);
		const failed = await runEffectPromise(
			uninstallXJsonIssuesLaunchAgentEffect({
				launchAgentsDir: makeHome(),
				label: "com.example.test",
			}),
		);
		expect(failed.unloaded).toBe(false);
	});
});
