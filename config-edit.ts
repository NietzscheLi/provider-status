// config-edit.ts
//
// balance-config.yaml 的定向（原子级）编辑层。
//
// 与 config-store.ts 的整文件读-改-写不同，这里用 yaml 的 Document API：
// 只对被编辑的条目做 setIn/deleteIn，未触动的条目连同注释、格式、键序一起原样保留；
// 每次编辑都在锁内从磁盘重新解析最新内容后套用改动，因此外部并发修改不会导致失败，
// 最多表现为"编辑面板里的列表显示稍有滞后"（每次动作后列表会重新读取）。

import { Document, YAMLMap, parseDocument, isMap, isNode } from "yaml";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { configPath } from "./config.ts";
import { configFingerprint, withConfigLock } from "./config-store.ts";
import type { JsonObject } from "./types.ts";

export type ConfigSection = "providers" | "profiles" | "orphanProviders";

/**
 * 启动时检测：若 pi 配置目录中缺少 balance-config.yaml，则初始化一份基础配置。
 * 已存在时什么都不做（不覆盖、不补写），也不校验其内容（交由使用时的 readConfig 报错）。
 */
export async function ensureBaseConfigFile(agentDir: string): Promise<void> {
	await withConfigLock(agentDir, () => {
		const path = configPath(agentDir);
		if (existsSync(path)) return;
		const doc = new Document({ refreshIntervalMinutes: 5, profiles: {}, providers: {} });
		doc.commentBefore = " Managed by pi-provider-status. Quarantined orphan entries are preserved in orphanProviders.";
		const tempPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
		writeFileSync(tempPath, `${String(doc)}\n`, { mode: 0o600 });
		renameSync(tempPath, path);
	});
}

/** 在独占锁内对最新文档应用 `edit` 并原子写回；返回是否产生了写入。 */
export async function editConfigDocument(agentDir: string, edit: (doc: Document) => void): Promise<boolean> {
	return withConfigLock(agentDir, () => {
		const path = configPath(agentDir);
		let doc: Document;
		if (existsSync(path)) {
			doc = parseDocument(readFileSync(path, "utf8"), { merge: true });
			if (doc.errors.length > 0) {
				throw new Error(`balance-config.yaml 无法解析，请先手工修复：${doc.errors[0]!.message}`);
			}
			if (!isMap(doc.contents)) {
				throw new Error("balance-config.yaml 顶层必须是映射（key: value 形式）");
			}
		} else {
			doc = new Document({});
			doc.commentBefore = " Managed by pi-provider-status. Quarantined orphan entries are preserved in orphanProviders.";
		}
		const before = String(doc);
		edit(doc);
		const after = String(doc);
		if (after === before) return false;
		const tempPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
		writeFileSync(tempPath, `${after}\n`, { mode: 0o600 });
		renameSync(tempPath, path);
		return true;
	});
}

/** 读取某个配置段的条目（作为普通 JS 值），用于列表显示；文件不存在返回空。 */
export function readSectionEntries(agentDir: string, section: ConfigSection): Record<string, JsonObject> {
	const path = configPath(agentDir);
	if (!existsSync(path)) return {};
	const doc = parseDocument(readFileSync(path, "utf8"), { merge: true });
	if (doc.errors.length > 0) throw new Error(`balance-config.yaml 无法解析：${doc.errors[0]!.message}`);
	const value = doc.getIn([section]);
	if (!isMap(value)) return {};
	const result: Record<string, JsonObject> = {};
	for (const pair of value.items) {
		const key = String(pair.key);
		const entry = pair.value?.toJSON?.();
		if (entry && typeof entry === "object" && !Array.isArray(entry)) result[key] = entry as JsonObject;
	}
	return result;
}

function ensureMap(doc: Document, key: string): void {
	const existing = doc.get(key);
	if (isMap(existing)) return;
	if (existing !== undefined) throw new Error(`balance-config.yaml 的 ${key} 段不是映射，无法安全编辑`);
	// 必须是真 YAMLMap 节点，后续 setIn/deleteIn 才能沿路径生效。
	doc.set(key, new YAMLMap());
}

/** 条目级替换：只触碰 `section.<id>` 这一个节点。 */
export async function upsertEntry(agentDir: string, section: ConfigSection, id: string, entry: JsonObject): Promise<void> {
	await editConfigDocument(agentDir, (doc) => {
		ensureMap(doc, section);
		doc.setIn([section, id], entry);
	});
}

/** 条目级删除：只触碰 `section.<id>` 这一个节点；段变空后顺手移除空段，不留骨架。 */
function deleteSectionIfEmpty(doc: Document, section: ConfigSection): void {
	const value = doc.get(section);
	if (isMap(value) && value.items.length === 0) doc.delete(section);
}

export async function removeEntry(agentDir: string, section: ConfigSection, id: string): Promise<void> {
	await editConfigDocument(agentDir, (doc) => {
		ensureMap(doc, section);
		doc.deleteIn([section, id]);
		deleteSectionIfEmpty(doc, section);
	});
}

/**
 * orphan 恢复：把 `orphanProviders.<id>` 的**原节点**移动到 `providers.<id>`。
 * 节点移动保留了原始的格式与注释；目标已存在时抛错，由调用方提示用户。
 */
export async function restoreOrphanEntry(agentDir: string, id: string): Promise<void> {
	await editConfigDocument(agentDir, (doc) => {
		ensureMap(doc, "orphanProviders");
		const node = doc.getIn(["orphanProviders", id]);
		if (!isNode(node) && node === undefined) throw new Error(`orphanProviders 中不存在 ${id}`);
		ensureMap(doc, "providers");
		if (doc.getIn(["providers", id]) !== undefined) throw new Error(`providers 中已存在 ${id}，无法恢复`);
		doc.setIn(["providers", id], node);
		doc.deleteIn(["orphanProviders", id]);
		deleteSectionIfEmpty(doc, "orphanProviders");
	});
}

/** 校验某个 profile 是否存在于最新文档中（保存前调用）。 */
export function profileExists(agentDir: string, name: string): boolean {
	const path = configPath(agentDir);
	if (!existsSync(path)) return false;
	const doc = parseDocument(readFileSync(path, "utf8"), { merge: true });
	return doc.getIn(["profiles", name]) !== undefined;
}

/**
 * 原始 YAML 兑底编辑的守卫写入：打开编辑器前后指纹一致才落盘，
 * 避免整文件替换静默丢弃编辑期间的并发改动。定向编辑请勿使用此函数。
 */
export async function overwriteConfigFile(agentDir: string, text: string, expectedFingerprint: string | undefined): Promise<void> {
	const doc = parseDocument(text, { merge: true });
	if (doc.errors.length > 0) throw new Error(`YAML 无法解析：${doc.errors[0]!.message}`);
	if (!isMap(doc.contents)) throw new Error("YAML 顶层必须是映射");
	await withConfigLock(agentDir, () => {
		const path = configPath(agentDir);
		if (configFingerprint(agentDir) !== expectedFingerprint) {
			throw new Error("文件在编辑期间被外部修改，未写入；请重新打开编辑器重试");
		}
		const tempPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
		writeFileSync(tempPath, `${text.endsWith("\n") ? text : `${text}\n`}`, { mode: 0o600 });
		renameSync(tempPath, path);
	});
}
