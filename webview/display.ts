/**
 * 展示状态与它的 DOM 同步 —— 「谁可见、谁是当前项」。
 *
 * 这是整个前端最需要小心的地方，因为它同时管两件事：
 *
 * 1. **状态**：每轮的 `turnViews`（`focusKey` 单读看谁 / `compare` 并排对比哪几个）。
 *    这是展示状态的**唯一真相源**。历史教训：曾经同时存在一份全局的
 *    `compare`/`focusKey` 和每轮 `turn.view`，两份状态各被读一半，导致悬浮条上的
 *    控件点了完全没反应（详见 commit `fix(ui): 统一并排对比状态`）。
 * 2. **把状态刷到 DOM**：`applyVisibility()` 给每一轮切换并排/单读布局，
 *    `renderStripActive()` 刷新悬浮条上的高亮与勾选。
 *
 * ⚠️ 改 `applyVisibility()` 时，**所有派生的 UI 都要跟着刷新**，漏一处就会出现
 * 「要点两下才有反应」这类问题（曾经就漏了选项卡上的 `.tab-check.checked`）。
 * 完整清单见 `docs/refactor-checklist.md`。
 *
 * 本模块是叶子：不 import 任何其它业务模块，避免和悬浮条互相依赖成环。
 */

import { state, el, latestTurn, turnById, hasAnyTurn, visibleKeys } from './state.js';
import type { TurnViewState } from './state.js';
import { post } from './host.js';

/** 取某一轮的展示设置；没有就从上一轮（或本轮第一个模型）推导出来并记住。 */
export function viewForTurn(turnId: string): TurnViewState {
	let view = state.turnViews.get(turnId);
	if (!view) {
		const turn = turnById(turnId);
		const turns = state.session.turns;
		const index = turns.findIndex((item) => item.id === turnId);
		const previous = turns[Math.max(0, index - 1)];
		// 新的一轮继承上一轮的看法：上一轮在并排对比，新的一轮也并排
		const inherited = turn?.view ?? previous?.view;
		view = {
			focusKey:
				inherited?.focusKey ||
				Object.keys(turn?.responses || {})[0] ||
				state.models[0]?.key ||
				'',
			compare: new Set(inherited?.compareKeys || []),
		};
		state.turnViews.set(turnId, view);
	}
	return view;
}

/** 把某一轮的展示设置回报给扩展侧（落到会话文件里，切换会话后还在）。 */
export function saveTurnView(turnId: string): void {
	const view = viewForTurn(turnId);
	post({
		type: 'updateTurnView',
		turnId,
		view: { focusKey: view.focusKey, compareKeys: Array.from(view.compare) },
	});
}

/**
 * 悬浮条是「最新一轮」的快捷控制条 —— 它左侧的复选框与卡片正文都写进
 * **最新一轮**的展示设置，不另开一份全局状态。还没有任何轮次时返回 null。
 */
export function latestViewInfo(): { turnId: string; view: TurnViewState } | null {
	const last = latestTurn();
	return last ? { turnId: last.id, view: viewForTurn(last.id) } : null;
}

/** 是否处于「并排对比」：最新一轮勾了至少一个左复选框。 */
export function isCompareMode(): boolean {
	const info = latestViewInfo();
	return !!info && info.view.compare.size > 0;
}

/**
 * 修正「最新一轮」的聚焦模型。
 *
 * 优先沿用该轮已有的选择；选中的模型不在本轮、或已经不可见时，回落到本轮
 * 第一个问过的模型，再退回列表里的第一个 —— 否则这一轮会只剩一句
 * 「本轮未向 X 提问」，看起来像坏了。
 */
export function ensureFocusKey(): void {
	const available = visibleKeys();
	const last = latestTurn();
	if (!last) {
		return;
	}
	const view = viewForTurn(last.id);
	const asked = Object.keys(last.responses || {});
	view.focusKey =
		(asked.includes(view.focusKey) && available.includes(view.focusKey) ? view.focusKey : '') ||
		asked.find((key) => available.includes(key)) ||
		available[0] ||
		'';
}

/**
 * 点悬浮条的卡片正文 = 单模型阅读这个模型（并排对比会因此退出）。
 *
 * 作用于**最新一轮**：悬浮条是「现在」的控制条；历史轮次各自的看法由那一轮的
 * 选项卡控制。卡片标题栏上的模型名走 `setTurnFocus`，因为那里天然知道自己
 * 属于哪一轮。
 */
export function setFocus(key: string): void {
	if (!key) {
		return;
	}
	const info = latestViewInfo();
	if (!info) {
		return;
	}
	// 单读和并排是两种互斥的看「法」：进入单读要清掉并排勾选，
	// 否则「点了卡片却什么都没变」，会让人以为点击失效。
	const wasCompare = info.view.compare.size > 0;
	info.view.compare.clear();
	if (key === info.view.focusKey && !wasCompare) {
		return;
	}
	info.view.focusKey = key;
	saveTurnView(info.turnId);
	applyVisibility();
}

/**
 * 切换某模型的「并排对比」勾选（悬浮条卡片左侧的复选框）。
 * 只影响**怎么展示**，和「是否参与提问」无关。
 */
export function setCompare(key: string, on: boolean): void {
	const info = latestViewInfo();
	if (!info) {
		return;
	}
	if (on) {
		info.view.compare.add(key);
	} else {
		info.view.compare.delete(key);
	}
	saveTurnView(info.turnId);
	applyVisibility();
}

