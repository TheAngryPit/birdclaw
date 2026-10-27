import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { ensureBirdclawDirs, getBirdclawPaths } from "./config";
import { runEffectPromise, tryPromise, trySync } from "./effect-runtime";
import {
	buildLaunchAgent,
	buildLaunchProgramArguments,
	installLaunchAgentEffect,
	resolveUserPath,
	type LaunchAgentInstallResult,
} from "./launchd";
import { runSubprocessEffect } from "./subprocess";

export const DEFAULT_X_JSON_ISSUES_LAUNCHD_LABEL =
	"com.steipete.birdclaw.x-json-issues";
export const DEFAULT_X_JSON_ISSUES_INTERVAL_SECONDS = 15 * 60;

export interface XJsonIssuesLaunchAgentOptions {
	repo: string;
	authors?: string[];
	ghPath?: string;
	label?: string;
	intervalSeconds?: number;
	program?: string;
	runtime?: string;
	runtimeArgs?: string[];
	logPath?: string;
	envFile?: string;
	stdoutPath?: string;
	stderrPath?: string;
	launchAgentsDir?: string;
	load?: boolean;
}

export interface XJsonIssuesLaunchAgentInstallResult extends LaunchAgentInstallResult {}

export function getDefaultXJsonIssuesStdoutPath() {
	return path.join(getBirdclawPaths().rootDir, "logs", "x-json-issues.out.log");
}

export function getDefaultXJsonIssuesStderrPath() {
	return path.join(getBirdclawPaths().rootDir, "logs", "x-json-issues.err.log");
}

function buildProgramArguments({
	program = "birdclaw",
	runtime,
	runtimeArgs,
	repo,
	authors = [],
	ghPath,
	envFile,
}: XJsonIssuesLaunchAgentOptions) {
	const args = ["--json", "import", "x-json-issues", "--repo", repo];
	for (const author of authors) {
		args.push("--author", author);
	}
	if (ghPath) {
		args.push("--gh", ghPath);
	}
	return buildLaunchProgramArguments({
		program,
		args,
		envFile,
		runtime,
		runtimeArgs,
	});
}

export function buildXJsonIssuesLaunchAgentPlist(
	options: XJsonIssuesLaunchAgentOptions,
) {
	if (!options.repo?.trim()) {
		throw new Error(
			"--repo is required to build the x-json-issues LaunchAgent",
		);
	}
	const label = options.label ?? DEFAULT_X_JSON_ISSUES_LAUNCHD_LABEL;
	const intervalSeconds =
		options.intervalSeconds ?? DEFAULT_X_JSON_ISSUES_INTERVAL_SECONDS;
	const logPath = resolveUserPath(
		options.logPath ??
			path.join(getBirdclawPaths().rootDir, "audit", "x-json-issues.log"),
	);
	const stdoutPath = resolveUserPath(
		options.stdoutPath ?? getDefaultXJsonIssuesStdoutPath(),
	);
	const stderrPath = resolveUserPath(
		options.stderrPath ?? getDefaultXJsonIssuesStderrPath(),
	);
	const programArguments = buildProgramArguments({ ...options, logPath });
	return buildLaunchAgent({
		label,
		intervalSeconds,
		logPath,
		stdoutPath,
		stderrPath,
		programArguments,
		envFile: options.envFile,
	});
}

export function installXJsonIssuesLaunchAgentEffect(
	options: XJsonIssuesLaunchAgentOptions,
): Effect.Effect<XJsonIssuesLaunchAgentInstallResult, unknown> {
	return Effect.gen(function* () {
		yield* trySync(() => ensureBirdclawDirs());
		const agent = yield* trySync(() =>
			buildXJsonIssuesLaunchAgentPlist(options),
		);
		return yield* installLaunchAgentEffect(agent, options);
	});
}

export function installXJsonIssuesLaunchAgent(
	options: XJsonIssuesLaunchAgentOptions,
) {
	return runEffectPromise(installXJsonIssuesLaunchAgentEffect(options));
}

export interface XJsonIssuesLaunchAgentUninstallResult {
	ok: true;
	label: string;
	plistPath: string;
	unloaded: boolean;
	removed: boolean;
}

export function uninstallXJsonIssuesLaunchAgentEffect({
	label = DEFAULT_X_JSON_ISSUES_LAUNCHD_LABEL,
	launchAgentsDir,
}: {
	label?: string;
	launchAgentsDir?: string;
} = {}): Effect.Effect<XJsonIssuesLaunchAgentUninstallResult, unknown> {
	return Effect.gen(function* () {
		const resolvedDir = resolveUserPath(
			launchAgentsDir ?? "~/Library/LaunchAgents",
		);
		const plistPath = path.join(resolvedDir, `${label}.plist`);
		let unloaded = false;
		yield* runSubprocessEffect({
			command: "launchctl",
			args: ["unload", plistPath],
		}).pipe(Effect.catchAll(() => Effect.void));
		unloaded = true;
		let removed = false;
		try {
			yield* tryPromise(() => fs.unlink(plistPath));
			removed = true;
		} catch {
			removed = false;
		}
		return { ok: true, label, plistPath, unloaded, removed };
	});
}

export function uninstallXJsonIssuesLaunchAgent(
	options: { label?: string; launchAgentsDir?: string } = {},
) {
	return runEffectPromise(uninstallXJsonIssuesLaunchAgentEffect(options));
}

export interface XJsonIssuesLaunchAgentStatus {
	label: string;
	plistPath: string;
	plistExists: boolean;
	loaded: boolean;
	domain: string;
}

export function getXJsonIssuesLaunchAgentStatusEffect({
	label = DEFAULT_X_JSON_ISSUES_LAUNCHD_LABEL,
	launchAgentsDir,
}: {
	label?: string;
	launchAgentsDir?: string;
} = {}): Effect.Effect<XJsonIssuesLaunchAgentStatus, unknown> {
	return Effect.gen(function* () {
		const resolvedDir = resolveUserPath(
			launchAgentsDir ?? "~/Library/LaunchAgents",
		);
		const plistPath = path.join(resolvedDir, `${label}.plist`);
		const plistExists = yield* tryPromise(() =>
			fs
				.access(plistPath)
				.then(() => true)
				.catch(() => false),
		);
		const uid = process.getuid?.() ?? os.userInfo().uid;
		const domain = `gui/${String(uid)}/${label}`;
		const loaded = yield* runSubprocessEffect({
			command: "launchctl",
			args: ["print", domain],
			acceptedExitCodes: [0],
		}).pipe(
			Effect.map(() => true),
			Effect.catchAll(() => Effect.succeed(false)),
		);
		return { label, plistPath, plistExists, loaded, domain };
	});
}

export function getXJsonIssuesLaunchAgentStatus(
	options: { label?: string; launchAgentsDir?: string } = {},
) {
	return runEffectPromise(getXJsonIssuesLaunchAgentStatusEffect(options));
}
