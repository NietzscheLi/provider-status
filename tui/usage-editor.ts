// tui/usage-editor.ts
//
// 余额条目编辑器：balances 覆盖配置与 templates 模板共用同一套两级表单。
//
//   第一层  请求 / 提取 / 有效性 / 凭据 / 绑定模板 / 原始 JSON / 保存
//   第二层  选中分节后逐字段编辑；Ctrl+S 在任意一层保存，Esc 逐层返回
//
// 草稿就是条目的 JsonObject 树（深拷贝），已知字段就地读写；
// "原始 JSON" 行用 ctx.ui.editor 兜底覆盖任意未列出的字段。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	headersToPairs,
	isRecord,
	maskSecret,
	parseNumberInput,
	setValueAtPath,
	stableStringify,
	valueAtPath,
} from "../usage-draft.ts";
import type { JsonObject } from "../types.ts";
import { editHeaders } from "./kv-editor.ts";
import { padLabel, showOptionPicker, showPersistentFormMenu, type MenuCursor, type MenuRow } from "./persistent-menu.ts";

export type EntryEditOutcome =
	| { action: "save"; entry: JsonObject }
	| { action: "cancel" };

interface FieldSpec {
	id: string;
	label: string;
	// 展示值；敏感字段由调用方先掩码。
	value: string;
	// 该字段当前是否继承自模板（provider 未覆盖）。
	inherited?: boolean;
}

interface BalanceSection {
	id: string;
	label: string;
	// 该分节对应的配置键前缀；帮助浮层里用它把中文标签映射回 YAML 键。
	keyPrefix: string;
	fields: readonly string[];
}

// 分节只影响呈现顺序，字段集合仍以 buildBalanceRows 为准（覆盖率测试据此校验）。
const BALANCE_SECTIONS: readonly BalanceSection[] = [
	{ id: "request", label: "请求", keyPrefix: "request.*", fields: ["request.url", "request.baseUrl", "request.method", "request.timeoutSeconds", "request.headers", "request.body"] },
	{ id: "extractor", label: "提取", keyPrefix: "extractor.*", fields: ["extractor.remainingPath", "extractor.totalPath", "extractor.usedPath", "extractor.unit", "extractor.unitPath", "extractor.scale", "extractor.errorPath", "extractor.errorFallback"] },
	{ id: "validity", label: "有效性", keyPrefix: "extractor.validity.*", fields: ["extractor.validity.path", "extractor.validity.allTruthy", "extractor.validity.firstDefined", "extractor.validity.fallback"] },
	{ id: "credentials", label: "凭据", keyPrefix: "credentials.*", fields: ["credentials.apiKey", "credentials.accessToken", "credentials.userId"] },
];

const BALANCE_FIELD_HELP: Record<string, string> = {
	template: "绑定模板后，未覆盖的字段自动继承模板；同名字段以本条目为准。",
	"request.url": "完整请求地址；设置后优先于 baseUrl 拼接的默认端点。",
	"request.baseUrl": "服务基地址；留空则使用 provider 在 pi 中的后端地址。",
	"request.method": "HTTP 方法，默认 GET。",
	"request.timeoutSeconds": "单次查询超时秒数，默认 10。",
	"request.headers": "请求头；值支持 {{apiKey}} 等占位符插值。",
	"request.body": "POST 请求体 JSON；对象会做占位符插值。",
	"extractor.remainingPath": "响应中剩余额度的字段路径；未设置时用 total - used。",
	"extractor.totalPath": "响应中总额度的字段路径。",
	"extractor.usedPath": "响应中已用额度的字段路径。",
	"extractor.unit": "额度单位文案（如 USD、tokens）；未设置时从响应中取。",
	"extractor.unitPath": "从响应中读取单位的字段路径。",
	"extractor.scale": "对提取结果乘以的缩放系数，默认 1。",
	"extractor.errorPath": "响应中错误信息的字段路径。",
	"extractor.errorFallback": "无法提取错误信息时展示的兜底文案。",
	"extractor.validity.path": "判断凭据是否有效的字段路径。",
	"extractor.validity.allTruthy": "这些路径都为真时视为有效（逗号分隔）。",
	"extractor.validity.firstDefined": "这些路径中任一非空时视为有效（逗号分隔）。",
	"extractor.validity.fallback": "无法判断时的兜底结论（true/false）。",
	"credentials.apiKey": "条目的 API Key 覆盖；留空则用 pi 运行时解析的凭据。",
	"credentials.accessToken": "条目的 access token 覆盖；留空则用 pi 运行时解析的凭据。",
	"credentials.userId": "部分接口需要的用户标识。",
	raw: "直接编辑整个条目的 JSON，保存后整体替换。",
};

