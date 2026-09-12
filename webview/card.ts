/**
 * 回答卡片：一张卡片 = 某个模型在某一轮的回答。
 *
 * 卡片要同时维护一份 DOM 引用（`state.cards`）和一份内容副本，因为流式输出
 * 期间**不能**每个 chunk 都重排 DOM —— 那样会卡。做法是：`applyChunk()` 只往
 * `entry.text` 上追加，然后用 `FLUSH_MS` 合并成一次渲染。
 */

import { state, cardKey, latestTurn, STATUS_TEXT, MD_RENDER_LIMIT, FLUSH_MS } from './state.js';
import type { CardEntry } from './state.js';
import { updateTab } from './tab.js';
import { refreshMini } from './strip.js';
import { setTurnFocus } from './display.js';
import { copyWithFeedback, modelColorVar, modelLabel, nearBottom, scrollToBottom, updateDot } from './ui.js';
import { post } from './host.js';
import type { ModelResponse } from '../src/types.js';

/**
 * Markdown 渲染器由 `media/markdown.js` 以**普通脚本**挂到 window 上。
 *
 * 它没有被改写成 ESM 模块，有两个原因：
 * 1. `scripts/smoke-render.mjs` 用 Node 的 `require()` 加载它跑了 70 项断言，
 *    改成 ESM 产物会让那套测试失效；
 * 2. 它零依赖、自包含、有测试覆盖，没有拆分的必要。
 */
declare global {
	interface Window {
		MarkdownRenderer?: {
			render(source: string): string;
			escapeHtml(text: string): string;
			renderInline(text: string): string;
		};
	}
}

export function createCard(turnId: string, key: string, response: ModelResponse): HTMLElement {
	const model = state.models.find((m) => m.key === key);

	const card = document.createElement('article');
	card.className = 'card';
	card.style.setProperty('--c', modelColorVar(key));

	const head = document.createElement('div');
	head.className = 'card-head';

	const dot = document.createElement('span');
	dot.className = 'dot';

	const name = document.createElement('span');
	name.className = 'card-name';
	name.textContent = model ? modelLabel(model) : key;
	name.title = key;
	// 作用于这一张卡片所属的那一轮，不是「最新一轮」
	name.addEventListener('click', () => setTurnFocus(turnId, key));

	const copy = document.createElement('button');
	copy.className = 'card-copy';
	copy.type = 'button';
	copy.textContent = '复制';
	copy.title = '复制这条回答（保持 Markdown 原文）';
	copy.disabled = true;

	const regenerate = document.createElement('button');
	regenerate.className = 'card-copy card-regenerate';
	regenerate.type = 'button';
	regenerate.textContent = '重新生成';
	regenerate.title = '重新生成这条回答';
	regenerate.addEventListener('click', () => post({ type: 'regenerate', turnId, key }));

	const importOne = document.createElement('button');
	importOne.className = 'card-copy card-import';
	importOne.type = 'button';
	importOne.textContent = '导入单条';
	importOne.title = '导入这条回答到 Copilot Chat';
	importOne.addEventListener('click', () =>
		post({ type: 'importToCopilot', turnId, key, scope: 'one' }),
	);

	const importModel = document.createElement('button');
	importModel.className = 'card-copy card-import';
	importModel.type = 'button';
	importModel.textContent = '导入本组';
	importModel.title = '导入该模型在本会话中的全部对话到 Copilot Chat';
	importModel.addEventListener('click', () =>
		post({ type: 'importToCopilot', turnId, key, scope: 'model' }),
	);

	const setContext = document.createElement('button');
	setContext.className = 'card-copy card-context';
	setContext.type = 'button';
	setContext.textContent = '设为上下文';
	setContext.title = '将这条回答作为后续所有模型共享的上下文';
	setContext.addEventListener('click', () => post({ type: 'setContext', turnId, key }));

	const status = document.createElement('span');
	status.className = 'card-status';

	const actions = document.createElement('div');
	actions.className = 'card-actions';
	actions.appendChild(copy);
	actions.appendChild(regenerate);
	actions.appendChild(importOne);
	actions.appendChild(importModel);
	actions.appendChild(setContext);

	head.appendChild(dot);
	head.appendChild(name);
	head.appendChild(status);
	head.appendChild(actions);
	card.appendChild(head);

	const body = document.createElement('div');
	body.className = 'card-body';
	card.appendChild(body);

	const entry: CardEntry = {
		key,
		turnId,
		card,
		body,
		copy,
		dot,
		status,
		regenerate,
		importOne,
		importModel,
		setContext,
		text: response?.text ?? '',
		res: response ?? { status: 'pending', text: '' },
		timer: 0,
	};

	state.cards.set(cardKey(turnId, key), entry);
	copy.addEventListener('click', () => {
		if (entry.text) {
			copyWithFeedback(entry.text, copy);
		}
	});

	renderBody(entry);
	updateStatus(entry);
	return card;
}

