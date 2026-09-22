// usage-edit.ts
//
// usage-config.yaml 的定向（原子级）编辑层。
//
// 与 usage-store.ts 的整文件读-改-写不同，这里用 yaml 的 Document API：
// 只对被编辑的条目做 setIn/deleteIn，未触动的条目连同注释、格式、键序一起原样保留；
// 每次编辑都在锁内从磁盘重新解析最新内容后套用改动，因此外部并发修改不会导致失败，
// 最多表现为"编辑面板里的列表显示稍有滞后"（每次动作后列表会重新读取）。

import { Document, Scalar, YAMLMap, parseDocument, isMap, isNode } from "yaml";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { LEGACY_CONFIG_NAME, configPath, legacyConfigPath, normalizeEntry } from "./usage-config.ts";
import { configFingerprint, withConfigLock } from "./usage-store.ts";
import type { JsonObject } from "./types.ts";

export type ConfigSection = "balances" | "templates" | "subscriptions" | "orphans";

/** 旧段名 → 新段名；同一份文档里新旧并存时合并，新段优先（orphanBalances 是较新的旧键，先处理）。 */
const LEGACY_SECTION_RENAMES: ReadonlyArray<readonly [string, ConfigSection]> = [
	["providers", "balances"],
	["profiles", "templates"],
	["orphanBalances", "orphans"],
	["orphanProviders", "orphans"],
];

/** 就地重命名映射键，保留键前的空行、注释与键序。 */
function renameMapKey(map: YAMLMap, from: string, to: string): boolean {
	const pair = map.items.find((candidate) => String(candidate.key) === from);
	if (!pair) return false;
	const oldKey = pair.key;
	const newKey = new Scalar(to);
	pair.key = newKey;
	// 键前空行与注释挂在旧键节点上；不复制就会在重命名时丢掉。
	if (oldKey instanceof Scalar) {
		if (oldKey.spaceBefore) newKey.spaceBefore = true;
		if (oldKey.commentBefore) newKey.commentBefore = oldKey.commentBefore;
	}
	return true;
}

/** 条目级旧键迁移（就地，保留注释）：profile → template；顶层 validity → extractor.validity。 */
function normalizeEntryNode(value: unknown): boolean {
	if (!isMap(value)) return false;
	let changed = renameMapKey(value, "profile", "template");
	const validityPair = value.items.find((pair) => String(pair.key) === "validity");
	// 非映射的顶层 validity 是手写的无效值，不动用户数据。
	if (!validityPair || !isMap(validityPair.value)) return changed;
	const existing = value.get("extractor");
	let extractor: YAMLMap;
	if (isMap(existing)) {
		extractor = existing;
	} else {
		// 已有非法 extractor 值时替换其值，避免写出重复 key。
		const existingPair = value.items.find((pair) => String(pair.key) === "extractor");
		extractor = new YAMLMap();
		if (existingPair) existingPair.value = extractor;
		else value.add({ key: new Scalar("extractor"), value: extractor });
	}
	const nested = extractor.get("validity");
	if (isMap(nested)) {
		// extractor.validity 是运行时真正读取的位置；只补进顶层里缺少的键。
		for (const pair of validityPair.value.items) {
			if (nested.has(String(pair.key))) continue;
			nested.add(pair);
		}
	} else {
		extractor.add(validityPair);
	}
	value.items = value.items.filter((pair) => pair !== validityPair);
	return true;
}

/**
 * 旧键迁移（幂等，就地）：段名 providers/profiles/orphanBalances/orphanProviders、
 * refreshIntervalMinutes、条目级 profile 与顶层 validity。返回是否发生了改动。
 */
export function normalizeDocument(doc: Document): boolean {
	if (!isMap(doc.contents)) return false;
	const root = doc.contents;
	let changed = renameMapKey(root, "refreshIntervalMinutes", "refreshInterval");
	for (const [legacy, current] of LEGACY_SECTION_RENAMES) {
		const legacySection = root.get(legacy);
		if (legacySection === undefined) continue;
		const currentSection = root.get(current);
		if (currentSection === undefined) {
			renameMapKey(root, legacy, current);
			changed = true;
			continue;
		}
		// 旧段不是映射（无条目可合并），直接移除。
		if (!isMap(legacySection)) {
			root.delete(legacy);
			changed = true;
			continue;
		}
		// 新段被占用成非映射：不做破坏性合并，留给读取/编辑路径报错。
		if (!isMap(currentSection)) continue;
		for (const pair of legacySection.items) {
			if (currentSection.has(String(pair.key))) continue;
			currentSection.add(pair);
		}
		root.delete(legacy);
		changed = true;
	}
	for (const section of ["templates", "balances", "orphans"] as const) {
		const value = root.get(section);
		if (!isMap(value)) continue;
		for (const pair of value.items) {
			if (normalizeEntryNode(pair.value)) changed = true;
		}
	}
	return changed;
}

function baseDocument(): Document {
	const doc = new Document({ refreshInterval: 5, templates: {}, balances: {}, subscriptions: {} });
	doc.commentBefore = " Managed by pi-provider-status. Quarantined orphan entries are preserved in orphans.";
	return doc;
}

function writeDocument(agentDir: string, doc: Document): void {
	const path = configPath(agentDir);
	const tempPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	writeFileSync(tempPath, `${String(doc)}\n`, { mode: 0o600 });
	renameSync(tempPath, path);
}

