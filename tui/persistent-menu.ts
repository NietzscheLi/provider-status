// tui/persistent-menu.ts
//
// "光标记忆"菜单组件，用 ctx.ui.custom 实现（移植自 pi-model-manager，去掉 i18n 依赖）。
// 调用方在循环间持有 cursor: { index } 引用，菜单进出时光标位置不丢。
//
// 布局遵循"一屏一件事"：标题下只保留一行上下文，快捷键提示只放常用项，
// 完整说明与全部快捷键按 ? 打开帮助浮层。列表页支持 "/" 过滤，表单页另有 Ctrl+S 保存。

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface MenuRow {
	id: string;
	label: string;
	// label 是按列宽截断后的表格文本；需要按真实标识搜索的调用方必须显式提供未截断的 searchText。
	searchText?: string;
	// 可调整性属于行自身；开关切换会让字段集变化，放在外部集合里会与重建后的行脱节。
	adjustable?: boolean;
}

// 底部快捷键提示；key 与说明分开才能分别着色，并在窄终端按项折行而不是被截掉。
export interface MenuHint {
	key: string;
	label: string;
}

export interface PersistentMenuOptions {
	// 标题下的一行上下文（当前激活项、条目计数等）；渲染时取值才能随动作刷新。
	context?: string;
	getContext?: () => string | undefined;
	// 完整说明；按 ? 打开帮助浮层时展示，避免常驻占用屏幕。
	helpLines?: readonly string[];
	getDetailLines?: (selectedRow: MenuRow | undefined, theme: Theme) => readonly string[];
	hints?: readonly MenuHint[];
	emptyLabel?: string;
	visibleRows?: number;
	searchable?: boolean;
}

export interface PersistentFormMenuOptions extends PersistentMenuOptions {
	// 就地切换该字段并返回重建后的行；返回 undefined 则忽略本次按键。
	onAdjust?: (id: string, direction: HorizontalDirection) => MenuRow[] | undefined;
}

export type MenuAction =
	| { type: "pick"; id: string }
	| { type: "cancel" };

export type HorizontalDirection = "left" | "right";
export type FormMenuAction = MenuAction | { type: "save" };

export type ShortcutMenuAction<TShortcut extends string = string> = MenuAction | { type: "shortcut"; shortcut: TShortcut };

export interface MenuShortcut<TShortcut extends string = string> {
	input: string;
	shortcut: TShortcut;
}

export interface MenuCursor {
	index: number;
}

function clampIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return Math.min(Math.max(0, index), length - 1);
}

function padToVisibleWidth(text: string, targetWidth: number): string {
	const pad = Math.max(0, targetWidth - visibleWidth(text));
	return text + " ".repeat(pad);
}

export function padLabel(label: string, columns: number): string {
	return padToVisibleWidth(label, columns);
}

// 明文按可见宽度折行（CJK 计 2 列），避免长说明被帮助浮层截断。
function wrapPlain(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;
	for (const character of Array.from(text)) {
		const characterWidth = visibleWidth(character);
		if (current && currentWidth + characterWidth > width) {
			lines.push(current);
			current = "";
			currentWidth = 0;
		}
		current += character;
		currentWidth += characterWidth;
	}
	if (current) lines.push(current);
	return lines.length > 0 ? lines : [""];
}

function getSearchText(row: MenuRow): string {
	return (row.searchText ?? `${row.id}\n${row.label}`).toLocaleLowerCase();
}

const HINT_GAP = "   ";

// 按项贪心排版：单行装不下就换行，保证窄终端下 Esc 等尾部提示不会被 truncate 丢失。
function layoutHintLines(hints: readonly MenuHint[], theme: Theme, width: number): string[] {
	const lines: string[] = [];
	let currentText = "";
	let currentWidth = 0;
	for (const hint of hints) {
		const hintWidth = visibleWidth(`${hint.key} ${hint.label}`);
		const styled = `${theme.fg("accent", hint.key)} ${theme.fg("dim", hint.label)}`;
		if (!currentText) {
			currentText = styled;
			currentWidth = hintWidth;
			continue;
		}
		if (currentWidth + HINT_GAP.length + hintWidth > width) {
			lines.push(currentText);
			currentText = styled;
			currentWidth = hintWidth;
			continue;
		}
		currentText += `${HINT_GAP}${styled}`;
		currentWidth += HINT_GAP.length + hintWidth;
	}
	if (currentText) lines.push(currentText);
	return lines;
}

