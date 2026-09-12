/**
 * 每轮顶部的模型选项卡（只在单模型阅读模式下可见）。
 *
 * 选项卡本身就是「按轮」的控制：点它切换**那一轮**读哪个模型，左侧复选框则把
 * 该模型加入**那一轮**的并排对比。这与悬浮条不同 —— 悬浮条作用于最新一轮。
 */

import { state, cardKey } from './state.js';
import type { TabEntry } from './state.js';
import { viewForTurn, setTurnCompare, setTurnFocus } from './display.js';
import { modelColorVar, modelLabel, statusBrief, updateDot } from './ui.js';
import type { ModelResponse } from '../src/types.js';

export function createTab(turnId: string, key: string, response: ModelResponse): HTMLButtonElement {
	const model = state.models.find((m) => m.key === key);
	const tab = document.createElement('button');
	tab.type = 'button';
	tab.className = 'tab';
	tab.dataset.key = key;
	tab.style.setProperty('--c', modelColorVar(key));
	tab.title = (model ? model.key : key) + '\n点击后只切换本轮展示的模型';

	const dot = document.createElement('span');
	dot.className = 'dot';
	const name = document.createElement('span');
	name.className = 'nm';
	name.textContent = model ? modelLabel(model) : key;
	const time = document.createElement('span');
	time.className = 'tm';

	const check = document.createElement('input');
	check.type = 'checkbox';
	check.className = 'tab-check';
	check.checked = viewForTurn(turnId).compare.has(key);
	check.addEventListener('click', (event) => event.stopPropagation());
	check.addEventListener('change', () => setTurnCompare(turnId, key, check.checked));
	tab.appendChild(check);
	tab.appendChild(dot);
	tab.appendChild(name);
	tab.appendChild(time);
	tab.addEventListener('click', () => setTurnFocus(turnId, key));

	const entry: TabEntry = { tab, dot, tm: time, key };
	state.tabs.set(cardKey(turnId, key), entry);
	updateTab(entry, response);
	return tab;
}

export function updateTab(entry: TabEntry, res: ModelResponse | undefined): void {
	const status = res?.status ?? 'pending';
	updateDot(entry.dot, status);
	entry.tm.textContent = statusBrief(res ?? ({ status } as ModelResponse));
}
