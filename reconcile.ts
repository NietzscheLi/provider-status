import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_MAP_NAME, MAP_NAME, configPath, readConfig } from "./usage-config.ts";
import { configFingerprint, updateConfig, withConfigLock } from "./usage-store.ts";
import type { JsonObject, UsageConfig } from "./types.ts";

export const MAP_VERSION = 1;

/** 与 manager `models-change-events.ts` 的负载结构保持一致（无 secret）。 */
export type ReconcileEvent =
	| { type: "provider-rename"; oldId: string; newId: string }
	| { type: "provider-delete"; providerId: string };

export interface UsageMapDocument {
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

export function readUsageMap(agentDir: string): UsageMapDocument {
	const path = join(agentDir, MAP_NAME);
	const legacyPath = join(agentDir, LEGACY_MAP_NAME);
	const target = existsSync(path) ? path : legacyPath;
	if (!existsSync(target)) return { version: MAP_VERSION, aliases: {} };
	const value: unknown = JSON.parse(readFileSync(target, "utf8"));
	if (!value || typeof value !== "object") return { version: MAP_VERSION, aliases: {} };
	const document = value as Partial<UsageMapDocument>;
	return { version: MAP_VERSION, aliases: { ...(document.aliases ?? {}) } };
}

function writeUsageMapAtomic(agentDir: string, map: UsageMapDocument): void {
	const path = join(agentDir, MAP_NAME);
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
 * Provider 身份对账：在配置锁内执行。
 * - 新增 Provider：只报告，不自动创建余额配置；
 * - 已有 Provider：原样保留；
 * - 删除 Provider：默认保留为 orphan，`confirmPrune` 明确确认后隔离进 `orphanBalances`（可恢复）；
 * - pi 内置 provider（builtinIds）不在 models.json 里，配置了也不算 orphan；
 * - 显式 rename 事件：迁移 balance key 并记录 alias；存在冲突时停止自动写入，报告冲突。
 * 订阅条目（subscriptions）不参与隔离，它们以 provider ID 为键、由内置适配器驱动。
 */
export async function reconcileProviders(agentDir: string, path: string, options: ReconcileOptions = {}): Promise<ReconcileReport> {
	return withConfigLock(agentDir, async () => {
		const modelIds = readModelsProviderIds(path);
		const builtinIds = options.builtinIds ?? new Set<string>();
		const isOrphan = (id: string): boolean => !modelIds.has(id) && !builtinIds.has(id);
		const before = configFingerprint(agentDir);
		const current = readConfig(agentDir);
		// 订阅型 provider 由内置适配器驱动，不配置余额，也不应计入 added。
		const subscriptionIds = new Set(Object.keys(current.subscriptions ?? {}));
		const balances: Record<string, JsonObject> = {};
		for (const [id, value] of Object.entries(current.balances ?? {})) {
			const record = providerRecord(value);
			if (record) balances[id] = record;
		}

		// 第一遍：冲突检测。任一冲突即停止自动写入。
		const conflicts: string[] = [];
		for (const event of options.events ?? []) {
			if (event.type !== "provider-rename") continue;
			if (!(event.oldId in balances)) continue;
			if (event.newId in balances || modelIds.has(event.oldId)) conflicts.push(event.newId);
		}
		const balanceIds = () => new Set(Object.keys(balances));
		if (conflicts.length > 0) {
			const ids = balanceIds();
			return {
				added: [...modelIds].filter((id) => !ids.has(id) && !subscriptionIds.has(id)),
				existing: [...modelIds].filter((id) => ids.has(id)),
				orphan: [...ids].filter(isOrphan),
				renamed: [],
				conflicts,
				quarantined: [],
				changed: false,
			};
		}

		// 第二遍：应用 rename 并记录 alias。
		const map = readUsageMap(agentDir);
		let mapChanged = false;
		const renamed: { from: string; to: string }[] = [];
		for (const event of options.events ?? []) {
			if (event.type !== "provider-rename") continue;
			if (!(event.oldId in balances)) continue;
			balances[event.newId] = balances[event.oldId]!;
			delete balances[event.oldId];
			renamed.push({ from: event.oldId, to: event.newId });
			if (map.aliases[event.newId]?.from !== event.oldId) {
				map.aliases[event.newId] = { from: event.oldId, source: "rename-event", confirmedAt: new Date().toISOString() };
				mapChanged = true;
			}
		}

		const idsAfterRename = balanceIds();
		const orphan = [...idsAfterRename].filter(isOrphan);

		// prune：用户明确确认后才把 orphan 隔离进 orphanBalances（可恢复，不做物理删除）。
		const quarantined: string[] = [];
		if (orphan.length > 0 && options.confirmPrune && (await options.confirmPrune(orphan))) {
			const quarantine: Record<string, JsonObject> = { ...(providerRecord(current.orphanBalances) ?? {}) };
			for (const id of orphan) {
				quarantine[id] = balances[id]!;
				delete balances[id];
				quarantined.push(id);
			}
			current.orphanBalances = quarantine;
		}

		const changed = renamed.length > 0 || quarantined.length > 0;
		if (changed) {
			current.balances = balances;
			updateConfig(agentDir, () => current, before);
		}
		if (mapChanged) writeUsageMapAtomic(agentDir, map);

		const finalIds = balanceIds();
		return {
			added: [...modelIds].filter((id) => !finalIds.has(id) && !subscriptionIds.has(id)),
			existing: [...modelIds].filter((id) => finalIds.has(id)),
			orphan: [...finalIds].filter(isOrphan),
			renamed,
			conflicts,
			quarantined,
			changed,
		};
	});
}

export { configPath };
export type { UsageConfig };
