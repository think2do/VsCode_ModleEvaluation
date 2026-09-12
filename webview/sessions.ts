/**
 * 右侧历史会话列表。
 *
 * 删除做成**两段式**（先点成「确认」，3 秒内再点才真删）：webview 里
 * `window.confirm` 不可靠（会被宿主拦掉或表现不一致），所以自己实现一次确认。
 */

import { state, el } from './state.js';
import { formatTime } from './ui.js';
import { post } from './host.js';

export function renderSessions(): void {
	el.sessionList.textContent = '';
	if (!state.sessions.length) {
		const li = document.createElement('li');
		li.className = 'empty-tip';
		li.textContent = '暂无历史会话';
		el.sessionList.appendChild(li);
		return;
	}

	for (const summary of state.sessions) {
		const li = document.createElement('li');
		li.className = 'session-item';
		if (summary.id === state.session.id) {
			li.classList.add('active');
		}

		const open = document.createElement('button');
		open.className = 'session-open';
		const title = document.createElement('span');
		title.className = 'session-title';
		title.textContent = summary.title || '(未命名)';
		const meta = document.createElement('span');
		meta.className = 'session-meta';
		meta.textContent = formatTime(summary.updatedAt) + ' · ' + summary.turnCount + ' 轮';
		open.appendChild(title);
		open.appendChild(meta);
		open.addEventListener('click', () => post({ type: 'loadSession', id: summary.id }));

		const del = document.createElement('button');
		del.className = 'session-del';
		del.textContent = '✕';
		del.title = '删除该会话';
		del.addEventListener('click', (event) => {
			event.stopPropagation();
			if (del.dataset.armed === '1') {
				post({ type: 'deleteSession', id: summary.id });
				return;
			}
			del.dataset.armed = '1';
			del.textContent = '确认';
			del.classList.add('armed');
			setTimeout(() => {
				del.dataset.armed = '';
				del.textContent = '✕';
				del.classList.remove('armed');
			}, 3000);
		});

		li.appendChild(open);
		li.appendChild(del);
		el.sessionList.appendChild(li);
	}
}
