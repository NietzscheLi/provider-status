// render.ts
//
// 状态栏文本渲染。
// 约定：只展示额度窗口与已用百分比（不带 provider 前缀与重置倒计时），
// 文本中不出现逗号与尾部 `(...)`；超宽时只保留 5h 窗口。

import type { UsageState, UsageWindow } from "./types.ts";

/** 默认宽度预算（可见字符），可用 subscriptions.<id>.maxWidth 覆盖。 */
export const DEFAULT_STATUS_MAX_WIDTH = 48;

function visibleLength(text: string): number {
	return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function renderWindows(windows: readonly UsageWindow[]): string {
	return windows
		.filter((window) => Number.isFinite(window.percent))
		.map((window) => `${window.label} ${Math.round(window.percent)}%`)
		.join(" · ");
}

/** 订阅窗口 → 状态栏文本：如 `5h 2% · wk 1% · mo 0%`，超宽时只保留 5h。 */
export function renderQuotaText(windows: readonly UsageWindow[], maxWidth = DEFAULT_STATUS_MAX_WIDTH): string {
	const finite = windows.filter((window) => Number.isFinite(window.percent));
	if (finite.length === 0) return "--";
	const text = renderWindows(finite);
	if (maxWidth <= 0 || visibleLength(text) <= maxWidth) return text;
	const primary = finite.find((window) => window.label === "5h") ?? finite[0]!;
	return renderWindows([primary]);
}

/** 状态栏显示文本：loading/stale 文案与旧的 formatBalance 保持一致。 */
export function formatUsageState(state: UsageState): string {
	const text = state.value?.text;
	if (state.loading) return text ? `${text} (refreshing…)` : "refreshing…";
	if (state.error) return text ? `${text} (stale)` : "unavailable";
	return text ?? "--";
}
