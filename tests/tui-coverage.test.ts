// TUI 配置覆盖率回归：表单必须覆盖运行时读取的全部字段，
// 且订阅与余额两类条目共享同一套 request.* / credentials.* 命名风格。
import assert from "node:assert/strict";
import test from "node:test";
import { subscriptionFormRows } from "../tui/subscription-editor.ts";
import { balanceFormRows } from "../tui/usage-editor.ts";

test("余额条目表单覆盖运行时全部字段", () => {
	const ids = new Set(balanceFormRows({}, true, []).map((row) => row.id));
	const expected = [
		"template",
		"request.url",
		"request.baseUrl",
		"request.method",
		"request.timeoutSeconds",
		"request.headers",
		"request.body",
		"extractor.remainingPath",
		"extractor.totalPath",
		"extractor.usedPath",
		"extractor.unit",
		"extractor.unitPath",
		"extractor.scale",
		"extractor.errorPath",
		"extractor.errorFallback",
		"extractor.validity.path",
		"extractor.validity.allTruthy",
		"extractor.validity.firstDefined",
		"extractor.validity.fallback",
		"credentials.apiKey",
		"credentials.accessToken",
		"credentials.userId",
		"raw",
	];
	for (const id of expected) assert.ok(ids.has(id), `余额表单缺少字段: ${id}`);
	// 模板行只在 balances 条目出现，templates 条目不应出现。
	assert.ok(!new Set(balanceFormRows({}, false, []).map((row) => row.id)).has("template"));
});

test("订阅条目表单覆盖运行时全部字段并使用统一的 request.* 命名", () => {
	const ids = new Set(subscriptionFormRows({}).map((row) => row.id));
	const expected = [
		"adapter",
		"label",
		"request.baseUrl",
		"request.timeoutSeconds",
		"request.headers",
		"maxWidth",
		"credentials.apiKey",
		"credentials.accessToken",
		"raw",
	];
	for (const id of expected) assert.ok(ids.has(id), `订阅表单缺少字段: ${id}`);
	// 统一风格：请求头必须挂在 request 下（旧实现是顶层 headers）。
	assert.ok(!ids.has("headers"), "订阅表单不应再暴露顶层 headers");
});
