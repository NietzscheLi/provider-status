// 生成速度测量的回归测试：滑动窗数学、突发补偿、流式区间与权威平均、超时归零。
import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens, SlidingWindow, TPS_MIN_SPAN_MS, TPS_STALE_MS, TpsMeter } from "../tps.ts";

test("estimateTokens 英文按词、CJK 与标点按字符", () => {
	assert.equal(estimateTokens(""), 0);
	assert.equal(estimateTokens("hello world"), 2);
	assert.equal(estimateTokens("a, b!"), 4);
	assert.equal(estimateTokens("额度不足"), 4);
	assert.equal(estimateTokens("重启 docker 容器"), 5);
});

test("SlidingWindow 用窗内 token 之和除以实际跨度，并丢弃窗外的旧事件", () => {
	const window = new SlidingWindow(1_000);
	for (let i = 0; i < 10; i += 1) window.record(5, 100 * i);
	// 最后 1s 内只有 t=900 的 5 个 token，跨度按实际首事件算：5 / 0.1s = 50。
	assert.equal(window.getTps(1_000), 50);
	// 窗口为空时返回 0，而不是 Infinity/NaN。
	assert.equal(window.getTps(10_000), 0);
});

test("SlidingWindow 对同一时间戳的突发放宽跨度（provider 缓冲）", () => {
	const window = new SlidingWindow(100);
	window.record(2, 0);
	// 一批 token 带同一个时间戳一次性 flush（窗口内只剩它们）。
	window.record(8, 900);
	window.record(8, 900);
	// 回看窗口前一个事件后跨度为 0 → 0.95s：16 / 0.95 = 16.84；
	// 若只看窗内事件（跨度 0.05s，被最小跨度卡到 0.25s）会得到 64。
	assert.equal(window.getTps(950), (1000 * 16) / 950);
});

test("SlidingWindow 用最小跨度兜住极短样本", () => {
	const window = new SlidingWindow(1_000);
	window.record(3, 5_000);
	assert.equal(window.getTps(5_000), (1000 * 3) / TPS_MIN_SPAN_MS);
});

test("TpsMeter 流式期间给滑动窗读数，流结束后切到权威平均", () => {
	const meter = new TpsMeter();
	meter.beginStream(1_000);
	// 生成区间：1s → 3s，期间按 provider 累计 output 上报（10 → 30 → 60）。
	meter.noteDelta("", 10, 1_500);
	meter.noteDelta("", 30, 2_000);
	meter.noteDelta("", 60, 3_000);
	const live = meter.value(3_000)!;
	assert.ok(live > 0, `live reading expected, got ${String(live)}`);
	// 流结束：分子用权威 usage.output，分母只覆盖 1s → 3s（TTFT 与工具时间不在窗口内）。
	meter.finishStream(100, 3_100);
	assert.equal(meter.value(3_100), 50);
	assert.equal(meter.streaming, false);
});

test("TpsMeter provider 未上报 output 时按词法估算", () => {
	const meter = new TpsMeter();
	meter.beginStream(1_000);
	meter.noteDelta("hello world", undefined, 2_000);
	// 2 tokens / 最小跨度 0.25s。
	assert.equal(meter.value(2_000), (1000 * 2) / TPS_MIN_SPAN_MS);
});

test("TpsMeter 权威 output 缺失或跨度过短时保留滑动窗读数", () => {
	const meter = new TpsMeter();
	meter.beginStream(1_000);
	meter.noteDelta("", 40, 1_100);
	// 跨度 < TPS_MIN_SPAN_MS：不用实际跨度，回退到滑动窗（最小跨度）读数。
	meter.finishStream(40, 1_120);
	assert.equal(meter.value(1_120), (1000 * 40) / TPS_MIN_SPAN_MS);
	// usage.output 为 0 的 provider（本地/faux）同样回退，而不是显示 0 tok/s。
	const second = new TpsMeter();
	second.beginStream(1_000);
	second.noteDelta("", 40, 2_000);
	second.finishStream(0, 2_000);
	assert.equal(second.value(2_000), (1000 * 40) / 1_000);
});

test("TpsMeter 超过 TPS_STALE_MS 没有新数据就归零，reset 清空历史", () => {
	const meter = new TpsMeter();
	meter.beginStream(1_000);
	meter.noteDelta("", 10, 2_000);
	meter.finishStream(10, 2_000);
	assert.ok(meter.value(2_000) !== undefined);
	assert.ok(meter.value(2_000 + TPS_STALE_MS) !== undefined);
	assert.equal(meter.value(2_000 + TPS_STALE_MS + 1), undefined);
	meter.reset();
	assert.equal(meter.value(2_000), undefined);
	assert.equal(meter.streaming, false);
});

test("TpsMeter beginStream 在同一轮内幂等，不重置已记录的窗口", () => {
	const meter = new TpsMeter();
	meter.beginStream(1_000);
	meter.noteDelta("", 20, 2_000);
	meter.beginStream(2_100);
	meter.noteDelta("", 30, 2_200);
	meter.finishStream(30, 2_200);
	// 起点仍是 1s：跨度 1.2s（若被重置成 2.1s 结果会不同）。
	assert.equal(meter.value(2_200), 30 / 1.2);
});
