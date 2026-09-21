// tui/usage-dashboard.ts
//
// usage-config.yaml 编辑面板：两级导航。
//
//   主面板  余额配置 / 订阅配置 / 余额模板 / 隔离条目 / 刷新间隔 / 原始 YAML / 退出
//   分类页  「＋ 新建…」+ 已配置条目列表；Enter 编辑，n 新建，d 删除，Esc 返回
//
// 列表每次动作后都从磁盘重新读取；写入走 usage-edit.ts 的定向编辑，
// 只触碰被编辑的条目，外部并发修改不会导致保存失败。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { BUILTIN_TEMPLATES, getBuiltinProviderIds, isBuiltinTemplate } from "../builtin.ts";
import {
	editConfigDocument,
	overwriteConfigFile,
	readSectionEntries,
	removeEntry,
	restoreOrphanEntry,
	templateExists,
	upsertEntry,
} from "../usage-edit.ts";
import { configFingerprint, serializeUsageConfig } from "../usage-store.ts";
import { configPath, readConfig, refreshInterval } from "../usage-config.ts";
import { modelsPath, readKnownProviderIds } from "../reconcile.ts";
import { adapterMeta, isSubscriptionAdapter, suggestAdapter } from "../subscription.ts";
import type { JsonObject } from "../types.ts";
import { editBalanceEntry } from "./usage-editor.ts";
import { editSubscriptionEntry } from "./subscription-editor.ts";
import { padLabel, showOptionPicker, showPersistentShortcutMenu, type MenuCursor, type MenuRow } from "./persistent-menu.ts";

function describeEntry(entry: JsonObject | undefined): string {
	if (!entry || Object.keys(entry).length === 0) return "(未配置)";
	if (typeof entry.template === "string" && entry.template) return `模板: ${entry.template}`;
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
	if (typeof entry.template === "string" && entry.template) lines.push(`  模板: ${entry.template}（provider 同名字段覆盖模板）`);
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

function notifyError(ctx: ExtensionCommandContext, prefix: string, error: unknown): void {
	void ctx.ui.notify(`${prefix}：${error instanceof Error ? error.message : String(error)}`, "error");
}

/** 主面板每次进入分类/动作前重读磁盘，外部修改不会让面板基于旧状态写入。 */
interface DashboardState {
	balances: Record<string, JsonObject>;
	subscriptions: Record<string, JsonObject>;
	templates: Record<string, JsonObject>;
	orphans: Record<string, JsonObject>;
	knownIds: Set<string>;
	interval: number;
}

async function readDashboardState(agentDir: string, builtinIds: ReadonlySet<string>): Promise<DashboardState> {
	return {
		balances: readSectionEntries(agentDir, "balances"),
		subscriptions: readSectionEntries(agentDir, "subscriptions"),
		templates: readSectionEntries(agentDir, "templates"),
		orphans: readSectionEntries(agentDir, "orphans"),
		knownIds: readKnownProviderIds(modelsPath(agentDir), builtinIds),
		interval: refreshInterval(readConfig(agentDir)),
	};
}

export async function runUsageDashboard(ctx: ExtensionCommandContext, agentDir: string): Promise<void> {
	const builtinIds = await getBuiltinProviderIds();
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const state = await readDashboardState(agentDir, builtinIds);
		const rows: MenuRow[] = [
			{ id: "balances", label: `${padLabel("余额配置", 14)}${Object.keys(state.balances).length} 项已配置`, searchText: "余额配置 balances" },
			{ id: "subscriptions", label: `${padLabel("订阅配置", 14)}${Object.keys(state.subscriptions).length} 项`, searchText: "订阅配置 subscriptions" },
			{ id: "templates", label: `${padLabel("余额模板", 14)}${Object.keys(state.templates).length} 个`, searchText: "余额模板 templates" },
			...(Object.keys(state.orphans).length > 0
				? [{ id: "orphans", label: `${padLabel("隔离条目", 14)}${Object.keys(state.orphans).length} 项待处理`, searchText: "隔离条目 orphans" }]
				: []),
			{ id: "refresh", label: `${padLabel("刷新间隔", 14)}${state.interval} 分钟`, searchText: "刷新间隔 refreshInterval" },
			{ id: "raw", label: `${padLabel("原始 YAML", 14)}直接编辑 usage-config.yaml`, searchText: "原始 YAML usage-config.yaml" },
			{ id: "quit", label: "退出" },
		];

		const action = await showPersistentShortcutMenu<"quit">(
			ctx,
			"usage-config.yaml",
			"",
			rows,
			cursor,
			[{ input: "q", shortcut: "quit" }],
			{
				getContext: () => `已配置余额 ${Object.keys(state.balances).length} / ${state.knownIds.size} 个已知 provider`,
				getDetailLines: (row) => {
					switch (row?.id) {
						case "balances": return ["  balances — 单个 provider 的余额查询配置（request/extractor 引擎），可绑定模板复用请求定义"];
						case "subscriptions": return ["  subscriptions — 按内置适配器查询套餐用量；凭据默认走 pi 运行时解析"];
						case "templates": return ["  templates — 可复用模板；provider 用 template 绑定后只需覆盖差异字段"];
						case "orphans": return ["  orphans — models.json 中已不存在的 provider；可恢复到 balances 或彻底删除"];
						case "refresh": return ["  refreshInterval — 后台刷新间隔（分钟）；条目可用 request.timeoutSeconds 覆盖单次请求超时"];
						case "raw": return ["  usage-config.yaml — 直接编辑 YAML 源文件；保存时校验指纹，避免覆盖外部修改"];
						default: return [];
					}
				},
				hints: [
					{ key: "↑↓", label: "选择" },
					{ key: "Enter", label: "进入" },
					{ key: "q", label: "退出" },
				],
				helpLines: [
					"余额走 request/extractor 引擎，订阅走内置适配器（ollama / commandcode / opencode-go / glm / chatgpt / kimi 等）。",
					"provider ID 必须与 models.json 中的键大小写完全一致，否则查询不会生效。",
				],
			},
		);

		if (action.type === "cancel" || (action.type === "shortcut" && action.shortcut === "quit")) return;
		if (action.type !== "pick") return;

		switch (action.id) {
			case "balances":
				await openBalances(ctx, agentDir, builtinIds);
				break;
			case "subscriptions":
				await openSubscriptions(ctx, agentDir, builtinIds);
				break;
			case "templates":
				await openTemplates(ctx, agentDir);
				break;
			case "orphans":
				await openOrphans(ctx, agentDir);
				break;
			case "refresh":
				await editRefreshInterval(ctx, agentDir, state.interval);
				break;
			case "raw":
				await editRawYaml(ctx, agentDir);
				break;
			default:
				break;
		}
	}
}

