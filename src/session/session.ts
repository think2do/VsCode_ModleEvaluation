/**
 * 会话的纯数据操作：不碰 vscode、不碰磁盘、不发消息。
 *
 * 放这里是因为这些动作（新建、清空某条应答、按 id 找轮次）在面板里被反复使用，
 * 散落在各个 handler 里时很容易把「找到轮次」的边界条件写错。
 */

import { randomUUID } from 'crypto';
import type { ModelResponse, Session, Turn } from '../types';

/** 新建一个空白会话。传上一轮的勾选，这样「新建会话」后不用重新勾模型。 */
export function createSession(selectedModels: string[]): Session {
	const now = Date.now();
	return {
		id: randomUUID(),
		title: '',
		createdAt: now,
		updatedAt: now,
		selectedModels,
		turns: [],
	};
}

export function findTurn(session: Session, turnId: string): Turn | undefined {
	return session.turns.find((turn) => turn.id === turnId);
}

export function findResponse(session: Session, turnId: string, key: string): ModelResponse | undefined {
	return findTurn(session, turnId)?.responses[key];
}

export function turnIndex(session: Session, turnId: string | undefined): number {
	return session.turns.findIndex((turn) => turn.id === turnId);
}

/** 最新一轮。多处逻辑（重新生成、编辑提问）都只对最新一轮生效。 */
export function latestTurn(session: Session): Turn | undefined {
	return session.turns[session.turns.length - 1];
}

/**
 * 把某个模型在某轮的应答清空为「等待中」，返回是否真的改动了。
 * 「重新生成」与「编辑后重发」共用这一段。
 */
export function resetResponse(turn: Turn, key: string): boolean {
	const response = turn.responses[key];
	if (!response) {
		return false;
	}
	response.text = '';
	response.status = 'pending';
	delete response.error;
	delete response.elapsedMs;
	delete response.droppedImages;
	return true;
}

/** 按文件里的模型 key 顺序找出对应的模型，用来「用本轮原有的模型重发」。 */
export function keysInOrder(turn: Turn): string[] {
	return Object.keys(turn.responses);
}
