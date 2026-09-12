// subscription.ts
//
// 订阅型 provider 的内置适配器。所有适配器只使用成熟认证：
//   - API key（models.json / pi 运行时解析）
//   - ChatGPT/Codex 使用 pi 运行时解析出的 OAuth access token（不读 cookie/旁路文件、不自建 refresh）
// 端点与字段语义参照已发布扩展：pi-cloud-quota（ollama/glm/kimi/chatgpt）、
// pi-quota-monitoring（commandcode/opencode-go）。

import { objectAt, valueAt } from "./usage-config.ts";
import { readBoundedBody } from "./usage-request.ts";
import type { FetchLike, JsonObject, SubscriptionAdapterId, UsageSource, UsageWindow } from "./types.ts";

export interface SubscriptionAdapterMeta {
	id: SubscriptionAdapterId;
	/** 默认短标签，可用条目的 label 覆盖。 */
	label: string;
	defaultBaseUrl: string;
	/** /usage 报告里的接口说明。 */
	endpoint: string;
	/** 来源参考，便于排障与审计。 */
	reference: string;
}

export const SUBSCRIPTION_ADAPTERS: readonly SubscriptionAdapterMeta[] = [
	{ id: "ollama", label: "Ollama", defaultBaseUrl: "https://ollama.com", endpoint: "GET /api/usage", reference: "pi-cloud-quota" },
	{ id: "commandcode", label: "CC", defaultBaseUrl: "https://api.commandcode.ai", endpoint: "GET /alpha/whoami → /alpha/billing/credits + /alpha/usage/summary", reference: "pi-quota-monitoring" },
	{ id: "opencode-go", label: "OG", defaultBaseUrl: "https://opencode.ai/zen/go/v1", endpoint: "GET /usage", reference: "pi-quota-monitoring" },
	{ id: "glm", label: "GLM", defaultBaseUrl: "https://api.z.ai", endpoint: "GET /api/monitor/usage/quota/limit", reference: "pi-cloud-quota" },
	{ id: "chatgpt", label: "Codex", defaultBaseUrl: "https://chatgpt.com", endpoint: "GET /backend-api/wham/usage", reference: "pi-cloud-quota" },
	{ id: "kimi", label: "Kimi", defaultBaseUrl: "https://api.kimi.com/coding/v1", endpoint: "GET /usages", reference: "pi-cloud-quota" },
];

export function adapterMeta(adapter: string): SubscriptionAdapterMeta | undefined {
	return SUBSCRIPTION_ADAPTERS.find((entry) => entry.id === adapter);
}

/** 按常见 provider ID 猜测默认适配器，供 `S` 新建订阅时预选。 */
const ADAPTER_BY_PROVIDER: Readonly<Record<string, SubscriptionAdapterId>> = {
	"ollama-cloud": "ollama",
	commandcode: "commandcode",
	"opencode-go": "opencode-go",
	zai: "glm",
	"zai-coding-cn": "glm",
	"bigmodel-cn": "glm",
	"openai-codex": "chatgpt",
	"kimi-coding": "kimi",
};

export function suggestAdapter(providerId: string): SubscriptionAdapterId | undefined {
	return ADAPTER_BY_PROVIDER[providerId];
}

/**
 * 区域端点默认值：GLM 中国区走 open.bigmodel.cn（pi provider `zai-coding-cn`），
 * 其余用适配器内置官方端点。条目里的 request.baseUrl 可覆盖。
 */
export function defaultBaseUrl(adapter: SubscriptionAdapterId, providerId: string): string {
	if (adapter === "glm" && /cn|bigmodel|zhipu/i.test(providerId)) return "https://open.bigmodel.cn";
	return adapterMeta(adapter)!.defaultBaseUrl;
}

export function isSubscriptionAdapter(value: unknown): value is SubscriptionAdapterId {
	return typeof value === "string" && SUBSCRIPTION_ADAPTERS.some((entry) => entry.id === value);
}

export interface SubscriptionFetchInput {
	providerId: string;
	adapter: SubscriptionAdapterId;
	source: UsageSource;
	entry: JsonObject;
	fetcher: FetchLike;
	signal?: AbortSignal;
	timeoutMs?: number;
	now?: () => number;
}

export interface SubscriptionUsage {
	windows: UsageWindow[];
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function numberValue(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const result = Number(value);
	return Number.isFinite(result) ? result : null;
}

/** 归一化 epoch 秒/毫秒或 ISO 字符串为 ISO。 */
export function parseDateish(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return new Date(value > 1e11 ? value : value * 1000).toISOString();
	}
	if (typeof value === "string" && value) {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
	}
	return undefined;
}