function textOr(value: unknown, fallback: string): string {
	return typeof value === "string" && value ? value : value !== undefined && value !== null ? String(value) : fallback;
}

/** 字段的有效值：provider 自身覆盖优先，否则回退到绑定模板。 */
function effectiveAt(draft: JsonObject, base: JsonObject | undefined, path: string): unknown {
	const own = valueAtPath(draft, path);
	if (own !== undefined) return own;
	return base === undefined ? undefined : valueAtPath(base, path);
}

function isInherited(draft: JsonObject, base: JsonObject | undefined, path: string): boolean {
	return valueAtPath(draft, path) === undefined && base !== undefined && valueAtPath(base, path) !== undefined;
}

/** 字符串列表字段的展示值（extractor.validity.allTruthy / extractor.validity.firstDefined）。 */
function listText(draft: JsonObject, base: JsonObject | undefined, path: string): string {
	const value = effectiveAt(draft, base, path);
	if (value === undefined) return "<无>";
	return Array.isArray(value) && value.length > 0 ? value.map(String).join(", ") : String(value);
}

/** 有效性兜底字段（布尔）的展示值。 */
function fallbackText(draft: JsonObject, base: JsonObject | undefined): string {
	const value = effectiveAt(draft, base, "extractor.validity.fallback");
	return value === undefined ? "<无>" : String(value);
}

