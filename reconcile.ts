import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { configPath, readConfig } from "./config.ts";
import { configFingerprint, updateConfig, withConfigLock } from "./config-store.ts";
import type { BalanceConfig, JsonObject } from "./types.ts";

export const BALANCE_MAP_NAME = "provider-balance-map.json";
export const MAP_VERSION = 1;

/** 与 manager `models-change-events.ts` 的负载结构保持一致（无 secret）。 */
export type ReconcileEvent =
	| { type: "provider-rename"; oldId: string; newId: string }
	| { type: "provider-delete"; providerId: string };

export interface BalanceMapDocument {
	version: 1;
	aliases: Record<string, { from: string; source: "rename-event"; confirmedAt: string }>;
}

export interface ReconcileReport {
	added: string[];
	existing: string[];
	orphan: string[];
	renamed: { from: string; to: string }[];
	conflicts: string[];
	quarantined: string[];
	changed: boolean;
}

export function modelsPath(agentDir: string): string {
	return join(agentDir, "models.json");
}

export function readModelsProviderIds(path: string): Set<string> {
	const models = JSON.parse(readFileSync(path, "utf8")) as { providers?: Record<string, unknown> };
	return new Set(Object.keys(models.providers ?? {}));
}

/** 已知 provider ID：models.json providers ∪ pi 内置 provider（大小写敏感，键必须完全一致才生效）。 */
export function readKnownProviderIds(path: string, builtinIds: ReadonlySet<string>): Set<string> {
	const ids = new Set(builtinIds);
	if (existsSync(path)) for (const id of readModelsProviderIds(path)) ids.add(id);
	return ids;
}

export function readBalanceMap(agentDir: string): BalanceMapDocument {
	const path = join(agentDir, BALANCE_MAP_NAME);
	if (!existsSync(path)) return { version: MAP_VERSION, aliases: {} };
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!value || typeof value !== "object") return { version: MAP_VERSION, aliases: {} };
	const document = value as Partial<BalanceMapDocument>;
	return { version: MAP_VERSION, aliases: { ...(document.aliases ?? {}) } };
}

function writeBalanceMapAtomic(agentDir: string, map: BalanceMapDocument): void {
	const path = join(agentDir, BALANCE_MAP_NAME);
	const tempPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	writeFileSync(tempPath, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
	renameSync(tempPath, path);
}

function providerRecord(value: unknown): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

export interface ReconcileOptions {
	/** manager 广播的变更事件。 */
	events?: readonly ReconcileEvent[];
	/** pi 内置 provider ID（如 openrouter，不在 models.json 里）；这些 ID 不算 orphan。 */
	builtinIds?: ReadonlySet<string>;
	/** `--prune` 前的用户确认回调；未提供或返回 false 时 orphan 保持原样。 */
	confirmPrune?: (orphanIds: string[]) => Promise<boolean> | boolean;
}

/**
 * Provider 身份对账（计划 4.4）：在配置锁内执行。
 * - 新增 Provider：只报告，不自动创建余额配置；
 * - 已有 Provider：原样保留；
 * - 删除 Provider：默认保留为 orphan，`confirmPrune` 明确确认后隔离进 `orphanProviders`（可恢复）；
 * - pi 内置 provider（builtinIds）不在 models.json 里，配置了也不算 orphan；
 * - 显式 rename 事件：迁移 balance key 并记录 alias；存在冲突时停止自动写入，报告冲突。
 */
export async function reconcileProviders(agentDir: string, path: string, options: ReconcileOptions = {}): Promise<ReconcileReport> {
	return withConfigLock(agentDir, async () => {
		const modelIds = readModelsProviderIds(path);
		const builtinIds = options.builtinIds ?? new Set<string>();
		const isOrphan = (id: string): boolean => !modelIds.has(id) && !builtinIds.has(id);
		const before = configFingerprint(agentDir);
		const current = readConfig(agentDir);
		const providers: Record<string, JsonObject> = {};
		for (const [id, value] of Object.entries(current.providers ?? {})) {
			const record = providerRecord(value);
			if (record) providers[id] = record;
		}

		// 第一遍：冲突检测。任一冲突即停止自动写入（计划 4.4 第 6 条）。
		const conflicts: string[] = [];
		for (const event of options.events ?? []) {
			if (event.type !== "provider-rename") continue;
			if (!(event.oldId in providers)) continue;
			if (event.newId in providers || modelIds.has(event.oldId)) conflicts.push(event.newId);
		}
		const balanceIds = () => new Set(Object.keys(providers));
		if (conflicts.length > 0) {
			const ids = balanceIds();
			return {
				added: [...modelIds].filter((id) => !ids.has(id)),
				existing: [...modelIds].filter((id) => ids.has(id)),
				orphan: [...ids].filter(isOrphan),
				renamed: [],
				conflicts,
				quarantined: [],
				changed: false,
			};
		}

		// 第二遍：应用 rename 并记录 alias。
		const map = readBalanceMap(agentDir);
		let mapChanged = false;
		const renamed: { from: string; to: string }[] = [];
		for (const event of options.events ?? []) {
			if (event.type !== "provider-rename") continue;
			if (!(event.oldId in providers)) continue;
			providers[event.newId] = providers[event.oldId]!;
			delete providers[event.oldId];
			renamed.push({ from: event.oldId, to: event.newId });
			if (map.aliases[event.newId]?.from !== event.oldId) {
				map.aliases[event.newId] = { from: event.oldId, source: "rename-event", confirmedAt: new Date().toISOString() };
				mapChanged = true;
			}
		}

		const idsAfterRename = balanceIds();
		const orphan = [...idsAfterRename].filter(isOrphan);

		// prune：用户明确确认后才把 orphan 隔离进 orphanProviders（可恢复，不做物理删除）。
		const quarantined: string[] = [];
		if (orphan.length > 0 && options.confirmPrune && (await options.confirmPrune(orphan))) {
			const quarantine: Record<string, JsonObject> = { ...(providerRecord(current.orphanProviders) ?? {}) };
			for (const id of orphan) {
				quarantine[id] = providers[id]!;
				delete providers[id];
				quarantined.push(id);
			}
			current.orphanProviders = quarantine;
		}

		const changed = renamed.length > 0 || quarantined.length > 0;
		if (changed) {
			current.providers = providers;
			updateConfig(agentDir, () => current, before);
		}
		if (mapChanged) writeBalanceMapAtomic(agentDir, map);

		const finalIds = balanceIds();
		return {
			added: [...modelIds].filter((id) => !finalIds.has(id)),
			existing: [...modelIds].filter((id) => finalIds.has(id)),
			orphan: [...finalIds].filter(isOrphan),
			renamed,
			conflicts,
			quarantined,
			changed,
		};
	});
}
