// tui/subscription-editor.ts
//
// 订阅条目编辑器：adapter + 端点/凭据/展示覆盖。
// 草稿是 subscriptions.<id> 的 JsonObject 树（深拷贝）；"原始 JSON" 行兜底未列出的字段。
// Ctrl+S 保存，Esc 返回。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SUBSCRIPTION_ADAPTERS, adapterMeta, isSubscriptionAdapter } from "../subscription.ts";
import { headersToPairs, isRecord, maskSecret, parseNumberInput, setValueAtPath, valueAtPath } from "../usage-draft.ts";
import type { JsonObject } from "../types.ts";
import { editHeaders } from "./kv-editor.ts";
import { padLabel, showOptionPicker, showPersistentFormMenu, type MenuCursor } from "./persistent-menu.ts";

export type SubscriptionEditOutcome =
	| { action: "save"; entry: JsonObject }
	| { action: "cancel" };

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
		{ id: "credentials.apiKey", label: "apiKey", value: maskSecret(valueAtPath(draft, "credentials.apiKey")) },
		{ id: "credentials.accessToken", label: "accessToken", value: maskSecret(valueAtPath(draft, "credentials.accessToken")) },
		{ id: "raw", label: "原始 JSON", value: "编辑整个条目" },
	];
}

/** 导出给覆盖率测试：订阅条目表单必须覆盖运行时读取的全部字段。 */
export function subscriptionFormRows(draft: JsonObject): { id: string; label: string; value: string }[] {
	return buildRows(draft);
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

/** 编辑订阅条目草稿；draft 会被就地修改。 */
export async function editSubscriptionEntry(ctx: ExtensionCommandContext, title: string, draft: JsonObject): Promise<SubscriptionEditOutcome> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const rows = buildRows(draft);
		const menuRows = rows.map((row) => ({ id: row.id, label: `${padLabel(row.label, 16)}${row.value}`, searchText: `${row.label}\n${row.value}` }));
		const action = await showPersistentFormMenu(ctx, title, "", menuRows, cursor, {
			getSummaryLines: () => [
				`adapter ${textOr(draft.adapter, "—")} · ${adapterMeta(String(draft.adapter))?.endpoint ?? "选择适配器后显示接口"}`,
				"凭据留空时使用 pi 运行时解析的 provider 凭据；这里只覆盖特殊情况",
				"Ctrl+S 保存到 usage-config.yaml；Esc 返回列表",
			],
			hints: [
				{ key: "↑↓", label: "选择" },
				{ key: "Enter", label: "编辑" },
				{ key: "Ctrl+S", label: "保存" },
				{ key: "Esc", label: "返回" },
			],
		});
		if (action.type === "cancel") return { action: "cancel" };
		if (action.type === "save") return { action: "save", entry: draft };
		const id = action.id;
		if (id === "adapter") {
			const choices = SUBSCRIPTION_ADAPTERS.map((entry) => ({ id: entry.id, label: `${entry.label} — ${entry.endpoint}` }));
			const choice = await showOptionPicker(ctx, "订阅适配器", choices, isSubscriptionAdapter(draft.adapter) ? draft.adapter : "");
			if (choice) setValueAtPath(draft, "adapter", choice.id);
			continue;
		}
		if (id === "request.headers") {
			const result = await editHeaders(ctx, "请求头", headersToPairs(valueAtPath(draft, "request.headers")));
			if (result.type === "done") setValueAtPath(draft, "request.headers", result.pairs.length > 0 ? Object.fromEntries(result.pairs.map((pair) => [pair.key, pair.value])) : "");
			continue;
		}
		if (id === "raw") {
			await editRawEntry(ctx, draft);
			continue;
		}
		if (id.startsWith("credentials.")) {
			await editSecretField(ctx, draft, id, id.slice("credentials.".length));
			continue;
		}
		if (id === "request.timeoutSeconds" || id === "maxWidth") {
			const current = valueAtPath(draft, id);
			const value = await ctx.ui.input(`${rows.find((row) => row.id === id)!.label}（当前：${textOr(current, id === "maxWidth" ? "48" : "15")}，留空清除）`, textOr(current, ""));
			if (value === undefined) continue;
			const parsed = parseNumberInput(value);
			if (parsed === null) {
				void ctx.ui.notify("需要数字", "warning");
				continue;
			}
			setValueAtPath(draft, id, parsed);
			continue;
		}
		const spec = rows.find((row) => row.id === id);
		if (spec) await editTextField(ctx, draft, id, spec.label);
	}
}