/** used/limit → 已用百分比；limit<=0 时按已用量决定 0% 或 100%。 */
export function usedPercent(used: unknown, limit: unknown): number | undefined {
	const u = numberValue(used);
	const l = numberValue(limit);
	if (u === null || l === null) return undefined;
	if (l <= 0) return u > 0 ? 100 : 0;
	return (u / l) * 100;
}

/** 全局重置网格：periodMs 周期、phaseMs 相位（如周一 00:00 UTC = epoch+4d）的下一次重置。 */
export function nextGridReset(nowMs: number, periodMs: number, phaseMs = 0): string {
	const remain = periodMs - ((nowMs - phaseMs) % periodMs);
	return new Date(nowMs + remain).toISOString();
}

/** CommandCode 月度账单按自然月重置。 */
export function nextMonthStart(nowMs: number): string {
	const now = new Date(nowMs);
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** 从 openai-codex 的 JWT access token 取 chatgpt_account_id。 */
export function jwtAccountId(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as JsonObject;
		const claim = payload["https://api.openai.com/auth"];
		const accountId = valueAt(claim, "chatgpt_account_id");
		return typeof accountId === "string" && accountId ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function originOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).origin;
	} catch {
		return baseUrl.replace(/\/+$/, "");
	}
}

function joinPath(baseUrl: string, path: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function extraHeaders(entry: JsonObject): Record<string, string> {
	const request = objectAt(entry, "request");
	const raw = objectAt(request, "headers");
	if (!raw) return {};
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) if (typeof value === "string") result[key] = value;
	return result;
}

function resolveToken(input: SubscriptionFetchInput): string {
	const credentials = objectAt(input.entry, "credentials") ?? {};
	const value = credentials.apiKey ?? credentials.accessToken ?? input.source.apiKey ?? input.source.accessToken ?? "";
	return typeof value === "string" ? value : String(value);
}

function baseUrlFor(input: SubscriptionFetchInput): string {
	// 与余额条目统一：只在 request.baseUrl 里覆盖端点；
	// 用量接口根地址与推理 baseUrl 不是一回事，默认按 provider 选择官方端点。
	const configured = (objectAt(input.entry, "request") ?? {}).baseUrl;
	return typeof configured === "string" && configured ? configured : defaultBaseUrl(input.adapter, input.providerId);
}

async function requestJson(url: string, init: RequestInit, input: SubscriptionFetchInput): Promise<unknown> {
	const timeout = AbortSignal.timeout(Math.max(1, input.timeoutMs ?? 15) * 1000);
	const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout;
	const response = await input.fetcher(url, { ...init, signal });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return JSON.parse(await readBoundedBody(response));
}

// ---------------------------------------------------------------------------
// 纯解析器（导出供单测）
// ---------------------------------------------------------------------------

/** Ollama Cloud：用量为 0-1 小数，且接口不返回重置时间，按全局网格推算。 */
export function parseOllamaUsage(json: unknown, nowMs: number): UsageWindow[] {
	const limits = objectAt(json, "limits") ?? {};
	const windows: UsageWindow[] = [];
	const session = numberValue(objectAt(limits, "session")?.usage);
	if (session !== null) windows.push({ label: "5h", percent: session * 100, resetsAt: nextGridReset(nowMs, 5 * 60 * 60 * 1000) });
	const weekly = numberValue(objectAt(limits, "weekly")?.usage);
	if (weekly !== null) windows.push({ label: "wk", percent: weekly * 100, resetsAt: nextGridReset(nowMs, 7 * 24 * 60 * 60 * 1000, 4 * 24 * 60 * 60 * 1000) });
	return windows;
}

/** OpenCode Go：/usage 直接返回 rolling(≈5h)/weekly/monthly 百分比与 resetsAt。 */
export function parseOpenCodeGoUsage(json: unknown): UsageWindow[] {
	const usage = objectAt(json, "usage") ?? {};
	const windows: UsageWindow[] = [];
	const specs: Array<[string, string]> = [["rolling", "5h"], ["weekly", "wk"], ["monthly", "mo"]];
	for (const [key, label] of specs) {
		const entry = objectAt(usage, key);
		const percent = numberValue(entry?.percent);
		if (percent === null) continue;
		windows.push({ label, percent, resetsAt: parseDateish(entry?.resetsAt) });
	}
	return windows;
}

