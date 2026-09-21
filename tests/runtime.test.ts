// 参照 pi-usage 查询运行时的回归测试：缓存优先快速路径、失败退避、切换 provider 中止在途请求。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import providerStatusExtension from "../index.ts";

// 余额芯片带 md-cash 前缀图标（见 index.ts BALANCE_ICON）。
const BALANCE_ICON = "\u{f0114}";

const CONFIG = [
  "templates: {}",
  "balances:",
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
  "subscriptions:",
  "  og:",
  "    adapter: opencode-go",
].join("\n");

function setup() {
  const dir = mkdtempSync(join("/tmp", "pi-provider-status-bk-"));
  writeFileSync(join(dir, "usage-config.yaml"), CONFIG);
  process.env.PI_CODING_AGENT_DIR = dir;

  let failFetch = false;
  let hangFetch = false;
  let fetchCount = 0;
  const abortedSignals: AbortSignal[] = [];
  const fetcher = (_input: string | URL, init?: RequestInit): Promise<Response> => {
    fetchCount++;
    if (init?.signal) abortedSignals.push(init.signal);
    if (String(_input).includes("opencode.ai"))
      return Promise.resolve(new Response(JSON.stringify({ usage: { rolling: { percent: 90, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() } } }), { status: 200 }));
    if (failFetch) return Promise.resolve(new Response("boom", { status: 500 }));
    if (hangFetch) return new Promise<Response>(() => undefined);
    return Promise.resolve(new Response(JSON.stringify({ remaining: 9 }), { status: 200 }));
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher as typeof fetch;

  type Handler = (event: unknown, ctx: unknown) => void;
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const statuses = new Map<string, string | undefined>();
  const notifications: string[] = [];
  let authCalls = 0;
  providerStatusExtension({
    registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, def),
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
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
    handler: (name: string): Handler => {
      const list = handlers.get(name);
      assert.ok(list && list.length > 0, `no handler registered for ${name}`);
      return list[0]!;
    },
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
    const modelSelectHandler = harness.handler("model_select");
    const ctx = harness.makeCtx("alpha");
    modelSelectHandler({}, ctx);
    await harness.settle();
    assert.equal(harness.getFetchCount(), 1);
    assert.equal(harness.statuses.get("balance"), `${BALANCE_ICON} 9 left`);
    assert.equal(harness.getAuthCalls(), 1);

    // 再次 model_select：缓存新鲜，直接复用，认证解析与 fetch 都不再发生。
    modelSelectHandler({}, ctx);
    await harness.settle();
    assert.equal(harness.getFetchCount(), 1);
    assert.equal(harness.getAuthCalls(), 1);
    assert.equal(harness.statuses.get("balance"), `${BALANCE_ICON} 9 left`);
  } finally {
    harness.restore();
  }
});

test("失败退避：事件触发的刷新在退避期内不再击打端点，强制刷新不受限", async () => {
  const harness = setup();
  try {
    const modelSelectHandler = harness.handler("model_select");
    const ctx = harness.makeCtx("alpha");
    harness.setFailFetch(true);
    modelSelectHandler({}, ctx);
    await harness.settle();
    assert.equal(harness.getFetchCount(), 1);
    assert.equal(harness.statuses.get("balance"), `${BALANCE_ICON} unavailable`);

    // 退避期内的事件刷新不再发请求（对应 pi-usage 的 FAILURE_BACKOFF_MS）。
    modelSelectHandler({}, ctx);
    await harness.settle();
    assert.equal(harness.getFetchCount(), 1);

    // /balance update（force）绕过退避。
    await harness.commands.get("usage")!.handler("update", ctx);
    await harness.settle();
    assert.equal(harness.getFetchCount(), 2);
  } finally {
    harness.restore();
  }
});

test("切换 provider 中止上一个在途请求（TUN 黑洞场景不再挂满超时时长）", async () => {
  const harness = setup();
  try {
    const modelSelectHandler = harness.handler("model_select");
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

test("未配置余额/订阅的 provider 两个键都不占位", async () => {
  const harness = setup();
  try {
    const modelSelectHandler = harness.handler("model_select");
    const ctx = harness.makeCtx("gamma");
    modelSelectHandler({}, ctx);
    await harness.settle();
    // 查询失败（未配置）也不能退化成 `󰄔 --` 这种像余额型的占位芯片。
    assert.equal(harness.statuses.get("balance"), undefined);
    assert.equal(harness.statuses.get("quota"), undefined);
    assert.match(harness.statuses.get("tps")!, /tok\/s/);
  } finally {
    harness.restore();
  }
});

test("订阅芯片低额度时带重置倒计时，缓存文本与通知保持不带倒计时", async () => {
  const harness = setup();
  try {
    const modelSelectHandler = harness.handler("model_select");
    const ctx = harness.makeCtx("og");
    modelSelectHandler({}, ctx);
    await harness.settle();
    assert.equal(harness.statuses.get("balance"), undefined);
    // 已用 90% → 剩余 10% < 20%：追加重置倒计时（符号与倒计时间留空格）。
    assert.match(harness.statuses.get("quota")!, /^5h 90% ↺ (2h|1h59m)$/);

    // 通知文案走缓存里的稳定文本，不带倒计时（倒计时是状态栏的即时重排）。
    await harness.commands.get("usage")!.handler("status", ctx);
    const notification = harness.notifications.at(-1)!;
    assert.match(notification, /Usage: og 5h 90%/);
    assert.ok(!notification.includes("↺"), notification);
  } finally {
    harness.restore();
  }
});

test("tps 只测生成区间：流式期间实时上屏，message_end 用权威 output 定案", async () => {
  const harness = setup();
  try {
    const onUpdate = harness.handler("message_update");
    const onEnd = harness.handler("message_end");
    const ctx = harness.makeCtx("alpha");
    const streamEvent = (event: Record<string, unknown>) => ({ assistantMessageEvent: event });
    const partial = { usage: { output: 0 } };

    onUpdate(streamEvent({ type: "text_start", contentIndex: 0, partial }), ctx);
    // 首个 delta：滑动窗立即给出读数（2 tokens / 最小跨度 0.25s），不必等到回合结束。
    onUpdate(streamEvent({ type: "text_delta", contentIndex: 0, delta: "hello world", partial }), ctx);
    assert.equal(harness.statuses.get("tps"), "8.0 tok/s");

    // 生成区间约 400ms 后流结束，usage.output 为权威分子（TTFT 与工具时间不在分母里）。
    await new Promise((r) => setTimeout(r, 400));
    onUpdate(streamEvent({ type: "text_delta", contentIndex: 0, delta: "again", partial: { usage: { output: 40 } } }), ctx);
    onEnd({ message: { role: "assistant", usage: { output: 40 } } }, ctx);
    const match = /^([0-9]+\.[0-9]) tok\/s$/.exec(harness.statuses.get("tps")!);
    assert.ok(match, harness.statuses.get("tps"));
    const tps = Number(match[1]);
    // 40 tokens / ~0.4s ≈ 100 tok/s（允许计时抖动）。
    assert.ok(tps >= 80 && tps <= 130, `unexpected tps: ${String(tps)}`);

    // 非 assistant 的 message_end（user/toolResult）不影响读数。
    onEnd({ message: { role: "user", usage: { output: 0 } } }, ctx);
    assert.equal(harness.statuses.get("tps"), `${tps.toFixed(1)} tok/s`);
  } finally {
    harness.restore();
  }
});
