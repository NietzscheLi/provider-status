// render.ts
//
// starship 友好的状态文本渲染。
// 约束来自 @narumitw/pi-starship 的 extension_status 模块：
//   - 尾部的 `(...)` 会被剥离，逗号会被替换为空格，因此这里不产出这两种形态；
//   - 显示宽度有限，超宽时按"全部 → 去掉 reset → 只保留 5h"逐级降级。

import type { UsageState, UsageWindow } from "./types.ts";

/** 默认宽度预算（可见字符），可用 subscriptions.<id>.maxWidth 覆盖。 */
export const DEFAULT_STATUS_MAX_WIDTH = 48;

/** `↺3h` / `↺45m` / `↺2d`；已过期或无法解析时返回 undefined。 */
export function formatReset(resetsAt: string | undefined, nowMs: number): string | undefined {
	if (!resetsAt) return undefined;
	const ms = Date.parse(resetsAt) - nowMs;
	if (!Number.isFinite(ms) || ms <= 0) return undefined;
	const minutes = ms / 60_000;
	if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
	const hours = minutes / 60;
	if (hours < 24) return `${Math.round(hours)}h`;
	return `${Math.round(hours / 24)}d`;
}

function visibleLength(text: string): number {
	return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function renderWindows(label: string, windows: readonly UsageWindow[], nowMs: number, withReset: boolean): string {
	const parts = windows
		.filter((window) => Number.isFinite(window.percent))
		.map((window) => {
			const reset = withReset ? formatReset(window.resetsAt, nowMs) : undefined;
			return `${window.label} ${Math.round(window.percent)}%${reset ? ` ↺${reset}` : ""}`;
		});
	return parts.length > 0 ? `${label} ${parts.join(" · ")}` : label;
}

/** 订阅窗口 → 状态栏文本，超宽时逐级降级。 */
export function renderQuotaText(label: string, windows: readonly UsageWindow[], nowMs = Date.now(), maxWidth = DEFAULT_STATUS_MAX_WIDTH): string {
	const finite = windows.filter((window) => Number.isFinite(window.percent));
	const fits = (text: string): boolean => maxWidth <= 0 || visibleLength(text) <= maxWidth;
	let text = renderWindows(label, finite, nowMs, true);
	if (fits(text)) return text;
	text = renderWindows(label, finite, nowMs, false);
	if (fits(text)) return text;
	const primary = finite.find((window) => window.label === "5h") ?? finite[0];
	return primary ? renderWindows(label, [primary], nowMs, false) : label;
}

/** 状态栏显示文本：loading/stale 文案与旧的 formatBalance 保持一致。 */
export function formatUsageState(state: UsageState): string {
	const text = state.value?.text;
	if (state.loading) return text ? `${text} (refreshing…)` : "refreshing…";
	if (state.error) return text ? `${text} (stale)` : "unavailable";
	return text ?? "--";
}