/** 切换某一轮的聚焦模型（选项卡、卡片标题栏）。并排勾选会被清掉。 */
export function setTurnFocus(turnId: string, key: string): void {
	const view = viewForTurn(turnId);
	view.focusKey = key;
	view.compare.clear();
	saveTurnView(turnId);
	applyVisibility();
}

/** 切换某模型在某一轮里的「并排对比」勾选（选项卡上的复选框）。 */
export function setTurnCompare(turnId: string, key: string, on: boolean): void {
	const view = viewForTurn(turnId);
	if (on) {
		view.compare.add(key);
	} else {
		view.compare.delete(key);
	}
	saveTurnView(turnId);
	applyVisibility();
}

/**
 * 记住滚动位置：重排前抓一个「锚点」轮次，重排后把它的相对偏移还原回去。
 * 否则切换聚焦模型 / 进出并排时，视口会莫名其妙跳走。
 */
function captureScrollAnchor(): { anchor: Element; offset: number } | null {
	const containerRect = el.messages.getBoundingClientRect();
	const turns = Array.from(el.messages.querySelectorAll('.turn'));
	const anchor =
		turns.find((turn) => turn.getBoundingClientRect().bottom > containerRect.top) ||
		turns[turns.length - 1];
	return anchor ? { anchor, offset: anchor.getBoundingClientRect().top - containerRect.top } : null;
}

function restoreScrollAnchor(snapshot: { anchor: Element; offset: number } | null): void {
	if (!snapshot || !snapshot.anchor.isConnected) {
		return;
	}
	const containerRect = el.messages.getBoundingClientRect();
	const currentOffset = snapshot.anchor.getBoundingClientRect().top - containerRect.top;
	el.messages.scrollTop += currentOffset - snapshot.offset;
}

/**
 * 统一刷新「谁可见、谁是当前项」。
 *
 * 两种展示方式是**按轮**的（每轮各自记住自己的看法）：
 * - **并排对比**（该轮勾了复选项）：同时列出被勾选的那几个模型，横向排开；
 * - **单模型阅读**（没勾）：只显示该轮聚焦模型的回答。
 *
 * 右侧开关（是否参与提问）不影响能不能看它已有的回答。
 */
export function applyVisibility(): void {
	const scrollAnchor = captureScrollAnchor();
	const previousOverflowAnchor = el.messages.style.overflowAnchor;
	el.messages.style.overflowAnchor = 'none';

	for (const [turnId, info] of state.turnEls) {
		const turn = turnById(turnId);
		const view = viewForTurn(turnId);
		const compare = view.compare.size > 0;
		info.cards.classList.toggle('tile', compare);
		info.section.classList.toggle('tile', compare);
		for (const entry of state.cards.values()) {
			if (entry.turnId !== turnId) {
				continue;
			}
			const visible = compare ? view.compare.has(entry.key) : entry.key === view.focusKey;
			entry.card.classList.toggle('hidden', !visible);
			entry.card.classList.toggle('tile', compare);
		}
		for (const tab of info.tabbar.querySelectorAll('.tab')) {
			const key = (tab as HTMLElement).dataset.key ?? '';
			const inCompare = view.compare.has(key);
			tab.classList.toggle('on', compare ? inCompare : key === view.focusKey);
			// 选项卡上的复选框也要跟着状态走：否则「点了卡片名退出并排」之后
			// 复选框还停在勾选态，再点一次反而被当成取消勾选，要点两下才有反应。
			const box = tab.querySelector<HTMLInputElement>('.tab-check');
			if (box) {
				box.checked = inCompare;
			}
		}
		for (const stale of Array.from(info.cards.querySelectorAll('.tile-missing'))) {
			stale.remove();
		}
		if (compare && turn) {
			for (const key of view.compare) {
				if ((turn.responses || {})[key]) {
					continue;
				}
				// 本轮没向这个模型提问，但用户要看它 —— 留一格虚线占位，
				// 保证各轮列出的列是对齐的
				const cell = document.createElement('article');
				cell.className = 'card tile-missing';
				cell.textContent = '本轮未向该模型提问。';
				info.cards.appendChild(cell);
			}
		}
		const showMissing = !compare && !!turn && !(turn.responses || {})[view.focusKey];
		info.missing.classList.toggle('hidden', !showMissing);
		if (showMissing) {
			info.missing.textContent = '本轮未向该模型提问。';
		}
	}
	renderStripActive();
	restoreScrollAnchor(scrollAnchor);
	requestAnimationFrame(() => {
		restoreScrollAnchor(scrollAnchor);
		el.messages.style.overflowAnchor = previousOverflowAnchor;
	});
}

/**
 * 悬浮条上的高亮与勾选状态。
 *
 * 与 `applyVisibility()` 分开，是因为它的输入只有「最新一轮的 view + 已勾选的
 * 模型」，纯派生，不需要碰消息区。`applyVisibility()` 会在末尾调它。
 */
export function renderStripActive(): void {
	const info = latestViewInfo();
	const compare = !!info && info.view.compare.size > 0;
	const focus = info ? info.view.focusKey : '';
	const hasTurn = hasAnyTurn();
	for (const [key, mini] of state.minis) {
		const comparing = !!info && info.view.compare.has(key);
		mini.root.classList.toggle('active', !compare && key === focus);
		mini.root.classList.toggle('off', !state.selected.has(key));
		mini.root.classList.toggle('comparing', comparing);
		mini.checkbox.checked = state.selected.has(key);
		mini.compareBox.checked = comparing;
		// 还没有任何回答时，没有内容可比，复选框置灰
		mini.compareBox.disabled = !hasTurn;
	}
}
