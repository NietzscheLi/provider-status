// tui/usage-dashboard.ts
//
// usage-config.yaml 编辑面板：列表 + 单键快捷操作。
//
//   Enter 编辑选中条目 / P 新建余额配置 / S 新建订阅配置 / n 新建模板 / d 删除
//   y 原始 YAML / q 退出
//
// 列表每次动作后都从磁盘重新读取；写入走 usage-edit.ts 的定向编辑，
// 只触碰被编辑的条目，外部并发修改不会导致保存失败。

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { BUILTIN_PROFILES, getBuiltinProviderIds, isBuiltinProfile } from "../builtin.ts";
import {
	editConfigDocument,
	overwriteConfigFile,
	profileExists,
	readSectionEntries,
	removeEntry,
	restoreOrphanEntry,
	upsertEntry,
} from "../usage-edit.ts";
import { configFingerprint, serializeUsageConfig } from "../usage-store.ts";
import { configPath, readConfig, refreshInterval } from "../usage-config.ts";
import { modelsPath, readModelsProviderIds, readKnownProviderIds } from "../reconcile.ts";
import { adapterMeta, isSubscriptionAdapter, suggestAdapter } from "../subscription.ts";
import type { JsonObject } from "../types.ts";
import { editBalanceEntry } from "./usage-editor.ts";
import { editSubscriptionEntry } from "./subscription-editor.ts";
import { padLabel, showOptionPicker, showPersistentShortcutMenu, type MenuCursor, type MenuRow } from "./persistent-menu.ts";

type RowKind =
	| { kind: "refresh" }
	| { kind: "balance"; id: string }
	| { kind: "subscription"; id: string }
	| { kind: "profile"; name: string }
	| { kind: "orphan"; id: string };

interface DashboardRow extends MenuRow {
	meta: RowKind;
}

function describeEntry(entry: JsonObject | undefined): string {
	if (!entry || Object.keys(entry).length === 0) return "(未配置)";
	if (typeof entry.profile === "string" && entry.profile) return `profile: ${entry.profile}`;
	const request = entry.request;
	const url = request && typeof request === "object" && typeof (request as JsonObject).url === "string"
		? String((request as JsonObject).url)
		: undefined;
	return url ? `自定义: ${url}` : "自定义";
}

function describeSubscription(entry: JsonObject | undefined): string {
	if (!entry || Object.keys(entry).length === 0) return "(未配置)";
	const adapter = isSubscriptionAdapter(entry.adapter) ? adapterMeta(entry.adapter)! : undefined;
	const label = typeof entry.label === "string" && entry.label ? entry.label : adapter?.label ?? String(entry.adapter ?? "?");
	const baseUrl = (() => {
		const request = entry.request;
		return request && typeof request === "object" ? (request as JsonObject).baseUrl : undefined;
	})();
	return `${label} · ${adapter?.id ?? "未知适配器"}${typeof baseUrl === "string" && baseUrl ? ` · ${baseUrl}` : ""}`;
}

function entrySummary(entry: JsonObject | undefined): string[] {
	if (!entry || Object.keys(entry).length === 0) return ["  空条目：绑定模板或填入 request.url 后才会查询余额"];
	const lines: string[] = [];
	const request = entry.request;
	if (request && typeof request === "object") {
		lines.push(`  URL: ${String((request as JsonObject).url ?? "—")}`);
		if ((request as JsonObject).method) lines.push(`  Method: ${String((request as JsonObject).method)}`);
	}
	const credentials = entry.credentials;
	if (credentials && typeof credentials === "object") {
		const keys = Object.keys(credentials as JsonObject).filter((key) => (credentials as JsonObject)[key]);
		if (keys.length > 0) lines.push(`  Credentials: ${keys.join(", ")}（值已掩码）`);
	}
	if (typeof entry.profile === "string" && entry.profile) lines.push(`  模板: ${entry.profile}（provider 同名字段覆盖模板）`);
	if (lines.length === 0) lines.push("  自定义条目：按 Enter 打开编辑器查看");
	return lines;
}

