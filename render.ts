// render.ts
//
// 状态栏文本渲染。
// 约定：只展示额度窗口与已用百分比（不带 provider 前缀）；窗口**剩余**低于其阈值时才追加重置倒计时
// （`↺ 2h30m`，符号与倒计时间留一个空格，避免 `↺3h` 贴在一起）；文本中不出现逗号与尾部 `(...)`。
// 超宽时逐级降级：全窗口+倒计时 → 全窗口 → 5h+倒计时 → 5h。

import type { UsageState, UsageWindow } from "./types.ts";

/** 默认宽度预算（可见字符），可用 subscriptions.<id>.maxWidth 覆盖。 */
export const DEFAULT_STATUS_MAX_WIDTH = 48;
/**
 * 每个窗口的倒计时阈值：**剩余**百分比低于该值才显示 `↺`（语义对齐 pi-cloud-quota 的 resetThresholds）。
 * 可用 subscriptions.<id>.resetThresholds 按窗口覆盖，覆盖后仍继承未提及标签的默认值。
 */
export const DEFAULT_RESET_THRESHOLDS: Readonly<Record<string, number>> = { "5h": 80, wk: 40, mo: 30 };
/** 阈值表未列出的窗口标签（如 GLM 的 `1h`、Kimi 的 `150m`）使用的兜底阈值。 */
export const FALLBACK_RESET_THRESHOLD = 30;

function visibleLength(text: string): number {
	return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** 重置倒计时：复合单位、最多两位（参照 pi-usage，如 `1d4h` / `2h30m` / `45m`）；已过期或缺失返回 undefined。 */
export function formatResetCountdown(resetsAt: string | undefined, now = Date.now()): string | undefined {
	if (!resetsAt) return undefined;
	const ms = Date.parse(resetsAt) - now;
	if (!Number.isFinite(ms) || ms <= 0) return undefined;
	const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
	const days = Math.floor(totalMinutes / 1_440);
	const hours = Math.floor((totalMinutes % 1_440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
	return `${minutes}m`;
}

/** 该窗口的倒计时阈值；未列入阈值表时用兜底值。 */
function resetThresholdFor(label: string, thresholds: Readonly<Record<string, number>>): number {
	const value = thresholds[label];
	return typeof value === "number" && Number.isFinite(value) ? value : FALLBACK_RESET_THRESHOLD;
}

/** `now` 为 undefined 时不渲染倒计时，用于缓存文本与通知文案。 */
function renderWindows(windows: readonly UsageWindow[], now: number | undefined, thresholds: Readonly<Record<string, number>>): string {
	return windows
		.filter((window) => Number.isFinite(window.percent))
		.map((window) => {
			const segment = `${window.label} ${Math.round(window.percent)}%`;
			if (now === undefined) return segment;
			// 剩余额度尚充足时不提示重置时间，避免常态噪声。
			if (100 - window.percent >= resetThresholdFor(window.label, thresholds)) return segment;
			const countdown = formatResetCountdown(window.resetsAt, now);
			return countdown ? `${segment} ↺ ${countdown}` : segment;
		})
		.join(" · ");
}

/** 订阅窗口 → 文本：如 `5h 2% · wk 1% · mo 0%`；传入 now 时低于阈值的窗口追加倒计时。 */
export function renderQuotaText(
	windows: readonly UsageWindow[],
	maxWidth = DEFAULT_STATUS_MAX_WIDTH,
	now?: number,
	thresholds: Readonly<Record<string, number>> = DEFAULT_RESET_THRESHOLDS,
): string {
	const finite = windows.filter((window) => Number.isFinite(window.percent));
	if (finite.length === 0) return "--";
	const primary = finite.find((window) => window.label === "5h") ?? finite[0]!;
	const candidates = now === undefined
		? [renderWindows(finite, undefined, thresholds), renderWindows([primary], undefined, thresholds)]
		: [
			renderWindows(finite, now, thresholds),
			renderWindows(finite, undefined, thresholds),
			renderWindows([primary], now, thresholds),
			renderWindows([primary], undefined, thresholds),
		];
	for (const candidate of candidates) {
		if (maxWidth <= 0 || visibleLength(candidate) <= maxWidth) return candidate;
	}
	return candidates[candidates.length - 1]!;
}

/** 状态栏显示文本：loading/stale 文案与旧的 formatBalance 保持一致；quotaText 为重排后的窗口文本。 */
export function formatUsageState(state: UsageState, quotaText?: string): string {
	const text = quotaText ?? state.value?.text;
	if (state.loading) return text ? `${text} (refreshing…)` : "refreshing…";
	if (state.error) return text ? `${text} (stale)` : "unavailable";
	return text ?? "--";
}
