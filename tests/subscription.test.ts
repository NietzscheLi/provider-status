// 订阅适配器回归测试：纯解析器、抓取分派、UsageService 类型判定。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_RESET_THRESHOLDS, FALLBACK_RESET_THRESHOLD, formatResetCountdown, renderQuotaText } from "../render.ts";
import {
	defaultBaseUrl,
	fetchSubscriptionUsage,
	jwtAccountId,
	parseChatGptUsage,
	parseCommandCodeUsage,
	parseGlmUsage,
	parseKimiUsage,
	parseOllamaUsage,
	parseOpenCodeGoUsage,
	suggestAdapter,
} from "../subscription.ts";
import { resetThresholdsFor } from "../usage-service.ts";
import { UsageService } from "../usage-service.ts";

function makeDir(): string {
	return mkdtempSync(join("/tmp", "pi-provider-status-sub-"));
}

test("Ollama：0-1 用量转百分比，reset 按全局网格推算", () => {
	const now = Date.parse("2026-01-07T03:00:00.000Z");
	const windows = parseOllamaUsage({ limits: { session: { usage: 0.34 }, weekly: { usage: 0.12 } } }, now);
	assert.equal(windows.length, 2);
	assert.equal(windows[0]!.label, "5h");
	assert.ok(Math.abs(windows[0]!.percent - 34) < 1e-9);
	assert.ok(windows[0]!.resetsAt);
	assert.equal(windows[1]!.label, "wk");
	assert.ok(Math.abs(windows[1]!.percent - 12) < 1e-9);
});

test("OpenCode Go：rolling/weekly/monthly 百分比与 resetsAt", () => {
	const windows = parseOpenCodeGoUsage({
		usage: {
			rolling: { percent: 15, resetsAt: "2026-01-07T05:00:00.000Z" },
			weekly: { percent: 3 },
			monthly: { percent: 27, resetsAt: "2026-02-01T00:00:00.000Z" },
		},
	});
	assert.deepEqual(windows.map((window) => window.label), ["5h", "wk", "mo"]);
	assert.equal(windows[0]!.percent, 15);
	assert.equal(windows[0]!.resetsAt, "2026-01-07T05:00:00.000Z");
});

test("CommandCode：5h 窗口 + 周窗口 + 月度 spent/total", () => {
	const now = Date.parse("2026-01-07T03:00:00.000Z");
	const windows = parseCommandCodeUsage(
		{
			credits: { monthlyCredits: 20, purchasedCredits: 5, freeCredits: 0, monthlyResetAt: "2026-02-01T00:00:00.000Z" },
			windowLimits: {
				fiveHour: { used: 3, cap: 20, resetAt: 1_800_000_000 },
				weekly: { used: 10, cap: 100 },
			},
		},
		{ totalCost: 25 },
		now,
	);
	assert.deepEqual(windows.map((window) => window.label), ["5h", "wk", "mo"]);
	assert.equal(windows[0]!.percent, 15);
	assert.equal(windows[1]!.percent, 10);
	// total = (20+5) + 25 = 50 → 25/50 = 50%
	assert.equal(windows[2]!.percent, 50);
	assert.equal(windows[2]!.resetsAt, "2026-02-01T00:00:00.000Z");
});

test("GLM：TOKENS_LIMIT 的 unit/number 映射为 5h/wk，nextResetTime 为 epoch ms", () => {
	const windows = parseGlmUsage({
		data: {
			limits: [
				{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 15, nextResetTime: 1_800_000_000_000 },
				{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 44 },
				{ type: "OTHER", unit: 6, percentage: 99 },
			],
		},
	});
	assert.deepEqual(windows.map((window) => window.label), ["5h", "wk"]);
	assert.equal(windows[0]!.percent, 15);
	assert.equal(windows[1]!.percent, 44);
});

test("ChatGPT/Codex：primary/secondary 窗口，used_percent 或 used/limit", () => {
	const windows = parseChatGptUsage({
		rate_limit: {
			primary_window: { used_percent: 5, reset_at: "2026-01-07T05:00:00.000Z" },
			secondary_window: { used: 24, limit: 100 },
		},
	});
	assert.deepEqual(windows.map((window) => window.label), ["5h", "wk"]);
	assert.equal(windows[0]!.percent, 5);
	assert.equal(windows[1]!.percent, 24);
});

