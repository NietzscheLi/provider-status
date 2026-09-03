import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { ExternalModificationError } from "../config-store.ts";
import { readBalanceMap, reconcileProviders } from "../reconcile.ts";
import type { BalanceConfig } from "../types.ts";

function makeDir(): string {
	return mkdtempSync(join("/tmp", "pi-provider-status-reconcile-"));
}

function seed(dir: string, yaml: string, providers: string[]): string {
	writeFileSync(join(dir, "balance-config.yaml"), yaml);
	const models = join(dir, "models.json");
	writeFileSync(models, JSON.stringify({ providers: Object.fromEntries(providers.map((id) => [id, { api: "openai-completions" }])) }));
	return models;
}

function readConfig(dir: string): BalanceConfig {
	return parse(readFileSync(join(dir, "balance-config.yaml"), "utf8"), { merge: true }) as BalanceConfig;
}

test("显式 rename 事件迁移 balance key 并记录 alias，重复对账幂等", async () => {
	const dir = makeDir();
	const models = seed(dir, "providers:\n  old:\n    profile: newapi\n", ["new"]);
	const first = await reconcileProviders(dir, models, { events: [{ type: "provider-rename", oldId: "old", newId: "new" }] });
	assert.deepEqual(first.renamed, [{ from: "old", to: "new" }]);
	assert.equal(first.changed, true);
	const config = readConfig(dir);
	assert.equal((config.providers as Record<string, unknown>).new && (config.providers as Record<string, unknown>).old, undefined);
	assert.equal(readBalanceMap(dir).aliases.new.from, "old");
	const second = await reconcileProviders(dir, models);
	assert.deepEqual(second, { added: [], existing: ["new"], orphan: [], renamed: [], conflicts: [], quarantined: [], changed: false });
});

test("rename 冲突（newId 已有余额配置）停止自动写入且不改文件", async () => {
	const dir = makeDir();
	const models = seed(dir, "providers:\n  old: {}\n  fresh:\n    profile: openrouter\n", ["fresh"]);
	const before = readFileSync(join(dir, "balance-config.yaml"), "utf8");
	const report = await reconcileProviders(dir, models, { events: [{ type: "provider-rename", oldId: "old", newId: "fresh" }] });
	assert.deepEqual(report.conflicts, ["fresh"]);
	assert.equal(report.changed, false);
	assert.equal(readFileSync(join(dir, "balance-config.yaml"), "utf8"), before);
});

test("删除的 Provider 默认保留为 orphan，确认后隔离进 orphanProviders 且可恢复", async () => {
	const dir = makeDir();
	const models = seed(dir, "providers:\n  gone:\n    profile: newapi\n  stay: {}\n", ["stay"]);
	const kept = await reconcileProviders(dir, models);
	assert.deepEqual(kept.orphan, ["gone"]);
	assert.equal(kept.changed, false);

	const pruned = await reconcileProviders(dir, models, { confirmPrune: async () => true });
	assert.deepEqual(pruned.quarantined, ["gone"]);
	const config = readConfig(dir);
	assert.equal((config.providers as Record<string, unknown>).gone, undefined);
	const quarantined = (config.orphanProviders as Record<string, { profile?: string }>).gone;
	assert.equal(quarantined.profile, "newapi");

	const again = await reconcileProviders(dir, models, { confirmPrune: async () => true });
	assert.deepEqual(again.quarantined, []);
	assert.equal(again.changed, false);
});

test("Provider ID 中的点号与连字符按字面 key 处理", async () => {
	const dir = makeDir();
	const models = seed(dir, "providers:\n  \"Toioto-Codex-0.25\": {}\n", ["Toioto-Codex-0.25"]);
	const report = await reconcileProviders(dir, models);
	assert.deepEqual(report.existing, ["Toioto-Codex-0.25"]);
	assert.equal(report.orphan.length, 0);
});

test("prune 确认回调期间外部修改配置时，对账拒绝写入且文件保持原样", async () => {
	const dir = makeDir();
	const models = seed(dir, "providers:\n  gone: {}\n", []);
	const promise = reconcileProviders(dir, models, {
		confirmPrune: async () => {
			// 模拟锁内 fingerprint 采集之后、写入之前的外部编辑。
			writeFileSync(join(dir, "balance-config.yaml"), "providers:\n  gone: {}\n  manual: {}\n");
			return true;
		},
	});
	await assert.rejects(promise, ExternalModificationError);
	const config = readConfig(dir);
	assert.ok((config.providers as Record<string, unknown>).gone);
	assert.ok((config.providers as Record<string, unknown>).manual);
	assert.equal(config.orphanProviders, undefined);
});

test("provider-delete 事件不删除 balance 配置，等待人工确认", async () => {
	const dir = makeDir();
	const models = seed(dir, "providers:\n  old: {}\n", []);
	const report = await reconcileProviders(dir, models, { events: [{ type: "provider-delete", providerId: "old" }] });
	assert.deepEqual(report.orphan, ["old"]);
	assert.equal(report.changed, false);
	const config = readConfig(dir);
	assert.ok((config.providers as Record<string, unknown>).old);
});

test("pi 内置 provider（如 openrouter）配置后不算 orphan", async () => {
	const dir = makeDir();
	const models = seed(dir, "providers:\n  openrouter: {}\n", []);
	const withBuiltin = await reconcileProviders(dir, models, { builtinIds: new Set(["openrouter"]) });
	assert.deepEqual(withBuiltin.orphan, []);
	assert.deepEqual(withBuiltin.added, []);
	// 不带 builtinIds 时保持旧行为：配置了但不在 models.json 里视为 orphan。
	const withoutBuiltin = await reconcileProviders(dir, models);
	assert.deepEqual(withoutBuiltin.orphan, ["openrouter"]);
});
