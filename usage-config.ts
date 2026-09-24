import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject, UsageConfig } from "./types.ts";

export const CONFIG_NAME = "usage-config.json";
export const LOCK_NAME = "usage-config.lock";
export const MAP_NAME = "provider-usage-map.json";

/** 内置余额模板名（用户可在 templates 段自定义同名模板覆盖）。 */
export const BUILTIN_TEMPLATE_NAMES = ["openrouter"] as const;

const DEFAULT_CONFIG: UsageConfig = { refreshInterval: 5, templates: {}, balances: {}, subscriptions: {} };

export function configPath(agentDir: string): string {
	return join(agentDir, CONFIG_NAME);
}

/** 读取侧归一化：顶层必须是对象，补齐三个配置段（返回新对象）。 */
export function normalizeConfig(raw: unknown): UsageConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${CONFIG_NAME} root must be an object`);
	const value = { ...(raw as UsageConfig) };
	value.templates ??= {};
	value.balances ??= {};
	value.subscriptions ??= {};
	return value;
}

export function readConfig(agentDir: string): UsageConfig {
	const path = configPath(agentDir);
	if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
	return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function refreshInterval(config: UsageConfig): number {
	const value = Number(config.refreshInterval);
	return Number.isFinite(value) && value >= 1 ? value : 5;
}

/** 缓存预热否决阈值：订阅窗口已用百分比达到该值即拒绝预热。默认 95，可用 cacheWarmingStopPercent 覆盖。 */
export function cacheWarmingStopPercent(config: UsageConfig): number {
	const value = Number(config.cacheWarmingStopPercent);
	return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 95;
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