/** 分类页「＋ 新建…」行的固定 id。 */
const NEW_ROW = "＋新建";

async function openBalances(ctx: ExtensionCommandContext, agentDir: string, builtinIds: ReadonlySet<string>): Promise<void> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const balances = readSectionEntries(agentDir, "balances");
		const known = readKnownProviderIds(modelsPath(agentDir), builtinIds);
		const configured = Object.keys(balances).sort();
		const available = [...known].filter((id) => !(id in balances)).sort();
		const rows: MenuRow[] = [
			{ id: NEW_ROW, label: "＋ 新建余额配置", searchText: "新建 新建余额配置" },
			...configured.map((id) => ({ id, label: `${padLabel(id, 24)}${describeEntry(balances[id])}`, searchText: `${id}\n${describeEntry(balances[id])}` })),
		];
		const action = await showPersistentShortcutMenu<"new" | "delete">(
			ctx,
			"余额配置",
			"",
			rows,
			cursor,
			[{ input: "n", shortcut: "new" }, { input: "d", shortcut: "delete" }],
			{
				getContext: () => `已配置 ${configured.length} · 未配置 ${available.length}`,
				getDetailLines: (row) => row && row.id !== NEW_ROW ? entrySummary(balances[row.id]) : ["  为单个 provider 新建余额查询；可绑定模板复用请求定义"],
				emptyLabel: "尚未配置任何 provider",
				hints: [
					{ key: "↑↓", label: "选择" },
					{ key: "Enter", label: "编辑" },
					{ key: "n", label: "新建" },
					{ key: "d", label: "删除" },
					{ key: "Esc", label: "返回" },
				],
				helpLines: [
					"余额查询使用 request/extractor 引擎；绑定模板后 provider 只需覆盖差异字段。",
					"新建时只能从 models.json 与 pi 内置目录的已知 provider 中选择，键必须大小写完全一致。",
				],
			},
		);
		if (action.type === "cancel") return;
		if (action.type === "shortcut" && action.shortcut === "new") {
			await createBalanceEntry(ctx, agentDir, known, balances);
			continue;
		}
		if (action.type === "shortcut" && action.shortcut === "delete") {
			const selected = rows[cursor.index];
			if (!selected || selected.id === NEW_ROW) {
				void ctx.ui.notify("请先选中一个已配置的余额条目再按 d", "info");
				continue;
			}
			if (await ctx.ui.confirm("删除余额配置", selected.id)) {
				try {
					await removeEntry(agentDir, "balances", selected.id);
				} catch (error) {
					notifyError(ctx, "写入失败", error);
				}
			}
			continue;
		}
		if (action.type !== "pick") continue;
		if (action.id === NEW_ROW) {
			await createBalanceEntry(ctx, agentDir, known, balances);
			continue;
		}
		await editStoredBalanceEntry(ctx, agentDir, "balances", action.id, balances[action.id], false);
	}
}

