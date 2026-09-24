import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { maskSecret, pairsToHeaders, headersToPairs, parseNumberInput, setValueAtPath, valueAtPath, pruneEmpty } from "../usage-draft.ts";
import {
	ensureBaseConfigFile,
	readSectionEntries,
	removeEntry,
	restoreOrphanEntry,
	templateExists,
	overwriteConfigFile,
	upsertEntry,
} from "../usage-edit.ts";
import { readConfig } from "../usage-config.ts";
import { configFingerprint } from "../usage-store.ts";

function makeDir(): string {
	return mkdtempSync(join("/tmp", "pi-provider-status-edit-"));
}

function writeJson(dir: string, value: unknown): void {
	writeFileSync(join(dir, "usage-config.json"), `${JSON.stringify(value, null, 2)}\n`);
}

test("maskSecret 掩码敏感值", () => {
	assert.equal(maskSecret("sk-abc"), "********");
	assert.equal(maskSecret(""), "<未填写>");
	assert.equal(maskSecret(undefined), "<未填写>");
	assert.equal(maskSecret(42), "<未填写>");
});

test("headers 键值对双向转换", () => {
	const pairs = headersToPairs({ Authorization: "Bearer {{apiKey}}", "X-A": 1 });
	assert.deepEqual(pairs, [{ key: "Authorization", value: "Bearer {{apiKey}}" }, { key: "X-A", value: "1" }]);
	assert.deepEqual(pairsToHeaders(pairs), { Authorization: "Bearer {{apiKey}}", "X-A": "1" });
	assert.equal(pairsToHeaders([]), undefined);
	assert.deepEqual(pairsToHeaders([{ key: "  ", value: "x" }]), undefined);
});

test("parseNumberInput 解析数字输入", () => {
	assert.equal(parseNumberInput(" 10 "), 10);
	assert.equal(parseNumberInput(""), undefined);
	assert.equal(parseNumberInput("abc"), null);
});

test("setValueAtPath 深层写入与清除，并清理空骨架", () => {
	const target = {};
	setValueAtPath(target, "request.url", "https://x");
	assert.deepEqual(target, { request: { url: "https://x" } });
	assert.equal(valueAtPath(target, "request.url"), "https://x");
	setValueAtPath(target, "request.url", "");
	pruneEmpty(target);
	assert.deepEqual(target, {});
});

test("ensureBaseConfigFile 初始化基础配置且不覆盖已有文件", async () => {
	const dir = makeDir();
	await ensureBaseConfigFile(dir);
	assert.ok(existsSync(join(dir, "usage-config.json")));
	const config = readConfig(dir);
	assert.equal(config.refreshInterval, 5);
	assert.deepEqual(config.templates, {});
	assert.deepEqual(config.balances, {});
	// 已有文件不被覆盖。
	writeJson(dir, { balances: { demo: {} } });
	await ensureBaseConfigFile(dir);
	assert.deepEqual(readConfig(dir).balances, { demo: {} });
});

test("upsertEntry 只替换目标条目，其余条目保持原值", async () => {
	const dir = makeDir();
	writeJson(dir, { balances: { demo: {}, keep: { template: "openrouter" } } });
	await upsertEntry(dir, "balances", "demo", { template: "sub2api", request: { url: "https://x" } });
	const balances = readConfig(dir).balances as Record<string, { template?: string; request?: { url?: string } }>;
	assert.equal(balances.keep!.template, "openrouter");
	assert.equal(balances.demo!.template, "sub2api");
	assert.equal(balances.demo!.request!.url, "https://x");
});

test("外部并发修改不阻断定向编辑", async () => {
	const dir = makeDir();
	writeJson(dir, { templates: { a: {} }, balances: { x: {} } });
	const before = configFingerprint(dir);
	// 模拟面板打开后、保存前文件被外部修改。
	writeJson(dir, { templates: { a: {}, b: {} }, balances: { x: {}, y: {} } });
	await upsertEntry(dir, "balances", "x", { template: "a" });
	const config = readConfig(dir);
	// 外部新增的条目完好，同时本次修改也生效。
	assert.deepEqual(Object.keys(config.balances as Record<string, unknown>).sort(), ["x", "y"]);
	assert.deepEqual(Object.keys(config.templates as Record<string, unknown>).sort(), ["a", "b"]);
	assert.equal((config.balances as Record<string, { template?: string }>).x!.template, "a");
	assert.notEqual(before, undefined);
});

test("upsertEntry / removeEntry / templateExists", async () => {
	const dir = makeDir();
	await upsertEntry(dir, "templates", "newapi", { request: { url: "https://p" } });
	await upsertEntry(dir, "balances", "demo", { template: "newapi" });
	assert.ok(templateExists(dir, "newapi"));
	assert.ok(!templateExists(dir, "missing"));
	assert.deepEqual(readSectionEntries(dir, "templates")["newapi"], { request: { url: "https://p" } });
	await removeEntry(dir, "balances", "demo");
	assert.deepEqual(readSectionEntries(dir, "balances"), {});
});

test("orphan 恢复把条目移回 balances 并清空 orphans", async () => {
	const dir = makeDir();
	writeJson(dir, { balances: {}, orphans: { gone: { template: "newapi" } } });
	await restoreOrphanEntry(dir, "gone");
	const config = readConfig(dir);
	assert.deepEqual(config.balances, { gone: { template: "newapi" } });
	assert.equal(config.orphans, undefined);
	// 目标已存在时拒绝恢复。
	writeJson(dir, { balances: { gone: {} }, orphans: { gone: { template: "newapi" } } });
	await assert.rejects(restoreOrphanEntry(dir, "gone"), /已存在/);
});

test("overwriteConfigFile 校验 JSON 与指纹", async () => {
	const dir = makeDir();
	writeJson(dir, { balances: { a: {} } });
	await overwriteConfigFile(dir, JSON.stringify({ balances: { b: {} } }), configFingerprint(dir));
	assert.deepEqual(readConfig(dir).balances, { b: {} });
	await assert.rejects(overwriteConfigFile(dir, "{", configFingerprint(dir)), /JSON 无法解析/);
	await assert.rejects(overwriteConfigFile(dir, "[]", configFingerprint(dir)), /顶层必须是对象/);
	await assert.rejects(overwriteConfigFile(dir, "{}", "stale-fingerprint"), /外部修改/);
});
