import {
	installAccountSyncLaunchAgent,
	parseAccountSyncSteps,
	runAccountSyncJob,
} from "#/lib/account-sync-job";
import {
	installBookmarkSyncLaunchAgent,
	runBookmarkSyncJob,
} from "#/lib/bookmark-sync-job";
import {
	buildXJsonIssuesLaunchAgentPlist,
	getXJsonIssuesLaunchAgentStatus,
	installXJsonIssuesLaunchAgent,
	uninstallXJsonIssuesLaunchAgent,
} from "#/lib/x-json-issues-job";
import {
	listJobSchedulePresets,
	resolveJobSchedulePreset,
} from "#/lib/job-schedule-presets";
import type { TimelineCollectionMode } from "#/lib/timeline-collections-live";
import type { CliCommandContext } from "./command-context";

function collectRuntimeArg(value: string, previous: string[]) {
	return [...previous, value];
}

function collectAuthorLogin(login: string, previous: string[]) {
	return [...previous, login];
}

export function registerJobCommands({
	program,
	print,
	parsePositiveLimitOption,
}: CliCommandContext) {
	const jobsCommand = program
		.command("jobs")
		.description("Run and install background Birdclaw jobs");

	const presetsCommand = jobsCommand
		.command("presets")
		.description("List built-in and config job schedule presets");

	presetsCommand
		.command("list")
		.description("List schedule preset names and intervals")
		.action(() => {
			print(listJobSchedulePresets(), true);
		});

	presetsCommand
		.command("show <name>")
		.description("Show one schedule preset")
		.action((name: string) => {
			print(resolveJobSchedulePreset(name), true);
		});

	jobsCommand
		.command("sync-account")
		.description(
			"Refresh live account timelines and append a JSONL audit entry",
		)
		.option("--account <username>", "Account username or id")
		.option(
			"--steps <steps>",
			"Comma list: timeline,mentions,mention-threads,likes,bookmarks,dms",
		)
		.option(
			"--mode <mode>",
			"auto, xurl, or bird; mention threads use xurl",
			"auto",
		)
		.option("--limit <n>", "Per-page/result limit", "100")
		.option("--max-pages <n>", "Stop after N pages", "3")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.option("--refresh", "Bypass live-cache freshness window")
		.option(
			"--allow-bird-account",
			"Assert bird cookies match --account for Bird-backed steps",
		)
		.option("--log <path>", "Audit JSONL path")
		.action(async (options) => {
			const result = await runAccountSyncJob({
				account: options.account,
				steps: parseAccountSyncSteps(options.steps),
				mode: options.mode as TimelineCollectionMode,
				limit: Number(options.limit),
				maxPages: Number(options.maxPages),
				refresh: Boolean(options.refresh),
				cacheTtlMs: Number(options.cacheTtl) * 1000,
				allowBirdAccount: Boolean(options.allowBirdAccount),
				logPath: options.log,
			});
			print(result, true);
			if (!result.ok) process.exitCode = 1;
		});

	jobsCommand
		.command("install-account-launchd")
		.description("Install a LaunchAgent that runs account sync")
		.option("--label <label>", "LaunchAgent label")
		.option(
			"--interval-seconds <seconds>",
			"Launch interval (overrides --preset)",
		)
		.option(
			"--program <path>",
			"birdclaw executable or source entry",
			"birdclaw",
		)
		.option("--runtime <absolute-path>", "Runtime executable for --program")
		.option(
			"--runtime-arg <value>",
			"Repeatable runtime argument (for example --runtime-arg=--no-env-file)",
			collectRuntimeArg,
			[],
		)
		.option("--account <username>", "Account username or id")
		.option(
			"--steps <steps>",
			"Comma list: timeline,mentions,mention-threads,likes,bookmarks,dms",
		)
		.option(
			"--mode <mode>",
			"auto, xurl, or bird; mention threads use xurl",
			"auto",
		)
		.option("--limit <n>", "Per-page/result limit", "100")
		.option("--max-pages <n>", "Stop after N pages", "3")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.option("--no-refresh", "Allow live-cache reuse")
		.option(
			"--allow-bird-account",
			"Assert bird cookies match --account for Bird-backed steps",
		)
		.option("--log <path>", "Audit JSONL path")
		.option(
			"--preset <name>",
			"Built-in or config schedule preset (native, relaxed, or jobs.presets.*)",
		)
		.option("--env-path <path>", "Shell env file to source before running")
		.option("--env-file <path>", "Deprecated alias for --env-path")
		.option("--stdout <path>", "launchd stdout path")
		.option("--stderr <path>", "launchd stderr path")
		.option("--launch-agents-dir <path>", "LaunchAgents directory")
		.option("--no-load", "Write plist without loading it")
		.action(async (options) => {
			const intervalSeconds = options.intervalSeconds
				? parsePositiveLimitOption(
						options.intervalSeconds,
						"--interval-seconds",
					)
				: undefined;

			const result = await installAccountSyncLaunchAgent({
				label: options.label,
				intervalSeconds,
				preset: options.preset,
				program: options.program,
				runtime: options.runtime,
				runtimeArgs: options.runtimeArg,
				account: options.account,
				steps: parseAccountSyncSteps(options.steps),
				mode: options.mode as TimelineCollectionMode,
				limit: Number(options.limit),
				maxPages: Number(options.maxPages),
				refresh: options.refresh,
				allowBirdAccount: Boolean(options.allowBirdAccount),
				cacheTtlSeconds: Number(options.cacheTtl),
				logPath: options.log,
				envFile: options.envPath ?? options.envFile,
				stdoutPath: options.stdout,
				stderrPath: options.stderr,
				launchAgentsDir: options.launchAgentsDir,
				load: options.load,
			});
			print(result, true);
		});

	jobsCommand
		.command("sync-bookmarks")
		.description("Refresh live bookmarks and append a JSONL audit entry")
		.option("--account <username>", "Account username or id")
		.option("--mode <mode>", "auto, xurl, or bird", "auto")
		.option("--limit <n>", "Per-page/result limit", "100")
		.option("--all", "Fetch every retrievable page")
		.option("--max-pages <n>", "Stop after N pages", "5")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.option("--refresh", "Bypass live-cache freshness window")
		.option("--log <path>", "Audit JSONL path")
		.action(async (options) => {
			const result = await runBookmarkSyncJob({
				account: options.account,
				mode: options.mode as TimelineCollectionMode,
				limit: Number(options.limit),
				all: Boolean(options.all) || options.maxPages !== undefined,
				maxPages: options.all ? undefined : Number(options.maxPages),
				refresh: Boolean(options.refresh),
				cacheTtlMs: Number(options.cacheTtl) * 1000,
				logPath: options.log,
			});
			print(result, true);
			if (!result.ok) process.exitCode = 1;
		});

	jobsCommand
		.command("install-bookmarks-launchd")
		.description("Install a LaunchAgent that runs bookmark sync every 3 hours")
		.option("--account <username>", "Account username or id")
		.option("--label <label>", "LaunchAgent label")
		.option(
			"--interval-seconds <seconds>",
			"Launch interval (overrides --preset)",
		)
		.option(
			"--program <path>",
			"birdclaw executable or source entry",
			"birdclaw",
		)
		.option("--runtime <absolute-path>", "Runtime executable for --program")
		.option(
			"--runtime-arg <value>",
			"Repeatable runtime argument (for example --runtime-arg=--no-env-file)",
			collectRuntimeArg,
			[],
		)
		.option("--mode <mode>", "auto, xurl, or bird", "auto")
		.option("--limit <n>", "Per-page/result limit", "100")
		.option("--all", "Fetch every retrievable page")
		.option("--max-pages <n>", "Stop after N pages", "5")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.option("--no-refresh", "Allow live-cache reuse")
		.option("--log <path>", "Audit JSONL path")
		.option(
			"--preset <name>",
			"Built-in or config schedule preset (native, relaxed, or jobs.presets.*)",
		)
		.option("--env-path <path>", "Shell env file to source before running")
		.option("--env-file <path>", "Deprecated alias for --env-path")
		.option("--stdout <path>", "launchd stdout path")
		.option("--stderr <path>", "launchd stderr path")
		.option("--launch-agents-dir <path>", "LaunchAgents directory")
		.option("--no-load", "Write plist without loading it")
		.action(async (options) => {
			const intervalSeconds = options.intervalSeconds
				? parsePositiveLimitOption(
						options.intervalSeconds,
						"--interval-seconds",
					)
				: undefined;

			const result = await installBookmarkSyncLaunchAgent({
				account: options.account,
				label: options.label,
				intervalSeconds,
				preset: options.preset,
				program: options.program,
				runtime: options.runtime,
				runtimeArgs: options.runtimeArg,
				mode: options.mode as TimelineCollectionMode,
				limit: Number(options.limit),
				all: Boolean(options.all) || options.maxPages !== undefined,
				maxPages: options.all ? undefined : Number(options.maxPages),
				refresh: options.refresh,
				cacheTtlSeconds: Number(options.cacheTtl),
				logPath: options.log,
				envFile: options.envPath ?? options.envFile,
				stdoutPath: options.stdout,
				stderrPath: options.stderr,
				launchAgentsDir: options.launchAgentsDir,
				load: options.load,
			});
			print(result, true);
		});

	jobsCommand
		.command("install-x-json-issues-launchd")
		.description(
			"Install a LaunchAgent that imports Grok Bot JSON from GitHub issues",
		)
		.requiredOption("--repo <repo>", "GitHub inbox repository (owner/name)")
		.option(
			"--author <login>",
			"Only import issues opened by this GitHub login (repeatable)",
			collectAuthorLogin,
			[],
		)
		.option(
			"--gh <path>",
			"gh executable passed to birdclaw import x-json-issues",
		)
		.option("--label <label>", "LaunchAgent label")
		.option("--interval-seconds <seconds>", "Launch interval", String(15 * 60))
		.option(
			"--program <path>",
			"birdclaw executable or source entry",
			"birdclaw",
		)
		.option("--runtime <absolute-path>", "Runtime executable for --program")
		.option(
			"--runtime-arg <value>",
			"Repeatable runtime argument (for example --runtime-arg=--no-env-file)",
			collectRuntimeArg,
			[],
		)
		.option("--env-path <path>", "Shell env file to source before running")
		.option("--env-file <path>", "Deprecated alias for --env-path")
		.option("--stdout <path>", "launchd stdout path")
		.option("--stderr <path>", "launchd stderr path")
		.option("--launch-agents-dir <path>", "LaunchAgents directory")
		.option("--no-load", "Write plist without loading it")
		.option("--print-plist", "Print the LaunchAgent plist and exit")
		.action(async (options) => {
			const intervalSeconds = parsePositiveLimitOption(
				options.intervalSeconds,
				"--interval-seconds",
			);
			const launchOptions = {
				repo: options.repo,
				authors: options.author,
				ghPath: options.gh,
				label: options.label,
				intervalSeconds,
				program: options.program,
				runtime: options.runtime,
				runtimeArgs: options.runtimeArg,
				envFile: options.envPath ?? options.envFile,
				stdoutPath: options.stdout,
				stderrPath: options.stderr,
				launchAgentsDir: options.launchAgentsDir,
				load: options.load,
			};
			if (options.printPlist) {
				const agent = buildXJsonIssuesLaunchAgentPlist(launchOptions);
				print(agent.plist, false);
				return;
			}
			const result = await installXJsonIssuesLaunchAgent(launchOptions);
			print(result, true);
		});

	jobsCommand
		.command("uninstall-x-json-issues-launchd")
		.description("Unload and remove the x-json-issues LaunchAgent plist")
		.option("--label <label>", "LaunchAgent label")
		.option("--launch-agents-dir <path>", "LaunchAgents directory")
		.action(async (options) => {
			const result = await uninstallXJsonIssuesLaunchAgent({
				label: options.label,
				launchAgentsDir: options.launchAgentsDir,
			});
			print(result, true);
		});

	jobsCommand
		.command("x-json-issues-launchd-status")
		.description(
			"Report whether the x-json-issues LaunchAgent plist is installed",
		)
		.option("--label <label>", "LaunchAgent label")
		.option("--launch-agents-dir <path>", "LaunchAgents directory")
		.action(async (options) => {
			const result = await getXJsonIssuesLaunchAgentStatus({
				label: options.label,
				launchAgentsDir: options.launchAgentsDir,
			});
			print(result, true);
		});
}