function buildBalanceRows(draft: JsonObject, showTemplate: boolean, templateNames: readonly string[], base?: JsonObject): FieldSpec[] {
	const rows: FieldSpec[] = [];
	if (showTemplate) {
		const rawTemplate = draft.template;
		const template = typeof rawTemplate === "string" ? rawTemplate : isRecord(rawTemplate) ? "(内联模板)" : "";
		rows.push({ id: "template", label: "绑定模板", value: template || "<不使用模板>" });
	}
	const eff = (path: string) => effectiveAt(draft, base, path);
	// 凭据不回退到模板：避免把模板密钥静默复制进 provider 条目。
	const row = (id: string, label: string, value: string, inherited = false): void => {
		rows.push({ id, label, value, inherited });
	};
	row("request.url", "请求 URL", `${textOr(eff("request.url"), "<未设置，可选>")}${isInherited(draft, base, "request.url") ? "（继承）" : ""}`);
	row("request.baseUrl", "Base URL", `${textOr(eff("request.baseUrl"), "<必填，默认用后端地址>")}${isInherited(draft, base, "request.baseUrl") ? "（继承）" : ""}`);
	row("request.method", "请求方法", textOr(eff("request.method"), "GET"));
	row("request.timeoutSeconds", "超时秒数", textOr(eff("request.timeoutSeconds"), "10"));
	row(
		"request.headers",
		"请求头",
		(() => {
			const count = headersToPairs(eff("request.headers")).length;
			const text = count > 0 ? `${count} 项` : "<无>";
			return valueAtPath(draft, "request.headers") === undefined && count > 0 ? `${text}（继承）` : text;
		})(),
	);
	row(
		"request.body",
		"请求体 JSON",
		valueAtPath(draft, "request.body") !== undefined
			? "已设置"
			: base !== undefined && valueAtPath(base, "request.body") !== undefined
				? "已设置（继承）"
				: "<无>",
	);
	row("extractor.remainingPath", "余量路径", `${textOr(eff("extractor.remainingPath"), "<直接用 total-used>")}${isInherited(draft, base, "extractor.remainingPath") ? "（继承）" : ""}`);
	row("extractor.totalPath", "总额路径", `${textOr(eff("extractor.totalPath"), "<未设置>")}${isInherited(draft, base, "extractor.totalPath") ? "（继承）" : ""}`);
	row("extractor.usedPath", "已用路径", `${textOr(eff("extractor.usedPath"), "<未设置>")}${isInherited(draft, base, "extractor.usedPath") ? "（继承）" : ""}`);
	row("extractor.unit", "单位", `${textOr(eff("extractor.unit"), "<响应里取>")}${isInherited(draft, base, "extractor.unit") ? "（继承）" : ""}`);
	row("extractor.unitPath", "单位路径", `${textOr(eff("extractor.unitPath"), "<未设置>")}${isInherited(draft, base, "extractor.unitPath") ? "（继承）" : ""}`);
	row("extractor.scale", "缩放系数", `${textOr(eff("extractor.scale"), "<1，不改余量>")}${isInherited(draft, base, "extractor.scale") ? "（继承）" : ""}`);
	row("extractor.errorPath", "错误信息路径", `${textOr(eff("extractor.errorPath"), "<未设置>")}${isInherited(draft, base, "extractor.errorPath") ? "（继承）" : ""}`);
	row("extractor.errorFallback", "失败提示", `${textOr(eff("extractor.errorFallback"), "Balance query failed")}${isInherited(draft, base, "extractor.errorFallback") ? "（继承）" : ""}`);
	row("extractor.validity.path", "有效性路径", `${textOr(eff("extractor.validity.path"), "<未设置>")}${isInherited(draft, base, "extractor.validity.path") ? "（继承）" : ""}`);
	row("extractor.validity.allTruthy", "有效性全真", `${listText(draft, base, "extractor.validity.allTruthy")}${isInherited(draft, base, "extractor.validity.allTruthy") ? "（继承）" : ""}`);
	row("extractor.validity.firstDefined", "有效性逐项", `${listText(draft, base, "extractor.validity.firstDefined")}${isInherited(draft, base, "extractor.validity.firstDefined") ? "（继承）" : ""}`);
	row("extractor.validity.fallback", "有效性兜底", `${fallbackText(draft, base)}${isInherited(draft, base, "extractor.validity.fallback") ? "（继承）" : ""}`);
	row("credentials.apiKey", "API Key", maskSecret(valueAtPath(draft, "credentials.apiKey")));
	row("credentials.accessToken", "Access Token", maskSecret(valueAtPath(draft, "credentials.accessToken")));
	row("credentials.userId", "用户 ID", textOr(valueAtPath(draft, "credentials.userId"), "<未设置>"));
	row("raw", "原始 JSON", "编辑整个条目");
	void templateNames;
	return rows;
}

/** 分节摘要：用有效值里最有信息量的一项概括该节。 */
function sectionSummary(sectionId: string, draft: JsonObject, base?: JsonObject): string {
	const eff = (path: string) => effectiveAt(draft, base, path);
	switch (sectionId) {
		case "request":
			return `${textOr(eff("request.method"), "GET")} · ${textOr(eff("request.url") ?? eff("request.baseUrl"), "<未设置>")}`;
		case "extractor": {
			const remaining = textOr(eff("extractor.remainingPath"), "");
			if (remaining) return `余量 ${remaining}`;
			const total = textOr(eff("extractor.totalPath"), "");
			const used = textOr(eff("extractor.usedPath"), "");
			if (total || used) return `总额 ${total || "—"} · 已用 ${used || "—"}`;
			return "<未设置>";
		}
		case "validity": {
			const path = textOr(eff("extractor.validity.path"), "");
			if (path) return `路径 ${path}`;
			if (eff("extractor.validity.allTruthy") !== undefined || eff("extractor.validity.firstDefined") !== undefined || eff("extractor.validity.fallback") !== undefined) return "已配置";
			return "<未设置>";
		}
		case "credentials": {
			const count = ["credentials.apiKey", "credentials.accessToken", "credentials.userId"].filter((path) => valueAtPath(draft, path) !== undefined && valueAtPath(draft, path) !== "").length;
			return count > 0 ? `${count} 项已设置` : "<用 pi 运行时凭据>";
		}
		default:
			return "";
	}
}

