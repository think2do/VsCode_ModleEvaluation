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
	view?: {
		focusKey?: string;
		compareKeys?: string[];
	};
	responses: Record<string, ModelResponse>;
}

export type WireTurn = Omit<Turn, 'images'> & { images: WireImage[] };

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
	contextSource?: {
		turnId: string;
		modelKey: string;
	};
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
