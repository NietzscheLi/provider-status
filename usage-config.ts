import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { JsonObject, UsageConfig } from "./types.ts";

export const CONFIG_NAME = "usage-config.yaml";
export const LEGACY_CONFIG_NAME = "balance-config.yaml";
export const LOCK_NAME = "usage-config.lock";
export const MAP_NAME = "provider-usage-map.json";
export const LEGACY_MAP_NAME = "provider-balance-map.json";

/** 内置余额模板名（用户可在 profiles 段自定义同名模板覆盖）。 */
export const BUILTIN_PROFILE_NAMES = ["openrouter"] as const;

const DEFAULT_CONFIG: UsageConfig = { refreshIntervalMinutes: 5, profiles: {}, balances: {}, subscriptions: {} };

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

/** 旧段名 providers/orphanProviders 归一化为 balances/orphanBalances（就地返回新对象）。 */
export function normalizeConfig(raw: unknown): UsageConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${CONFIG_NAME} root must be an object`);
	const value = { ...(raw as UsageConfig) };
	if (value.balances === undefined && value.providers !== undefined) value.balances = value.providers;
	if (value.orphanBalances === undefined && value.orphanProviders !== undefined) value.orphanBalances = value.orphanProviders;
	delete value.providers;
	delete value.orphanProviders;
	if (value.profiles === undefined) value.profiles = {};
	if (value.balances === undefined) value.balances = {};
	if (value.subscriptions === undefined) value.subscriptions = {};
	return value;
}

export function readConfig(agentDir: string): UsageConfig {
	const path = resolveConfigPath(agentDir);
	if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
	return normalizeConfig(parse(readFileSync(path, "utf8"), { merge: true }));
}

export function refreshInterval(config: UsageConfig): number {
	const value = Number(config.refreshIntervalMinutes);
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
