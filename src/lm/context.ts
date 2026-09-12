/**
 * 上下文规划：决定「这次请求要回放哪些历史」。
 *
 * **本模块是纯函数、不 import vscode 的值**（只用 `import type`），所以能直接在
 * Node 里做快照测试 —— 而这里的规则恰恰是最容易改出上下文错乱的地方。
 *
 * 核心约定：**每个模型只回放它自己答完的那些轮次**。某个模型失败 / 被取消不会
 * 污染其它模型的对话历史，这也是这个扩展相对「共享一份历史」的关键差异。
 *
 * 构造真正的 `vscode.LanguageModelChatMessage`（以及解码图片字节）是 `request.ts` 的事。
 */

import type { ImageAttachment, Session, Turn } from '../types';

/** 一条要放进消息序列的上下文；图片只留文件引用，字节由调用方按需解码。 */
export type ContextEntry =
	| { role: 'user'; text: string; images: ImageAttachment[] }
	| { role: 'assistant'; text: string };

/** 「被选中的模型回答」在助手侧的前缀，让模型知道这段是用户挑出来的参考。 */
export const CONTEXT_SOURCE_PREFIX = '【被选中的模型回答】';

/**
 * 规划一次请求的完整上下文。
 *
 * @param supportsImages   该模型是否支持图片（`undefined`/`true` 都按支持处理）
 * @param currentImages    本轮要发的图片；调用方在「明确不支持图片」时应传 `[]`
 */
export function planContext(
	session: Session,
	turn: Turn,
	modelKey: string,
	supportsImages: boolean,
	currentImages: ImageAttachment[],
): ContextEntry[] {
	const entries: ContextEntry[] = [];

	for (const past of session.turns) {
		if (past.id === turn.id) {
			continue;
		}
		const answer = past.responses[modelKey];
		// 只回放这个模型**答完且有内容**的轮次：失败 / 取消 / 空回答都跳过，
		// 否则会把半截内容当历史发过去，模型会以为那就是自己说过的话。
		if (!answer || answer.status !== 'done' || !answer.text.trim()) {
			continue;
		}
		// 该模型此前就因为不支持图片而丢过附件，历史里也不要再发图片，
		// 免得每轮都白失败一次
		const images = supportsImages && !answer.droppedImages ? past.images : [];
		entries.push({ role: 'user', text: past.prompt, images });
		entries.push({ role: 'assistant', text: answer.text });
	}

	const source = session.contextSource;
	if (source) {
		const sourceTurn = session.turns.find((candidate) => candidate.id === source.turnId);
		const sourceResponse = sourceTurn?.responses[source.modelKey];
		if (sourceResponse?.status === 'done' && sourceResponse.text.trim()) {
			entries.push({
				role: 'assistant',
				text: `${CONTEXT_SOURCE_PREFIX}\n${sourceResponse.text}`,
			});
		}
	}

	entries.push({ role: 'user', text: turn.prompt, images: currentImages });
	return entries;
}