// 标题嵌在顶部横线里，只画一条规则线，避免上下双边框把内容夹成"堆在一起"。
function headerLine(title: string, width: number, theme: Theme): string {
	const label = ` ${title} `;
	const rest = Math.max(0, width - 1 - visibleWidth(label));
	return truncateToWidth(
		`${theme.fg("borderMuted", "─")}${theme.fg("accent", theme.bold(label))}${theme.fg("borderMuted", "─".repeat(rest))}`,
		width,
	);
}

// 帮助浮层用方框圈出，和列表明显区分；内容行由调用方决定（说明 + 快捷键）。
function renderBox(title: string, lines: readonly string[], width: number, theme: Theme): string[] {
	if (width < 6) return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
	const inner = width - 2;
	const label = `─ ${theme.fg("accent", theme.bold(title))} `;
	const bar = theme.fg("borderMuted", "│");
	const top = `${theme.fg("borderMuted", "┌")}${label}${theme.fg("borderMuted", "─".repeat(Math.max(0, inner - visibleWidth(label))))}${theme.fg("borderMuted", "┐")}`;
	const bottom = `${theme.fg("borderMuted", "└")}${theme.fg("borderMuted", "─".repeat(inner))}${theme.fg("borderMuted", "┘")}`;
	const body = lines.map((line) => {
		const content = truncateToWidth(` ${line}`, inner - 1);
		return `${bar}${padToVisibleWidth(content, inner)}${bar}`;
	});
	return [top, ...body, bottom].map((line) => truncateToWidth(line, width));
}

// pi 在菜单下方还要渲染输入框与状态行，不预留就会把菜单底部的快捷键提示顶出屏幕。
const RESERVED_TERMINAL_ROWS = 3;
// 小于这个高度就无法同时容纳边框、标题、提示和列表，此时宁可溢出也不再继续压缩。
const MIN_MENU_ROWS = 8;
const MIN_LIST_ROWS = 1;

function filterRows(rows: MenuRow[], query: string): MenuRow[] {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return rows;
	return rows.filter((row) => getSearchText(row).includes(needle));
}

function isSearchTextInput(data: string): boolean {
	return data.length > 0 && !data.startsWith("\x1b") && !/[\u0000-\u001f\u007f]/.test(data);
}

function fitSearchQueryAroundCursor(query: string, cursor: number, cursorGlyph: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	const characters = Array.from(query);
	const cursorWidth = visibleWidth(cursorGlyph);
	const textBudget = Math.max(0, maxWidth - cursorWidth);
	let beforeCursor = "";
	let beforeWidth = 0;
	for (let index = Math.min(cursor, characters.length) - 1; index >= 0; index -= 1) {
		const character = characters[index]!;
		const characterWidth = visibleWidth(character);
		if (beforeWidth + characterWidth > textBudget) break;
		beforeCursor = character + beforeCursor;
		beforeWidth += characterWidth;
	}
	let afterCursor = "";
	let afterWidth = 0;
	for (let index = Math.min(cursor, characters.length); index < characters.length; index += 1) {
		const character = characters[index]!;
		const characterWidth = visibleWidth(character);
		if (beforeWidth + afterWidth + characterWidth > textBudget) break;
		afterCursor += character;
		afterWidth += characterWidth;
	}
	return `${beforeCursor}${cursorGlyph}${afterCursor}`;
}

