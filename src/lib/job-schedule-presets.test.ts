// @vitest-environment node
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	assertUserPresetNamesAllowed,
	listJobSchedulePresets,
	resolveJobSchedulePreset,
	resolveLaunchIntervalSeconds,
} from "./job-schedule-presets";
import { buildAccountSyncLaunchAgentPlist } from "./account-sync-job";
import { buildBookmarkSyncLaunchAgentPlist } from "./bookmark-sync-job";
import { resetBirdclawPathsForTests } from "./config";
import { useTestHome } from "../test/test-home";

const testHome = useTestHome({
	prefix: "birdclaw-job-presets-",
	seedDemoData: false,
});

describe("job schedule presets", () => {
	it("lists built-in native and relaxed presets", () => {
		const names = listJobSchedulePresets().map((preset) => preset.name);
		expect(names).toContain("native");
		expect(names).toContain("relaxed");
		const native = resolveJobSchedulePreset("native");
		expect(native.intervals).toEqual({
			accountSyncIntervalSeconds: 1800,
			bookmarksIntervalSeconds: 10800,
		});
		const relaxed = resolveJobSchedulePreset("relaxed");
		expect(relaxed.intervals).toEqual({
			accountSyncIntervalSeconds: 5400,
			bookmarksIntervalSeconds: 14400,
		});
	});

	it("loads user presets from config.json", () => {
		const home = testHome();
		resetBirdclawPathsForTests();
		writeFileSync(
			home.paths.configPath,
			JSON.stringify({
				jobs: {
					presets: {
						evening: {
							accountSyncIntervalSeconds: 7200,
							bookmarksIntervalSeconds: 21600,
						},
					},
				},
			}),
		);
		resetBirdclawPathsForTests();
		expect(resolveJobSchedulePreset("evening").intervals).toEqual({
			accountSyncIntervalSeconds: 7200,
			bookmarksIntervalSeconds: 21600,
		});
	});

	it("errors on unknown preset names", () => {
		expect(() => resolveJobSchedulePreset("missing")).toThrow(
			"Unknown job schedule preset",
		);
	});

	it("rejects user presets that clash with built-in names", () => {
		expect(() =>
			assertUserPresetNamesAllowed({
				native: { accountSyncIntervalSeconds: 60 },
			}),
		).toThrow('cannot override built-in preset "native"');
	});

	it("prefers explicit interval seconds over preset intervals", () => {
		expect(
			resolveLaunchIntervalSeconds({
				job: "account-sync",
				preset: "relaxed",
				explicitIntervalSeconds: 123,
			}),
		).toBe(123);
		expect(
			resolveLaunchIntervalSeconds({
				job: "bookmarks-sync",
				preset: "relaxed",
				explicitIntervalSeconds: 456,
			}),
		).toBe(456);
	});

	it("uses preset intervals when explicit seconds are omitted", () => {
		expect(
			resolveLaunchIntervalSeconds({
				job: "account-sync",
				preset: "relaxed",
			}),
		).toBe(5400);
		expect(
			resolveLaunchIntervalSeconds({
				job: "bookmarks-sync",
				preset: "relaxed",
			}),
		).toBe(14400);
	});

	it("writes launchd StartInterval from preset when interval flag is omitted", () => {
		const accountAgent = buildAccountSyncLaunchAgentPlist({
			preset: "relaxed",
		});
		expect(accountAgent.plist).toContain("<integer>5400</integer>");
		const bookmarkAgent = buildBookmarkSyncLaunchAgentPlist({
			preset: "relaxed",
		});
		expect(bookmarkAgent.plist).toContain("<integer>14400</integer>");
	});
});
