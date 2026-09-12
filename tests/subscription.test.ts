// 订阅适配器与迁移的回归测试：纯解析器、抓取分派、UsageService 类型判定、旧配置迁移。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { renderQuotaText } from "../render.ts";
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
import { ensureBaseConfigFile, migrateLegacyConfig } from "../usage-edit.ts";
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

test("renderQuotaText 只展示窗口与百分比，超宽时只留 5h", () => {
	const windows = [
		{ label: "5h", percent: 15, resetsAt: "2026-01-07T05:00:00.000Z" },
		{ label: "mo", percent: 3, resetsAt: "2026-02-01T00:00:00.000Z" },
	];
	assert.equal(renderQuotaText(windows, 100), "5h 15% · mo 3%");
	assert.equal(renderQuotaText(windows, 10), "5h 15%");
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
	writeFileSync(join(dir, "usage-config.yaml"), [
		"profiles: {}",
		"balances:",
		"  relay:",
		"    request: { url: 'https://relay.example/v1/usage' }",
		"    extractor: { remainingPath: remaining }",
		"subscriptions:",
		"  opencode-go:",
		"    adapter: opencode-go",
	].join("\n"));
	const service = new UsageService(dir, (async (input: string | URL) => {
		return String(input).includes("opencode.ai")
			? new Response(JSON.stringify({ usage: { rolling: { percent: 10 } } }), { status: 200 })
			: new Response(JSON.stringify({ remaining: 7 }), { status: 200 });
	}) as never);
	assert.equal(service.kindOf("opencode-go"), "subscription");
	assert.equal(service.kindOf("relay"), "balance");
	const relay = await service.refresh("relay", {});
	assert.equal(relay.value?.kind, "balance");
	assert.equal(relay.value?.text, "7");
	const subscription = await service.refresh("opencode-go", { apiKey: "sk" });
	assert.equal(subscription.value?.kind, "subscription");
	assert.equal(subscription.value?.text, "5h 10%");
});

test("旧 balance-config.yaml 一次性迁移到 usage-config.yaml，旧文件保留", async () => {
	const dir = makeDir();
	writeFileSync(join(dir, "balance-config.yaml"), [
		"refreshIntervalMinutes: 9",
		"profiles:",
		"  newapi: {}",
		"providers:",
		"  demo: { profile: newapi }",
		"orphanProviders:",
		"  gone: {}",
	].join("\n"));
	assert.equal(migrateLegacyConfig(dir), true);
	assert.ok(existsSync(join(dir, "balance-config.yaml")));
	const migrated = parseYaml(readFileSync(join(dir, "usage-config.yaml"), "utf8")) as Record<string, unknown>;
	assert.equal(migrated.refreshIntervalMinutes, 9);
	assert.deepEqual(migrated.balances, { demo: { profile: "newapi" } });
	assert.deepEqual(migrated.orphanBalances, { gone: {} });
	assert.equal(migrated.providers, undefined);
	assert.equal(migrated.orphanProviders, undefined);
	// 已存在新文件时不重复迁移，也不覆盖。
	writeFileSync(join(dir, "usage-config.yaml"), "balances: {}\n");
	await ensureBaseConfigFile(dir);
	assert.deepEqual(parseYaml(readFileSync(join(dir, "usage-config.yaml"), "utf8")), { balances: {} });
});