test("Kimi：最短 rolling 窗口作为 5h + weekly 汇总", () => {
	const windows = parseKimiUsage({
		limits: [{ window: { timeUnit: "TIME_UNIT_MINUTE", duration: 300 }, detail: { used: 72, limit: 100, resetTime: "2026-01-07T05:00:00.000Z" } }],
		usage: { used: 14, limit: 100 },
	});
	assert.equal(windows[0]!.label, "5h");
	assert.equal(windows[0]!.percent, 72);
	assert.equal(windows[1]!.label, "wk");
	assert.ok(Math.abs(windows[1]!.percent - 14) < 1e-9);
});

test("jwtAccountId 从 openai-codex token 的 JWT claim 取 chatgpt_account_id", () => {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } })).toString("base64url");
	assert.equal(jwtAccountId(`h.${payload}.s`), "acct_123");
	assert.equal(jwtAccountId("not-a-jwt"), undefined);
});

test("renderQuotaText 只展示窗口与百分比，超宽时逐级降级", () => {
	const windows = [
		{ label: "5h", percent: 15, resetsAt: "2026-01-07T05:00:00.000Z" },
		{ label: "mo", percent: 3, resetsAt: "2026-02-01T00:00:00.000Z" },
	];
	assert.equal(renderQuotaText(windows, 100), "5h 15% · mo 3%");
	assert.equal(renderQuotaText(windows, 10), "5h 15%");
});

test("formatResetCountdown 用复合单位，最多两位；过期或缺失返回 undefined", () => {
	const now = Date.parse("2026-01-07T00:00:00.000Z");
	assert.equal(formatResetCountdown("2026-01-08T04:00:00.000Z", now), "1d4h");
	assert.equal(formatResetCountdown("2026-01-07T02:30:00.000Z", now), "2h30m");
	assert.equal(formatResetCountdown("2026-01-07T00:45:00.000Z", now), "45m");
	assert.equal(formatResetCountdown("2026-01-07T05:00:00.000Z", now), "5h");
	// 已过期不给误导性的 `0m`；缺字段/非法值同样不显示。
	assert.equal(formatResetCountdown("2026-01-06T00:00:00.000Z", now), undefined);
	assert.equal(formatResetCountdown(undefined, now), undefined);
	assert.equal(formatResetCountdown("not-a-date", now), undefined);
});

test("倒计时仅在窗口剩余低于其阈值时出现，且符号与倒计时之间留空格", () => {
	const now = Date.parse("2026-01-07T00:00:00.000Z");
	const fiveHour = (percent: number) => [{ label: "5h", percent, resetsAt: "2026-01-07T02:30:00.000Z" }];
	// 默认阈值：5h 剩余 <80%（即已用 >20%）就提示重置时间。
	assert.equal(renderQuotaText(fiveHour(20.1), 100, now), "5h 20% ↺ 2h30m");
	// 剩余恰好等于阈值（未低于）不显示倒计时。
	assert.equal(renderQuotaText(fiveHour(20), 100, now), "5h 20%");
	// 不传 now 时永远不渲染倒计时（缓存文本与通知文案保持稳定）。
	assert.equal(renderQuotaText(fiveHour(90), 100), "5h 90%");
	// 阈值表按窗口生效：wk 默认 40、mo 默认 30。
	const windows = [
		{ label: "wk", percent: 61, resetsAt: "2026-01-09T00:00:00.000Z" },
		{ label: "mo", percent: 71, resetsAt: "2026-02-01T00:00:00.000Z" },
	];
	assert.equal(renderQuotaText(windows, 100, now), "wk 61% ↺ 2d · mo 71% ↺ 25d");
	assert.equal(renderQuotaText([{ ...windows[0]!, percent: 60 }], 100, now), "wk 60%");
});