function createPersistentMenu<TAction extends MenuAction | FormMenuAction | ShortcutMenuAction>(
	ctx: ExtensionCommandContext,
	title: string,
	help: string,
	rows: MenuRow[],
	cursor: MenuCursor,
	createSaveAction: (() => TAction) | undefined,
	shortcuts: MenuShortcut[],
	// 横向切换是纯本地状态变更，必须在组件内就地完成，否则每按一次方向键都会销毁重建整个 TUI。
	onAdjust: ((id: string, direction: HorizontalDirection) => MenuRow[] | undefined) | undefined = undefined,
	options: PersistentMenuOptions = {},
): Promise<TAction> {
	cursor.index = clampIndex(cursor.index, rows.length);
	return ctx.ui.custom<TAction>((tui, theme, _keybindings, done) => {
		let selectedIndex = clampIndex(cursor.index, rows.length);
		let searchActive = false;
		let searchQuery = "";
		let searchCursor = 0;
		let focused = false;
		let showHelp = false;
		const configuredVisibleRows = options.visibleRows ?? 18;
		// 真实可见行数要减去本帧的标题/上下文/详情/提示，每帧在 render 里重算，翻页也必须用同一个值。
		let viewportRows = configuredVisibleRows;
		const searchable = options.searchable ?? false;

		// onAdjust 会整批替换行数据，因此不能直接闭包参数 rows。
		let currentRows = rows;
		const getActiveRows = (): MenuRow[] => searchable ? filterRows(currentRows, searchQuery) : currentRows;

		const syncCursor = (activeRows: MenuRow[]): void => {
			const row = activeRows[selectedIndex];
			if (row) cursor.index = currentRows.indexOf(row);
		};

		const requestRender = (): void => {
			const activeRows = getActiveRows();
			selectedIndex = clampIndex(selectedIndex, activeRows.length);
			syncCursor(activeRows);
			tui.requestRender();
		};

		const clearSearch = (): boolean => {
			if (!searchable || (!searchActive && !searchQuery)) return false;
			searchActive = false;
			searchQuery = "";
			searchCursor = 0;
			selectedIndex = clampIndex(cursor.index, currentRows.length);
			requestRender();
			return true;
		};

		const replaceSearchQuery = (nextQuery: string, nextCursor: number): void => {
			const selectedRow = getActiveRows()[selectedIndex];
			searchQuery = nextQuery;
			searchCursor = clampIndex(nextCursor, Array.from(searchQuery).length + 1);
			const nextRows = getActiveRows();
			const retainedIndex = selectedRow ? nextRows.indexOf(selectedRow) : -1;
			selectedIndex = retainedIndex >= 0 ? retainedIndex : 0;
			requestRender();
		};

		const pickSelected = (): void => {
			const activeRows = getActiveRows();
			const row = activeRows[selectedIndex];
			if (!row) return;
			syncCursor(activeRows);
			done({ type: "pick", id: row.id } as TAction);
		};

		const moveSelection = (nextIndex: number): void => {
			selectedIndex = nextIndex;
			requestRender();
		};

		// 输入态显示带光标的搜索行；Tab 退出后仍需告知用户过滤仍生效。
		const renderQueryLine = (width: number): string => {
			if (!searchActive) {
				return truncateToWidth(`${theme.fg("dim", "过滤：")}${searchQuery}`, width, "");
			}
			const cursorGlyph = focused ? `${CURSOR_MARKER}${theme.fg("accent", "▌")}` : "";
			const searchPrefix = theme.fg("accent", "搜索：");
			const queryWidth = Math.max(0, width - visibleWidth(searchPrefix));
			const queryDisplay = searchQuery
				? fitSearchQueryAroundCursor(searchQuery, searchCursor, cursorGlyph, queryWidth)
				: `${cursorGlyph}${theme.fg("dim", "<输入关键词>")}`;
			return truncateToWidth(`${searchPrefix}${queryDisplay}`, width, "");
		};

		const getHints = (): MenuHint[] => {
			const hints: MenuHint[] = [...(options.hints ?? [])];
			// 列表可能超出可视行数时补充翻页提示（长列表更相关）。
			if (getActiveRows().length > configuredVisibleRows) hints.push({ key: "PgUp/PgDn", label: "翻页" });
			if (!searchable) {
				hints.push({ key: "?", label: "帮助" });
				return hints;
			}
			// 输入态下 ? 是普通字符，不能再当作帮助；只提示搜索自身的操作。
			if (searchActive) return [...hints, { key: "Tab", label: "完成输入" }, { key: "Esc", label: "清空" }];
			if (searchQuery) hints.push({ key: "Tab", label: "继续输入" }, { key: "Esc", label: "清空过滤" });
			else hints.push({ key: "/", label: "搜索" });
			hints.push({ key: "?", label: "帮助" });
			return hints;
		};

		// 终端高度未知（如测试环境）时不限制总行数，交由调用方配置的 visibleRows 控制。
		const getRowBudget = (): number => {
			const terminalRows = tui.terminal?.rows ?? 0;
			if (terminalRows <= 0) return Number.POSITIVE_INFINITY;
			return Math.max(MIN_MENU_ROWS, terminalRows - RESERVED_TERMINAL_ROWS);
		};

		// 帮助浮层：说明文字 + 全部快捷键，用 ?/Esc 关闭。
		const renderHelp = (width: number): string[] => {
			const helpLines = [...(help ? help.split("\n") : []), ...(options.helpLines ?? [])]
				.flatMap((line) => wrapPlain(line, Math.max(8, width - 4)));
			const boxLines: string[] = helpLines.map((line) => theme.fg("dim", line));
			const entries = getHints().filter((hint) => hint.key !== "?");
			if (boxLines.length > 0 && entries.length > 0) boxLines.push("");
			for (const hint of entries) {
				boxLines.push(`${theme.fg("accent", padLabel(hint.key, 10))} ${hint.label}`);
			}
			boxLines.push("", theme.fg("accent", padLabel("?/Esc", 10)) + " 关闭帮助");
			return renderBox("快捷键与说明", boxLines, width, theme);
		};

		return {
			get focused(): boolean {
				return focused;
			},
			set focused(value: boolean) {
				focused = value;
			},
			invalidate(): void {},
			handleInput(data: string): void {
				if (showHelp) {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "?" || data === "q") {
						showHelp = false;
						requestRender();
					}
					return;
				}
				if (!searchActive && data === "?") {
					showHelp = true;
					requestRender();
					return;
				}
				if (createSaveAction && matchesKey(data, Key.ctrl("s"))) {
					syncCursor(getActiveRows());
					done(createSaveAction());
					return;
				}
				const horizontalDirection: HorizontalDirection | undefined = matchesKey(data, Key.left)
					? "left"
					: matchesKey(data, Key.right)
						? "right"
						: undefined;
				if (horizontalDirection && onAdjust) {
					const row = getActiveRows()[selectedIndex];
					if (row?.adjustable) {
						syncCursor(getActiveRows());
						const nextRows = onAdjust(row.id, horizontalDirection);
						if (nextRows) {
							currentRows = nextRows;
							requestRender();
						}
					}
					return;
				}

				if (searchable && (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")))) {
					if (clearSearch()) return;
					done({ type: "cancel" } as TAction);
					return;
				}

				if (searchable && searchActive) {
					const queryCharacters = Array.from(searchQuery);
					if (matchesKey(data, Key.backspace)) {
						if (searchCursor > 0) {
							queryCharacters.splice(searchCursor - 1, 1);
							replaceSearchQuery(queryCharacters.join(""), searchCursor - 1);
						}
						return;
					}
					if (matchesKey(data, Key.delete)) {
						if (searchCursor < queryCharacters.length) {
							queryCharacters.splice(searchCursor, 1);
							replaceSearchQuery(queryCharacters.join(""), searchCursor);
						}
						return;
					}
					if (matchesKey(data, Key.left)) {
						searchCursor = Math.max(0, searchCursor - 1);
						requestRender();
						return;
					}
					if (matchesKey(data, Key.right)) {
						searchCursor = Math.min(queryCharacters.length, searchCursor + 1);
						requestRender();
						return;
					}
					if (matchesKey(data, Key.home)) {
						searchCursor = 0;
						requestRender();
						return;
					}
					if (matchesKey(data, Key.end)) {
						searchCursor = queryCharacters.length;
						requestRender();
						return;
					}
					// Tab 只退出输入态并保留过滤结果，让用户搜到目标后还能按单字母快捷键；Esc 才清空。
					if (matchesKey(data, Key.tab)) {
						searchActive = false;
						requestRender();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						pickSelected();
						return;
					}
					if (isSearchTextInput(data)) {
						queryCharacters.splice(searchCursor, 0, ...Array.from(data));
						replaceSearchQuery(queryCharacters.join(""), searchCursor + Array.from(data).length);
						return;
					}
				}

				// 提示里快捷键显示为大写，因此 Shift 组合也必须命中同一个动作。
				const shortcut = shortcuts.find((candidate) => candidate.input.toLowerCase() === data.toLowerCase());
				if (shortcut) {
					syncCursor(getActiveRows());
					done({ type: "shortcut", shortcut: shortcut.shortcut } as TAction);
					return;
				}
				if (searchable && searchQuery && matchesKey(data, Key.tab)) {
					searchActive = true;
					searchCursor = Array.from(searchQuery).length;
					requestRender();
					return;
				}
				if (searchable && data === "/") {
					searchActive = true;
					searchCursor = Array.from(searchQuery).length;
					requestRender();
					return;
				}

				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
					done({ type: "cancel" } as TAction);
					return;
				}
				if (matchesKey(data, Key.enter)) {
					pickSelected();
					return;
				}

				const activeRows = getActiveRows();
				if (matchesKey(data, Key.up)) {
					moveSelection(Math.max(0, selectedIndex - 1));
					return;
				}
				if (matchesKey(data, Key.down)) {
					moveSelection(Math.min(activeRows.length - 1, selectedIndex + 1));
					return;
				}
				if (matchesKey(data, Key.pageUp)) {
					moveSelection(Math.max(0, selectedIndex - viewportRows));
					return;
				}
				if (matchesKey(data, Key.pageDown)) {
					moveSelection(Math.min(activeRows.length - 1, selectedIndex + viewportRows));
					return;
				}
				if (matchesKey(data, Key.home)) {
					moveSelection(0);
					return;
				}
				if (matchesKey(data, Key.end)) {
					moveSelection(activeRows.length - 1);
					return;
				}
			},
			render(width: number): string[] {
				if (showHelp) return renderHelp(width);

				const activeRows = getActiveRows();
				selectedIndex = clampIndex(selectedIndex, activeRows.length);
				syncCursor(activeRows);

				const context = options.getContext?.() ?? options.context;
				const hintLines = layoutHintLines(getHints(), theme, width);
				const searchLine = searchable && (searchActive || searchQuery) ? renderQueryLine(width) : undefined;
				// 详情文本由调用方按语义着色，这里只负责裁剪，避免外层样式与内层 reset 互相打断。
				const detailLines = (options.getDetailLines?.(activeRows[selectedIndex], theme) ?? [])
					.map((line) => truncateToWidth(line, width));

				// 固定开销之外的剩余空间分给列表；详情与提示必须先占位，否则会被列表挤出屏幕。
				const budget = getRowBudget();
				const fixedRows = 1 + (context ? 1 : 0) + 1 + (hintLines.length > 0 ? hintLines.length + 1 : 0);
				const detailRows = detailLines.length > 0 ? detailLines.length + 1 : 0;
				const bodyBudget = Math.max(MIN_LIST_ROWS, budget - fixedRows - detailRows);
				const scrolling = activeRows.length > bodyBudget;
				viewportRows = Math.max(MIN_LIST_ROWS, scrolling ? bodyBudget - 1 : bodyBudget);

				const headLines: string[] = [headerLine(title, width, theme)];
				if (context) headLines.push(truncateToWidth(theme.fg("dim", ` ${context}`), width));
				headLines.push("");
				if (searchLine) headLines.push(searchLine);

				const windowStart = Math.max(
					0,
					Math.min(selectedIndex - Math.floor(viewportRows / 2), Math.max(0, activeRows.length - viewportRows)),
				);
				const shownRows = activeRows.slice(windowStart, windowStart + viewportRows);
				const contentWidth = Math.max(0, width);

				const bodyLines: string[] = [];
				if (shownRows.length === 0) {
					const emptyLabel = searchQuery ? `无匹配项：${searchQuery}` : options.emptyLabel ?? "暂无条目";
					bodyLines.push(truncateToWidth(theme.fg("dim", `  ${emptyLabel}`), width));
				} else {
					for (let offset = 0; offset < shownRows.length; offset += 1) {
						const row = shownRows[offset]!;
						const selected = windowStart + offset === selectedIndex;
						const prefix = selected ? "❯ " : "  ";
						const rowText = truncateToWidth(`${prefix}${row.label}`, contentWidth);
						// 选中行用背景色而不是整行前景色，列内的语义色才不会被抹平。
						bodyLines.push(selected ? theme.bg("selectedBg", padToVisibleWidth(rowText, contentWidth)) : rowText);
					}
					if (scrolling) {
						const firstRow = windowStart + 1;
						const lastRow = windowStart + shownRows.length;
						const range = firstRow === lastRow ? `${firstRow}` : `${firstRow}-${lastRow}`;
						const position = `第 ${range} 行 / 共 ${activeRows.length} 行`;
						bodyLines.push(theme.fg("dim", padToVisibleWidth("", Math.max(0, contentWidth - visibleWidth(position))) + position));
					}
				}

				const tailLines: string[] = [];
				if (detailLines.length > 0) tailLines.push("", ...detailLines);
				if (hintLines.length > 0) tailLines.push("", ...hintLines.map((line) => truncateToWidth(line, width)));

				return [...headLines, ...bodyLines, ...tailLines].map((line) => truncateToWidth(line, width));
			},
		};
	});
}

