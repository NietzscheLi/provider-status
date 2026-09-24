import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ExternalModificationError, LockConflictError, configFingerprint, redactSecrets, updateConfig, withConfigLock } from "../usage-store.ts";
import type { UsageConfig } from "../types.ts";

function makeDir(): string {
	return mkdtempSync(join("/tmp", "pi-provider-status-store-"));
}

function readConfigFile(dir: string): UsageConfig {
	return JSON.parse(readFileSync(join(dir, "usage-config.json"), "utf8")) as UsageConfig;
}

test("updateConfig 原子写入缺失的配置并保留未知字段", () => {
	const dir = makeDir();
	const result = updateConfig(dir, (config) => ({ ...config, customTopLevel: { keep: true }, balances: { demo: { template: "newapi" } } }));
	assert.equal(result.changed, true);
	assert.ok(existsSync(join(dir, "usage-config.json")));
	const saved = readConfigFile(dir);
	assert.equal(saved.customTopLevel && (saved.customTopLevel as { keep?: boolean }).keep, true);
	assert.equal((saved.balances as Record<string, unknown>).demo && ((saved.balances as Record<string, { template?: string }>).demo).template, "newapi");
	assert.ok(!existsSync(`${join(dir, "usage-config.json")}.tmp-0`), "temp file must be renamed away");
});

test("外部修改检测：fingerprint 不匹配时拒绝写入且文件保持不变", () => {
	const dir = makeDir();
	writeFileSync(join(dir, "usage-config.json"), JSON.stringify({ balances: { demo: {} } }));
	const stale = configFingerprint(dir);
	writeFileSync(join(dir, "usage-config.json"), JSON.stringify({ balances: { demo: {}, other: {} } }));
	assert.throws(() => updateConfig(dir, () => ({ refreshInterval: 9 }), stale), ExternalModificationError);
	const saved = readConfigFile(dir);
	assert.equal(saved.refreshInterval, undefined);
	assert.ok((saved.balances as Record<string, unknown>).other);
});

test("配置锁互斥：持有期间第二个写者抛出 LockConflictError", async () => {
	const dir = makeDir();
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const first = withConfigLock(dir, async () => {
		await gate;
		return "first";
	});
	await Promise.resolve();
	await assert.rejects(withConfigLock(dir, () => "second" as never), LockConflictError);
	release!();
	assert.equal(await first, "first");
});

test("配置锁容忍 stale lock：过期锁文件被接管", async () => {
	const dir = makeDir();
	const lockPath = join(dir, "usage-config.lock");
	writeFileSync(lockPath, "stale");
	const old = new Date(Date.now() - 60_000);
	utimesSync(lockPath, old, old);
	assert.equal(await withConfigLock(dir, () => "acquired"), "acquired");
	assert.equal(existsSync(lockPath), false, "lock must be released");
});

test("redactSecrets 从输出中移除 template/balance/orphan credentials 值", () => {
	const config = {
		templates: { newapi: { credentials: { accessToken: "sk-super-secret-token" } } },
		balances: { demo: { credentials: { userId: "user-42" } } },
		orphans: { gone: { credentials: { apiKey: "orphan-key-123" } } },
	} as unknown as UsageConfig;
	const message = "request failed for sk-super-secret-token / user-42 / orphan-key-123";
	assert.equal(redactSecrets(message, config), "request failed for *** / *** / ***");
	assert.equal(redactSecrets("short: abc", config), "short: abc");
});
