import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { maskSecret, pairsToHeaders, headersToPairs, parseNumberInput, setValueAtPath, valueAtPath, pruneEmpty } from "../usage-draft.ts";
import {
	editConfigDocument,
	ensureBaseConfigFile,
	profileExists,
	readSectionEntries,
	removeEntry,
	restoreOrphanEntry,
	overwriteConfigFile,
	upsertEntry,
} from "../usage-edit.ts";
import { readConfig } from "../usage-config.ts";
import { configFingerprint } from "../usage-store.ts";

function makeDir(): string {
	return mkdtempSync(join("/tmp", "pi-provider-status-edit-"));
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
	assert.ok(existsSync(join(dir, "usage-config.yaml")));
	const config = readConfig(dir);
	assert.equal(config.refreshIntervalMinutes, 5);
	assert.deepEqual(config.profiles, {});
	assert.deepEqual(config.balances, {});
	// 已有文件不被覆盖。
	writeFileSync(join(dir, "usage-config.yaml"), "balances:\n  demo: {}\n");
	await ensureBaseConfigFile(dir);
	assert.deepEqual(readConfig(dir).balances, { demo: {} });
});

test("editConfigDocument 定向编辑保留未触碰内容的注释与格式", async () => {
	const dir = makeDir();
	writeFileSync(join(dir, "usage-config.yaml"), "# 顶部注释\nbalances:\n  demo: {}\n  keep:\n    # keep 的注释\n    profile: openrouter\n");
	await upsertEntry(dir, "balances", "demo", { profile: "sub2api", request: { url: "https://x" } });
	const text = readFileSync(join(dir, "usage-config.yaml"), "utf8");
	// 未触碰条目的注释原样保留；被替换条目内部的注释随节点重建（预期行为）。
	assert.ok(text.includes("# 顶部注释"));
	assert.ok(text.includes("# keep 的注释"));
	assert.equal(readConfig(dir).balances!.keep && (readConfig(dir).balances as Record<string, { profile?: string }>).keep!.profile, "openrouter");
	const demo = (readConfig(dir).balances as Record<string, { profile?: string; request?: { url?: string } }>).demo!;
	assert.equal(demo.profile, "sub2api");
	assert.equal(demo.request!.url, "https://x");
});

test("外部并发修改不阻断定向编辑", async () => {
	const dir = makeDir();
	writeFileSync(join(dir, "usage-config.yaml"), "profiles:\n  a: {}\nbalances:\n  x: {}\n");
	const before = configFingerprint(dir);
	// 模拟面板打开后、保存前文件被外部修改。
	writeFileSync(join(dir, "usage-config.yaml"), "profiles:\n  a: {}\n  b: {}\nbalances:\n  x: {}\n  y: {}\n");
	await upsertEntry(dir, "balances", "x", { profile: "a" });
	const config = readConfig(dir);
	// 外部新增的条目完好，同时本次修改也生效。
	assert.deepEqual(Object.keys(config.balances as Record<string, unknown>).sort(), ["x", "y"]);
	assert.deepEqual(Object.keys(config.profiles as Record<string, unknown>).sort(), ["a", "b"]);
	assert.equal((config.balances as Record<string, { profile?: string }>).x!.profile, "a");
	assert.notEqual(before, undefined);
});

test("upsertEntry / removeEntry / profileExists", async () => {
	const dir = makeDir();
	await upsertEntry(dir, "profiles", "newapi", { request: { url: "https://p" } });
	await upsertEntry(dir, "balances", "demo", { profile: "newapi" });
	assert.ok(profileExists(dir, "newapi"));
	assert.ok(!profileExists(dir, "missing"));
	assert.deepEqual(readSectionEntries(dir, "profiles")["newapi"], { request: { url: "https://p" } });
	await removeEntry(dir, "balances", "demo");
	assert.deepEqual(readSectionEntries(dir, "balances"), {});
});

test("orphan 恢复是节点移动，保留注释", async () => {
	const dir = makeDir();
	writeFileSync(join(dir, "usage-config.yaml"), "balances: {}\norphanBalances:\n  gone:\n    # 保住我\n    profile: newapi\n");
	await restoreOrphanEntry(dir, "gone");
	const text = readFileSync(join(dir, "usage-config.yaml"), "utf8");
	assert.ok(text.includes("# 保住我"));
	const config = readConfig(dir);
	assert.deepEqual(Object.keys(config.balances as Record<string, unknown>), ["gone"]);
	assert.equal(config.orphanBalances, undefined);
	await overwriteConfigFile(dir, "balances:\n  a: {}\n", configFingerprint(dir));
	assert.deepEqual(readConfig(dir).balances, { a: {} });
});