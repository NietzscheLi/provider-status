import type { BalanceState, BalanceSource, FetchLike } from "./types.ts";
import { readConfig, refreshInterval } from "./config.ts";
import { requestBalance } from "./balance-request.ts";

const EMPTY: BalanceState = { text: "--", loading: false };
export class BalanceService {
  private states = new Map<string, BalanceState>();
  private pending = new Map<string, Promise<BalanceState>>();
  private readonly agentDir: string;
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  constructor(agentDir: string, fetcher: FetchLike = globalThis.fetch, now: () => number = Date.now) {
    this.agentDir = agentDir;
    this.fetcher = fetcher;
    this.now = now;
  }
  get(id: string): BalanceState { return this.states.get(id) ?? EMPTY; }
  // 缓存优先的快速路径：新鲜结果直接返回（调用方无需解析认证、不发请求），
  // 对应 pi-usage 的 UsageCache 语义；查询快的关键在这里。
  isFresh(id: string): boolean {
    const current = this.get(id);
    if (current.updatedAt === undefined || current.loading) return false;
    const age = refreshInterval(readConfig(this.agentDir)) * 60000;
    return this.now() - current.updatedAt < age;
  }
  async refresh(id: string, source: BalanceSource, force = false, signal?: AbortSignal): Promise<BalanceState> {
    const active = this.pending.get(id); if (active) return active;
    const current = this.get(id); const age = refreshInterval(readConfig(this.agentDir)) * 60000;
    if (!force && current.updatedAt !== undefined && this.now() - current.updatedAt < age) return current;
    this.states.set(id, { ...current, loading: true });
    // 失败结果保留原来的 updatedAt（可能是 undefined）：若把失败时间记为 updatedAt，
    // 一次网络抖动/超时就会被当作新鲜结果缓存整个刷新周期，期间普通刷新全部被节流，
    // 用户必须反复强制刷新才能恢复；保留旧值让下一次 refresh 立即重试。
    // 中止（切换 provider / session 结束）：丢弃在途结果，恢复原状态，不当作失败。
    const promise = requestBalance(this.agentDir, id, source, this.fetcher, signal).then((text) => ({ text, loading: false, updatedAt: this.now() }), (error) => {
      if (signal?.aborted) return { ...current, loading: false };
      return { text: current.text, loading: false, error: error instanceof Error ? error.message : "Balance query failed", updatedAt: current.updatedAt };
    });
    this.pending.set(id, promise);
    const result = await promise; this.pending.delete(id); this.states.set(id, result); return result;
  }
}
export function formatBalance(state: BalanceState): string { if (state.loading) return `${state.text} (refreshing…)`; if (state.error && state.text === "--") return "unavailable"; if (state.error) return `${state.text} (stale)`; return state.text; }
