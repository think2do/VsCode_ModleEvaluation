/**
 * Webview → 扩展 消息的运行时收窄（解析器）。
 *
 * 消息的**类型**定义在 `types.ts`（扩展侧与 Webview 共享同一份定义）；
 * 这里只放扩展侧运行时需要的那部分：把 `unknown` 收窄成 `WebviewMessage`。
 *
 * 起因：以前 `onMessage` 的每个 case 都要写一次
 * `message as unknown as { turnId?: string; key?: string }`，同一个字段名在
 * 十几处重复，改协议只能靠搜字符串。现在改 `types.ts` 里的一处定义就够了 ——
 * 而且 switch 会按 `type` 自动收窄，不需要任何强转。
 *
 * 这里顺带做归一化（缺字段补默认值），这样各个 handler 不用再自己写
 * `?? []` / `typeof x === 'string'` —— 那些防御散在各处时，漏掉一处就是
 * 一个 `undefined is not an object`。
 */

import type { IncomingImage, TurnView, WebviewMessage } from './types';

// 让扩展侧可以只从 './protocol' 引入协议相关的一切
export type {
	HostMessage,
	ImportScope,
	IncomingImage,
	NoticeLevel,
	TurnView,
	WebviewMessage,
} from './types';

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
