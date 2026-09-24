// usage-edit.ts
//
// usage-config.json 的定向编辑层。
//
// 每次编辑都在配置锁内从磁盘重新解析最新 JSON，只改被编辑的条目后原子写回；
// 列表显示用 readSectionEntries 单独读取，因此外部并发修改不会导致编辑失败。

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { CONFIG_NAME, configPath, normalizeConfig } from "./usage-config.ts";
import { configFingerprint, withConfigLock } from "./usage-store.ts";
import type { JsonObject, UsageConfig } from "./types.ts";

export type ConfigSection = "balances" | "templates" | "subscriptions" | "orphans";

const BASE_CONFIG: UsageConfig = { refreshInterval: 5, templates: {}, balances: {}, subscriptions: {} };

function writeConfigAtomic(agentDir: string, config: UsageConfig): void {
	const path = configPath(agentDir);
	const tempPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	renameSync(tempPath, path);
}

/** 读取磁盘上的最新配置；文件缺失返回基础配置，解析失败抛错（由调用方提示用户）。 */
function readConfigFile(agentDir: string): UsageConfig {
	const path = configPath(agentDir);
	if (!existsSync(path)) return structuredClone(BASE_CONFIG);
	try {
		return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`${CONFIG_NAME} 无法解析，请先手工修复：${reason}`);
	}
}

/** 启动时检测：配置缺失时初始化一份基础配置；已存在时什么都不做。 */
export async function ensureBaseConfigFile(agentDir: string): Promise<void> {
	await withConfigLock(agentDir, () => {
		if (existsSync(configPath(agentDir))) return;
		writeConfigAtomic(agentDir, BASE_CONFIG);
	});
}

/** 在独占锁内对最新配置应用 `edit` 并原子写回；返回是否产生了写入。 */
export async function editConfigDocument(agentDir: string, edit: (config: UsageConfig) => void): Promise<boolean> {
	return withConfigLock(agentDir, () => {
		const before = existsSync(configPath(agentDir)) ? readFileSync(configPath(agentDir), "utf8") : undefined;
		const config = readConfigFile(agentDir);
		edit(config);
		const serialized = `${JSON.stringify(config, null, 2)}\n`;
		if (serialized === before) return false;
		writeConfigAtomic(agentDir, config);
		return true;
	});
}

/** 读取某个配置段的条目（普通 JS 值），用于列表显示；文件不存在返回空。 */
export function readSectionEntries(agentDir: string, section: ConfigSection): Record<string, JsonObject> {
	const value = readConfigFile(agentDir)[section];
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: Record<string, JsonObject> = {};
	for (const [key, entry] of Object.entries(value as JsonObject)) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		result[key] = entry as JsonObject;
	}
	return result;
}

function ensureSection(config: UsageConfig, key: ConfigSection): JsonObject {
	const existing = config[key];
	if (existing && typeof existing === "object" && !Array.isArray(existing)) return existing as JsonObject;
	if (existing !== undefined) throw new Error(`${CONFIG_NAME} 的 ${key} 段不是对象，无法安全编辑`);
	const created: JsonObject = {};
	config[key] = created;
	return created;
}

function deleteSectionIfEmpty(config: UsageConfig, section: ConfigSection): void {
	const value = config[section];
	if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) delete config[section];
}

/** 条目级替换：只触碰 `section.<id>` 这一个键。 */
export async function upsertEntry(agentDir: string, section: ConfigSection, id: string, entry: JsonObject): Promise<void> {
	await editConfigDocument(agentDir, (config) => {
		ensureSection(config, section)[id] = entry;
	});
}

/** 条目级删除：只触碰 `section.<id>` 这一个键；段变空后顺手移除空段，不留骨架。 */
export async function removeEntry(agentDir: string, section: ConfigSection, id: string): Promise<void> {
	await editConfigDocument(agentDir, (config) => {
		delete ensureSection(config, section)[id];
		deleteSectionIfEmpty(config, section);
	});
}

/** orphan 恢复：把 `orphans.<id>` 的值移动回 `balances.<id>`；目标已存在时抛错，由调用方提示用户。 */
export async function restoreOrphanEntry(agentDir: string, id: string): Promise<void> {
	await editConfigDocument(agentDir, (config) => {
		const orphans = ensureSection(config, "orphans");
		if (!(id in orphans)) throw new Error(`orphans 中不存在 ${id}`);
		const balances = ensureSection(config, "balances");
		if (id in balances) throw new Error(`balances 中已存在 ${id}，无法恢复`);
		balances[id] = orphans[id];
		delete orphans[id];
		deleteSectionIfEmpty(config, "orphans");
	});
}

/** 校验某个模板是否存在于最新配置中（保存前调用）。 */
export function templateExists(agentDir: string, name: string): boolean {
	const templates = readConfigFile(agentDir).templates;
	return Boolean(templates && typeof templates === "object" && !Array.isArray(templates) && name in (templates as JsonObject));
}

/**
 * 原始 JSON 兑底编辑的守卫写入：打开编辑器前后指纹一致才落盘，
 * 避免整文件替换静默丢弃编辑期间的并发改动。定向编辑请勿使用此函数。
 */
export async function overwriteConfigFile(agentDir: string, text: string, expectedFingerprint: string | undefined): Promise<void> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`JSON 无法解析：${reason}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON 顶层必须是对象");
	await withConfigLock(agentDir, () => {
		const path = configPath(agentDir);
		if (configFingerprint(agentDir) !== expectedFingerprint) {
			throw new Error("文件在编辑期间被外部修改，未写入；请重新打开编辑器重试");
		}
		const tempPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
		writeFileSync(tempPath, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
		renameSync(tempPath, path);
	});
}