function subscriptionSummary(entry: JsonObject | undefined): string[] {
	if (!entry) return [];
	const adapter = isSubscriptionAdapter(entry.adapter) ? adapterMeta(entry.adapter) : undefined;
	const lines: string[] = [];
	if (adapter) {
		lines.push(`  接口: ${adapter.endpoint}`);
		lines.push(`  参考实现: ${adapter.reference}`);
	} else {
		lines.push(`  适配器未设置或无效: ${String(entry.adapter ?? "—")}`);
	}
	lines.push(`  凭据: ${entry.credentials ? "条目内覆盖（已掩码）；其余用 pi 运行时解析" : "使用 pi 运行时解析的 provider 凭据"}`);
	if (entry.maxWidth !== undefined) lines.push(`  状态栏宽度: ${String(entry.maxWidth)}`);
	return lines;
}

export async function runUsageDashboard(ctx: ExtensionCommandContext, agentDir: string): Promise<void> {
	const cursor: MenuCursor = { index: 0 };
	const builtinIds = await getBuiltinProviderIds();
	while (true) {
		// 每轮都从磁盘重读，外部修改不会让面板卡在旧状态上。
		const modelsProviderIds = existsSync(modelsPath(agentDir)) ? readModelsProviderIds(modelsPath(agentDir)) : new Set<string>();
		const balances = readSectionEntries(agentDir, "balances");
		const subscriptions = readSectionEntries(agentDir, "subscriptions");
		const profiles = readSectionEntries(agentDir, "profiles");
		const orphans = readSectionEntries(agentDir, "orphanBalances");
		const interval = refreshInterval(readConfig(agentDir));

		const rows: DashboardRow[] = [{
			meta: { kind: "refresh" },
			id: "refresh",
			label: padLabel("刷新间隔", 16) + `${interval} 分钟`,
		}];
		for (const id of [...new Set([...modelsProviderIds, ...builtinIds, ...Object.keys(balances)])].sort()) {
			const builtinOnly = builtinIds.has(id) && !modelsProviderIds.has(id);
			rows.push({
				meta: { kind: "balance", id },
				id: `balance:${id}`,
				label: padLabel(builtinOnly ? `[余额][内置] ${id}` : `[余额] ${id}`, 30) + describeEntry(balances[id]),
				searchText: id,
			});
		}
		for (const id of Object.keys(subscriptions).sort()) {
			rows.push({
				meta: { kind: "subscription", id },
				id: `subscription:${id}`,
				label: padLabel(`[订阅] ${id}`, 30) + describeSubscription(subscriptions[id]),
				searchText: id,
			});
		}
		for (const name of Object.keys(profiles).sort()) {
			rows.push({
				meta: { kind: "profile", name },
				id: `profile:${name}`,
				label: padLabel(`[模板] ${name}`, 30) + describeEntry(profiles[name]),
				searchText: name,
			});
		}
		for (const id of Object.keys(orphans).sort()) {
			rows.push({
				meta: { kind: "orphan", id },
				id: `orphan:${id}`,
				label: padLabel(`[隔离] ${id}`, 30) + describeEntry(orphans[id]),
				searchText: id,
			});
		}

		const detailLines = (row: DashboardRow | undefined, _theme: Theme): string[] => {
			if (!row) return [];
			if (row.meta.kind === "refresh") return ["  每次会话读取用量的默认间隔；余额条目可用 request.timeoutSeconds 覆盖单次请求超时"];
			if (row.meta.kind === "balance") return entrySummary(balances[row.meta.id]);
			if (row.meta.kind === "subscription") return subscriptionSummary(subscriptions[row.meta.id]);
			if (row.meta.kind === "profile") return entrySummary(profiles[row.meta.name]);
			return entrySummary(orphans[row.meta.id]);
		};

		const action = await showPersistentShortcutMenu<"new-balance" | "new-subscription" | "new" | "raw" | "quit" | "delete">(
			ctx,
			"usage-config",
			"",
			rows.map((row) => ({ ...row })),
			cursor,
			[
				{ input: "p", shortcut: "new-balance" },
				{ input: "s", shortcut: "new-subscription" },
				{ input: "n", shortcut: "new" },
				{ input: "d", shortcut: "delete" },
				{ input: "y", shortcut: "raw" },
				{ input: "q", shortcut: "quit" },
			],
			{
				getSummaryLines: () => [
					`balances ${Object.keys(balances).length} · subscriptions ${Object.keys(subscriptions).length} · profiles ${Object.keys(profiles).length} · orphan ${Object.keys(orphans).length} · 刷新 ${interval} 分钟`,
					"[余额] 走 request/extractor 引擎；[订阅] 走内置适配器（ollama/commandcode/opencode-go/glm/chatgpt/kimi）",
				],
				tableHeader: padLabel("条目", 30) + "配置",
				formatRow: (row) => row.label,
				getDetailLines: detailLines,
				emptyLabel: "暂无条目",
				hints: [
					{ key: "↑↓", label: "选择" },
					{ key: "Enter", label: "编辑" },
					{ key: "P", label: "新建余额配置" },
					{ key: "S", label: "新建订阅配置" },
					{ key: "n", label: "新建模板" },
					{ key: "d", label: "删除" },
					{ key: "y", label: "原始 YAML" },
					{ key: "q", label: "退出" },
				],
			},
		);

		if (action.type === "cancel" || (action.type === "shortcut" && action.shortcut === "quit")) return;

		if (action.type === "shortcut" && action.shortcut === "new-balance") {
			await createBalanceEntry(ctx, agentDir, readKnownProviderIds(modelsPath(agentDir), builtinIds), balances);
			continue;
		}

		if (action.type === "shortcut" && action.shortcut === "new-subscription") {
			await createSubscriptionEntry(ctx, agentDir, readKnownProviderIds(modelsPath(agentDir), builtinIds), subscriptions);
			continue;
		}

		if (action.type === "shortcut" && action.shortcut === "new") {
			const name = await ctx.ui.input("新模板 ID（将创建 profiles.<id>）", "");
			if (name === undefined) continue;
			const trimmed = name.trim();
			if (!trimmed) continue;
			if (profiles[trimmed]) {
				await ctx.ui.notify(`模板 ${trimmed} 已存在`, "warning");
				continue;
			}
			try {
				await upsertEntry(agentDir, "profiles", trimmed, {});
			} catch (error) {
				await ctx.ui.notify(`写入失败：${error instanceof Error ? error.message : String(error)}`, "error");
			}
			continue;
		}

		if (action.type === "shortcut" && action.shortcut === "raw") {
			const path = configPath(agentDir);
			const before = existsSync(path) ? readFileSync(path, "utf8") : serializeUsageConfig({ profiles: {}, balances: {}, subscriptions: {} });
			const fingerprint = configFingerprint(agentDir);
			const text = await ctx.ui.editor("usage-config.yaml（原始 YAML）", before);
			if (text === undefined) continue;
			try {
				await overwriteConfigFile(agentDir, text, fingerprint);
			} catch (error) {
				await ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
			continue;
		}

		if (action.type === "shortcut" && action.shortcut === "delete") {
			const selected = rows[cursor.index];
			if (!selected) continue;
			if (selected.meta.kind === "refresh") {
				await ctx.ui.notify("刷新间隔不可删除；留空保存即可恢复默认 5 分钟", "info");
				continue;
			}
			if (selected.meta.kind === "orphan") {
				const choice = await showOptionPicker(ctx, `[隔离] ${selected.meta.id}`, [
					{ id: "delete", label: "彻底删除" },
					{ id: "restore", label: "恢复到 balances" },
				], "delete");
				if (!choice) continue;
				try {
					if (choice.id === "delete") {
						if (await ctx.ui.confirm("彻底删除隔离条目", selected.meta.id)) await removeEntry(agentDir, "orphanBalances", selected.meta.id);
					} else {
						await restoreOrphanEntry(agentDir, selected.meta.id);
					}
				} catch (error) {
					await ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				}
				continue;
			}
			const deleteSection = selected.meta.kind === "profile" ? "profiles" : selected.meta.kind === "subscription" ? "subscriptions" : "balances";
			const deleteId = selected.meta.kind === "profile" ? selected.meta.name : selected.meta.id;
			if (selected.meta.kind === "balance" && !balances[selected.meta.id]) {
				await ctx.ui.notify(`${deleteId} 尚无余额配置；按 P 新建`, "info");
				continue;
			}
			if (selected.meta.kind === "subscription" && !subscriptions[selected.meta.id]) {
				await ctx.ui.notify(`${deleteId} 尚无订阅配置；按 S 新建`, "info");
				continue;
			}
			if (await ctx.ui.confirm(`删除 ${selected.meta.kind === "profile" ? "模板" : selected.meta.kind === "subscription" ? "订阅配置" : "余额配置"}`, deleteId)) {
				try {
					await removeEntry(agentDir, deleteSection, deleteId);
				} catch (error) {
					await ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			}
			continue;
		}

		const row = rows.find((candidate) => candidate.id === action.id);
		if (!row) continue;
		if (row.meta.kind === "refresh") {
			const value = await ctx.ui.input(`刷新间隔（分钟，当前 ${interval}，留空清除恢复默认 5）`, String(interval));
			if (value === undefined) continue;
			const trimmed = value.trim();
			try {
				await editConfigDocument(agentDir, (doc) => {
					if (!trimmed) doc.delete("refreshIntervalMinutes");
					else {
						const parsed = Number(trimmed);
						if (!Number.isFinite(parsed) || parsed < 1) throw new Error("刷新间隔需要 >= 1 的数字");
						doc.set("refreshIntervalMinutes", parsed);
					}
				});
			} catch (error) {
				await ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
			continue;
		}
		if (row.meta.kind === "orphan") {
			const choice = await showOptionPicker(ctx, `[隔离] ${row.meta.id}`, [
				{ id: "restore", label: "恢复到 balances（若 models.json 中无此 provider，下次对账会再次隔离）" },
				{ id: "delete", label: "彻底删除" },
				{ id: "edit", label: "查看/编辑（仍保留在隔离区）" },
			], "restore");
			if (!choice) continue;
			try {
				if (choice.id === "restore") {
					await restoreOrphanEntry(agentDir, row.meta.id);
				} else if (choice.id === "delete") {
					if (await ctx.ui.confirm("彻底删除隔离条目", row.meta.id)) await removeEntry(agentDir, "orphanBalances", row.meta.id);
				} else {
					await editStoredBalanceEntry(ctx, agentDir, "orphanBalances", row.meta.id, orphans[row.meta.id], false);
				}
			} catch (error) {
				await ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
			continue;
		}
		if (row.meta.kind === "subscription") {
			const draft: JsonObject = structuredClone(subscriptions[row.meta.id] ?? {});
			const outcome = await editSubscriptionEntry(ctx, `订阅配置: ${row.meta.id}`, draft);
			if (outcome.action === "cancel") continue;
			if (!isSubscriptionAdapter(outcome.entry.adapter)) {
				await ctx.ui.notify("未选择有效的订阅适配器，已取消保存", "warning");
				continue;
			}
			try {
				await upsertEntry(agentDir, "subscriptions", row.meta.id, outcome.entry);
			} catch (error) {
				await ctx.ui.notify(`写入失败：${error instanceof Error ? error.message : String(error)}`, "error");
			}
			continue;
		}

		const isProfile = row.meta.kind === "profile";
		const section = isProfile ? "profiles" : "balances";
		const entryId = isProfile ? row.meta.name : (row.meta as { id: string }).id;
		const existing: JsonObject | undefined = isProfile ? profiles[entryId] : balances[entryId];
		await editStoredBalanceEntry(ctx, agentDir, section, entryId, existing, isProfile);
	}
}

async function editStoredBalanceEntry(
	ctx: ExtensionCommandContext,
	agentDir: string,
	section: "balances" | "profiles" | "orphanBalances",
	id: string,
	existing: JsonObject | undefined,
	isProfile: boolean,
): Promise<void> {
	const draft: JsonObject = structuredClone(existing ?? {});
	// 模板选择器：文件里的模板 + 内置模板（同名自定义优先，仅未覆盖的内置模板标注（内置））。
	const fileProfileNames = Object.keys(readSectionEntries(agentDir, "profiles")).sort();
	const profileNames = [...new Set([...fileProfileNames, ...Object.keys(BUILTIN_PROFILES)])].sort();
	const builtinOnlyProfileNames = Object.keys(BUILTIN_PROFILES).filter((name) => !fileProfileNames.includes(name));
	const outcome = await editBalanceEntry(ctx, `${isProfile ? "模板" : "余额配置"}: ${id}`, draft, { showProfile: !isProfile, profileNames, builtinOnlyProfileNames });
	if (outcome.action === "cancel") return;
	if (!isProfile && typeof draft.profile === "string" && draft.profile && !profileExists(agentDir, draft.profile) && !isBuiltinProfile(draft.profile)) {
		await ctx.ui.notify(`模板 ${draft.profile} 不存在，已取消保存；可先在 [模板] 中新建`, "warning");
		return;
	}
	try {
		await upsertEntry(agentDir, section, id, outcome.entry);
	} catch (error) {
		await ctx.ui.notify(`写入失败：${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

/**
 * 新建余额配置：仅从已知 provider ID 列表选择（models.json ∪ pi 内置目录），
 * 不提供自由输入；balances 键必须与 provider ID 大小写完全一致才生效。
 * 有同名内置模板（如 openrouter）时自动预绑定。
 */
async function createBalanceEntry(
	ctx: ExtensionCommandContext,
	agentDir: string,
	knownIds: ReadonlySet<string>,
	balances: Record<string, JsonObject>,
): Promise<void> {
	const candidates = [...knownIds].filter((id) => !(id in balances)).sort();
	if (candidates.length === 0) {
		await ctx.ui.notify("models.json 与 pi 内置目录中的 provider 都已有余额配置", "info");
		return;
	}
	const choice = await showOptionPicker(ctx, "新建 Provider 余额配置（键需与 provider ID 大小写完全一致）", candidates.map((id) => ({ id, label: id })), candidates[0]!);
	if (!choice) return;
	const draft: JsonObject = isBuiltinProfile(choice.id) ? { profile: choice.id } : {};
	await editStoredBalanceEntry(ctx, agentDir, "balances", choice.id, structuredClone(draft), false);
}

/** 新建订阅配置：从已知 provider ID 中选择，按 ID 预选适配器后进入编辑器。 */
async function createSubscriptionEntry(
	ctx: ExtensionCommandContext,
	agentDir: string,
	knownIds: ReadonlySet<string>,
	subscriptions: Record<string, JsonObject>,
): Promise<void> {
	const candidates = [...knownIds].filter((id) => !(id in subscriptions)).sort();
	if (candidates.length === 0) {
		await ctx.ui.notify("已知 provider 都已有订阅配置", "info");
		return;
	}
	const choice = await showOptionPicker(ctx, "新建订阅配置（键需与 provider ID 大小写完全一致）", candidates.map((id) => {
		const suggested = suggestAdapter(id);
		return { id, label: suggested ? `${id}  →  ${suggested}` : id };
	}), candidates[0]!);
	if (!choice) return;
	const suggested = suggestAdapter(choice.id);
	const draft: JsonObject = suggested ? { adapter: suggested } : {};
	const outcome = await editSubscriptionEntry(ctx, `订阅配置: ${choice.id}`, draft);
	if (outcome.action === "cancel") return;
	if (!isSubscriptionAdapter(outcome.entry.adapter)) {
		await ctx.ui.notify("未选择有效的订阅适配器，已取消保存", "warning");
		return;
	}
	try {
		await upsertEntry(agentDir, "subscriptions", choice.id, outcome.entry);
	} catch (error) {
		await ctx.ui.notify(`写入失败：${error instanceof Error ? error.message : String(error)}`, "error");
	}
}