/**
 * 旧 balance-config.yaml → 新 usage-config.yaml 的一次性迁移：
 * 旧文件存在且新文件缺失时，按当前键名（providers→balances、profiles→templates、
 * orphan*→orphans 等）归一化后写入新文件；旧文件保留不删（回滚安全），后续读取以新文件为准。
 */
export function migrateLegacyConfig(agentDir: string): boolean {
	const legacyPath = legacyConfigPath(agentDir);
	if (existsSync(configPath(agentDir)) || !existsSync(legacyPath)) return false;
	const doc = parseDocument(readFileSync(legacyPath, "utf8"), { merge: true });
	if (doc.errors.length > 0 || !isMap(doc.contents)) return false;
	doc.commentBefore = " Managed by pi-provider-status. Migrated from balance-config.yaml; quarantined orphan entries are preserved in orphans.";
	// 直接在旧文档上做键迁移，注释与键序随节点一起保留。
	normalizeDocument(doc);
	if (doc.get("balances") === undefined) doc.set("balances", new YAMLMap());
	if (doc.get("subscriptions") === undefined) doc.set("subscriptions", new YAMLMap());
	writeDocument(agentDir, doc);
	return true;
}

/** 已存在的新文件里残留旧键时，在锁内做一次迁移写回；解析失败则原样保留。 */
function migrateConfigKeys(agentDir: string): boolean {
	const path = configPath(agentDir);
	const doc = parseDocument(readFileSync(path, "utf8"), { merge: true });
	if (doc.errors.length > 0 || !isMap(doc.contents)) return false;
	if (!normalizeDocument(doc)) return false;
	writeDocument(agentDir, doc);
	return true;
}

/**
 * 启动时检测：若 pi 配置目录中既没有新文件也没有旧文件，则初始化一份基础配置。
 * 旧文件存在时执行一次性迁移；新文件里残留旧键时迁移到当前键名（保留注释），其余情况不覆盖。
 */
export async function ensureBaseConfigFile(agentDir: string): Promise<void> {
	await withConfigLock(agentDir, () => {
		if (migrateLegacyConfig(agentDir)) return;
		if (!existsSync(configPath(agentDir))) {
			writeDocument(agentDir, baseDocument());
			return;
		}
		migrateConfigKeys(agentDir);
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
				throw new Error(`usage-config.yaml 无法解析，请先手工修复：${doc.errors[0]!.message}`);
			}
			if (!isMap(doc.contents)) {
				throw new Error("usage-config.yaml 顶层必须是映射（key: value 形式）");
			}
		} else {
			doc = new Document({});
			doc.commentBefore = " Managed by pi-provider-status. Quarantined orphan entries are preserved in orphans.";
		}
		const before = String(doc);
		// 旧键迁移优先：即使本次编辑本身不产生差异，也要把文档落成新键。
		normalizeDocument(doc);
		edit(doc);
		const after = String(doc);
		if (after === before) return false;
		writeDocument(agentDir, doc);
		return true;
	});
}

/** 读取某个配置段的条目（作为普通 JS 值），用于列表显示；文件不存在返回空。 */
export function readSectionEntries(agentDir: string, section: ConfigSection): Record<string, JsonObject> {
	const path = configPath(agentDir);
	if (!existsSync(path)) return {};
	const doc = parseDocument(readFileSync(path, "utf8"), { merge: true });
	if (doc.errors.length > 0) throw new Error(`usage-config.yaml 无法解析：${doc.errors[0]!.message}`);
	const value = doc.getIn([section]);
	if (!isMap(value)) return {};
	const result: Record<string, JsonObject> = {};
	for (const pair of value.items) {
		const key = String(pair.key);
		const node = pair.value;
		const entry = isNode(node) ? node.toJSON() : node;
		if (entry && typeof entry === "object" && !Array.isArray(entry)) {
			// 旧键在读取侧也做一次归一化：迁移写盘失败时列表与编辑器仍按新键工作。
			normalizeEntry(entry as JsonObject);
			result[key] = entry as JsonObject;
		}
	}
	return result;
}

function ensureMap(doc: Document, key: string): void {
	const existing = doc.get(key);
	if (isMap(existing)) return;
	if (existing !== undefined) throw new Error(`usage-config.yaml 的 ${key} 段不是映射，无法安全编辑`);
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
 * orphan 恢复：把 `orphans.<id>` 的**原节点**移动到 `balances.<id>`。
 * 节点移动保留了原始的格式与注释；目标已存在时抛错，由调用方提示用户。
 */
export async function restoreOrphanEntry(agentDir: string, id: string): Promise<void> {
	await editConfigDocument(agentDir, (doc) => {
		ensureMap(doc, "orphans");
		const node = doc.getIn(["orphans", id]);
		if (!isNode(node) && node === undefined) throw new Error(`orphans 中不存在 ${id}`);
		ensureMap(doc, "balances");
		if (doc.getIn(["balances", id]) !== undefined) throw new Error(`balances 中已存在 ${id}，无法恢复`);
		doc.setIn(["balances", id], node);
		doc.deleteIn(["orphans", id]);
		deleteSectionIfEmpty(doc, "orphans");
	});
}

/** 校验某个模板是否存在于最新文档中（保存前调用）。 */
export function templateExists(agentDir: string, name: string): boolean {
	const path = configPath(agentDir);
	if (!existsSync(path)) return false;
	const doc = parseDocument(readFileSync(path, "utf8"), { merge: true });
	return doc.getIn(["templates", name]) !== undefined;
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

export { LEGACY_CONFIG_NAME };
