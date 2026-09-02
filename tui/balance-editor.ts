// tui/balance-editor.ts
//
// 余额条目编辑器：providers 覆盖配置与 profiles 模板共用同一个表单。
// 草稿就是条目的 JsonObject 树（深拷贝），已知字段就地读写；
// "原始 JSON" 行用 ctx.ui.editor 兜底覆盖任意未列出的字段。Ctrl+S 保存，Esc 返回。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	headersToPairs,
	isRecord,
	maskSecret,
	parseNumberInput,
	setValueAtPath,
	stableStringify,
	valueAtPath,
} from "../balance-draft.ts";
import type { JsonObject } from "../types.ts";
import { editHeaders } from "./kv-editor.ts";
import { padLabel, showOptionPicker, showPersistentFormMenu, type MenuCursor } from "./persistent-menu.ts";

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

/** 字符串列表字段的展示值（validity.allTruthy / validity.firstDefined）。 */
function listText(draft: JsonObject, base: JsonObject | undefined, path: string): string {
	const value = effectiveAt(draft, base, path);
	if (value === undefined) return "<无>";
	return Array.isArray(value) && value.length > 0 ? value.map(String).join(", ") : String(value);
}

/** 有效性兜底字段（布尔）的展示值。 */
function fallbackText(draft: JsonObject, base: JsonObject | undefined): string {
	const value = effectiveAt(draft, base, "validity.fallback");
	return value === undefined ? "<无>" : String(value);
}

function buildRows(draft: JsonObject, showProfile: boolean, profileNames: readonly string[], base?: JsonObject): FieldSpec[] {
	const rows: FieldSpec[] = [];
	if (showProfile) {
		const rawProfile = draft.profile;
		const profile = typeof rawProfile === "string" ? rawProfile : isRecord(rawProfile) ? "(内联模板)" : "";
		rows.push({ id: "profile", label: "绑定模板", value: profile || "<不使用模板>" });
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
	row("validity.path", "有效性路径", `${textOr(eff("validity.path"), "<未设置>")}${isInherited(draft, base, "validity.path") ? "（继承）" : ""}`);
	row("validity.allTruthy", "有效性全真", `${listText(draft, base, "validity.allTruthy")}${isInherited(draft, base, "validity.allTruthy") ? "（继承）" : ""}`);
	row("validity.firstDefined", "有效性逐项", `${listText(draft, base, "validity.firstDefined")}${isInherited(draft, base, "validity.firstDefined") ? "（继承）" : ""}`);
	row("validity.fallback", "有效性兜底", `${fallbackText(draft, base)}${isInherited(draft, base, "validity.fallback") ? "（继承）" : ""}`);
	row("credentials.apiKey", "apiKey", maskSecret(valueAtPath(draft, "credentials.apiKey")));
	row("credentials.accessToken", "accessToken", maskSecret(valueAtPath(draft, "credentials.accessToken")));
	row("credentials.userId", "userId", textOr(valueAtPath(draft, "credentials.userId"), "<未设置>"));
	row("raw", "原始 JSON", "编辑整个条目");
	void profileNames;
	return rows;
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
	const current = effectiveAt(draft, base, "validity.fallback");
	const value = await ctx.ui.input(`有效性兜底（当前：${fallbackText(draft, base)}；true/false，留空清除）`, typeof current === "boolean" ? String(current) : textOr(current, ""));
	if (value === undefined) return;
	const trimmed = value.trim();
	const lowered = trimmed.toLowerCase();
	setValueAtPath(draft, "validity.fallback", trimmed === "" ? "" : lowered === "true" ? true : lowered === "false" ? false : trimmed);
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

/**
 * 编辑一个余额条目草稿；draft 会被就地修改。
 * showProfile 为 true 时（providers 条目）出现"绑定模板"行；
 * profileNames 用于展示与校验，保存前由调用方负责最终校验。
 */
export async function editBalanceEntry(
	ctx: ExtensionCommandContext,
	title: string,
	draft: JsonObject,
	options: { showProfile: boolean; profileNames: readonly string[]; base?: JsonObject },
): Promise<EntryEditOutcome> {
	const base = options.base;
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const rows = buildRows(draft, options.showProfile, options.profileNames, base);
		const menuRows = rows.map((row) => ({ id: row.id, label: `${padLabel(row.label, 16)}${row.value}`, searchText: `${row.label}\n${row.value}` }));
		const action = await showPersistentFormMenu(ctx, title, "", menuRows, cursor, {
			getSummaryLines: () => [
				`URL ${textOr(effectiveAt(draft, base, "request.url"), "—")} · 模板 ${textOr(draft.profile, options.showProfile ? "<无>" : "n/a")}`,
				"表单预填 profile -> provider 合并后的有效值，（继承）表示未覆盖；provider 同名字段覆盖模板",
				"Ctrl+S 保存到 balance-config.yaml；Esc 返回列表",
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
		if (id === "profile") {
			const choices = [
				{ id: "", label: "<不使用模板>" },
				...options.profileNames.map((name) => ({ id: name, label: name })),
			];
			const choice = await showOptionPicker(ctx, "绑定余额模板", choices, typeof draft.profile === "string" ? draft.profile : "");
			if (choice) setValueAtPath(draft, "profile", choice.id);
			continue;
		}
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
			continue;
		}
		if (id === "request.headers") {
			// 预填合并后的请求头；运行时按整体替换合并，保存写回完整集合语义不变。
			const result = await editHeaders(ctx, "请求头", headersToPairs(effectiveAt(draft, base, "request.headers")));
			if (result.type === "done") setValueAtPath(draft, "request.headers", result.pairs.length > 0 ? Object.fromEntries(result.pairs.map((pair) => [pair.key, pair.value])) : "");
			continue;
		}
		if (id === "request.body") {
			await editBody(ctx, draft, base);
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
		if (id === "validity.allTruthy" || id === "validity.firstDefined") {
			await editStringListField(ctx, draft, id, rows.find((row) => row.id === id)!.label, base);
			continue;
		}
		if (id === "validity.fallback") {
			await editFallbackField(ctx, draft, base);
			continue;
		}
		if (id === "request.timeoutSeconds" || id === "extractor.scale") {
			const current = effectiveAt(draft, base, id);
			const fallback = id === "request.timeoutSeconds" ? "10" : "<未设置>";
			const value = await ctx.ui.input(`${rows.find((row) => row.id === id)!.label}（当前：${textOr(current, fallback)}，留空清除）`, textOr(current, ""));
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
		if (spec) await editTextField(ctx, draft, id, spec.label, base);
	}
}
