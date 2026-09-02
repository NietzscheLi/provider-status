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
  async refresh(id: string, source: BalanceSource, force = false): Promise<BalanceState> {
    const active = this.pending.get(id); if (active) return active;
    const current = this.get(id); const age = refreshInterval(readConfig(this.agentDir)) * 60000;
    if (!force && current.updatedAt !== undefined && this.now() - current.updatedAt < age) return current;
    this.states.set(id, { ...current, loading: true });
    const promise = requestBalance(this.agentDir, id, source, this.fetcher).then((text) => ({ text, loading: false, updatedAt: this.now() }), (error) => ({ text: current.text, loading: false, error: error instanceof Error ? error.message : "Balance query failed", updatedAt: this.now() }));
    this.pending.set(id, promise);
    const result = await promise; this.pending.delete(id); this.states.set(id, result); return result;
  }
}
export function formatBalance(state: BalanceState): string { if (state.loading) return `${state.text} (refreshing…)`; if (state.error && state.text === "--") return "unavailable"; if (state.error) return `${state.text} (stale)`; return state.text; }