test("倒计时阈值可按窗口覆盖，未列出的标签用兜底阈值", () => {
	const now = Date.parse("2026-01-07T00:00:00.000Z");
	const windows = [{ label: "5h", percent: 20.5, resetsAt: "2026-01-07T02:30:00.000Z" }];
	// 覆盖为 50：剩余 79.5% ≥ 50 → 不显示。
	assert.equal(renderQuotaText(windows, 100, now, { ...DEFAULT_RESET_THRESHOLDS, "5h": 50 }), "5h 21%");
	// 覆盖为 0（或负数）等于关闭该窗口的倒计时。
	assert.equal(renderQuotaText(windows, 100, now, { ...DEFAULT_RESET_THRESHOLDS, "5h": 0 }), "5h 21%");
	// 未列出的标签（GLM 的 `1h`、Kimi 的 `150m`）用兜底阈值。
	const odd = [{ label: "1h", percent: 100 - FALLBACK_RESET_THRESHOLD + 1, resetsAt: "2026-01-07T00:30:00.000Z" }];
	assert.equal(renderQuotaText(odd, 100, now, {}), "1h 71% ↺ 30m");
	assert.equal(renderQuotaText([{ ...odd[0]!, percent: 50 }], 100, now, {}), "1h 50%");
});

test("超宽时先丢倒计时，再丢非 5h 窗口", () => {
	const now = Date.parse("2026-01-07T00:00:00.000Z");
	const windows = [
		{ label: "5h", percent: 90, resetsAt: "2026-01-07T02:30:00.000Z" },
		{ label: "mo", percent: 90, resetsAt: "2026-02-01T00:00:00.000Z" },
	];
	// 可见宽度：全窗口+倒计时 29 字，全窗口 15 字，5h+倒计时 14 字，5h 6 字。
	assert.equal(renderQuotaText(windows, 100, now), "5h 90% ↺ 2h30m · mo 90% ↺ 25d");
	assert.equal(renderQuotaText(windows, 15, now), "5h 90% · mo 90%");
	assert.equal(renderQuotaText(windows, 14, now), "5h 90% ↺ 2h30m");
	assert.equal(renderQuotaText(windows, 6, now), "5h 90%");
});

test("suggestAdapter 覆盖常见 provider ID", () => {
	assert.equal(suggestAdapter("ollama-cloud"), "ollama");
	assert.equal(suggestAdapter("commandcode"), "commandcode");
	assert.equal(suggestAdapter("opencode-go"), "opencode-go");
	assert.equal(suggestAdapter("zai"), "glm");
	assert.equal(suggestAdapter("zai-coding-cn"), "glm");
	assert.equal(suggestAdapter("openai-codex"), "chatgpt");
	assert.equal(suggestAdapter("kimi-coding"), "kimi");
	assert.equal(suggestAdapter("unknown"), undefined);
});

test("GLM 区域默认端点按 provider ID 选择，可被 request.baseUrl 覆盖", async () => {
	assert.equal(defaultBaseUrl("glm", "zai"), "https://api.z.ai");
	assert.equal(defaultBaseUrl("glm", "zai-coding-cn"), "https://open.bigmodel.cn");
	const seen: string[] = [];
	const fetcher = async (input: string | URL) => {
		seen.push(String(input));
		return new Response(JSON.stringify({ data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1 }] } }), { status: 200 });
	};
	await fetchSubscriptionUsage({ providerId: "zai-coding-cn", adapter: "glm", source: { apiKey: "sk" }, entry: {}, fetcher });
	assert.deepEqual(seen, ["https://open.bigmodel.cn/api/monitor/usage/quota/limit"]);
	seen.length = 0;
	await fetchSubscriptionUsage({ providerId: "zai-coding-cn", adapter: "glm", source: { apiKey: "sk" }, entry: { request: { baseUrl: "https://proxy.example" } }, fetcher });
	assert.deepEqual(seen, ["https://proxy.example/api/monitor/usage/quota/limit"]);
});

test("fetchSubscriptionUsage：opencode-go 走官方 API 并解析窗口", async () => {
	const urls: string[] = [];
	const fetcher = async (input: string | URL) => {
		urls.push(String(input));
		return new Response(JSON.stringify({ usage: { rolling: { percent: 10 }, monthly: { percent: 20 } } }), { status: 200 });
	};
	const result = await fetchSubscriptionUsage({
		providerId: "opencode-go",
		adapter: "opencode-go",
		source: { baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "sk" },
		entry: {},
		fetcher,
	});
	assert.deepEqual(urls, ["https://opencode.ai/zen/go/v1/usage"]);
	assert.deepEqual(result.windows.map((window) => window.label), ["5h", "mo"]);
});

