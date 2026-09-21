// tui/subscription-editor.ts
//
// 订阅条目编辑器：两级表单。
//
//   第一层  连接 / 显示 / 凭据 / 原始 JSON / 保存
//   第二层  选中分节后逐字段编辑；Ctrl+S 在任意一层保存，Esc 逐层返回
//
// 草稿是 subscriptions.<id> 的 JsonObject 树（深拷贝）；"原始 JSON" 行兜底未列出的字段。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SUBSCRIPTION_ADAPTERS, adapterMeta, isSubscriptionAdapter } from "../subscription.ts";
import { headersToPairs, isRecord, maskSecret, parseNumberInput, setValueAtPath, stableStringify, valueAtPath } from "../usage-draft.ts";
import type { JsonObject } from "../types.ts";
import { editHeaders } from "./kv-editor.ts";
import { padLabel, showOptionPicker, showPersistentFormMenu, type MenuCursor, type MenuRow } from "./persistent-menu.ts";

export type SubscriptionEditOutcome =
	| { action: "save"; entry: JsonObject }
	| { action: "cancel" };

interface SubscriptionSection {
	id: string;
	label: string;
	// 该分节对应的配置键前缀；帮助浮层里用它把中文标签映射回 YAML 键。
	keyPrefix: string;
	fields: readonly string[];
}

const SUBSCRIPTION_SECTIONS: readonly SubscriptionSection[] = [
	{ id: "connection", label: "连接", keyPrefix: "request.*", fields: ["adapter", "request.baseUrl", "request.timeoutSeconds", "request.headers"] },
	{ id: "display", label: "显示", keyPrefix: "label / maxWidth", fields: ["label", "maxWidth"] },
	{ id: "credentials", label: "凭据", keyPrefix: "credentials.*", fields: ["credentials.apiKey", "credentials.accessToken"] },
];

const SUBSCRIPTION_FIELD_HELP: Record<string, string> = {
	adapter: "决定请求端点与解析方式；未选择有效适配器时无法保存。",
	label: "状态栏上的短标签；留空使用适配器默认名称。",
	"request.baseUrl": "覆盖适配器的默认接口地址。",
	"request.timeoutSeconds": "单次查询超时秒数，默认 15。",
	"request.headers": "额外请求头；值支持 {{apiKey}} 等占位符插值。",
	maxWidth: "状态栏展示的最大宽度，默认 48。",
	"credentials.apiKey": "条目的 API Key 覆盖；留空则用 pi 运行时解析的 provider 凭据。",
	"credentials.accessToken": "条目的 access token 覆盖；留空则用 pi 运行时解析的 provider 凭据。",
	raw: "直接编辑整个条目的 JSON，保存后整体替换。",
};

function textOr(value: unknown, fallback: string): string {
	return typeof value === "string" && value ? value : value !== undefined && value !== null ? String(value) : fallback;
}

function buildRows(draft: JsonObject): { id: string; label: string; value: string }[] {
	const rawAdapter = draft.adapter;
	const adapter = isSubscriptionAdapter(rawAdapter) ? adapterMeta(rawAdapter)!.label + ` (${rawAdapter})` : "";
	const headerCount = headersToPairs(valueAtPath(draft, "request.headers")).length;
	return [
		{ id: "adapter", label: "适配器", value: adapter || "<必选>" },
		{ id: "label", label: "短标签", value: textOr(draft.label, "<用适配器默认>") },
		{ id: "request.baseUrl", label: "Base URL", value: textOr(valueAtPath(draft, "request.baseUrl"), "<用适配器默认>") },
		{ id: "request.timeoutSeconds", label: "超时秒数", value: textOr(valueAtPath(draft, "request.timeoutSeconds"), "15") },
		{ id: "request.headers", label: "请求头", value: headerCount > 0 ? `${headerCount} 项` : "<无>" },
		{ id: "maxWidth", label: "状态栏宽度", value: textOr(draft.maxWidth, "48") },
		{ id: "credentials.apiKey", label: "API Key", value: maskSecret(valueAtPath(draft, "credentials.apiKey")) },
		{ id: "credentials.accessToken", label: "Access Token", value: maskSecret(valueAtPath(draft, "credentials.accessToken")) },
		{ id: "raw", label: "原始 JSON", value: "编辑整个条目" },
	];
}

