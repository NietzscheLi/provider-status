// balance-draft.ts
//
// 条目草稿的纯逻辑层：TUI 编辑器把 providers/profiles 条目当作 JsonObject 树就地修改。
// 这里集中路径读写、headers 键值对转换、掩码与数字解析，便于脱离 TUI 做单元测试。

import type { JsonObject } from "./types.ts";

/** 掩码显示敏感值；与 redactSecrets 的口径一致，只暴露"是否已填写"。 */
export function maskSecret(value: unknown): string {
	return typeof value === "string" && value.length > 0 ? "********" : "<未填写>";
}

export function isRecord(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 按点路径读取；数组下标用数字键。路径不存在返回 undefined。 */
export function valueAtPath(value: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((current, key) => {
		if (current === null || typeof current !== "object") return undefined;
		if (Array.isArray(current)) return /^\d+$/.test(key) ? current[Number(key)] : undefined;
		return (current as JsonObject)[key];
	}, value);
}

/** 按点路径写入；写 undefined/空串表示删除该键，沿途清理空对象。 */
export function setValueAtPath(target: JsonObject, path: string, value: unknown): void {
	const keys = path.split(".");
	let current: JsonObject = target;
	for (const key of keys.slice(0, -1)) {
		const next = current[key];
		if (!isRecord(next)) {
			const created: JsonObject = {};
			current[key] = created;
			current = created;
		} else {
			current = next;
		}
	}
	const last = keys[keys.length - 1]!;
	const empty = value === undefined || value === "";
	if (empty) {
		delete current[last];
	} else {
		current[last] = value;
	}
	pruneEmpty(target);
}

// 删除因清空产生的空中间对象，避免残留 "request": {} 这类骨架。
export function pruneEmpty(target: JsonObject): void {
	let changed = true;
	while (changed) {
		changed = false;
		const visit = (node: JsonObject): void => {
			for (const [key, child] of Object.entries(node)) {
				if (isRecord(child)) {
					visit(child);
					if (Object.keys(child).length === 0) {
						delete node[key];
						changed = true;
					}
				}
			}
		};
		visit(target);
	}
}

export interface HeaderPair {
	key: string;
	value: string;
}

/** request.headers 对象 ↔ 可编辑的键值对列表（插值串保持原样）。 */
export function headersToPairs(headers: unknown): HeaderPair[] {
	if (!isRecord(headers)) return [];
	return Object.entries(headers).map(([key, value]) => ({ key, value: String(value) }));
}

export function pairsToHeaders(pairs: readonly HeaderPair[]): JsonObject | undefined {
	const result: JsonObject = {};
	for (const pair of pairs) {
		const key = pair.key.trim();
		if (!key) continue;
		result[key] = pair.value;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/** 解析数字输入；空串表示清除（返回 undefined），非法输入返回 null 由调用方报错。 */
export function parseNumberInput(text: string): number | undefined | null {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const value = Number(trimmed);
	return Number.isFinite(value) ? value : null;
}

/** 稳定字符串化（键排序），用于深比较两个 JSON 值。 */
export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** 解析 provider 绑定的模板：字符串引用查 profiles 表，内联对象/YAML 别名展开的对象直接返回。 */
export function resolveProfileBase(entry: JsonObject, profiles: Record<string, JsonObject>): JsonObject | undefined {
	const raw = entry.profile;
	if (typeof raw === "string" && raw) return profiles[raw];
	if (isRecord(raw)) return raw;
	return undefined;
}

/**
 * 内联/别名展开的 profile 若与某个具名模板完全一致，改回字符串引用，
 * 避免编辑保存时把别名展开成内联副本、悄悄切断与模板的继承关系。
 */
export function normalizeProfileReference(entry: JsonObject, profiles: Record<string, JsonObject>): void {
	const raw = entry.profile;
	if (!isRecord(raw)) return;
	for (const [name, profile] of Object.entries(profiles)) {
		if (stableStringify(profile) === stableStringify(raw)) {
			entry.profile = name;
			return;
		}
	}
}

/** 从 headers 键值对里找出同名 key（忽略大小写），供编辑前定位。 */
export function findPairIndex(pairs: readonly HeaderPair[], key: string): number {
	return pairs.findIndex((pair) => pair.key.toLowerCase() === key.toLowerCase());
}
