import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { formatUsageState, renderQuotaText } from "./render.ts";
import { UsageService } from "./usage-service.ts";
import { readConfig, refreshInterval } from "./usage-config.ts";
import { ensureBaseConfigFile } from "./usage-edit.ts";
import { getBuiltinProviderIds } from "./builtin.ts";
import { redactSecrets } from "./usage-store.ts";
import {
	modelsPath,
	reconcileProviders,
	type ReconcileEvent,
	type ReconcileReport,
} from "./reconcile.ts";
import type { UsageState } from "./types.ts";

// 与 pi-model-manager `models-change-events.ts` 的广播通道一致；
// manager 是唯一发布者，这里复制常量以避免跨 package 依赖。
const MODELS_CHANGED_EVENT = "pi-model-manager:models-changed";
// 参照 pi-usage：失败后退避一段时间，避免端点持续故障时被事件风暴反复击打。
const FAILURE_BACKOFF_MS = 30_000;
// 余额芯片前缀图标，取自 pi-cc-extensions footer 同族（Nerd Fonts v3 MDI）：md-cash U+F0114，
// 与该项目 footer 缓存芯片的 md-database 󰆼（U+F01BC）同族；tok/s 不带图标。
const BALANCE_ICON = "\u{f0114}";
// 倒计时是本地重排（不发请求），参照 pi-usage 的 60s 重渲染节奏。
const COUNTDOWN_TICK_MS = 60_000;

