/**
 * 前端内部共用的小工具。
 *
 * 分成两部分：
 * - **常量**：图片上限、Markdown 渲染阈值、模型识别色等
 * - **元素引用与状态**：`el`（DOM 引用）与 `state`（全局状态）
 *
 * 关于 `state`：里面几个 `Map`（`cards` / `tabs` / `turnEls` / `minis`）保存的是
 * DOM 元素的引用，用来做「只更新变化的那一小块」而不是整屏重渲染。
 * 它们必须与真实 DOM 保持同步，所以**插入/替换 DOM 的代码有义务同时维护它们**。
 */

import type { ModelRef, ModelResponse, SessionSummary, WireSession, WireTurn } from '../src/types.js';

// #region 常量

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 超过这个长度就不再走 Markdown 渲染，避免重排卡顿 */
export const MD_RENDER_LIMIT = 20000;
/** 流式输出的合并间隔（毫秒），避免每个 chunk 都触发一次重排 */
export const FLUSH_MS = 90;

/** 状态的界面文案。索引是 `ModelResponse['status']`。 */
export const STATUS_TEXT: Record<string, string> = {
	pending: '等待中',
	streaming: '生成中',
	done: '完成',
	error: '失败',
	cancelled: '已取消',
};

/**
 * 模型识别色。按模型在列表里的下标取色，保证同一模型在
 * 选项卡 / 卡片 / 悬浮条里颜色一致。用 VS Code 的图表色，
 * 深浅主题都自带合适取值。
 */
export const MODEL_COLORS = [
	'--vscode-charts-blue',
	'--vscode-charts-purple',
	'--vscode-charts-orange',
	'--vscode-charts-green',
	'--vscode-charts-red',
	'--vscode-charts-yellow',
];

// #endregion

// #region DOM 引用

/** 按 id 取元素；拿不到说明 HTML 骨架和代码对不上，直接抛错而不是留下一个 null。 */
function mustGet(id: string): HTMLElement {
	const node = document.getElementById(id);
	if (!node) {
		throw new Error(`界面骨架缺少 #${id}`);
	}
	return node;
}

export const el = {
	app: mustGet('app'),
	sessionTitle: mustGet('session-title'),
	messages: mustGet('messages'),
	strip: mustGet('strip'),
	stripList: mustGet('stripList'),
	input: mustGet('input') as HTMLTextAreaElement,
	send: mustGet('send') as HTMLButtonElement,
	stop: mustGet('stop') as HTMLButtonElement,
	newSession: mustGet('newSession') as HTMLButtonElement,
	toggleHistory: mustGet('toggleHistory') as HTMLButtonElement,
	history: mustGet('history'),
	sessionList: mustGet('sessionList'),
	attachments: mustGet('attachments'),
	notice: mustGet('notice'),
	composer: mustGet('composer'),
};

// #endregion

// #region 状态

/** 某一轮的展示设置。`focusKey` = 单读看谁；`compare` 非空 = 并排对比这几个。 */
export interface TurnViewState {
	focusKey: string;
	compare: Set<string>;
}

/** 回答卡片：DOM 引用 + 该条回答的当前内容与状态。 */
export interface CardEntry {
	key: string;
	turnId: string;
	card: HTMLElement;
	body: HTMLElement;
	copy: HTMLButtonElement;
	dot: HTMLElement;
	status: HTMLElement;
	regenerate: HTMLButtonElement;
	importOne: HTMLButtonElement;
	importModel: HTMLButtonElement;
	setContext: HTMLButtonElement;
	/** Markdown 原文（复制走的是这个，不是渲染后的 HTML） */
	text: string;
	res: ModelResponse;
	/** 流式合并用的定时器；0 表示当前没有待渲染的批次 */
	timer: number;
}

/** 选项卡：聚焦模式下每轮顶部的模型条目。 */
export interface TabEntry {
	tab: HTMLButtonElement;
	dot: HTMLElement;
	tm: HTMLElement;
	key: string;
}

/** 一轮对话的元素引用。 */
export interface TurnEls {
	section: HTMLElement;
	missing: HTMLElement;
	tabbar: HTMLElement;
	cards: HTMLElement;
	qText: HTMLElement;
	qEdited: HTMLElement;
	editBtn: HTMLButtonElement;
	editArea: HTMLElement;
	/** 是否正处于编辑提问状态（编辑期间不能重建卡片，否则 textarea 会被顶掉） */
	editing: boolean;
}

/** 悬浮条里的迷你卡（左复选框 / 中正文 / 右开关）。 */
export interface MiniEntry {
	root: HTMLElement;
	dot: HTMLElement;
	badge: HTMLElement;
	checkbox: HTMLInputElement;
	compareBox: HTMLInputElement;
	compareLabel: HTMLElement;
}

/** 输入区里待发送的图片。 */
export interface PendingImage {
	mime: string;
	dataUrl: string;
	name: string;
}

export const state = {
	models: [] as ModelRef[],
	/** 参与对比的模型（决定请求发给谁）：由悬浮条上每张卡片的开关控制 */
	selected: new Set<string>(),
	/**
	 * turnId -> 该轮的展示设置。
	 *
	 * 这是「谁可见、谁是当前项」的**唯一真相源**：每轮各自记住自己的看法，
	 * 不再另存一份全局状态（两份状态各被读一半，正是悬浮条上点了没反应的原因）。
	 */
	turnViews: new Map<string, TurnViewState>(),
	session: { id: '', title: '', selectedModels: [] as string[], turns: [] as WireTurn[] } as WireSession,
	sessions: [] as SessionSummary[],
	attachments: [] as PendingImage[],
	/** key = `${turnId}|${modelKey}` -> 回答卡片 */
	cards: new Map<string, CardEntry>(),
	/** key = `${turnId}|${modelKey}` -> 选项卡 */
	tabs: new Map<string, TabEntry>(),
	/** turnId -> 该轮的元素引用 */
	turnEls: new Map<string, TurnEls>(),
	/** modelKey -> 悬浮条里的迷你卡 */
	minis: new Map<string, MiniEntry>(),
	sending: false,
	/** 正在编辑提问的轮次 id（同一时刻只编辑一个） */
	editingTurnId: '',
	noticeTimer: 0,
};

/** `cards` / `tabs` 的复合键。 */
export function cardKey(turnId: string, key: string): string {
	return turnId + '|' + key;
}

/** 在会话里按 id 找轮次。 */
export function turnById(turnId: string): WireTurn | undefined {
	return state.session.turns.find((turn) => turn.id === turnId);
}

/**
 * 最新一轮。多处逻辑（重新生成、编辑提问）都只对最新一轮生效。
 */
export function latestTurn(): WireTurn | undefined {
	const turns = state.session.turns;
	return turns.length ? turns[turns.length - 1] : undefined;
}

export function hasAnyTurn(): boolean {
	return state.session.turns.length > 0;
}

/** 轮次序号（第 N 轮）。找不到时返回 0。 */
export function turnNumber(turnId: string): number {
	return state.session.turns.findIndex((turn) => turn.id === turnId) + 1;
}

/** 当前界面上的模型 key 列表。 */
export function visibleKeys(): string[] {
	return state.models.map((model) => model.key);
}

// #endregion
