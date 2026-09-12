/**
 * 轮次的渲染：整屏重建（`renderSession`）、追加一轮（`appendTurn`）、
 * 以及会话标题 / 上下文徽标（`renderSessionHeader`）。
 *
 * `appendTurn` 之所以要单独存在（而不是每次都整屏重建），是为了**流式输出期间
 * 不打断用户**：新的一轮只往消息区尾部追加，已有的 DOM、滚动位置、
 * 并排阅读状态都不动。
 */

import { state, el, turnNumber } from './state.js';
import type { TurnEls } from './state.js';
import { formatTime, modelLabel, openLightbox, scrollToBottom } from './ui.js';
import { applyVisibility, ensureFocusKey } from './display.js';
import { renderStrip } from './strip.js';
import { createCard } from './card.js';
import { createTab } from './tab.js';
import { refreshPromptActions, startEditPrompt } from './composer.js';
import { post } from './host.js';
import type { WireTurn } from '../src/types.js';

export function renderSessionHeader(): void {
	el.sessionTitle.textContent = state.session.title || '新会话';
	el.sessionTitle.title = '会话 ID：' + state.session.id;

	let contextBadge = document.getElementById('context-badge');
	if (!contextBadge) {
		contextBadge = document.createElement('button');
		contextBadge.id = 'context-badge';
		contextBadge.className = 'btn tiny context-badge';
		contextBadge.addEventListener('click', () => post({ type: 'clearContext' }));
		el.sessionTitle.parentElement?.appendChild(contextBadge);
	}

	// 「上下文」徽标：显示当前把哪条回答当共享上下文在用，点一下清除
	const source = state.session.contextSource;
	const sourceTurn = source && state.session.turns.find((turn) => turn.id === source.turnId);
	const sourceModel = sourceTurn && state.models.find((model) => model.key === source.modelKey);
	contextBadge.hidden = !source || !sourceTurn || !sourceModel;
	if (source && sourceTurn && sourceModel) {
		const round = state.session.turns.indexOf(sourceTurn) + 1;
		contextBadge.textContent =
			'上下文：' + modelLabel(sourceModel) + ' · 第 ' + round + ' 轮 ×';
		contextBadge.title = '当前使用「被选中的模型回答」作为后续所有模型的共享上下文，点击清除';
	}
}

/** 整屏重建消息区（切换会话、新建会话时用）。 */
export function renderSession(): void {
	renderSessionHeader();
	el.messages.textContent = '';
	state.cards.clear();
	state.tabs.clear();
	state.turnEls.clear();
	state.turnViews.clear();
	for (const turn of state.session.turns || []) {
		appendTurn(turn, false);
	}
	if ((state.session.turns || []).length === 0) {
		const hint = document.createElement('div');
		hint.className = 'welcome';
		hint.innerHTML =
			'<p>把同一个问题同时发给多个模型，再挑着读它们的回答。</p>' +
			'<ul>' +
			'<li>顶部每张卡片上：<b>左侧复选框</b> = 勾几个就<b>并排对比</b>几个；</li>' +
			'<li><b>点卡片正文</b> = 只看这一个（退出并排）；<b>右侧开关</b> = 它是否参与提问</li>' +
			'<li>回车发送，Shift+回车换行；可直接粘贴或拖入图片</li>' +
			'</ul>';
		el.messages.appendChild(hint);
	}
	ensureFocusKey();
	applyVisibility();
	renderStrip();
	scrollToBottom();
}

export function appendTurn(turn: WireTurn, doScroll: boolean): HTMLElement {
	el.messages.querySelector('.welcome')?.remove();

	const section = document.createElement('section');
	section.className = 'turn';

	// ── 轮次头：第 N 轮 · 时间
	const head = document.createElement('header');
	head.className = 'q-head';
	const badge = document.createElement('span');
	badge.className = 'q-badge';
	badge.textContent = '第 ' + turnNumber(turn.id) + ' 轮';
	const time = document.createElement('span');
	time.className = 'q-time';
	time.textContent = formatTime(turn.at);
	head.appendChild(badge);
	head.appendChild(time);
	section.appendChild(head);

	// ── 用户提问：一块带底色的「提问」区，与下面的模型回答拉开差别
	const qRow = document.createElement('div');
	qRow.className = 'q-row';

	// 提问区头部：左边是「你的提问」标签，右边是「编辑」按钮
	const qBar = document.createElement('div');
	qBar.className = 'q-bar';
	const qTag = document.createElement('div');
	qTag.className = 'q-tag';
	qTag.textContent = '你的提问';
	const qEdited = document.createElement('span');
	qEdited.className = 'q-edited';
	qEdited.textContent = '已编辑';
	qEdited.title = '这条提问在发送后被修改过';
	qEdited.hidden = !turn.editedAt;
	const qActions = document.createElement('div');
	qActions.className = 'q-actions';
	const editBtn = document.createElement('button');
	editBtn.type = 'button';
	editBtn.className = 'q-edit';
	editBtn.textContent = '编辑';
	editBtn.title = '编辑这一轮的提问';
	editBtn.addEventListener('click', () => startEditPrompt(turn.id));
	qActions.appendChild(editBtn);
	qBar.appendChild(qTag);
	qBar.appendChild(qEdited);
	qBar.appendChild(qActions);

	const qText = document.createElement('div');
	qText.className = 'q-text';
	qText.textContent = turn.prompt || '(图片消息)';

	// 编辑态容器：点击「编辑」后才填充 textarea 与按钮
	const editArea = document.createElement('div');
	editArea.className = 'q-edit-area hidden';

	qRow.appendChild(qBar);
	qRow.appendChild(qText);

	if (turn.images && turn.images.length) {
		const thumbs = document.createElement('div');
		thumbs.className = 'thumbs';
		for (const img of turn.images) {
			const thumb = document.createElement('img');
			thumb.src = img.dataUrl;
			thumb.alt = img.name || '图片';
			thumb.title = '点击放大';
			thumb.addEventListener('click', () => openLightbox(img.dataUrl));
			thumbs.appendChild(thumb);
		}
		qRow.appendChild(thumbs);
	}
	qRow.appendChild(editArea);
	section.appendChild(qRow);

	// ── 模型选项卡（仅单模型阅读模式可见）
	const tabbar = document.createElement('div');
	tabbar.className = 'tabbar';
	section.appendChild(tabbar);

	// ── 「模型回答」小标题（仅单读模式可见），把回答区和上面的提问区分开
	const answersLabel = document.createElement('div');
	answersLabel.className = 'answers-label';
	answersLabel.textContent = '模型回答';
	section.appendChild(answersLabel);

	// ── 各模型回答
	const cards = document.createElement('div');
	cards.className = 'cards';
	const keys = Object.keys(turn.responses || {});

	const missing = document.createElement('div');
	missing.className = 'pane-missing hidden';
	cards.appendChild(missing);

	if (keys.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'empty-tip';
		empty.textContent = '本轮没有可用的模型。';
		cards.appendChild(empty);
	}
	for (const key of keys) {
		tabbar.appendChild(createTab(turn.id, key, turn.responses[key]));
		cards.appendChild(createCard(turn.id, key, turn.responses[key]));
	}
	section.appendChild(cards);

	const info: TurnEls = {
		section,
		missing,
		tabbar,
		cards,
		qText,
		qEdited,
		editBtn,
		editArea,
		editing: false,
	};
	state.turnEls.set(turn.id, info);
	el.messages.appendChild(section);

	refreshPromptActions();
	if (doScroll) {
		scrollToBottom();
	}
	return section;
}
