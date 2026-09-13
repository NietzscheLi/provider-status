// 菜单组件行为回归：标题/上下文/快捷键渲染，? 帮助浮层开关，Enter/Esc 语义。
import assert from "node:assert/strict";
import test from "node:test";
import { showPersistentShortcutMenu, type MenuCursor, type MenuRow } from "../tui/persistent-menu.ts";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };

interface Capture {
	component: { render(width: number): string[]; handleInput(data: string): void };
	resolve: (action: unknown) => void;
}

function makeCtx(): { ctx: unknown; captures: Capture[] } {
	const captures: Capture[] = [];
	const ctx = {
		ui: {
			custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (action: unknown) => void) => Capture["component"]) {
				return new Promise((resolve) => {
					const component = factory({ terminal: { rows: 24, columns: 80 }, requestRender() {} }, theme, {}, resolve);
					captures.push({ component, resolve: resolve as (action: unknown) => void });
				});
			},
		},
	};
	return { ctx, captures };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("菜单渲染标题/上下文/快捷键，? 打开帮助浮层", async () => {
	const { ctx, captures } = makeCtx();
	const rows: MenuRow[] = [{ id: "a", label: "甲" }, { id: "b", label: "乙" }];
	const cursor: MenuCursor = { index: 0 };
	void showPersistentShortcutMenu(ctx as never, "测试菜单", "", rows, cursor, [], {
		context: "上下文行",
		hints: [{ key: "Enter", label: "进入" }],
		helpLines: ["这是一段说明文字。"],
	});
	await settle();
	const component = captures[0]!.component;

	const list = component.render(80).join("\n");
	assert.match(list, /测试菜单/);
	assert.match(list, /上下文行/);
	assert.match(list, /Enter/);
	assert.match(list, /\?/);

	component.handleInput("?");
	const help = component.render(80).join("\n");
	assert.match(help, /快捷键与说明/);
	assert.match(help, /这是一段说明文字/);

	component.handleInput("?");
	assert.ok(!component.render(80).join("\n").includes("快捷键与说明"), "再按 ? 应关闭帮助");
});

test("Enter 返回选中行，Esc 返回 cancel，快捷键按注册解析", async () => {
	const { ctx, captures } = makeCtx();
	const rows: MenuRow[] = [{ id: "a", label: "甲" }, { id: "b", label: "乙" }];
	const cursor: MenuCursor = { index: 0 };
	const pending = showPersistentShortcutMenu<"run">(ctx as never, "快捷菜单", "", rows, cursor, [{ input: "x", shortcut: "run" }], {});
	await settle();
	const component = captures[0]!.component;

	component.handleInput("\x1b[B"); // 下移
	component.handleInput("\r"); // Enter
	assert.deepEqual(await pending, { type: "pick", id: "b" });

	const second = makeCtx();
	const pendingSecond = showPersistentShortcutMenu(second.ctx as never, "取消菜单", "", rows, { index: 0 }, [], {});
	await settle();
	second.captures[0]!.component.handleInput("\x1b");
	assert.deepEqual(await pendingSecond, { type: "cancel" });

	const third = makeCtx();
	const pendingThird = showPersistentShortcutMenu<"run">(third.ctx as never, "快捷键", "", rows, { index: 1 }, [{ input: "x", shortcut: "run" }], {});
	await settle();
	third.captures[0]!.component.handleInput("x");
	assert.deepEqual(await pendingThird, { type: "shortcut", shortcut: "run" });
});
