import { objectAt, readConfig, refreshInterval } from "./usage-config.ts";
import { requestBalance } from "./usage-request.ts";
import { renderQuotaText } from "./render.ts";
import { adapterMeta, fetchSubscriptionUsage, isSubscriptionAdapter } from "./subscription.ts";
import type { FetchLike, JsonObject, UsageSource, UsageState, UsageValue } from "./types.ts";

const EMPTY: UsageState = { loading: false };

export type UsageKind = "balance" | "subscription";

/** 按 provider ID 分派余额型 / 订阅型查询，并保持缓存与失败语义。 */
export class UsageService {
	private states = new Map<string, UsageState>();
	private pending = new Map<string, Promise<UsageState>>();
	private readonly agentDir: string;
	private readonly fetcher: FetchLike;
	private readonly now: () => number;

	constructor(agentDir: string, fetcher: FetchLike = globalThis.fetch, now: () => number = Date.now) {
		this.agentDir = agentDir;
		this.fetcher = fetcher;
		this.now = now;
	}

	get(id: string): UsageState {
		return this.states.get(id) ?? EMPTY;
	}

	/** 配置声明的类型；未配置返回 undefined（状态栏据此决定写哪个键）。 */
	kindOf(id: string): UsageKind | undefined {
		const config = readConfig(this.agentDir);
		const subscription = objectAt(config.subscriptions?.[id], "");
		if (subscription && isSubscriptionAdapter(subscription.adapter)) return "subscription";
		if (objectAt(config.balances?.[id], "")) return "balance";
		return undefined;
	}

	// 缓存优先的快速路径：新鲜结果直接返回（调用方无需解析认证、不发请求）。
	isFresh(id: string): boolean {
		const current = this.get(id);
		if (current.updatedAt === undefined || current.loading) return false;
		const age = refreshInterval(readConfig(this.agentDir)) * 60_000;
		return this.now() - current.updatedAt < age;
	}

	async refresh(id: string, source: UsageSource, force = false, signal?: AbortSignal): Promise<UsageState> {
		const active = this.pending.get(id);
		if (active) return active;
		const current = this.get(id);
		const age = refreshInterval(readConfig(this.agentDir)) * 60_000;
		if (!force && current.updatedAt !== undefined && this.now() - current.updatedAt < age) return current;
		this.states.set(id, { ...current, loading: true });
		// 失败结果保留原来的 updatedAt（可能是 undefined）：若把失败时间记为 updatedAt，
		// 一次网络抖动/超时就会被当作新鲜结果缓存整个刷新周期，期间普通刷新全部被节流，
		// 用户必须反复强制刷新才能恢复；保留旧值让下一次 refresh 立即重试。
		// 中止（切换 provider / session 结束）：丢弃在途结果，恢复原状态，不当作失败。
		const promise = this.fetchValue(id, source, signal).then(
			(value): UsageState => ({ value, loading: false, updatedAt: this.now() }),
			(error): UsageState => {
				if (signal?.aborted) return { ...current, loading: false };
				return { value: current.value, loading: false, error: error instanceof Error ? error.message : "Usage query failed", updatedAt: current.updatedAt };
			},
		);
		this.pending.set(id, promise);
		const result = await promise;
		this.pending.delete(id);
		this.states.set(id, result);
		return result;
	}

	private async fetchValue(id: string, source: UsageSource, signal?: AbortSignal): Promise<UsageValue> {
		const config = readConfig(this.agentDir);
		const subscription = objectAt(config.subscriptions?.[id], "");
		if (subscription) return this.fetchSubscription(id, subscription, source, signal);
		const text = await requestBalance(this.agentDir, id, source, this.fetcher, signal);
		return { kind: "balance", text };
	}

	private async fetchSubscription(id: string, entry: JsonObject, source: UsageSource, signal?: AbortSignal): Promise<UsageValue> {
		const adapter = entry.adapter;
		if (!isSubscriptionAdapter(adapter)) throw new Error(`Unknown subscription adapter for ${id}: ${String(adapter)}`);
		const meta = adapterMeta(adapter)!;
		const label = typeof entry.label === "string" && entry.label ? entry.label : meta.label;
		const request = objectAt(entry, "request") ?? {};
		const timeoutSeconds = Number(request.timeoutSeconds);
		const { windows } = await fetchSubscriptionUsage({
			providerId: id,
			adapter,
			source,
			entry,
			fetcher: this.fetcher,
			signal,
			timeoutMs: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : undefined,
			now: this.now,
		});
		if (windows.length === 0) throw new Error(`${label} returned no quota windows`);
		const maxWidth = Number(entry.maxWidth);
		return {
			kind: "subscription",
			text: renderQuotaText(windows, Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : undefined),
			windows,
		};
	}
}
