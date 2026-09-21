// /usage 子命令语法回归：与 workspace-preset 的 /preset 保持同一风格
// （status / config / help + 领域扩展；未知子命令给出统一用法）。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-usage-cmd-"));
const { default: providerStatusExtension } = await import("../index.ts");

interface Notification {
	message: string;
	level: string;
}

function setup() {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const pi = {
		registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, definition),
		on: () => {},
		events: { on: () => {} },
	};
	providerStatusExtension(pi as never);
	const notifications: Notification[] = [];
	const ctx = {
		hasUI: false,
		cwd: process.cwd(),
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setStatus: () => {},
			confirm: async () => false,
		},
	};
	return { invoke: (args: string) => commands.get("usage")!.handler(args, ctx), notifications };
}

test("/usage help 显示统一用法", async () => {
	const { invoke, notifications } = setup();
	await invoke("help");
	assert.equal(notifications.at(-1)!.level, "info");
	assert.match(notifications.at(-1)!.message, /usage: \/usage \[status \| config \| update \| reconcile \[--prune\]\]/);
});

test("/usage 未知子命令给出统一用法", async () => {
	const { invoke, notifications } = setup();
	await invoke("bogus");
	assert.equal(notifications.at(-1)!.level, "warning");
	assert.match(notifications.at(-1)!.message, /未知子命令/);
	assert.match(notifications.at(-1)!.message, /usage: \/usage/);
});

test("/usage config 与别名 edit 在无 UI 时提示需要 TUI", async () => {
	const { invoke, notifications } = setup();
	await invoke("config");
	assert.match(notifications.at(-1)!.message, /需要交互式 TUI/);
	await invoke("edit");
	assert.match(notifications.at(-1)!.message, /需要交互式 TUI/);
});

test("/usage reconcile --prune 在无 UI 时提示需要确认", async () => {
	const { invoke, notifications } = setup();
	await invoke("reconcile --prune");
	assert.match(notifications.at(-1)!.message, /需要交互式 TUI/);
});
