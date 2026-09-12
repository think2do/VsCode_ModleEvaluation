/**
 * 扩展侧消息的分发。
 *
 * 消息类型定义在 `src/types.ts` 的 `HostMessage`（与扩展侧共享同一份），
 * 所以这里 `switch (message.type)` 会自动收窄，各个分支里的字段都有类型、
 * 也不需要在每个 case 里手写类型断言。
 */

import { state, el } from './state.js';
import { notice } from './ui.js';
import { applyVisibility, ensureFocusKey } from './display.js';
import { renderStrip } from './strip.js';
import { appendTurn, renderSession, renderSessionHeader } from './turn.js';
import { renderSessions } from './sessions.js';
import { applyChunk, applyPatch, resetCard } from './card.js';
import { setSending } from './composer.js';
import type { HostMessage } from '../src/types.js';

/** 处理一条来自扩展侧的消息。认不出来的类型直接忽略。 */
export function handleHostMessage(data: unknown): void {
	if (!data || typeof data !== 'object') {
		return;
	}
	const message = data as HostMessage;

	switch (message.type) {
		case 'models':
			state.models = message.models || [];
			state.selected = new Set(message.selected || []);
			renderSessionHeader();
			renderStrip();
			if (message.warning) {
				notice('warn', message.warning);
			}
			break;

		case 'session':
			state.session = message.session;
			state.sessions = message.sessions || [];
			// 勾选状态以会话里记录的为准；各轮的展示设置由 renderSession 从该会话
			// 自己的 turn.view 重建，所以不会把上一个会话的看法带过来。
			state.selected = new Set(message.session.selectedModels || []);
			renderSession();
			renderSessions();
			setSending(false);
			break;

		case 'sessions':
			state.sessions = message.sessions || [];
			renderSessions();
			break;

		case 'turn':
			state.session.turns = state.session.turns || [];
			state.session.turns.push(message.turn);
			renderSessionHeader();
			appendTurn(message.turn, true);
			// 新的一轮若没问过当前聚焦的模型，ensureFocusKey 会切到本轮问过的
			// 第一个模型，否则这一轮会只剩一句「本轮未向 X 提问」。
			ensureFocusKey();
			applyVisibility();
			// 已经有回答了，悬浮条左复选框从此刻起可用
			renderStrip();
			setSending(true);
			break;

		case 'chunk':
			applyChunk(message.turnId, message.key, message.text);
			break;

		case 'patch':
			applyPatch(message.turnId, message.key, message.patch || {});
			break;

		case 'reset':
			resetCard(message.turnId, message.key);
			break;

		case 'prompt': {
			// 扩展侧改完提问后的轻量回推：只刷新这一轮的提问区，不整屏重渲染
			const turn = state.session.turns.find((t) => t.id === message.turnId);
			if (turn) {
				turn.prompt = message.prompt;
				turn.editedAt = message.editedAt;
			}
			const info = state.turnEls.get(message.turnId);
			// 用户正在这一轮里编辑时不要覆盖他的输入
			if (info && !info.editing) {
				info.qText.textContent = message.prompt || '(图片消息)';
				info.qEdited.hidden = !message.editedAt;
			}
			if (typeof message.title === 'string') {
				state.session.title = message.title;
			}
			if ('contextSource' in message) {
				state.session.contextSource = message.contextSource || undefined;
			}
			renderSessionHeader();
			break;
		}

		case 'idle':
			setSending(false);
			break;

		case 'notice':
			notice(message.level, message.message);
			break;

		case 'toggleHistory':
			el.history.classList.toggle('hidden');
			break;

		default:
			break;
	}
}
