// tps.ts
//
// 生成速度（tok/s）测量：参照 pi-token-speed 的时间滑动窗。
// 与「turn_end 整轮平均」不同，这里只统计流式生成区间——首次内容到达（text/thinking/toolcall 的
// *_start）到最后一个 delta——所以 TTFT/排队与工具执行时间天然不在分母里。
// 分子优先用 provider 累计上报的 usage.output，缺失时按词法估算；流结束后用权威 usage.output 定案。

/** 滑动窗长度（毫秒）：窗内 token 之和 ÷ 实际跨度。 */
export const TPS_WINDOW_MS = 5_000;
/** 最小有效跨度（毫秒）：低于此值不按实际跨度计算，避免 provider 缓冲突发把结果放大。 */
export const TPS_MIN_SPAN_MS = 250;
/** 无新数据超过该时长就不再展示（芯片回到 `-- tok/s`）。 */
export const TPS_STALE_MS = 5 * 60_000;
/** 事件数组压缩阈值：长流式会话下窗口只保留最近一段，避免无界增长。 */
const COMPACT_THRESHOLD = 2_048;

/** 词法估算（pi-token-speed 同款）：英文按词、CJK 与标点按字符。 */
const TOKEN_PATTERN = /\w+|[^\s\w]/gu;

export function estimateTokens(text: string): number {
	if (!text) return 0;
	return text.match(TOKEN_PATTERN)?.length ?? 0;
}

/**
 * 时间滑动窗：记录 (时间, token) 事件并给出窗内速率。
 * 一批 token 可能带着同一个时间戳到达（provider 缓冲后一次性 flush），此时回看窗口前一个事件，
 * 用「上次活动 → 现在」作为跨度，而不是除以 ≈0。
 */
export class SlidingWindow {
	private events: Array<{ time: number; tokens: number }> = [];
	private startIndex = 0;
	private readonly windowMs: number;

	constructor(windowMs = TPS_WINDOW_MS) {
		this.windowMs = windowMs;
	}

	reset(): void {
		this.events = [];
		this.startIndex = 0;
	}

	record(tokens: number, now = Date.now()): void {
		if (!(tokens > 0)) return;
		this.events.push({ time: now, tokens });
		if (this.startIndex >= COMPACT_THRESHOLD) {
			this.events = this.events.slice(this.startIndex);
			this.startIndex = 0;
		}
	}

	/** 窗内 token 之和 ÷ 实际时间跨度；窗内没有 token 时返回 0。 */
	getTps(now = Date.now()): number {
		while (this.startIndex < this.events.length && this.events[this.startIndex]!.time < now - this.windowMs) {
			this.startIndex += 1;
		}
		if (this.startIndex >= this.events.length) return 0;
		let tokens = 0;
		for (let index = this.startIndex; index < this.events.length; index += 1) tokens += this.events[index]!.tokens;
		if (tokens === 0) return 0;
		let spanStart = this.events[this.startIndex]!.time;
		const lastTime = this.events[this.events.length - 1]!.time;
		if (spanStart === lastTime && this.startIndex > 0) spanStart = this.events[this.startIndex - 1]!.time;
		return (1000 * tokens) / Math.max(now - spanStart, TPS_MIN_SPAN_MS);
	}
}

/** 生成速度状态机：流式期间给滑动窗读数，流结束后切到权威平均，超时归零。 */
export class TpsMeter {
	private readonly window = new SlidingWindow();
	private active = false;
	private startedAt = 0;
	private lastDeltaAt = 0;
	private usageOutput = 0;
	private streamedTokens = 0;
	private last: number | undefined;
	private average: number | undefined;
	private updatedAt = 0;

	get streaming(): boolean {
		return this.active;
	}

	/** 首次内容到达：开始计时（同一条消息内重复调用不重置）。 */
	beginStream(now = Date.now()): void {
		if (this.active) return;
		this.active = true;
		this.startedAt = now;
		this.lastDeltaAt = now;
		this.usageOutput = 0;
		this.streamedTokens = 0;
		this.average = undefined;
		this.window.reset();
	}

	/** 流式增量：provider 累计 output 增长时用其增量，否则按词法估算。 */
	noteDelta(delta: string, usageOutput: number | undefined, now = Date.now()): void {
		if (!this.streaming) return;
		this.lastDeltaAt = now;
		const cumulative = typeof usageOutput === "number" && Number.isFinite(usageOutput) && usageOutput > 0 ? usageOutput : 0;
		const tokens = cumulative > this.usageOutput ? cumulative - this.usageOutput : estimateTokens(delta);
		this.usageOutput = Math.max(this.usageOutput, cumulative);
		this.streamedTokens += tokens;
		this.window.record(tokens, now);
		const live = this.window.getTps(now);
		if (live > 0) {
			this.last = live;
			this.updatedAt = now;
		}
	}

	/**
	 * 流结束：分子优先用权威 usage.output（否则用本轮估算总量），分母只覆盖生成区间；
	 * 跨度过短时保留滑动窗读数，不用不可靠的商。
	 */
	finishStream(outputTokens: number | undefined, now = Date.now()): void {
		const spanSeconds = (this.lastDeltaAt - this.startedAt) / 1000;
		const tokens = typeof outputTokens === "number" && outputTokens > 0 ? outputTokens : this.streamedTokens;
		if (tokens > 0 && spanSeconds >= TPS_MIN_SPAN_MS / 1000) {
			this.average = tokens / spanSeconds;
			this.updatedAt = now;
		}
		this.active = false;
		this.window.reset();
	}

	/** 当前展示值；无数据或超过 TPS_STALE_MS 未更新时返回 undefined。 */
	value(now = Date.now()): number | undefined {
		if (this.updatedAt === 0 || now - this.updatedAt > TPS_STALE_MS) return undefined;
		return this.average ?? this.last;
	}

	reset(): void {
		this.active = false;
		this.startedAt = 0;
		this.lastDeltaAt = 0;
		this.usageOutput = 0;
		this.streamedTokens = 0;
		this.last = undefined;
		this.average = undefined;
		this.updatedAt = 0;
		this.window.reset();
	}
}
