/**
 * 顶部悬浮条：把每个可用模型列成一张迷你卡。
 *
 * 每张迷你卡同时承担三件事（左 / 中 / 右）：
 * - 左侧复选框 → 加入并排对比（只影响怎么看）
 * - 卡片正文   → 单模型阅读这个模型（退出并排）
 * - 右侧开关   → 该模型是否参与提问（只影响问不问它）
 *
 * 空会话（还没有任何回答）时也照常列出，这样第一次提问前就能在这里选模型。
 *
 * 只负责**构建 DOM 与刷新状态**；并排/聚焦的状态写在 `display.ts`，
 * 「发送」按钮的可用性在 `composer.ts`。
 */

import { state, el, latestTurn, hasAnyTurn } from './state.js';
import type { MiniEntry } from './state.js';
import { latestViewInfo, renderStripActive, setCompare, setFocus } from './display.js';
import { modelColorVar, modelLabel, statusBrief, updateDot } from './ui.js';
import { updateSendEnabled } from './composer.js';
import { post } from './host.js';

export function renderStrip(): void {
	const list = state.models;
	el.stripList.textContent = '';
	state.minis.clear();
	// 悬浮条只反映最新一轮的并排勾选（它就是这个看法的最新状态）
	const latest = latestViewInfo();
	const comparing = latest ? latest.view.compare : new Set<string>();

	for (const model of list) {
		const mini = document.createElement('div');
		mini.className = 'mini';
		mini.style.setProperty('--c', modelColorVar(model.key));

		// ── 左：加入并排对比
		const compareLabel = document.createElement('label');
		compareLabel.className = 'mini-check';
		const compareBox = document.createElement('input');
		compareBox.type = 'checkbox';
		compareBox.disabled = !hasAnyTurn();
		compareBox.checked = comparing.has(model.key);
		compareBox.addEventListener('change', () => setCompare(model.key, compareBox.checked));
		compareLabel.appendChild(compareBox);
		compareLabel.title = hasAnyTurn()
			? '勾选后，该模型的回答会在这里并排展示，方便和其它模型逐条对比。\n只影响怎么看，不影响是否向它提问。'
			: '还没有回答可以对比 —— 先提问后再勾选。';
		compareLabel.addEventListener('click', (event) => event.stopPropagation());

		// ── 中：点这里 = 单模型阅读这个模型
		const body = document.createElement('div');
		body.className = 'mini-body';
		body.title = '只看 ' + modelLabel(model) + ' 的回答（退出并排对比）';

		const top = document.createElement('div');
		top.className = 'mini-top';
		const dot = document.createElement('span');
		dot.className = 'dot';
		const name = document.createElement('span');
		name.className = 'mini-name';
		name.textContent = modelLabel(model);
		name.title = model.key;
		const badge = document.createElement('span');
		badge.className = 'mini-badge';
		top.appendChild(dot);
		top.appendChild(name);
		if (model.supportsImages === false) {
			const noImg = document.createElement('span');
			noImg.className = 'no-image';
			noImg.textContent = '无图';
			noImg.title = '该模型不支持图片输入';
			top.appendChild(noImg);
		}
		top.appendChild(badge);

		body.appendChild(top);
		body.addEventListener('click', () => setFocus(model.key));

		// ── 右：开关 = 是否参与提问
		const toggle = document.createElement('label');
		toggle.className = 'mini-switch';
		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.checked = state.selected.has(model.key);
		checkbox.addEventListener('change', () => setModelSelected(model.key, checkbox.checked));
		const track = document.createElement('i');
		toggle.appendChild(checkbox);
		toggle.appendChild(track);
		toggle.title = '打开后该模型参与提问；\n关闭只是不再向它提问，已有的回答仍可以点开看。';
		// 点开关不应连带触发聚焦
		toggle.addEventListener('click', (event) => event.stopPropagation());

		mini.appendChild(compareLabel);
		mini.appendChild(body);
		mini.appendChild(toggle);
		el.stripList.appendChild(mini);

		const entry: MiniEntry = { root: mini, dot, badge, checkbox, compareBox, compareLabel };
		state.minis.set(model.key, entry);
		refreshMini(model.key);
	}

	const count = list.length;
	el.strip.classList.toggle('hidden', count === 0);
	// 悬浮条出现时消息区要额外留出它的高度（见 style.css 的 .strip-on）
	el.app.classList.toggle('strip-on', count > 0);
	renderStripActive();
}

/**
 * 只刷新某个模型的迷你卡（流式输出时高频调用，避免整条重建）。
 * 状态与耗时都取自**最新一轮**；没参与过本轮就只留个灰点。
 */
export function refreshMini(key: string): void {
	const mini = state.minis.get(key);
	if (!mini) {
		return;
	}
	const turn = latestTurn();
	const res = turn ? (turn.responses || {})[key] : undefined;
	if (!res) {
		mini.dot.className = 'dot d-idle';
		mini.badge.textContent = '';
		return;
	}
	updateDot(mini.dot, res.status);
	mini.badge.textContent = statusBrief(res);
}

/**
 * 切换某个模型是否参与提问（悬浮条右侧的开关）。
 * 立刻回报给扩展侧，这样勾选状态能跟着会话落盘。
 */
export function setModelSelected(key: string, on: boolean): void {
	if (on) {
		state.selected.add(key);
	} else {
		state.selected.delete(key);
	}
	renderStripActive();
	updateSendEnabled();
	post({ type: 'selectModels', selected: Array.from(state.selected) });
}