// 内部基础菜单：对外只暴露 showOptionPicker / showPersistentFormMenu / showPersistentShortcutMenu 三个语义入口。
async function showPersistentMenu(
	ctx: ExtensionCommandContext,
	title: string,
	help: string,
	rows: MenuRow[],
	cursor: MenuCursor,
	options: PersistentMenuOptions = {},
): Promise<MenuAction> {
	return createPersistentMenu<MenuAction>(ctx, title, help, rows, cursor, undefined, [], undefined, options);
}

// 单选弹窗：所有枚举字段都走这里，避免同一表单里出现两种选择器外观。
export async function showOptionPicker<TChoice extends { id: string; label: string }>(
	ctx: ExtensionCommandContext,
	title: string,
	choices: readonly TChoice[],
	currentId: string,
): Promise<TChoice | undefined> {
	const cursor: MenuCursor = { index: Math.max(0, choices.findIndex((choice) => choice.id === currentId)) };
	const action = await showPersistentMenu(
		ctx,
		title,
		"",
		choices.map((choice) => ({
			id: choice.id,
			label: choice.id === currentId ? `${choice.label}  ← 当前` : choice.label,
		})),
		cursor,
		{
			hints: [
				{ key: "↑↓", label: "选择" },
				{ key: "Enter", label: "选择" },
				{ key: "Esc", label: "返回" },
			],
		},
	);
	if (action.type === "cancel") return undefined;
	return choices.find((choice) => choice.id === action.id);
}

export async function showPersistentFormMenu(
	ctx: ExtensionCommandContext,
	title: string,
	help: string,
	rows: MenuRow[],
	cursor: MenuCursor,
	options: PersistentFormMenuOptions = {},
): Promise<FormMenuAction> {
	return createPersistentMenu<FormMenuAction>(
		ctx,
		title,
		help,
		rows,
		cursor,
		() => ({ type: "save" }),
		[],
		options.onAdjust,
		options,
	);
}

export async function showPersistentShortcutMenu<TShortcut extends string>(
	ctx: ExtensionCommandContext,
	title: string,
	help: string,
	rows: MenuRow[],
	cursor: MenuCursor,
	shortcuts: MenuShortcut<TShortcut>[],
	options: PersistentMenuOptions = {},
): Promise<ShortcutMenuAction<TShortcut>> {
	return createPersistentMenu<ShortcutMenuAction<TShortcut>>(ctx, title, help, rows, cursor, undefined, shortcuts, undefined, { searchable: true, ...options });
}