/** 导出给覆盖率测试：订阅条目表单必须覆盖运行时读取的全部字段。 */
export function subscriptionFormRows(draft: JsonObject): { id: string; label: string; value: string }[] {
	return buildRows(draft);
}

function sectionSummary(sectionId: string, draft: JsonObject): string {
	switch (sectionId) {
		case "connection": {
			const adapter = isSubscriptionAdapter(draft.adapter) ? adapterMeta(draft.adapter)!.label : "<未选择适配器>";
			return `${adapter} · ${textOr(valueAtPath(draft, "request.baseUrl"), adapterMeta(String(draft.adapter))?.endpoint ?? "—")}`;
		}
		case "display":
			return `标签 ${textOr(draft.label, "默认")} · 宽度 ${textOr(draft.maxWidth, "48")}`;
		case "credentials": {
			const count = ["credentials.apiKey", "credentials.accessToken"].filter((path) => valueAtPath(draft, path) !== undefined && valueAtPath(draft, path) !== "").length;
			return count > 0 ? `${count} 项已设置` : "<用 pi 运行时凭据>";
		}
		default:
			return "";
	}
}

async function editTextField(ctx: ExtensionCommandContext, draft: JsonObject, path: string, title: string): Promise<void> {
	const current = valueAtPath(draft, path);
	const value = await ctx.ui.input(`${title}（当前：${textOr(current, "<空>")}，留空清除）`, typeof current === "string" ? current : current !== undefined && current !== null ? String(current) : "");
	if (value === undefined) return;
	setValueAtPath(draft, path, value.trim());
}

async function editSecretField(ctx: ExtensionCommandContext, draft: JsonObject, path: string, title: string): Promise<void> {
	const value = await ctx.ui.input(`${title}（当前：${maskSecret(valueAtPath(draft, path))}；留空保持原值，输入 - 清除）`, "");
	if (value === undefined) return;
	const trimmed = value.trim();
	setValueAtPath(draft, path, trimmed === "-" ? "" : trimmed);
}

async function editRawEntry(ctx: ExtensionCommandContext, draft: JsonObject): Promise<void> {
	const text = await ctx.ui.editor("原始条目 JSON（保存后整个替换）", JSON.stringify(draft, null, 2));
	if (text === undefined) return;
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isRecord(parsed)) {
			void ctx.ui.notify("条目必须是 JSON 对象，已放弃本次修改", "warning");
			return;
		}
		for (const key of Object.keys(draft)) delete draft[key];
		Object.assign(draft, parsed);
	} catch (error) {
		void ctx.ui.notify(`JSON 解析失败，已放弃本次修改：${error instanceof Error ? error.message : String(error)}`, "warning");
	}
}

async function editSubscriptionFieldById(ctx: ExtensionCommandContext, rows: { id: string; label: string }[], draft: JsonObject, id: string): Promise<void> {
	const label = rows.find((row) => row.id === id)?.label ?? id;
	if (id === "adapter") {
		const choices = SUBSCRIPTION_ADAPTERS.map((entry) => ({ id: entry.id, label: `${entry.label} — ${entry.endpoint}` }));
		const choice = await showOptionPicker(ctx, "订阅适配器", choices, isSubscriptionAdapter(draft.adapter) ? draft.adapter : "");
		if (choice) setValueAtPath(draft, "adapter", choice.id);
		return;
	}
	if (id === "request.headers") {
		const initial = headersToPairs(valueAtPath(draft, "request.headers"));
		const result = await editHeaders(ctx, "请求头", initial);
		if (result.type === "done") {
			const next = result.pairs.length > 0 ? Object.fromEntries(result.pairs.map((pair) => [pair.key, pair.value])) : "";
			if (stableStringify(result.pairs) === stableStringify(initial)) return;
			setValueAtPath(draft, "request.headers", next);
		}
		return;
	}
	if (id.startsWith("credentials.")) {
		await editSecretField(ctx, draft, id, label);
		return;
	}
	if (id === "request.timeoutSeconds" || id === "maxWidth") {
		const current = valueAtPath(draft, id);
		const value = await ctx.ui.input(`${label}（当前：${textOr(current, id === "maxWidth" ? "48" : "15")}，留空清除）`, textOr(current, ""));
		if (value === undefined) return;
		const parsed = parseNumberInput(value);
		if (parsed === null) {
			void ctx.ui.notify("需要数字", "warning");
			return;
		}
		setValueAtPath(draft, id, parsed);
		return;
	}
	await editTextField(ctx, draft, id, label);
}

