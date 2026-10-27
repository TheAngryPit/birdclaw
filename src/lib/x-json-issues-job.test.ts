// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import {
	buildXJsonIssuesLaunchAgentPlist,
	DEFAULT_X_JSON_ISSUES_INTERVAL_SECONDS,
	DEFAULT_X_JSON_ISSUES_LAUNCHD_LABEL,
} from "./x-json-issues-job";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
	resetBirdclawPathsForTests();
});

function makeTempDir(prefix: string) {
	const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(directory);
	return directory;
}

describe("x-json-issues launchd", () => {
	it("builds a plist that honors BIRDCLAW_HOME and repo flags", () => {
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-x-json-issues-home-");
		resetBirdclawPathsForTests();
		const home = process.env.BIRDCLAW_HOME!;
		const agent = buildXJsonIssuesLaunchAgentPlist({
			repo: "synth-org/synth-inbox",
			authors: ["synth_bot_a"],
			ghPath: "/opt/homebrew/bin/gh",
			program: "/opt/homebrew/bin/birdclaw",
			intervalSeconds: DEFAULT_X_JSON_ISSUES_INTERVAL_SECONDS,
		});

		expect(agent.label).toBe(DEFAULT_X_JSON_ISSUES_LAUNCHD_LABEL);
		expect(agent.plist).toContain("<key>BIRDCLAW_HOME</key>");
		expect(agent.plist).toContain(`<string>${home}</string>`);
		expect(agent.plist).toContain("<key>BIRDCLAW_GH_PATH</key>");
		expect(agent.plist).toContain("<string>/opt/homebrew/bin/gh</string>");
		expect(agent.plist).toContain(
			`<integer>${String(DEFAULT_X_JSON_ISSUES_INTERVAL_SECONDS)}</integer>`,
		);
		expect(agent.programArguments).toContain("import");
		expect(agent.programArguments).toContain("x-json-issues");
		expect(agent.programArguments).toContain("synth-org/synth-inbox");
		expect(agent.programArguments).toContain("--author");
		expect(agent.programArguments).toContain("synth_bot_a");
		expect(agent.programArguments).toContain("--gh");
		expect(agent.programArguments).toContain("/opt/homebrew/bin/gh");
		expect(agent.stdoutPath).toContain(process.env.BIRDCLAW_HOME);
	});

	it("requires at least one --author", () => {
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-x-json-issues-home-");
		resetBirdclawPathsForTests();
		expect(() =>
			buildXJsonIssuesLaunchAgentPlist({
				repo: "synth-org/synth-inbox",
				authors: [],
			}),
		).toThrow("--author is required");
	});

	it("validates --repo like the import command", () => {
		process.env.BIRDCLAW_HOME = makeTempDir("birdclaw-x-json-issues-home-");
		resetBirdclawPathsForTests();
		expect(() =>
			buildXJsonIssuesLaunchAgentPlist({
				repo: "not-a-repo",
				authors: ["synth_bot_a"],
			}),
		).toThrow("--repo must be a GitHub repository");
	});
});
