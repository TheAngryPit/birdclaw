import { getBirdclawConfig, type BirdclawConfig } from "./config";

export const BUILTIN_JOB_SCHEDULE_PRESET_NAMES = ["native", "relaxed"] as const;
export type BuiltinJobSchedulePresetName =
	(typeof BUILTIN_JOB_SCHEDULE_PRESET_NAMES)[number];

export interface JobSchedulePresetIntervals {
	accountSyncIntervalSeconds: number;
	bookmarksIntervalSeconds: number;
}

export interface JobSchedulePresetRecord {
	name: string;
	builtin: boolean;
	intervals: JobSchedulePresetIntervals;
}

export type ScheduledLaunchJobKind = "account-sync" | "bookmarks-sync";

const BUILTIN_JOB_SCHEDULE_PRESETS: Record<
	BuiltinJobSchedulePresetName,
	JobSchedulePresetIntervals
> = {
	native: {
		accountSyncIntervalSeconds: 30 * 60,
		bookmarksIntervalSeconds: 3 * 60 * 60,
	},
	relaxed: {
		accountSyncIntervalSeconds: 90 * 60,
		bookmarksIntervalSeconds: 4 * 60 * 60,
	},
};

function isBuiltinPresetName(
	name: string,
): name is BuiltinJobSchedulePresetName {
	return (BUILTIN_JOB_SCHEDULE_PRESET_NAMES as readonly string[]).includes(
		name,
	);
}

function readPositiveInterval(
	value: unknown,
	label: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return value;
}

export function assertUserPresetNamesAllowed(
	presets: Record<string, unknown> | undefined,
) {
	if (!presets) return;
	for (const name of Object.keys(presets)) {
		if (isBuiltinPresetName(name)) {
			throw new Error(
				`jobs.presets.${name} cannot override built-in preset "${name}"`,
			);
		}
	}
}

function readUserJobPresetsFromConfig(
	config: BirdclawConfig = getBirdclawConfig(),
): Record<string, JobSchedulePresetIntervals> {
	const raw = config.jobs?.presets;
	if (!raw || typeof raw !== "object") return {};
	assertUserPresetNamesAllowed(raw as Record<string, unknown>);
	const presets: Record<string, JobSchedulePresetIntervals> = {};
	for (const [name, value] of Object.entries(raw)) {
		if (!value || typeof value !== "object") {
			throw new Error(`jobs.presets.${name} must be an object`);
		}
		const record = value as Record<string, unknown>;
		const accountSyncIntervalSeconds = readPositiveInterval(
			record.accountSyncIntervalSeconds,
			`jobs.presets.${name}.accountSyncIntervalSeconds`,
		);
		const bookmarksIntervalSeconds = readPositiveInterval(
			record.bookmarksIntervalSeconds,
			`jobs.presets.${name}.bookmarksIntervalSeconds`,
		);
		if (
			accountSyncIntervalSeconds === undefined &&
			bookmarksIntervalSeconds === undefined
		) {
			throw new Error(
				`jobs.presets.${name} must set accountSyncIntervalSeconds and/or bookmarksIntervalSeconds`,
			);
		}
		presets[name] = {
			accountSyncIntervalSeconds:
				accountSyncIntervalSeconds ??
				BUILTIN_JOB_SCHEDULE_PRESETS.native.accountSyncIntervalSeconds,
			bookmarksIntervalSeconds:
				bookmarksIntervalSeconds ??
				BUILTIN_JOB_SCHEDULE_PRESETS.native.bookmarksIntervalSeconds,
		};
	}
	return presets;
}

export function listJobSchedulePresets(): JobSchedulePresetRecord[] {
	const userPresets = readUserJobPresetsFromConfig();
	const builtIn = BUILTIN_JOB_SCHEDULE_PRESET_NAMES.map((name) => ({
		name,
		builtin: true,
		intervals: BUILTIN_JOB_SCHEDULE_PRESETS[name],
	}));
	const custom = Object.entries(userPresets)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, intervals]) => ({
			name,
			builtin: false,
			intervals,
		}));
	return [...builtIn, ...custom];
}

export function resolveJobSchedulePreset(
	name: string,
): JobSchedulePresetRecord {
	const trimmed = name.trim();
	if (!trimmed) {
		throw new Error("Preset name must be a non-empty string");
	}
	if (isBuiltinPresetName(trimmed)) {
		return {
			name: trimmed,
			builtin: true,
			intervals: BUILTIN_JOB_SCHEDULE_PRESETS[trimmed],
		};
	}
	const userPresets = readUserJobPresetsFromConfig();
	const intervals = userPresets[trimmed];
	if (!intervals) {
		throw new Error(`Unknown job schedule preset: ${trimmed}`);
	}
	return { name: trimmed, builtin: false, intervals };
}

export function resolveLaunchIntervalSeconds(options: {
	job: ScheduledLaunchJobKind;
	preset?: string;
	explicitIntervalSeconds?: number;
}): number {
	if (options.explicitIntervalSeconds !== undefined) {
		return options.explicitIntervalSeconds;
	}
	if (options.preset?.trim()) {
		const preset = resolveJobSchedulePreset(options.preset);
		return options.job === "account-sync"
			? preset.intervals.accountSyncIntervalSeconds
			: preset.intervals.bookmarksIntervalSeconds;
	}
	return options.job === "account-sync"
		? BUILTIN_JOB_SCHEDULE_PRESETS.native.accountSyncIntervalSeconds
		: BUILTIN_JOB_SCHEDULE_PRESETS.native.bookmarksIntervalSeconds;
}