test("fetchSubscriptionUsage：commandcode 先 whoami 再并行 credits/summary", async () => {
	const seen: string[] = [];
	const fetcher = async (input: string | URL) => {
		const url = String(input);
		seen.push(url);
		if (url.endsWith("/alpha/whoami")) return new Response(JSON.stringify({ org: { id: "org_1" } }), { status: 200 });
		if (url.includes("/alpha/billing/credits")) return new Response(JSON.stringify({ credits: { monthlyCredits: 10 }, windowLimits: { fiveHour: { used: 1, cap: 4 } } }), { status: 200 });
		return new Response(JSON.stringify({ totalCost: 0 }), { status: 200 });
	};
	const result = await fetchSubscriptionUsage({
		providerId: "commandcode",
		adapter: "commandcode",
		source: { baseUrl: "https://api.commandcode.ai/provider/v1", apiKey: "sk" },
		entry: {},
		fetcher,
	});
	assert.ok(seen[0]!.endsWith("/alpha/whoami"));
	assert.ok(seen.every((url) => url.startsWith("https://api.commandcode.ai/alpha/")));
	assert.equal(result.windows[0]!.label, "5h");
	assert.equal(result.windows[0]!.percent, 25);
});

test("fetchSubscriptionUsage：commandcode 401/403 给出套餐/登录提示", async () => {
	const fetcher = async () => new Response("unauthorized", { status: 401 });
	await assert.rejects(
		fetchSubscriptionUsage({ providerId: "commandcode", adapter: "commandcode", source: { apiKey: "sk" }, entry: {}, fetcher }),
		/Pro 及以上套餐的 API key/,
	);
});

test("UsageService 按配置分派订阅/余额并记录 kind", async () => {
	const dir = makeDir();
	writeFileSync(join(dir, "usage-config.json"), JSON.stringify({
		templates: {},
		balances: { relay: { request: { url: "https://relay.example/v1/usage" }, extractor: { remainingPath: "remaining" } } },
		subscriptions: { "opencode-go": { adapter: "opencode-go" } },
	}, null, 2));
	const service = new UsageService(dir, (async (input: string | URL) => {
		return String(input).includes("opencode.ai")
			? new Response(JSON.stringify({ usage: { rolling: { percent: 10 } } }), { status: 200 })
			: new Response(JSON.stringify({ remaining: 7 }), { status: 200 });
	}) as never);
	assert.equal(service.kindOf("opencode-go"), "subscription");
	assert.equal(service.kindOf("relay"), "balance");
	const relay = await service.refresh("relay", {});
	assert.equal(relay.value?.kind, "balance");
	assert.equal(relay.value?.text, "7 left");
	const subscription = await service.refresh("opencode-go", { apiKey: "sk" });
	assert.equal(subscription.value?.kind, "subscription");
	assert.equal(subscription.value?.text, "5h 10%");
	// 未配置 resetThresholds 时携带默认阈值表，供状态栏重排使用。
	assert.deepEqual(subscription.value?.kind === "subscription" ? subscription.value.resetThresholds : undefined, { ...DEFAULT_RESET_THRESHOLDS });
});

test("resetThresholdsFor 在默认表上按窗口覆盖，非法值忽略", () => {
	assert.deepEqual(resetThresholdsFor({}), { ...DEFAULT_RESET_THRESHOLDS });
	assert.deepEqual(resetThresholdsFor({ resetThresholds: { "5h": 50, "1h": 20 } }), { ...DEFAULT_RESET_THRESHOLDS, "5h": 50, "1h": 20 });
	// JSON 里写成字符串的数字可用；不可转换的值退回默认。
	assert.deepEqual(resetThresholdsFor({ resetThresholds: { wk: "35", mo: "abc" } }), { ...DEFAULT_RESET_THRESHOLDS, wk: 35 });
});