export function updateStatus(entry: CardEntry): void {
	const res = entry.res;
	entry.status.textContent = STATUS_TEXT[res.status] || res.status;
	entry.status.className = 'card-status s-' + res.status;
	entry.card.dataset.status = res.status;
	updateDot(entry.dot, res.status);

	// 选项卡与悬浮条都跟着状态走
	const tab = state.tabs.get(cardKey(entry.turnId, entry.key));
	if (tab) {
		updateTab(tab, res);
	}
	const last = latestTurn();
	const isLatest = !!last && last.id === entry.turnId;
	if (isLatest) {
		refreshMini(entry.key);
	}

	// 没有内容就没什么可复制的；生成中也别让用户点（点了会得到半截内容）
	entry.copy.disabled = !entry.text;
	entry.regenerate.hidden =
		!isLatest || res.status === 'streaming' || res.status === 'pending';
	const busy = res.status === 'streaming' || res.status === 'pending';
	const importDisabled = !entry.text || busy;
	entry.importOne.disabled = importDisabled;
	entry.importModel.disabled = importDisabled;
	entry.setContext.disabled = !entry.text || res.status !== 'done';
	const source = state.session.contextSource;
	entry.setContext.textContent =
		source && source.turnId === entry.turnId && source.modelKey === entry.key
			? '当前上下文'
			: '设为上下文';

	let hint = entry.card.querySelector('.card-hint');
	if (res.droppedImages) {
		if (!hint) {
			hint = document.createElement('div');
			hint.className = 'card-hint';
			entry.card.insertBefore(hint, entry.card.querySelector('.card-error'));
		}
		hint.textContent = '该模型不支持图片，本次已仅发送文本。';
	} else if (hint) {
		hint.remove();
	}

	let err = entry.card.querySelector('.card-error');
	if (res.error) {
		if (!err) {
			err = document.createElement('div');
			err.className = 'card-error';
			entry.card.appendChild(err);
		}
		err.textContent = res.error;
	} else if (err) {
		err.remove();
	}
}

export function renderBody(entry: CardEntry): void {
	const text = entry.text || '';
	const renderer = window.MarkdownRenderer;
	if (text.length > MD_RENDER_LIMIT) {
		// 超长回答退化为纯文本，避免 Markdown 解析 + 重排开销
		entry.body.classList.remove('md');
		entry.body.textContent = text;
		return;
	}
	entry.body.classList.add('md');
	entry.body.innerHTML = renderer ? renderer.render(text) : text;
}

/** 流式增量：先累积，再按 FLUSH_MS 合并成一次渲染。 */
export function applyChunk(turnId: string, key: string, text: string): void {
	const entry = state.cards.get(cardKey(turnId, key));
	if (!entry) {
		return;
	}
	const stick = nearBottom();
	entry.text += text;
	if (entry.timer) {
		return;
	}
	entry.timer = setTimeout(() => {
		entry.timer = 0;
		renderBody(entry);
		entry.copy.disabled = !entry.text;
		const last = latestTurn();
		if (last && last.id === turnId) {
			refreshMini(key);
		}
		if (stick) {
			scrollToBottom();
		}
	}, FLUSH_MS);
}

/** 字段级更新（状态 / 耗时 / 错误 / 图片降级标记）。 */
export function applyPatch(turnId: string, key: string, patch: Partial<ModelResponse>): void {
	const entry = state.cards.get(cardKey(turnId, key));
	const turn = state.session.turns.find((t) => t.id === turnId);
	if (turn?.responses?.[key]) {
		Object.assign(turn.responses[key], patch);
	}
	if (!entry) {
		return;
	}
	entry.res = Object.assign({}, entry.res, patch);
	if (typeof patch.text === 'string') {
		// 完整文本来了：丢掉还没来得及渲染的那一批，直接用新文本
		if (entry.timer) {
			clearTimeout(entry.timer);
			entry.timer = 0;
		}
		entry.text = patch.text;
		renderBody(entry);
	}
	updateStatus(entry);
}

/** 清空某条卡片（「重新生成」前，扩展侧会先推一条 reset）。 */
export function resetCard(turnId: string, key: string): void {
	const entry = state.cards.get(cardKey(turnId, key));
	if (!entry) {
		return;
	}
	if (entry.timer) {
		clearTimeout(entry.timer);
		entry.timer = 0;
	}
	entry.text = '';
	renderBody(entry);
	updateStatus(entry);
}