async function openSubscriptions(ctx: ExtensionCommandContext, agentDir: string, builtinIds: ReadonlySet<string>): Promise<void> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const subscriptions = readSectionEntries(agentDir, "subscriptions");
		const known = readKnownProviderIds(modelsPath(agentDir), builtinIds);
		const configured = Object.keys(subscriptions).sort();
		const available = [...known].filter((id) => !(id in subscriptions)).sort();
		const rows: MenuRow[] = [
			{ id: NEW_ROW, label: "＋ 新建订阅配置", searchText: "新建 新建订阅配置" },
			...configured.map((id) => ({ id, label: `${padLabel(id, 24)}${describeSubscription(subscriptions[id])}`, searchText: `${id}\n${describeSubscription(subscriptions[id])}` })),
		];
		const action = await showPersistentShortcutMenu<"new" | "delete">(
			ctx,
			"订阅配置",
			"",
			rows,
			cursor,
			[{ input: "n", shortcut: "new" }, { input: "d", shortcut: "delete" }],
			{
				getContext: () => `已配置 ${configured.length} · 未配置 ${available.length}`,
				getDetailLines: (row) => row && row.id !== NEW_ROW ? subscriptionSummary(subscriptions[row.id]) : ["  为单个 provider 新建订阅用量查询；按 ID 自动预选适配器"],
				emptyLabel: "尚未配置任何订阅",
				hints: [
					{ key: "↑↓", label: "选择" },
					{ key: "Enter", label: "编辑" },
					{ key: "n", label: "新建" },
					{ key: "d", label: "删除" },
					{ key: "Esc", label: "返回" },
				],
				helpLines: ["订阅查询走内置适配器；凭据留空时使用 pi 运行时解析的 provider 凭据。"],
			},
		);
		if (action.type === "cancel") return;
		if (action.type === "shortcut" && action.shortcut === "new") {
			await createSubscriptionEntry(ctx, agentDir, known, subscriptions);
			continue;
		}
		if (action.type === "shortcut" && action.shortcut === "delete") {
			const selected = rows[cursor.index];
			if (!selected || selected.id === NEW_ROW) {
				void ctx.ui.notify("请先选中一个已配置的订阅条目再按 d", "info");
				continue;
			}
			if (await ctx.ui.confirm("删除订阅配置", selected.id)) {
				try {
					await removeEntry(agentDir, "subscriptions", selected.id);
				} catch (error) {
					notifyError(ctx, "写入失败", error);
				}
			}
			continue;
		}
		if (action.type !== "pick") continue;
		if (action.id === NEW_ROW) {
			await createSubscriptionEntry(ctx, agentDir, known, subscriptions);
			continue;
		}
		const draft: JsonObject = structuredClone(subscriptions[action.id] ?? {});
		const outcome = await editSubscriptionEntry(ctx, `订阅配置: ${action.id}`, draft);
		if (outcome.action === "cancel") continue;
		if (!isSubscriptionAdapter(outcome.entry.adapter)) {
			void ctx.ui.notify("未选择有效的订阅适配器，已取消保存", "warning");
			continue;
		}
		try {
			await upsertEntry(agentDir, "subscriptions", action.id, outcome.entry);
		} catch (error) {
			notifyError(ctx, "写入失败", error);
		}
	}
}

