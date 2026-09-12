/**
 * 共享类型定义。
 *
 * 命名约定：
 * - `Session` / `Turn` / `ImageAttachment` 是**落盘**的结构（不含 base64，避免会话文件膨胀）。
 * - `Wire*` 前缀的是**发给 Webview** 的结构（图片带 `dataUrl`，供界面直接渲染）。
 */

/** 落盘保存的图片附件。真实二进制存在 globalStorage/images 下。 */
export interface ImageAttachment {
	/** 文件名（不含目录） */
	file: string;
	/** MIME 类型，如 image/png */
	mime: string;
	/** 可读名称，仅用于界面提示 */
	name?: string;
}

/** 发给 Webview 的图片附件，额外带上可直接渲染的 data URL。 */
export interface WireImage extends ImageAttachment {
	dataUrl: string;
}

/** 暴露给界面的模型信息。 */
export interface ModelRef {
	/** 稳定标识，形如 `vendor:id` */
	key: string;
	id: string;
	vendor: string;
	family: string;
	name: string;
	maxInputTokens: number;
	/**
	 * 是否支持图片输入。
	 * - `true` / `false`：从运行时能力信息中读到了明确结论；
	 * - `undefined`：无法判断，只能"带图试一次，失败再降级"。
	 */
	supportsImages?: boolean;
}

export type ResponseStatus = 'pending' | 'streaming' | 'done' | 'error' | 'cancelled';

/** 单个模型对某一轮的应答状态。 */
export interface ModelResponse {
	text: string;
	status: ResponseStatus;
	error?: string;
	/** 从开始请求到结束的耗时（毫秒） */
	elapsedMs?: number;
	/** 该模型不支持图片，本次已降级为纯文本 */
	droppedImages?: boolean;
}

/**
 * 某一轮独立的展示设置。
 *
 * 这是「展示状态」的**唯一真相源**：`focusKey`（单读看哪个模型）与
 * `compareKeys`（并排对比哪几个）都只认这里，不存在第二份全局状态。
 * 缺省时由前端按上一轮的设置推导（新的一轮继承你上一轮的看法）。
 */
export interface TurnView {
	focusKey?: string;
	compareKeys?: string[];
}

/** 一轮对话：一条用户提问 + 各模型各自的回答。 */
export interface Turn {
	id: string;
	/** 时间戳 */
	at: number;
	prompt: string;
	/** 用户最后一次编辑提问的时间戳（目前只允许编辑最新一轮） */
	editedAt?: number;
	images: ImageAttachment[];
	/** 该轮独立的展示设置；缺省时由前端按上一轮或当前模型推导 */
	view?: TurnView;
	responses: Record<string, ModelResponse>;
}

export type WireTurn = Omit<Turn, 'images'> & { images: WireImage[] };

/**
 * 后续所有模型共享的单条回答来源。
 *
 * 用户可以把某条已完成的回答「设为上下文」，之后每次提问都会把它当
 * 助手侧的系统提示一起发过去。
 */
export interface ContextSource {
	turnId: string;
	modelKey: string;
}

/** 一次完整会话。 */
export interface Session {
	id: string;
	/** 取自首条提问，仅用于列表展示 */
	title: string;
	createdAt: number;
	updatedAt: number;
	/** 上次勾选的模型 key 列表 */
	selectedModels: string[];
	/** 后续所有模型共享的单条回答来源 */
	contextSource?: ContextSource;
	turns: Turn[];
}

export type WireSession = Omit<Session, 'turns'> & { turns: WireTurn[] };

/** 历史列表用的轻量摘要。 */
export interface SessionSummary {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	turnCount: number;
}

// #region Webview ⇄ 扩展 的消息契约
//
// 这是两侧**唯一**的一份协议定义：扩展侧在 `protocol.ts` 里做运行时收窄，
// Webview 侧（`webview/`）用 `import type` 引入同一份类型。
//
// 放在 `types.ts` 而不是 `protocol.ts`，是因为 Webview 只需要这些**类型**。
// `protocol.ts` 里的解析函数属于扩展侧运行时，不该被打进 Webview 的产物。

/**
 * Webview 发过来的图片负载：还没落盘，带可直接渲染的 data URL。
 * （`WireImage` 是反方向：已落盘、扩展侧发给界面。）
 */
export interface IncomingImage {
	dataUrl: string;
	mime?: string;
	name?: string;
}

/** 「导入到 Copilot」的范围：这一条回答 / 该模型在整个会话里的对话。 */
export type ImportScope = 'one' | 'model';

/** Webview → 扩展。 */
export type WebviewMessage =
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

// #endregion

