import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { requestBalance } from "../balance-request.ts";
import { extractBalance } from "../balance-extractor.ts";
import { BalanceService } from "../balance-service.ts";
import { reconcileProviders } from "../reconcile.ts";

test("extracts nested and calculated balances with scaling", () => {
  assert.equal(extractBalance({ data: { total: 10, used: 2 } }, { totalPath: "data.total", usedPath: "data.used", scale: 0.5, unit: "$" }), "$4");
  assert.equal(extractBalance({ items: [{ remaining: 3 }] }, { remainingPath: "items.0.remaining", unit: "USD " }), "USD 3");
});

test("validity firstDefined/fallback/errorPath gate invalid responses", () => {
	const base = { remainingPath: "remaining", unit: "$" };
	// firstDefined：第一个存在的字段决定有效性。
	assert.throws(
		() => extractBalance({ is_active: false, message: "no quota" }, { ...base, errorPath: "message", validity: { firstDefined: ["is_active", "isValid"] } }),
		/no quota/,
	);
	assert.equal(extractBalance({ is_active: true, remaining: 3 }, { ...base, validity: { firstDefined: ["is_active", "isValid"] } }), "$3");
	// 字段都不存在时用 fallback 决定；fallback 为真则继续提取。
	assert.equal(extractBalance({ remaining: 7 }, { ...base, validity: { firstDefined: ["is_active", "isValid"], fallback: true } }), "$7");
	assert.throws(
		() => extractBalance({ remaining: 7 }, { ...base, validity: { firstDefined: ["is_active", "isValid"], fallback: false } }),
		/Balance query failed/,
	);
	// errorPath 缺失时回退 errorFallback。
	assert.throws(
		() => extractBalance({ is_active: false }, { ...base, errorPath: "message", validity: { firstDefined: ["is_active"] } }),
		/Balance query failed/,
	);
	// errorPath 优先于 errorFallback（allTruthy 失败同样生效）。
	assert.throws(
		() => extractBalance({ success: false, message: "unauthorized" }, { ...base, errorPath: "message", errorFallback: "Balance query failed", validity: { allTruthy: ["success"] } }),
		/unauthorized/,
	);
});

test("deduplicates concurrent refreshes and preserves stale value", async () => {
  const dir = mkdtempSync(join("/tmp", "pi-provider-status-"));
  writeFileSync(join(dir, "balance-config.yaml"), "profiles: {}\nproviders:\n  demo:\n    request:\n      url: https://example.invalid/balance\n    extractor:\n      remainingPath: remaining\n");
  let calls = 0;
  const fetcher = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return new Response(JSON.stringify({ remaining: 7 }), { status: 200 }); };
  const service = new BalanceService(dir, fetcher, () => 1000);
  const [a, b] = await Promise.all([service.refresh("demo", {}), service.refresh("demo", {})]);
  assert.equal(calls, 1); assert.equal(a.text, "7"); assert.equal(b.text, "7");
});

test("reports new and orphan provider IDs without mutating config", async () => {
  const dir = mkdtempSync(join("/tmp", "pi-provider-status-"));
  writeFileSync(join(dir, "balance-config.yaml"), "providers:\n  old: {}\n  keep: {}\n");
  const models = join(dir, "models.json"); writeFileSync(models, JSON.stringify({ providers: { keep: {}, fresh: {} } }));
  assert.deepEqual(await reconcileProviders(dir, models), { added: ["fresh"], existing: ["keep"], orphan: ["old"], renamed: [], conflicts: [], quarantined: [], changed: false });
});

test("supports profile aliases/inline objects and relative request URLs", async () => {
  const dir = mkdtempSync(join("/tmp", "pi-provider-status-"));
  writeFileSync(join(dir, "balance-config.yaml"), [
    "profiles:",
    "  sub2api: &sub2api",
    "    request:",
    "      url: '{{baseUrl}}/v1/usage'",
    "      headers:",
    "        Accept: application/json",
    "    extractor:",
    "      remainingPath: remaining",
    "      unit: $",
    "providers:",
    "  alias:",
    "    profile: *sub2api",
    "    request:",
    "      baseUrl: https://alias.example",
    "  inline:",
    "    profile:",
    "      request:",
    "        url: /v1/usage",
    "      extractor:",
    "        remainingPath: remaining",
    "    request:",
    "      baseUrl: https://inline.example",
    "    extractor:",
    "      unit: 'USD '",
  ].join("\n"));
  const urls: string[] = [];
  const fetcher = async (input: string | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ remaining: 7 }), { status: 200 });
  };
  assert.equal(await requestBalance(dir, "alias", { apiKey: "sk" }, fetcher), "$7");
  assert.equal(await requestBalance(dir, "inline", { apiKey: "sk" }, fetcher), "USD 7");
  assert.deepEqual(urls, ["https://alias.example/v1/usage", "https://inline.example/v1/usage"]);
});

test("providers 里未定义的同名模板回退到内置模板（openrouter）", async () => {
  const dir = mkdtempSync(join("/tmp", "pi-provider-status-"));
  writeFileSync(join(dir, "balance-config.yaml"), "profiles: {}\nproviders:\n  openrouter:\n    profile: openrouter\n");
  let url = "";
  let auth: string | undefined;
  const fetcher = async (input: string | URL, init?: { headers?: Record<string, string> }) => {
    url = String(input);
    auth = init?.headers?.Authorization;
    return new Response(JSON.stringify({ data: { total_credits: "10", total_usage: "4" } }), { status: 200 });
  };
  assert.equal(await requestBalance(dir, "openrouter", { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or" }, fetcher), "$6");
  assert.equal(url, "https://openrouter.ai/api/v1/credits");
  assert.equal(auth, "Bearer sk-or");
});

test("用户自定义的同名模板优先于内置模板", async () => {
  const dir = mkdtempSync(join("/tmp", "pi-provider-status-"));
  writeFileSync(join(dir, "balance-config.yaml"), [
    "profiles:",
    "  openrouter:",
    "    request:",
    "      url: https://custom.example/credits",
    "    extractor:",
    "      remainingPath: left",
    "      unit: C",
    "providers:",
    "  openrouter:",
    "    profile: openrouter",
  ].join("\n"));
  const fetcher = async () => new Response(JSON.stringify({ left: 9 }), { status: 200 });
  assert.equal(await requestBalance(dir, "openrouter", { baseUrl: "https://openrouter.ai/api/v1" }, fetcher), "C9");
});
