/**
 * Webview ⇄ 扩展 的消息契约。
 *
 * 这是两侧**唯一**的一份协议定义：扩展侧在 `panel.ts` 用它做分发，Webview 侧
 * （`webview/src/`）用 `import type` 引入同一份类型。
 *
 * 起因：以前 `onMessage` 的每个 case 都要写一次
 * `message as unknown as { turnId?: string; key?: string }`，同一个字段名在
 * 十几处重复，改协议只能靠搜字符串。现在改这里一处就够了 —— 而且 switch 会
 * 按 `type` 自动收窄，不需要任何强转。
 *
 * 命名约定：
 * - `WebviewMessage` = **入**（Webview 发给扩展）
 * - `HostMessage`    = **出**（扩展发给 Webview）
 */

import type {
	ContextSource,
	ModelRef,
	ModelResponse,
	SessionSummary,
	TurnView,
	WireSession,
	WireTurn,
} from './types';

/** Webview 发过来的图片负载：还没落盘，带可直接渲染的 data URL。 */
export interface IncomingImage {
	dataUrl: string;
	mime?: string;
	name?: string;
}

/** 「导入到 Copilot」的范围：这一条回答 / 该模型在整个会话里的对话。 */
export type ImportScope = 'one' | 'model';

/** Webview → 扩展。 */
export type WebviewMessage =
	/** 界面加载完成，可以下发模型与会话了 */
	| { type: 'ready' }
	| { type: 'send'; prompt?: string; images: IncomingImage[]; selected?: string[] }
	| { type: 'stop' }
	| { type: 'regenerate'; turnId?: string; key?: string }
	| { type: 'editPrompt'; turnId?: string; prompt?: string; regenerate?: boolean }
	| { type: 'newSession' }
	| { type: 'selectModels'; selected: string[] }
	| { type: 'setContext'; turnId?: string; key?: string }
	| { type: 'clearContext' }
	| { type: 'updateTurnView'; turnId?: string; view?: TurnView }
	| { type: 'loadSession'; id?: string }
	| { type: 'deleteSession'; id?: string }
	| { type: 'requestSessions' }
	| { type: 'openLink'; href?: string }
	| { type: 'importToCopilot'; turnId?: string; key?: string; scope: ImportScope };

export type NoticeLevel = 'info' | 'warn' | 'error';

/** 扩展 → Webview。 */
export type HostMessage =
	| { type: 'models'; models: ModelRef[]; selected: string[]; warning: string }
	| { type: 'session'; session: WireSession; sessions: SessionSummary[] }
	| { type: 'sessions'; sessions: SessionSummary[] }
	/** 新的一轮（发送后立刻推，此时各模型都还是 pending） */
	| { type: 'turn'; turn: WireTurn }
	/** 流式增量 */
	| { type: 'chunk'; turnId: string; key: string; text: string }
	/** 状态 / 耗时 / 错误等字段级更新 */
	| { type: 'patch'; turnId: string; key: string; patch: Partial<ModelResponse> }
	/** 清空某模型的卡片，准备重新生成 */
	| { type: 'reset'; turnId: string; key: string }
	/**
	 * 编辑提问后的**轻量**回推：只刷新那一轮的提问区，不整屏重渲染
	 * （整屏重渲染会丢掉并排对比状态）。
	 *
	 * ⚠️ `contextSource` 必须是 `null` 而不是 `undefined` ——
	 * `postMessage` 会丢掉值为 `undefined` 的字段，用 `null` 才能把
	 * 「上下文已被清除」这件事真的传过去。
	 */
	| {
			type: 'prompt';
			turnId: string;
			prompt: string;
			editedAt?: number;
			title: string;
			contextSource: ContextSource | null;
	  }
	/** 本轮所有请求都结束了，可以解除「发送中」 */
	| { type: 'idle' }
	| { type: 'notice'; level: NoticeLevel; message: string }
	| { type: 'toggleHistory' };

// #region 运行时解析

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

/**
 * 字符串数组。字段缺失或类型不对时返回 `undefined` —— 用于「缺省代表回落到别的
 * 来源」的字段（如 `send.selected` 缺省表示沿用会话里已勾选的模型），
 * 这种字段不能把缺失归一化成 `[]`，否则就变成「一个模型都没勾」了。
 */
function asOptionalStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.filter((item): item is string => typeof item === 'string');
}

function asImages(value: unknown): IncomingImage[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: IncomingImage[] = [];
	for (const item of value) {
		const record = asRecord(item);
		// 没有 dataUrl 的图片没有任何用，直接丢掉
		const dataUrl = record ? asString(record.dataUrl) : undefined;
		if (!dataUrl) {
			continue;
		}
		out.push({ dataUrl, mime: asString(record?.mime), name: asString(record?.name) });
	}
	return out;
}

function asTurnView(value: unknown): TurnView | undefined {
	const record = asRecord(value);
	if (!record) {
		return undefined;
	}
	return { focusKey: asString(record.focusKey), compareKeys: asOptionalStringArray(record.compareKeys) };
}

/**
 * 把 Webview 发来的原始消息收窄成 `WebviewMessage`。
 *
 * 这里顺带做归一化（缺字段补默认值），这样各个 handler 不用再自己写
 * `?? []` / `typeof x === 'string'` —— 那些防御散在各处时，漏掉一处就是
 * 一个 `undefined is not an object`。
 *
 * 认不出来的消息返回 `undefined`，由调用方直接忽略。
 */
export function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
	const message = asRecord(raw);
	if (!message) {
		return undefined;
	}

	switch (message.type) {
		case 'ready':
			return { type: 'ready' };
		case 'stop':
			return { type: 'stop' };
		case 'newSession':
			return { type: 'newSession' };
		case 'clearContext':
			return { type: 'clearContext' };
		case 'requestSessions':
			return { type: 'requestSessions' };
		case 'send':
			return {
				type: 'send',
				prompt: asString(message.prompt),
				images: asImages(message.images),
				selected: asOptionalStringArray(message.selected),
			};
		case 'regenerate':
			return { type: 'regenerate', turnId: asString(message.turnId), key: asString(message.key) };
		case 'editPrompt':
			return {
				type: 'editPrompt',
				turnId: asString(message.turnId),
				prompt: asString(message.prompt),
				regenerate: asBoolean(message.regenerate),
			};
		case 'selectModels':
			return { type: 'selectModels', selected: asOptionalStringArray(message.selected) ?? [] };
		case 'setContext':
			return { type: 'setContext', turnId: asString(message.turnId), key: asString(message.key) };
		case 'updateTurnView':
			return {
				type: 'updateTurnView',
				turnId: asString(message.turnId),
				view: asTurnView(message.view),
			};
		case 'loadSession':
			return { type: 'loadSession', id: asString(message.id) };
		case 'deleteSession':
			return { type: 'deleteSession', id: asString(message.id) };
		case 'openLink':
			return { type: 'openLink', href: asString(message.href) };
		case 'importToCopilot':
			return {
				type: 'importToCopilot',
				turnId: asString(message.turnId),
				key: asString(message.key),
				scope: message.scope === 'model' ? 'model' : 'one',
			};
		default:
			return undefined;
	}
}

// #endregion