async function editTextField(
	ctx: ExtensionCommandContext,
	draft: JsonObject,
	path: string,
	title: string,
	base?: JsonObject,
): Promise<void> {
	// 预填写有效值（含模板继承）；留空清除 provider 覆盖，恢复继承。
	const current = effectiveAt(draft, base, path);
	const value = await ctx.ui.input(`${title}（当前：${textOr(current, "<空>")}，留空清除）`, typeof current === "string" ? current : current !== undefined && current !== null ? String(current) : "");
	if (value === undefined) return;
	setValueAtPath(draft, path, value.trim());
}

async function editSecretField(ctx: ExtensionCommandContext, draft: JsonObject, path: string, title: string): Promise<void> {
	const value = await ctx.ui.input(
		`${title}（当前：${maskSecret(valueAtPath(draft, path))}；留空保持原值，输入 - 清除）`,
		"",
	);
	if (value === undefined) return;
	const trimmed = value.trim();
	setValueAtPath(draft, path, trimmed === "-" ? "" : trimmed);
}

/** 字符串列表字段编辑：逗号分隔输入；留空清除覆盖、恢复继承。 */
async function editStringListField(ctx: ExtensionCommandContext, draft: JsonObject, path: string, title: string, base?: JsonObject): Promise<void> {
	const current = effectiveAt(draft, base, path);
	const text = Array.isArray(current) ? current.map(String).join(", ") : typeof current === "string" ? current : "";
	const value = await ctx.ui.input(`${title}（逗号分隔；当前：${text || "<无>"}；留空清除）`, text);
	if (value === undefined) return;
	const list = value.split(",").map((entry) => entry.trim()).filter(Boolean);
	setValueAtPath(draft, path, list.length > 0 ? list : "");
}

/** 布尔兼底字段编辑：true/false 转为布尔，其它文本原样保留；留空清除。 */
async function editFallbackField(ctx: ExtensionCommandContext, draft: JsonObject, base?: JsonObject): Promise<void> {
	const current = effectiveAt(draft, base, "extractor.validity.fallback");
	const value = await ctx.ui.input(`有效性兜底（当前：${fallbackText(draft, base)}；true/false，留空清除）`, typeof current === "boolean" ? String(current) : textOr(current, ""));
	if (value === undefined) return;
	const trimmed = value.trim();
	const lowered = trimmed.toLowerCase();
	setValueAtPath(draft, "extractor.validity.fallback", trimmed === "" ? "" : lowered === "true" ? true : lowered === "false" ? false : trimmed);
}

async function editBody(ctx: ExtensionCommandContext, draft: JsonObject, base?: JsonObject): Promise<void> {
	const own = valueAtPath(draft, "request.body");
	// 预填继承的请求体；确认后若与模板完全一致则不落为 provider 覆盖，保持继承。
	const inherited = own === undefined && base !== undefined ? valueAtPath(base, "request.body") : undefined;
	const current = own ?? inherited;
	const text = await ctx.ui.editor(
		"请求体 JSON（对象会做 {{apiKey}} 等插值）",
		current === undefined ? "{\n  \n}" : JSON.stringify(current, null, 2),
	);
	if (text === undefined) return;
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			if (own === undefined && inherited !== undefined && stableStringify(parsed) === stableStringify(inherited)) return;
			setValueAtPath(draft, "request.body", parsed);
			return;
		}
		void ctx.ui.notify("请求体必须是 JSON 对象，已放弃本次修改", "warning");
	} catch (error) {
		void ctx.ui.notify(`JSON 解析失败，已放弃本次修改：${error instanceof Error ? error.message : String(error)}`, "warning");
	}
}

async function editRawEntry(ctx: ExtensionCommandContext, draft: JsonObject): Promise<boolean> {
	const text = await ctx.ui.editor("原始条目 JSON（保存后整个替换）", JSON.stringify(draft, null, 2));
	if (text === undefined) return false;
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isRecord(parsed)) {
			void ctx.ui.notify("条目必须是 JSON 对象，已放弃本次修改", "warning");
			return false;
		}
		// 就地替换内容，保持调用方持有的 draft 引用有效。
		for (const key of Object.keys(draft)) delete draft[key];
		Object.assign(draft, parsed);
		return true;
	} catch (error) {
		void ctx.ui.notify(`JSON 解析失败，已放弃本次修改：${error instanceof Error ? error.message : String(error)}`, "warning");
		return false;
	}
}