/** CommandCode：credits（windowLimits + 余额）+ usage summary → 5h/周 + 月度账单。 */
export function parseCommandCodeUsage(credits: unknown, summary: unknown, nowMs: number): UsageWindow[] {
	const root = objectAt(credits, "credits") ?? {};
	const windowLimits = objectAt(credits, "windowLimits") ?? {};
	const windows: UsageWindow[] = [];
	const pushWindow = (key: string, label: string): void => {
		const entry = objectAt(windowLimits, key);
		if (!entry) return;
		const percent = usedPercent(entry.used, entry.cap);
		if (percent === undefined) return;
		windows.push({ label, percent, resetsAt: parseDateish(entry.resetAt) });
	};
	pushWindow("fiveHour", "5h");
	pushWindow("weekly", "wk");

	const monthly = numberValue(root.monthlyCredits) ?? 0;
	const purchased = numberValue(root.purchasedCredits) ?? 0;
	const free = numberValue(root.freeCredits) ?? 0;
	const remaining = monthly + purchased + free;
	const spent = numberValue(valueAt(summary, "totalCost")) ?? 0;
	const total = remaining + spent;
	if (total > 0) {
		windows.push({
			label: "mo",
			percent: (spent / total) * 100,
			resetsAt: parseDateish(root.monthlyResetAt) ?? nextMonthStart(nowMs),
		});
	}
	return windows;
}

/** GLM Coding Plan：data.limits[] 中 TOKENS_LIMIT，unit 3=小时、6=周；nextResetTime 为 epoch ms。 */
export function parseGlmUsage(json: unknown): UsageWindow[] {
	const data = objectAt(json, "data");
	const limits = data && Array.isArray(data.limits) ? data.limits : [];
	const windows: UsageWindow[] = [];
	for (const raw of limits) {
		const entry = objectAt(raw, "");
		if (!entry || entry.type !== "TOKENS_LIMIT") continue;
		const percent = numberValue(entry.percentage);
		if (percent === null) continue;
		const unit = numberValue(entry.unit);
		const number = numberValue(entry.number);
		const label = unit === 6 ? "wk" : unit === 3 && number === 5 ? "5h" : unit === 3 && number !== null ? `${number}h` : undefined;
		if (!label) continue;
		if (windows.some((window) => window.label === label)) continue;
		windows.push({ label, percent, resetsAt: parseDateish(entry.nextResetTime) });
	}
	return windows;
}

/** ChatGPT/Codex：rate_limit.primary_window(5h) / secondary_window(wk)。 */
export function parseChatGptUsage(json: unknown): UsageWindow[] {
	const rateLimit = objectAt(json, "rate_limit") ?? objectAt(json, "rate_limits") ?? {};
	const pairs: Array<[unknown, string]> = [
		[rateLimit.primary_window ?? rateLimit.primary ?? rateLimit.five_hour_limit ?? rateLimit.five_hour, "5h"],
		[rateLimit.secondary_window ?? rateLimit.secondary ?? rateLimit.weekly_limit ?? rateLimit.weekly, "wk"],
	];
	const windows: UsageWindow[] = [];
	for (const [raw, label] of pairs) {
		const win = objectAt(raw, "");
		if (!win) continue;
		let percent = numberValue(win.used_percent);
		if (percent === null) percent = usedPercent(win.used ?? win.usage, win.limit ?? win.total ?? win.allowed) ?? null;
		if (percent === null) continue;
		windows.push({ label, percent, resetsAt: parseDateish(win.reset_at ?? win.resets_at) });
	}
	return windows;
}

/** Kimi For Coding：最短 rolling 窗口(300min=5h) + weekly 汇总。 */
export function parseKimiUsage(json: unknown): UsageWindow[] {
	const windows: UsageWindow[] = [];
	let bestMinutes = Number.POSITIVE_INFINITY;
	let best: UsageWindow | undefined;
	const limits = Array.isArray((json as JsonObject | null)?.limits) ? ((json as JsonObject).limits as unknown[]) : [];
	for (const raw of limits) {
		const entry = objectAt(raw, "");
		const window = objectAt(entry, "window");
		if (!window || window.timeUnit !== "TIME_UNIT_MINUTE") continue;
		const minutes = numberValue(window.duration);
		const detail = objectAt(entry, "detail");
		const percent = usedPercent(detail?.used, detail?.limit);
		if (minutes === null || percent === undefined || minutes >= bestMinutes) continue;
		bestMinutes = minutes;
		best = { label: minutes === 300 ? "5h" : `${minutes}m`, percent, resetsAt: parseDateish(detail?.resetTime) };
	}
	if (best) windows.push(best);
	const usage = objectAt(json, "usage");
	const weekly = usedPercent(usage?.used, usage?.limit);
	if (weekly !== undefined) windows.push({ label: "wk", percent: weekly, resetsAt: parseDateish(usage?.resetTime) });
	return windows;
}