export default function providerStatusExtension(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	const service = new UsageService(agentDir);
	const path = modelsPath(agentDir);
	// 配置缺失时初始化基础文件（旧 balance-config.yaml 会一次性迁移）；失败不阻断扩展加载。
	void ensureBaseConfigFile(agentDir).catch(() => undefined);
	let startedAt: number | undefined;
	let tps: number | undefined;
	let current: string | undefined;
	let sessionCtx: ExtensionContext | undefined;
	let inFlight: Promise<ReconcileReport | undefined> | undefined;
	// 查询运行时（参照 pi-usage）：generation + AbortController 保证只有最新的在途查询
	// 能写状态栏；切换 provider/session 时中止旧请求；失败退避避免端点故障时被反复击打。
	let refreshGeneration = 0;
	let refreshController: AbortController | undefined;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	let countdownTimer: ReturnType<typeof setTimeout> | undefined;
	const failureBackoff = new Map<string, number>();

	const notifySafe = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") => {
		try {
			let redacted = message;
			try {
				redacted = redactSecrets(message, readConfig(agentDir));
			} catch {
				// 配置不可读时保持原文（消息本身不含 secret）。
			}
			ctx.ui.notify(redacted, level);
		} catch {
			// stale ctx 或非 TUI 模式下忽略 UI 失败。
		}
	};

	const reportSummary = (report: ReconcileReport): string => {
		const parts: string[] = [];
		if (report.renamed.length > 0) parts.push(`renamed: ${report.renamed.map((entry) => `${entry.from} -> ${entry.to}`).join(", ")}`);
		if (report.quarantined.length > 0) parts.push(`quarantined: ${report.quarantined.join(", ")}`);
		if (report.conflicts.length > 0) parts.push(`conflicts: ${report.conflicts.join(", ")}`);
		if (report.added.length > 0) parts.push(`without balance config: ${report.added.join(", ")}`);
		if (report.orphan.length > 0) parts.push(`orphan: ${report.orphan.join(", ")}`);
		return parts.length > 0 ? parts.join("; ") : "usage config in sync";
	};

	const runReconcile = (events?: readonly ReconcileEvent[], confirmPrune?: (orphanIds: string[]) => Promise<boolean>) => {
		if (inFlight) return inFlight;
		inFlight = getBuiltinProviderIds()
			.catch(() => new Set<string>() as ReadonlySet<string>)
			.then((builtinIds) => reconcileProviders(agentDir, path, { events, confirmPrune, builtinIds }))
			.then((report) => {
				const ctx = sessionCtx;
				if (ctx && (report.conflicts.length > 0 || report.renamed.length > 0 || report.added.length > 0 || report.orphan.length > 0)) {
					notifySafe(ctx, `Provider usage reconcile: ${reportSummary(report)}`, report.conflicts.length > 0 ? "warning" : "info");
				}
				return report;
			})
			.catch((error: unknown) => {
				const ctx = sessionCtx;
				if (ctx) notifySafe(ctx, `Provider usage reconcile failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
				return undefined;
			})
			.finally(() => {
				inFlight = undefined;
			});
		return inFlight;
	};

	/** 生成速度文案：数字在前、单位在后，不带图标（`42.7 tok/s`）。 */
	const tpsText = (): string => (tps === undefined ? "-- tok/s" : `${tps.toFixed(1)} tok/s`);

	// 状态栏去重：每秒级的 tps 刷新与 60s 的倒计时重排不该让 footer 无谓重绘。
	const published = new Map<string, string | undefined>();
	const publish = (ctx: ExtensionContext, key: string, value: string | undefined) => {
		if (published.get(key) === value) return;
		published.set(key, value);
		ctx.ui.setStatus(key, value);
	};

	const update = (ctx: ExtensionContext) => {
		try {
			const state: UsageState | undefined = current ? service.get(current) : undefined;
			const kind = current ? service.kindOf(current) : undefined;
			const value = state?.value;
			// 窗口文本每次按当前时间重排：缓存里的 text 不含倒计时，否则重渲染会一直显示旧值。
			const quotaText = value?.kind === "subscription" ? renderQuotaText(value.windows, value.maxWidth, Date.now()) : undefined;
			const text = state ? formatUsageState(state, quotaText) : "--";
			// 订阅型与余额型分键发布，同一时刻只会有一个键有值；未配置的 provider 不占位。
			if (kind === "subscription") {
				publish(ctx, "quota", text);
				publish(ctx, "balance", undefined);
			} else if (kind === "balance") {
				publish(ctx, "balance", `${BALANCE_ICON} ${text}`);
				publish(ctx, "quota", undefined);
			} else {
				publish(ctx, "quota", undefined);
				publish(ctx, "balance", undefined);
			}
			publish(ctx, "tps", tpsText());
			scheduleCountdownTick(ctx, quotaText !== undefined && quotaText.includes("↺"));
		} catch {
			// stale ctx 或非 TUI 模式下忽略 UI 失败。
		}
	};

	const clearRefreshTimer = () => {
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = undefined;
	};

	const clearCountdownTimer = () => {
		if (countdownTimer) clearTimeout(countdownTimer);
		countdownTimer = undefined;
	};

	/** 仅在文本含倒计时时挂每分钟的本地重渲染；不触发任何网络查询。 */
	const scheduleCountdownTick = (ctx: ExtensionContext, active: boolean) => {
		clearCountdownTimer();
		if (!active) return;
		countdownTimer = setTimeout(() => {
			countdownTimer = undefined;
			const latest = sessionCtx;
			if (latest) update(latest);
		}, COUNTDOWN_TICK_MS);
		countdownTimer.unref?.();
	};

	/** 按刷新间隔调度的后台刷新（unref 的递归 setTimeout，不阻止进程退出）。 */
	const scheduleNextRefresh = (ctx: ExtensionContext) => {
		clearRefreshTimer();
		let interval: number;
		try {
			interval = refreshInterval(readConfig(agentDir));
		} catch {
			return;
		}
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			const ctx = sessionCtx;
			if (ctx) refreshInBackground(ctx, false, false);
		}, Math.max(1, interval) * 60_000);
		refreshTimer.unref?.();
	};

	const refresh = async (ctx: ExtensionContext, force = false): Promise<void> => {
		const model = ctx.model;
		if (!model) return;
		current = model.provider;
		// 缓存优先：新鲜结果立即上屏，不解析认证、不发请求——这是查询快的关键。
		if (!force && service.isFresh(current)) {
			update(ctx);
			scheduleNextRefresh(ctx);
			return;
		}
		const backoffUntil = failureBackoff.get(current);
		if (!force && backoffUntil !== undefined && backoffUntil > Date.now()) {
			update(ctx);
			return;
		}
		if (force) failureBackoff.delete(current);
		refreshGeneration += 1;
		refreshController?.abort();
		const controller = new AbortController();
		refreshController = controller;
		const generation = refreshGeneration;
		// 用与聊天请求完全相同的认证解析（models.json apiKey / OAuth），
		// 而不是 getProviderAuth：后者只查 auth.json 且大小写敏感，
		// pi 把小写 provider id 解析到 models.json 里大小写不同的 ID 时会拿不到 key。
		const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		// 等待认证解析期间模型已切换或出现了更新的查询：丢弃本次结果。
		if (controller.signal.aborted || generation !== refreshGeneration || ctx.model !== model) return;
		const source = resolved.ok
			? { baseUrl: model.baseUrl, apiKey: resolved.apiKey, headers: resolved.headers as Record<string, string> | undefined }
			: { baseUrl: model.baseUrl };
		const pending = service.refresh(model.provider, source, force, controller.signal);
		// 请求进行中就把 refreshing 状态画到状态栏；handler 立即返回，不阻塞 pi。
		update(ctx);
		const state = await pending;
		if (generation !== refreshGeneration || controller.signal.aborted) return;
		if (state.error) failureBackoff.set(model.provider, Date.now() + FAILURE_BACKOFF_MS);
		else failureBackoff.delete(model.provider);
		update(ctx);
		scheduleNextRefresh(ctx);
	};

	/** 后台刷新：绝不在命令 handler 里 await 网络请求，否则 pi 会把整个 agent 视为 busy。 */
	const refreshInBackground = (ctx: ExtensionContext, force: boolean, report: boolean) => {
		void refresh(ctx, force)
			.then(() => {
				if (report) showStatus(ctx);
			})
			.catch((error: unknown) => {
				notifySafe(ctx, `Usage refresh failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			});
	};

	const describeState = (state: UsageState): string => {
		const detail = state.value?.kind === "subscription" ? state.value.windows.map((window) => `${window.label} ${Math.round(window.percent)}%`).join(" · ") : state.value?.text;
		const suffix = state.error ? ` (${state.error})` : "";
		return `${detail ?? "no data"}${suffix}`;
	};

	const showStatus = (ctx: ExtensionContext) => {
		const state: UsageState = current ? service.get(current) : { loading: false };
		notifySafe(ctx, `Usage: ${current ?? "no model"} ${describeState(state)}; ${tpsText()}`, "info");
	};

	pi.registerCommand("usage", {
		description: "Provider usage status; subcommands: status (default), config (TUI), update, reconcile [--prune], help",
		handler: async (args, ctx) => {
			// 子命令风格与 workspace-preset 对齐：status / config / help + 领域扩展命令。
			const USAGE = "usage: /usage [status | config | update | reconcile [--prune]]";
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const command = (tokens[0] ?? "").toLowerCase();
			if (command === "" || command === "status") {
				void runReconcile();
				refreshInBackground(ctx, false, false);
				showStatus(ctx);
				return;
			}
			if (command === "config" || command === "edit") {
				if (!ctx.hasUI) {
					notifySafe(ctx, `/usage ${command} 需要交互式 TUI`, "warning");
					return;
				}
				const { runUsageDashboard } = await import("./tui/usage-dashboard.ts");
				await runUsageDashboard(ctx, agentDir);
				return;
			}
			if (command === "update") {
				showStatus(ctx);
				refreshInBackground(ctx, true, true);
				return;
			}
			if (command === "reconcile") {
				const prune = tokens.includes("--prune");
				if (prune && !ctx.hasUI) {
					notifySafe(ctx, "/usage reconcile --prune 需要交互式 TUI 进行确认", "warning");
					return;
				}
				const report = await runReconcile(undefined, prune
					? async (orphanIds) => ctx.ui.confirm("Quarantine orphan balance entries?", orphanIds.join(", "))
					: undefined);
				if (report) notifySafe(ctx, `Provider usage reconcile: ${reportSummary(report)}`, report.conflicts.length > 0 ? "warning" : "info");
				return;
			}
			if (command === "help") {
				notifySafe(ctx, USAGE, "info");
				return;
			}
			notifySafe(ctx, `未知子命令；${USAGE}`, "warning");
		},
	});

	pi.on("turn_start", (event: any) => {
		startedAt = event.timestamp;
	});

	pi.on("turn_end", (event, ctx) => {
		if (event.message?.role === "assistant" && startedAt !== undefined) {
			const message = event.message as AssistantMessage;
			tps = message.usage.output / Math.max((Date.now() - startedAt) / 1000, 0.001);
			update(ctx);
		}
	});

	pi.on("model_select", (_event, ctx) => {
		refreshInBackground(ctx, false, false);
	});

	pi.events.on(MODELS_CHANGED_EVENT, (payload) => {
		const events = extractEvents(payload);
		void runReconcile(events);
	});

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		update(ctx);
		refreshInBackground(ctx, false, false);
		void runReconcile();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionCtx = undefined;
		refreshGeneration += 1;
		refreshController?.abort();
		refreshController = undefined;
		clearRefreshTimer();
		clearCountdownTimer();
		failureBackoff.clear();
		ctx.ui.setStatus("balance", undefined);
		ctx.ui.setStatus("quota", undefined);
		ctx.ui.setStatus("tps", undefined);
		published.clear();
	});
}

function extractEvents(payload: unknown): ReconcileEvent[] | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const events = (payload as { events?: unknown }).events;
	if (!Array.isArray(events)) return undefined;
	return events.filter((event): event is ReconcileEvent => {
		if (!event || typeof event !== "object") return false;
		const candidate = event as { type?: unknown; oldId?: unknown; newId?: unknown; providerId?: unknown };
		if (candidate.type === "provider-rename") return typeof candidate.oldId === "string" && typeof candidate.newId === "string";
		if (candidate.type === "provider-delete") return typeof candidate.providerId === "string";
		return false;
	});
}
