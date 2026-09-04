// 参照 pi-usage 查询运行时的回归测试：缓存优先快速路径、失败退避、切换 provider 中止在途请求。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import providerStatusExtension from "../index.ts";

const CONFIG = [
  "profiles: {}",
  "providers:",
  "  alpha:",
  "    request:",
  "      url: https://example.invalid/balance",
  "    extractor:",
  "      remainingPath: remaining",
  "  beta:",
  "    request:",
  "      url: https://example.invalid/balance",
  "    extractor:",
  "      remainingPath: remaining",
].join("\n");

function setup() {
  const dir = mkdtempSync(join("/tmp", "pi-provider-status-bk-"));
  writeFileSync(join(dir, "balance-config.yaml"), CONFIG);
  process.env.PI_CODING_AGENT_DIR = dir;

  let failFetch = false;
  let hangFetch = false;
  let fetchCount = 0;
  const abortedSignals: AbortSignal[] = [];
  const fetcher = (_input: string | URL, init?: RequestInit): Promise<Response> => {
    fetchCount++;
    if (init?.signal) abortedSignals.push(init.signal);
    if (failFetch) return Promise.resolve(new Response("boom", { status: 500 }));
    if (hangFetch) return new Promise<Response>(() => undefined);
    return Promise.resolve(new Response(JSON.stringify({ remaining: 9 }), { status: 200 }));
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher as typeof fetch;

  const eventHandlers: ((event: unknown, ctx: unknown) => void)[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const statuses = new Map<string, string | undefined>();
  const notifications: string[] = [];
  let authCalls = 0;
  providerStatusExtension({
    registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, def),
    on: (_name: string, handler: (event: unknown, ctx: unknown) => void) => eventHandlers.push(handler),
    events: { on: () => undefined },
  } as never);

  const makeCtx = (provider: string) => ({
    hasUI: false,
    model: { provider, id: "m", baseUrl: "https://example.invalid/v1" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => { authCalls++; return { ok: true, apiKey: "sk" }; },
    },
    ui: {
      setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
      notify(message: string) { notifications.push(message); },
    },
  });

  const settle = () => new Promise((r) => setTimeout(r, 50));

  return {
    eventHandlers,
    commands,
    statuses,
    notifications,
    makeCtx,
    settle,
    getFetchCount: () => fetchCount,
    getAuthCalls: () => authCalls,
    getAbortedSignals: () => abortedSignals,
    setFailFetch: (value: boolean) => { failFetch = value; },
    setHangFetch: (value: boolean) => { hangFetch = value; },
    restore: () => {
      globalThis.fetch = originalFetch;
      delete process.env.PI_CODING_AGENT_DIR;
    },
  };
}

test("缓存优先：新鲜结果直接上屏，不解析认证也不发请求", async () => {
  const harness = setup();
  try {
    // 注册顺序：turn_start, turn_end, model_select, session_start, session_shutdown
    const modelSelectHandler = harness.eventHandlers[2];
    const ctx = harness.makeCtx("alpha");
    modelSelectHandler({}, ctx);
    await harness.settle();
    assert.equal(harness.getFetchCount(), 1);
    assert.equal(harness.statuses.get("balance"), "9");
    assert.equal(harness.getAuthCalls(), 1);

    // 再次 model_select：缓存新鲜，直接复用，认证解析与 fetch 都不再发生。
    modelSelectHandler({}, ctx);
    await harness.settle();
    assert.equal(harness.getFetchCount(), 1);
    assert.equal(harness.getAuthCalls(), 1);
    assert.equal(harness.statuses.get("balance"), "9");
  } finally {
    harness.restore();
  }
});

test("失败退避：事件触发的刷新在退避期内不再击打端点，强制刷新不受限", async () => {
  const harness = setup();
  try {
    const modelSelectHandler = harness.eventHandlers[2];
    const ctx = harness.makeCtx("alpha");
    harness.setFailFetch(true);
    modelSelectHandler({}, ctx);
    await harness.settle();
    assert.equal(harness.getFetchCount(), 1);
    assert.equal(harness.statuses.get("balance"), "unavailable");

    // 退避期内的事件刷新不再发请求（对应 pi-usage 的 FAILURE_BACKOFF_MS）。
    modelSelectHandler({}, ctx);
    await harness.settle();
    assert.equal(harness.getFetchCount(), 1);

    // /balance update（force）绕过退避。
    await harness.commands.get("balance")!.handler("update", ctx);
    await harness.settle();
    assert.equal(harness.getFetchCount(), 2);
  } finally {
    harness.restore();
  }
});

test("切换 provider 中止上一个在途请求（TUN 黑洞场景不再挂满超时时长）", async () => {
  const harness = setup();
  try {
    const modelSelectHandler = harness.eventHandlers[2];
    const ctxA = harness.makeCtx("alpha");
    harness.setHangFetch(true);
    modelSelectHandler({}, ctxA);
    await harness.settle();
    assert.equal(harness.getFetchCount(), 1);

    // 切到 beta：alpha 的在途请求应立即收到 abort，而不是等超时。
    const ctxB = harness.makeCtx("beta");
    modelSelectHandler({}, ctxB);
    await harness.settle();
    assert.equal(harness.getFetchCount(), 2);
    const signals = harness.getAbortedSignals();
    assert.ok(signals.length >= 2);
    assert.equal(signals[0].aborted, true, "previous in-flight request should be aborted");
  } finally {
    harness.restore();
  }
});