// ---------------------------------------------------------------------------
// 抓取器
// ---------------------------------------------------------------------------

export async function fetchSubscriptionUsage(input: SubscriptionFetchInput): Promise<SubscriptionUsage> {
	const meta = adapterMeta(input.adapter);
	if (!meta) throw new Error(`Unknown subscription adapter: ${input.adapter}`);
	const token = resolveToken(input);
	if (!token) throw new Error(`No credential resolved for ${input.providerId}`);
	const headers = { Accept: "application/json", ...extraHeaders(input.entry) };
	const nowMs = (input.now ?? Date.now)();
	switch (input.adapter) {
		case "ollama": {
			// 官方用量接口挂在站点根路径，去掉 provider baseUrl 可能携带的 /v1 等后缀。
			const json = await requestJson(joinPath(originOf(baseUrlFor(input)), "/api/usage"), { method: "GET", headers: { ...headers, Authorization: `Bearer ${token}` } }, input);
			return { windows: parseOllamaUsage(json, nowMs) };
		}
		case "commandcode": {
			const origin = originOf(baseUrlFor(input));
			const auth = { ...headers, Authorization: `Bearer ${token}` };
			try {
				const whoami = objectAt(await requestJson(joinPath(origin, "/alpha/whoami"), { method: "GET", headers: auth }, input), "");
				const orgId = objectAt(whoami?.org, "id");
				const query = typeof orgId === "string" && orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
				const [credits, summary] = await Promise.all([
					requestJson(joinPath(origin, `/alpha/billing/credits${query}`), { method: "GET", headers: auth }, input),
					requestJson(joinPath(origin, `/alpha/usage/summary${query}`), { method: "GET", headers: auth }, input),
				]);
				return { windows: parseCommandCodeUsage(credits, summary, nowMs) };
			} catch (error) {
				// Command Code 的用量接口与其 Provider API 同源：需要 Pro 及以上套餐的 API key，
				// 或 CLI/OAuth 登录（由 pi-commandcode-provider 的 oauth.getApiKey 自动刷新）。
				if (error instanceof Error && /^HTTP 40[13]$/.test(error.message)) {
					throw new Error(`${error.message}: Command Code 用量需要 Pro 及以上套餐的 API key，或用 \`/login commandcode\` 登录`);
				}
				throw error;
			}
		}
		case "opencode-go": {
			const json = await requestJson(joinPath(baseUrlFor(input), "/usage"), { method: "GET", headers: { ...headers, Authorization: `Bearer ${token}` } }, input);
			return { windows: parseOpenCodeGoUsage(json) };
		}
		case "glm": {
			const url = joinPath(originOf(baseUrlFor(input)), "/api/monitor/usage/quota/limit");
			// 区域实现有差异：先裸 key，401 再 Bearer。
			let json: unknown;
			try {
				json = await requestJson(url, { method: "GET", headers: { ...headers, Authorization: token } }, input);
			} catch (error) {
				if (!(error instanceof Error) || error.message !== "HTTP 401") throw error;
				json = await requestJson(url, { method: "GET", headers: { ...headers, Authorization: `Bearer ${token}` } }, input);
			}
			if (objectAt(json, "success") === false) throw new Error(`GLM coding plan unavailable: ${String(objectAt(json, "msg") ?? "")}`.trim());
			return { windows: parseGlmUsage(json) };
		}
		case "chatgpt": {
			const accountId = input.source.headers?.["chatgpt-account-id"] ?? jwtAccountId(token);
			const requestHeaders: Record<string, string> = { ...headers, Authorization: `Bearer ${token}`, Origin: "https://chatgpt.com", Referer: "https://chatgpt.com/" };
			if (accountId) requestHeaders["chatgpt-account-id"] = accountId;
			const json = await requestJson(joinPath(baseUrlFor(input), "/backend-api/wham/usage"), { method: "GET", headers: requestHeaders }, input);
			return { windows: parseChatGptUsage(json) };
		}
		case "kimi": {
			const json = await requestJson(joinPath(baseUrlFor(input), "/usages"), { method: "GET", headers: { ...headers, Authorization: `Bearer ${token}` } }, input);
			return { windows: parseKimiUsage(json) };
		}
	}
}