async function openTemplates(ctx: ExtensionCommandContext, agentDir: string): Promise<void> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const templates = readSectionEntries(agentDir, "templates");
		const names = Object.keys(templates).sort();
		const rows: MenuRow[] = [
			{ id: NEW_ROW, label: "＋ 新建模板", searchText: "新建 新建模板" },
			...names.map((name) => ({ id: name, label: `${padLabel(name, 24)}${describeEntry(templates[name])}`, searchText: `${name}\n${describeEntry(templates[name])}` })),
		];
		const action = await showPersistentShortcutMenu<"new" | "delete">(
			ctx,
			"余额模板",
			"",
			rows,
			cursor,
			[{ input: "n", shortcut: "new" }, { input: "d", shortcut: "delete" }],
			{
				getContext: () => `${names.length} 个模板`,
				getDetailLines: (row) => row && row.id !== NEW_ROW ? entrySummary(templates[row.id]) : ["  templates.<id> — 模板定义可复用的请求与提取规则；provider 用 template 绑定后只需覆盖差异字段"],
				emptyLabel: "尚无余额模板",
				hints: [
					{ key: "↑↓", label: "选择" },
					{ key: "Enter", label: "编辑" },
					{ key: "n", label: "新建" },
					{ key: "d", label: "删除" },
					{ key: "Esc", label: "返回" },
				],
				helpLines: ["模板存放在 templates 段；provider 用 template 绑定后，同名字段以 provider 自身为准。", "有同名内置模板（如 openrouter）时，新建 provider 余额会自动预绑定。"],
			},
		);
		if (action.type === "cancel") return;
		if (action.type === "shortcut" && action.shortcut === "new") {
			await createTemplate(ctx, agentDir, templates);
			continue;
		}
		if (action.type === "shortcut" && action.shortcut === "delete") {
			const selected = rows[cursor.index];
			if (!selected || selected.id === NEW_ROW) {
				void ctx.ui.notify("请先选中一个模板再按 d", "info");
				continue;
			}
			if (await ctx.ui.confirm("删除模板", selected.id)) {
				try {
					await removeEntry(agentDir, "templates", selected.id);
				} catch (error) {
					notifyError(ctx, "写入失败", error);
				}
			}
			continue;
		}
		if (action.type !== "pick") continue;
		if (action.id === NEW_ROW) {
			await createTemplate(ctx, agentDir, templates);
			continue;
		}
		await editStoredBalanceEntry(ctx, agentDir, "templates", action.id, templates[action.id], true);
	}
}

async function createTemplate(ctx: ExtensionCommandContext, agentDir: string, templates: Record<string, JsonObject>): Promise<void> {
	const name = await ctx.ui.input("新模板 ID（将创建 templates.<id>）", "");
	if (name === undefined) return;
	const trimmed = name.trim();
	if (!trimmed) return;
	if (templates[trimmed]) {
		void ctx.ui.notify(`模板 ${trimmed} 已存在`, "warning");
		return;
	}
	try {
		await upsertEntry(agentDir, "templates", trimmed, {});
	} catch (error) {
		notifyError(ctx, "写入失败", error);
	}
}

async function openOrphans(ctx: ExtensionCommandContext, agentDir: string): Promise<void> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const orphans = readSectionEntries(agentDir, "orphans");
		const ids = Object.keys(orphans).sort();
		if (ids.length === 0) return;
		const rows: MenuRow[] = ids.map((id) => ({ id, label: `${padLabel(id, 24)}${describeEntry(orphans[id])}`, searchText: `${id}\n${describeEntry(orphans[id])}` }));
		const action = await showPersistentShortcutMenu<"delete">(
			ctx,
			"隔离条目",
			"",
			rows,
			cursor,
			[{ input: "d", shortcut: "delete" }],
			{
				getContext: () => `${ids.length} 项 · 对账时 models.json 已不存在的 provider`,
				getDetailLines: (row) => (row ? entrySummary(orphans[row.id]) : []),
				emptyLabel: "隔离区为空",
				hints: [
					{ key: "↑↓", label: "选择" },
					{ key: "Enter", label: "处理" },
					{ key: "d", label: "删除" },
					{ key: "Esc", label: "返回" },
				],
				helpLines: ["隔离条目来自 provider 对账：models.json 中已删除/改名的 provider。", "恢复后若 models.json 仍无此 provider，下次对账会再次隔离。"],
			},
		);
		if (action.type === "cancel") return;
		if (action.type === "shortcut" && action.shortcut === "delete") {
			const selected = rows[cursor.index];
			if (!selected) continue;
			if (await ctx.ui.confirm("彻底删除隔离条目", selected.id)) {
				try {
					await removeEntry(agentDir, "orphans", selected.id);
				} catch (error) {
					notifyError(ctx, "写入失败", error);
				}
			}
			continue;
		}
		if (action.type !== "pick") continue;
		const id = action.id;
		const choice = await showOptionPicker(ctx, `隔离条目: ${id}`, [
			{ id: "restore", label: "恢复到 balances（若 models.json 中无此 provider，下次对账会再次隔离）" },
			{ id: "delete", label: "彻底删除" },
			{ id: "edit", label: "查看/编辑（仍保留在隔离区）" },
		], "restore");
		if (!choice) continue;
		try {
			if (choice.id === "restore") {
				await restoreOrphanEntry(agentDir, id);
			} else if (choice.id === "delete") {
				if (await ctx.ui.confirm("彻底删除隔离条目", id)) await removeEntry(agentDir, "orphans", id);
			} else {
				await editStoredBalanceEntry(ctx, agentDir, "orphans", id, orphans[id], false);
			}
		} catch (error) {
			void ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		}
	}
}

