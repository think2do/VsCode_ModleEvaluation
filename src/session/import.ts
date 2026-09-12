/**
 * 「导入到 Copilot」的内容规划。
 *
 * 纯函数：给定会话、模型与范围，算出要写进上下文文件的内容、文件名，
 * 以及写文件失败时的剪贴板兜底内容。落盘与打开编辑器是 `panel.ts` 的事。
 *
 * 之所以拆出来，是因为这段拼装（标题层级、轮次编号、分隔线）一旦写错，
 * 用户在 Copilot 里看到的上下文就是乱的，而这种错误没有报错、只有「感觉不对」。
 */

import type { ImportScope } from '../protocol';
import type { Session } from '../types';

export interface ImportPlan {
	/** 目标文件名（已做安全化处理） */
	fileName: string;
	/** 写进文件的内容 */
	fileText: string;
	/** 整段内容的自然语言包装版，用于写文件失败时复制到剪贴板 */
	query: string;
}

/**
 * 规划一次「导入到 Copilot」。
 *
 * @param scope `'model'` = 该模型在本会话里的全部对话；`'one'` = 仅 `turnId` 那一轮
 * @returns 没有任何可导入内容时返回 `undefined`
 */
export function planImport(options: {
	session: Session;
	modelName: string;
	modelKey: string;
	turnId?: string;
	scope: ImportScope;
}): ImportPlan | undefined {
	const { session, modelName, modelKey, turnId, scope } = options;
	const onlyThisTurn = scope !== 'model';

	const turns = session.turns.filter(
		(turn) => turn.responses[modelKey] && (!onlyThisTurn || turn.id === turnId),
	);
	if (turns.length === 0) {
		return undefined;
	}

	const content = turns
		.map((turn) => {
			const response = turn.responses[modelKey];
			const number = session.turns.findIndex((item) => item.id === turn.id) + 1;
			// 单条导入时带上轮次标题，方便在 Copilot 里对上号；整段导入时不必
			const heading = onlyThisTurn ? `## 第 ${number} 轮\n\n` : '';
			return (
				`${heading}### 用户\n\n${turn.prompt || '(图片消息)'}\n\n` +
				`### ${modelName}\n\n${response.text || '(无文本回复)'}`
			);
		})
		.join('\n\n---\n\n');

	const what = onlyThisTurn ? '单条回复及其提问' : '完整对话';
	const number = session.turns.findIndex((turn) => turn.id === turnId) + 1;
	const suffix = onlyThisTurn ? `第${number}轮` : '完整对话';

	return {
		fileName: `${safeFileName(session.title)}-${safeFileName(modelName)}-${suffix}.md`,
		fileText: `# ${modelName} 对话上下文\n\n${content}\n`,
		query: `以下是多模型对比会话中 ${modelName} 的${what}，请作为后续讨论的上下文。\n\n${content}`,
	};
}

/**
 * 文件名安全化。
 *
 * 注意：中文标题会被整体替换成 `-` 再裁掉，最终落到兜底的 `'model'`。
 * 这是既有行为（避免非 ASCII 文件名在不同文件系统上的麻烦），不是疏漏。
 */
function safeFileName(value: string): string {
	return (
		value
			.replace(/[^a-zA-Z0-9._-]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'model'
	);
}
