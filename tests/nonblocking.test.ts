// 非阻塞回归测试：/balance 命令 handler 必须立即返回，余额请求在后台完成；
// 请求挂起期间 pi（agent session）不能被阻塞。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import providerStatusExtension from "../index.ts";

const CONFIG = [
  "profiles: {}",
  "providers:",
  "  demo:",
  "    request:",
  "      url: https://example.invalid/balance",
  "    extractor:",
  "      remainingPath: remaining",
].join("\n");

interface Harness {
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  statuses: Map<string, string | undefined>;
  notifications: string[];
  ctx: unknown;
  release: () => void;
  getFetchCount: () => number;
  restore: () => void;
}

function setup(hangFetch: boolean): Harness {
  const dir = mkdtempSync(join("/tmp", "pi-provider-status-nb-"));
  writeFileSync(join(dir, "balance-config.yaml"), CONFIG);
  process.env.PI_CODING_AGENT_DIR = dir;

  let finishFetch: ((response: Response) => void) | undefined;
  let fetchCount = 0;
  const fetcher = (_input: string | URL, init?: RequestInit): Promise<Response> => {
    fetchCount++;
    if (!hangFetch) return Promise.resolve(new Response(JSON.stringify({ remaining: 7 }), { status: 200 }));
    return new Promise<Response>((resolve, reject) => {
      finishFetch = resolve;
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher as typeof fetch;

  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const statuses = new Map<string, string | undefined>();
  const notifications: string[] = [];
  const fakePi = {
    registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, def),
    on: () => undefined,
    events: { on: () => undefined },
  };
  providerStatusExtension(fakePi as never);

  const ctx = {
    hasUI: true,
    model: { provider: "demo", id: "m", baseUrl: "https://example.invalid/v1" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk" }) },
    ui: {
      setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
      notify(message: string) { notifications.push(message); },
    },
  };

  return {
    commands,
    statuses,
    notifications,
    ctx,
    release: () => finishFetch?.(new Response(JSON.stringify({ remaining: 9 }), { status: 200 })),
    getFetchCount: () => fetchCount,
    restore: () => {
      globalThis.fetch = originalFetch;
      delete process.env.PI_CODING_AGENT_DIR;
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

test("/balance update handler returns immediately while the balance request hangs", async () => {
  const harness = setup(true);
  try {
    const handler = harness.commands.get("balance")!.handler;
    const start = Date.now();
    // 挂起的 fetch 模拟 TUN 代理黑洞（直到 AbortSignal 超时都不返回）：
    // handler 必须在请求进行中就返回，否则 pi 会把整个 agent 视为 busy。
    await handler("update", harness.ctx);
    assert.ok(Date.now() - start < 2000, `handler blocked for ${Date.now() - start}ms`);
    assert.match(harness.statuses.get("balance")!, /refreshing/);

    // 放行挂起的请求，状态栏随后更新为余额。
    harness.release();
    await settle();
    assert.equal(harness.getFetchCount(), 1);
    assert.equal(harness.statuses.get("balance"), "9");
  } finally {
    harness.restore();
  }
});

test("/balance status reports current state without waiting for the request", async () => {
  const harness = setup(true);
  try {
    const handler = harness.commands.get("balance")!.handler;
    const start = Date.now();
    await handler("", harness.ctx);
    assert.ok(Date.now() - start < 2000, `handler blocked for ${Date.now() - start}ms`);
    assert.match(harness.statuses.get("balance")!, /refreshing/);

    harness.release();
    await settle();
    assert.equal(harness.statuses.get("balance"), "9");
  } finally {
    harness.restore();
  }
});

test("session_start background refresh does not throw unhandled rejections", async () => {
  const harness = setup(true);
  try {
    const eventHandlers: ((event: unknown, ctx: unknown) => void)[] = [];
    providerStatusExtension({
      registerCommand: () => undefined,
      on: (_name: string, handler: (event: unknown, ctx: unknown) => void) => eventHandlers.push(handler),
      events: { on: () => undefined },
    } as never);
    // session_start 里的后台刷新遇到挂起的 fetch 也必须安静地等待，不能抛未处理拒绝。
    for (const handler of eventHandlers) handler({ timestamp: 0 }, harness.ctx);
    await settle();
    assert.match(harness.statuses.get("balance")!, /refreshing/);
  } finally {
    harness.restore();
  }
});