/** 分节的字段列表：Enter 编辑字段，Ctrl+S 保存，Esc 返回上一层。 */
async function editSubscriptionSection(
	ctx: ExtensionCommandContext,
	title: string,
	section: SubscriptionSection,
	draft: JsonObject,
): Promise<"back" | "save"> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const allRows = buildRows(draft);
		const rows: MenuRow[] = allRows
			.filter((spec) => section.fields.includes(spec.id))
			.map((spec) => ({ id: spec.id, label: `${padLabel(spec.label, 16)}${spec.value}`, searchText: `${spec.label}\n${spec.value}` }));
		const action = await showPersistentFormMenu(ctx, `${title} › ${section.label}`, "", rows, cursor, {
			getContext: () => "Ctrl+S 保存 · Esc 返回",
			getDetailLines: (row) => {
				if (!row) return [];
				const help = SUBSCRIPTION_FIELD_HELP[row.id];
				return help ? [`  ${row.id} — ${help}`] : [];
			},
			hints: [
				{ key: "↑↓", label: "选择" },
				{ key: "Enter", label: "编辑" },
				{ key: "Ctrl+S", label: "保存" },
				{ key: "Esc", label: "返回" },
			],
			helpLines: ["凭据留空时使用 pi 运行时解析的 provider 凭据；这里只覆盖特殊情况。"],
		});
		if (action.type === "cancel") return "back";
		if (action.type === "save") return "save";
		await editSubscriptionFieldById(ctx, allRows, draft, action.id);
	}
}

/** 编辑订阅条目草稿；draft 会被就地修改。 */
export async function editSubscriptionEntry(ctx: ExtensionCommandContext, title: string, draft: JsonObject): Promise<SubscriptionEditOutcome> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const rows: MenuRow[] = [
			...SUBSCRIPTION_SECTIONS.map((section) => ({
				id: section.id,
				label: `${padLabel(section.label, 14)}${sectionSummary(section.id, draft)}`,
				searchText: `${section.label} ${section.fields.join(" ")}`,
			})),
			{ id: "raw", label: `${padLabel("原始 JSON", 14)}编辑整个条目`, searchText: "原始 JSON raw" },
			{ id: "save", label: `${padLabel("保存", 14)}写入 usage-config.yaml`, searchText: "保存 save" },
		];
		const allRows = buildRows(draft);
		const action = await showPersistentFormMenu(ctx, title, "", rows, cursor, {
			getContext: () => "Ctrl+S 保存 · Esc 返回",
			getDetailLines: (row) => {
				if (!row) return [];
				if (row.id === "raw") return ["  raw — 直接编辑整个条目的 JSON，保存后整体替换。"];
				if (row.id === "save") return ["  usage-config.yaml — 写入磁盘；外部并发修改会被指纹校验拦下。"];
				const section = SUBSCRIPTION_SECTIONS.find((candidate) => candidate.id === row.id);
				if (!section) return [];
				const labels = section.fields.map((field) => allRows.find((spec) => spec.id === field)?.label ?? field);
				return [`  ${section.keyPrefix} — 包含：${labels.join("、")}`];
			},
			hints: [
				{ key: "↑↓", label: "选择" },
				{ key: "Enter", label: "进入" },
				{ key: "Ctrl+S", label: "保存" },
				{ key: "Esc", label: "返回" },
			],
			helpLines: [
				"适配器决定端点与解析方式；选择后显示对应接口。",
				"凭据留空时使用 pi 运行时解析的 provider 凭据。",
			],
		});
		if (action.type === "cancel") return { action: "cancel" };
		if (action.type === "save" || action.id === "save") return { action: "save", entry: draft };
		if (action.id === "raw") {
			await editRawEntry(ctx, draft);
			continue;
		}
		const section = SUBSCRIPTION_SECTIONS.find((candidate) => candidate.id === action.id);
		if (!section) continue;
		const result = await editSubscriptionSection(ctx, title, section, draft);
		if (result === "save") return { action: "save", entry: draft };
	}
}