async function editRefreshInterval(ctx: ExtensionCommandContext, agentDir: string, interval: number): Promise<void> {
	const value = await ctx.ui.input(`刷新间隔（分钟，当前 ${interval}，留空清除恢复默认 5）`, String(interval));
	if (value === undefined) return;
	const trimmed = value.trim();
	try {
		await editConfigDocument(agentDir, (doc) => {
			if (!trimmed) doc.delete("refreshInterval");
			else {
				const parsed = Number(trimmed);
				if (!Number.isFinite(parsed) || parsed < 1) throw new Error("刷新间隔需要 >= 1 的数字");
				doc.set("refreshInterval", parsed);
			}
		});
	} catch (error) {
		void ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
	}
}

async function editRawYaml(ctx: ExtensionCommandContext, agentDir: string): Promise<void> {
	const path = configPath(agentDir);
	const before = existsSync(path) ? readFileSync(path, "utf8") : serializeUsageConfig({ templates: {}, balances: {}, subscriptions: {} });
	const fingerprint = configFingerprint(agentDir);
	const text = await ctx.ui.editor("usage-config.yaml（原始 YAML）", before);
	if (text === undefined) return;
	try {
		await overwriteConfigFile(agentDir, text, fingerprint);
	} catch (error) {
		void ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
	}
}

async function editStoredBalanceEntry(
	ctx: ExtensionCommandContext,
	agentDir: string,
	section: "balances" | "templates" | "orphans",
	id: string,
	existing: JsonObject | undefined,
	isTemplate: boolean,
): Promise<void> {
	const draft: JsonObject = structuredClone(existing ?? {});
	// 模板选择器：文件里的模板 + 内置模板（同名自定义优先，仅未覆盖的内置模板标注（内置））。
	const fileTemplateNames = Object.keys(readSectionEntries(agentDir, "templates")).sort();
	const templateNames = [...new Set([...fileTemplateNames, ...Object.keys(BUILTIN_TEMPLATES)])].sort();
	const builtinOnlyTemplateNames = Object.keys(BUILTIN_TEMPLATES).filter((name) => !fileTemplateNames.includes(name));
	const outcome = await editBalanceEntry(ctx, `${isTemplate ? "模板" : "余额配置"}: ${id}`, draft, { showTemplate: !isTemplate, templateNames, builtinOnlyTemplateNames });
	if (outcome.action === "cancel") return;
	if (!isTemplate && typeof draft.template === "string" && draft.template && !templateExists(agentDir, draft.template) && !isBuiltinTemplate(draft.template)) {
		await ctx.ui.notify(`模板 ${draft.template} 不存在，已取消保存；可先在 [余额模板] 中新建`, "warning");
		return;
	}
	try {
		await upsertEntry(agentDir, section, id, outcome.entry);
	} catch (error) {
		notifyError(ctx, "写入失败", error);
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
		void ctx.ui.notify("models.json 与 pi 内置目录中的 provider 都已有余额配置", "info");
		return;
	}
	const choice = await showOptionPicker(ctx, "新建 Provider 余额配置（键需与 provider ID 大小写完全一致）", candidates.map((id) => ({ id, label: id })), candidates[0]!);
	if (!choice) return;
	const draft: JsonObject = isBuiltinTemplate(choice.id) ? { template: choice.id } : {};
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
		void ctx.ui.notify("已知 provider 都已有订阅配置", "info");
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
		void ctx.ui.notify("未选择有效的订阅适配器，已取消保存", "warning");
		return;
	}
	try {
		await upsertEntry(agentDir, "subscriptions", choice.id, outcome.entry);
	} catch (error) {
		notifyError(ctx, "写入失败", error);
	}
}