/** 分节内的单字段编辑；按 id 分派到对应的输入控件。 */
async function editBalanceFieldById(
	ctx: ExtensionCommandContext,
	rows: readonly FieldSpec[],
	draft: JsonObject,
	id: string,
	base?: JsonObject,
): Promise<void> {
	const label = rows.find((row) => row.id === id)?.label ?? id;
	if (id === "request.method") {
		const choice = await showOptionPicker(
			ctx,
			"请求方法",
			[
				{ id: "GET", label: "GET" },
				{ id: "POST", label: "POST" },
			],
			textOr(effectiveAt(draft, base, "request.method"), "GET"),
		);
		if (choice) setValueAtPath(draft, "request.method", choice.id);
		return;
	}
	if (id === "request.headers") {
		// 预填合并后的请求头；仅当改动过才写回，避免“打开即 Esc”把继承值固化成覆盖。
		const initial = headersToPairs(effectiveAt(draft, base, "request.headers"));
		const result = await editHeaders(ctx, "请求头", initial);
		if (result.type === "done") {
			const next = result.pairs.length > 0 ? Object.fromEntries(result.pairs.map((pair) => [pair.key, pair.value])) : "";
			if (stableStringify(result.pairs) === stableStringify(initial)) return;
			setValueAtPath(draft, "request.headers", next);
		}
		return;
	}
	if (id === "request.body") {
		await editBody(ctx, draft, base);
		return;
	}
	if (id.startsWith("credentials.")) {
		await editSecretField(ctx, draft, id, label);
		return;
	}
	if (id === "extractor.validity.allTruthy" || id === "extractor.validity.firstDefined") {
		await editStringListField(ctx, draft, id, label, base);
		return;
	}
	if (id === "extractor.validity.fallback") {
		await editFallbackField(ctx, draft, base);
		return;
	}
	if (id === "request.timeoutSeconds" || id === "extractor.scale") {
		const current = effectiveAt(draft, base, id);
		const fallback = id === "request.timeoutSeconds" ? "10" : "<未设置>";
		const value = await ctx.ui.input(`${label}（当前：${textOr(current, fallback)}，留空清除）`, textOr(current, ""));
		if (value === undefined) return;
		const parsed = parseNumberInput(value);
		if (parsed === null) {
			void ctx.ui.notify("需要数字", "warning");
			return;
		}
		setValueAtPath(draft, id, parsed);
		return;
	}
	await editTextField(ctx, draft, id, label, base);
}

/** 分节的字段列表：Enter 编辑字段，Ctrl+S 保存，Esc 返回上一层。 */
async function editBalanceSection(
	ctx: ExtensionCommandContext,
	title: string,
	section: BalanceSection,
	draft: JsonObject,
	options: { showTemplate: boolean; templateNames: readonly string[]; base?: JsonObject },
): Promise<"back" | "save"> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const allRows = buildBalanceRows(draft, options.showTemplate, options.templateNames, options.base);
		const rows: MenuRow[] = allRows
			.filter((spec) => section.fields.includes(spec.id))
			.map((spec) => ({ id: spec.id, label: `${padLabel(spec.label, 16)}${spec.value}`, searchText: `${spec.id}\n${spec.label}\n${spec.value}` }));
		const action = await showPersistentFormMenu(ctx, `${title} › ${section.label}`, "", rows, cursor, {
			getContext: () => "Ctrl+S 保存 · Esc 返回",
			getDetailLines: (row) => {
				if (!row) return [];
				const help = BALANCE_FIELD_HELP[row.id];
				return help ? [`  ${row.id} — ${help}`] : [];
			},
			hints: [
				{ key: "↑↓", label: "选择" },
				{ key: "Enter", label: "编辑" },
				{ key: "Ctrl+S", label: "保存" },
				{ key: "Esc", label: "返回" },
			],
			helpLines: ["（继承）表示未覆盖、当前取自绑定模板；provider 同名字段覆盖模板。"],
		});
		if (action.type === "cancel") return "back";
		if (action.type === "save") return "save";
		await editBalanceFieldById(ctx, allRows, draft, action.id, options.base);
	}
}

