// tui/kv-editor.ts
//
// request.headers 等字符串键值对编辑器：Enter/n 编辑或新增，d 删除，Esc 完成返回。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { findPairIndex, type HeaderPair } from "../balance-draft.ts";
import { padLabel, showPersistentShortcutMenu, type MenuCursor } from "./persistent-menu.ts";

export type KvEditorResult = { type: "done"; pairs: HeaderPair[] } | { type: "cancel" };
/**
 * 打开键值对编辑器；返回 done 时携带编辑后的列表（空 key 行已过滤）。
 * cancel 表示用户放弃了整次编辑，调用方应保留原值。
 */
export async function editHeaders(
	ctx: ExtensionCommandContext,
	title: string,
	initial: readonly HeaderPair[],
): Promise<KvEditorResult> {
	let pairs: HeaderPair[] = [...initial];
	// [喵喵喵]: 起始光标定位到传入的第一行，方便"改一个 header 就走"的路径。
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const rows = pairs.map((pair, index) => ({
			id: String(index),
			label: `${padLabel(pair.key, 24)}${pair.value || "<空>"}`,
			searchText: `${pair.key}\n${pair.value}`,
		}));
		const action = await showPersistentShortcutMenu<"new" | "delete">(
			ctx,
			`${title}（${pairs.length} 项）`,
			"",
			rows,
			cursor,
			[
				{ input: "n", shortcut: "new" },
				{ input: "d", shortcut: "delete" },
			],
			{
				emptyLabel: "暂无 header",
				hints: [
					{ key: "↑↓", label: "选择" },
					{ key: "Enter", label: "编辑值" },
					{ key: "n", label: "新增" },
					{ key: "d", label: "删除" },
					{ key: "Esc", label: "完成" },
				],
			},
		);
		if (action.type === "cancel") return { type: "cancel" };
		if (action.type === "shortcut" && action.shortcut === "new") {
			const key = await ctx.ui.input("Header 名称（如 Authorization）", "");
			if (key === undefined) continue;
			const trimmedKey = key.trim();
			if (!trimmedKey) continue;
			const existing = findPairIndex(pairs, trimmedKey);
			const placeholder = existing >= 0 ? pairs[existing]!.value : "";
			const value = await ctx.ui.input(`Header ${trimmedKey} 的值（支持 {{apiKey}} 等插值）`, placeholder);
			if (value === undefined) continue;
			const pair: HeaderPair = { key: trimmedKey, value };
			if (existing >= 0) pairs[existing] = pair;
			else pairs.push(pair);
			cursor.index = existing >= 0 ? existing : pairs.length - 1;
			continue;
		}
		if (action.type === "shortcut" && action.shortcut === "delete") {
			const index = Number(action.id);
			const pair = pairs[index];
			if (!pair) continue;
			const confirmed = await ctx.ui.confirm("删除 header", `${pair.key}: ${pair.value || "<空>"}`);
			if (confirmed) {
				pairs = pairs.filter((_, position) => position !== index);
				cursor.index = Math.max(0, Math.min(cursor.index, pairs.length - 1));
			}
			continue;
		}
		// Enter：编辑选中项的 key 与 value。
		const index = Number(action.id);
		const pair = pairs[index];
		if (!pair) continue;
		const nextKey = await ctx.ui.input(`Header 名称（当前：${pair.key}）`, pair.key);
		if (nextKey === undefined) continue;
		const nextValue = await ctx.ui.input(`Header ${pair.key} 的值（支持 {{apiKey}} 等插值）`, pair.value);
		if (nextValue === undefined) continue;
		const trimmedKey = nextKey.trim();
		if (!trimmedKey) continue;
		pairs[index] = { key: trimmedKey, value: nextValue };
	}
}
