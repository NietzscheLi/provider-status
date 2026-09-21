import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { JsonObject, UsageConfig } from "./types.ts";

export const CONFIG_NAME = "usage-config.yaml";
export const LEGACY_CONFIG_NAME = "balance-config.yaml";
export const LOCK_NAME = "usage-config.lock";
export const MAP_NAME = "provider-usage-map.json";
export const LEGACY_MAP_NAME = "provider-balance-map.json";

/** 内置余额模板名（用户可在 templates 段自定义同名模板覆盖）。 */
export const BUILTIN_TEMPLATE_NAMES = ["openrouter"] as const;

const DEFAULT_CONFIG: UsageConfig = { refreshInterval: 5, templates: {}, balances: {}, subscriptions: {} };

export function configPath(agentDir: string): string {
	return join(agentDir, CONFIG_NAME);
}
export function legacyConfigPath(agentDir: string): string {
	return join(agentDir, LEGACY_CONFIG_NAME);
}
/** 优先新文件；新文件缺失时回退旧文件，实现旧配置的兼容读取。 */
export function resolveConfigPath(agentDir: string): string {
	return existsSync(configPath(agentDir)) ? configPath(agentDir) : legacyConfigPath(agentDir);
}

/**
 * 条目级旧键归一化（就地）：profile → template；顶层 validity → extractor.validity。
 * 返回是否发生了改动，供 Document 迁移判断是否需要写盘。
 */
export function normalizeEntry(entry: JsonObject): boolean {
	let changed = false;
	if (entry.profile !== undefined) {
		if (entry.template === undefined) entry.template = entry.profile;
		delete entry.profile;
		changed = true;
	}
	// 旧版 TUI 把有效性写在条目顶层，运行时其实只读 extractor.validity；合并时以 extractor 为准。
	const validity = entry.validity;
	if (validity && typeof validity === "object" && !Array.isArray(validity)) {
		const extractor = entry.extractor && typeof entry.extractor === "object" && !Array.isArray(entry.extractor)
			? (entry.extractor as JsonObject)
			: (entry.extractor = {});
		const nested = extractor.validity && typeof extractor.validity === "object" && !Array.isArray(extractor.validity)
			? (extractor.validity as JsonObject)
			: undefined;
		extractor.validity = nested ? { ...(validity as JsonObject), ...nested } : validity;
		delete entry.validity;
		changed = true;
	}
	return changed;
}

/** 段名归一化表：旧键 → 新键（新键缺失时搬移，两键并存时合并，新键优先）。 */
const LEGACY_SECTION_KEYS: ReadonlyArray<readonly [string, string]> = [
	["providers", "balances"],
	["profiles", "templates"],
	// orphanBalances 是较新的旧键，先处理才能在与 orphanProviders 并存时胜出。
	["orphanBalances", "orphans"],
	["orphanProviders", "orphans"],
];

/** 旧段名与旧字段名归一化为 templates/balances/orphans + extractor.validity（就地返回新对象）。 */
export function normalizeConfig(raw: unknown): UsageConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${CONFIG_NAME} root must be an object`);
	const value = { ...(raw as UsageConfig) };
	for (const [legacy, current] of LEGACY_SECTION_KEYS) {
		const legacyValue = value[legacy];
		if (legacyValue === undefined) continue;
		const currentValue = value[current];
		value[current] = currentValue && legacyValue && typeof currentValue === "object" && typeof legacyValue === "object"
			? { ...(legacyValue as JsonObject), ...(currentValue as JsonObject) }
			: currentValue ?? legacyValue;
		delete value[legacy];
	}
	if (value.refreshInterval === undefined && value.refreshIntervalMinutes !== undefined) {
		value.refreshInterval = value.refreshIntervalMinutes;
	}
	delete value.refreshIntervalMinutes;
	value.templates ??= {};
	value.balances ??= {};
	value.subscriptions ??= {};
	for (const section of [value.templates, value.balances, value.orphans]) {
		if (!section || typeof section !== "object" || Array.isArray(section)) continue;
		for (const entry of Object.values(section as JsonObject)) {
			if (entry && typeof entry === "object" && !Array.isArray(entry)) normalizeEntry(entry as JsonObject);
		}
	}
	return value;
}

export function readConfig(agentDir: string): UsageConfig {
	const path = resolveConfigPath(agentDir);
	if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
	return normalizeConfig(parse(readFileSync(path, "utf8"), { merge: true }));
}

export function refreshInterval(config: UsageConfig): number {
	const value = Number(config.refreshInterval);
	return Number.isFinite(value) && value >= 1 ? value : 5;
}

export function objectAt(value: unknown, path: string): JsonObject | undefined {
	const result = path ? valueAt(value, path) : value;
	return result && typeof result === "object" && !Array.isArray(result) ? (result as JsonObject) : undefined;
}

export function valueAt(value: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((current, key) => {
		if (current === null || typeof current !== "object") return undefined;
		if (Array.isArray(current)) return /^\d+$/.test(key) ? current[Number(key)] : undefined;
		return (current as JsonObject)[key];
	}, value);
}