function buildSectionRows(draft: JsonObject, options: { showTemplate: boolean; templateNames: readonly string[]; base?: JsonObject }): MenuRow[] {
	const templateValue = typeof draft.template === "string" ? draft.template : isRecord(draft.template) ? "(内联模板)" : "<不使用模板>";
	return [
		...BALANCE_SECTIONS.map((section) => ({
			id: section.id,
			label: `${padLabel(section.label, 14)}${sectionSummary(section.id, draft, options.base)}`,
			searchText: `${section.label} ${section.fields.join(" ")}`,
		})),
		...(options.showTemplate ? [{ id: "template", label: `${padLabel("绑定模板", 14)}${templateValue}`, searchText: "绑定模板 template" }] : []),
		{ id: "raw", label: `${padLabel("原始 JSON", 14)}编辑整个条目`, searchText: "原始 JSON raw" },
		{ id: "save", label: `${padLabel("保存", 14)}写入 usage-config.yaml`, searchText: "保存 save" },
	];
}

/**
 * 编辑一个余额条目草稿；draft 会被就地修改。
 * showTemplate 为 true 时（balances 条目）出现"绑定模板"行；
 * templateNames 用于展示与校验，保存前由调用方负责最终校验。
 */
export async function editBalanceEntry(
	ctx: ExtensionCommandContext,
	title: string,
	draft: JsonObject,
	options: { showTemplate: boolean; templateNames: readonly string[]; builtinOnlyTemplateNames?: readonly string[]; base?: JsonObject },
): Promise<EntryEditOutcome> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const rows = buildSectionRows(draft, options);
		const allRows = buildBalanceRows(draft, options.showTemplate, options.templateNames, options.base);
		const action = await showPersistentFormMenu(ctx, title, "", rows, cursor, {
			getContext: () => "Ctrl+S 保存 · Esc 返回",
			getDetailLines: (row) => {
				if (!row) return [];
				if (row.id === "template") return ["  template — 绑定模板后，未覆盖的字段自动继承模板；同名字段以本条目为准。"];
				if (row.id === "raw") return ["  raw — 直接编辑整个条目的 JSON，保存后整体替换。"];
				if (row.id === "save") return ["  usage-config.yaml — 写入磁盘；外部并发修改会被指纹校验拦下。"];
				const section = BALANCE_SECTIONS.find((candidate) => candidate.id === row.id);
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
				"分节进入后逐字段编辑；Ctrl+S 在任意一层都能保存。",
				"表单预填 template -> provider 合并后的有效值，（继承）表示未覆盖。",
				"留空通常表示清除覆盖、恢复继承；凭据留空则保持原值（输入 - 清除）。",
			],
		});
		if (action.type === "cancel") return { action: "cancel" };
		if (action.type === "save" || action.id === "save") return { action: "save", entry: draft };
		if (action.id === "template") {
			const choices = [
				{ id: "", label: "<不使用模板>" },
				...options.templateNames.map((name) => ({
					id: name,
					label: options.builtinOnlyTemplateNames?.includes(name) ? `${name}（内置）` : name,
				})),
			];
			const choice = await showOptionPicker(ctx, "绑定余额模板", choices, typeof draft.template === "string" ? draft.template : "");
			if (choice) setValueAtPath(draft, "template", choice.id);
			continue;
		}
		if (action.id === "raw") {
			await editRawEntry(ctx, draft);
			continue;
		}
		const section = BALANCE_SECTIONS.find((candidate) => candidate.id === action.id);
		if (!section) continue;
		const result = await editBalanceSection(ctx, title, section, draft, options);
		if (result === "save") return { action: "save", entry: draft };
	}
}

/** 导出给覆盖率测试：余额条目表单必须覆盖运行时读取的全部字段。 */
export function balanceFormRows(draft: JsonObject, showTemplate = true, templateNames: readonly string[] = [], base?: JsonObject) {
	return buildBalanceRows(draft, showTemplate, templateNames, base);
}
