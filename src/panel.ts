/**
 * 多模型对比对话面板。
 *
 * 这里只做三件事：**消息路由、会话编排、把下面各层粘起来**。
 *
 * | 职责 | 在哪 |
 * | --- | --- |
 * | 模型发现 / 筛选 / 勾选收敛 | `lm/models.ts` |
 * | 上下文回放规则 | `lm/context.ts` |
 * | 流式请求与图片降级重试 | `lm/request.ts` |
 * | 错误码中文化 | `lm/errors.ts` |
 * | 会话纯数据操作 | `session/session.ts` |
 * | 「导入到 Copilot」内容拼装 | `session/import.ts` |
 * | 落盘结构 → 界面结构 | `webview/wire.ts` |
 * | Webview HTML 外壳 | `webview/html.ts` |
 * | 消息协议 | `protocol.ts` |
 */

import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { discoverModels } from './lm/discovery';
import { errText } from './lm/errors';
import { keyOf } from './lm/models';
import { runModel, type RunnerHost } from './lm/request';
import { parseWebviewMessage, type HostMessage, type WebviewMessage } from './protocol';
import { planImport } from './session/import';
import { writeImportPlan } from './session/importWriter';
import {
	createSession,
	findResponse,
	findTurn,
	latestTurn,
	resetResponse,
	turnIndex,
} from './session/session';
import { SessionStore } from './store';
import type { ImageAttachment, ModelResponse, Session, Turn } from './types';
import { buildPanelHtml } from './webview/html';
import { WireBuilder } from './webview/wire';

export class MultiModelChatPanel {
	public static current: MultiModelChatPanel | undefined;
	private static readonly viewType = 'multiModelCompare.chat';

	private readonly disposables: vscode.Disposable[] = [];
	/** key = ModelRef.key -> 正在进行的请求。既用于「全部停止」，也用于防重复生成 */
	private readonly running = new Map<string, vscode.CancellationTokenSource>();
	private readonly wire: WireBuilder;

	private models: vscode.LanguageModelChat[] = [];
	private session: Session = createSession([]);
	private ready = false;
	/** 面板已关闭。关闭后任何 postMessage 都会抛错，必须拦住。 */
	private disposed = false;

	public static createOrShow(context: vscode.ExtensionContext, store: SessionStore): MultiModelChatPanel {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
		if (MultiModelChatPanel.current) {
			MultiModelChatPanel.current.panel.reveal(column);
			return MultiModelChatPanel.current;
		}

		const panel = vscode.window.createWebviewPanel(
			MultiModelChatPanel.viewType,
			'多模型对比对话',
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
			},
		);

		MultiModelChatPanel.current = new MultiModelChatPanel(panel, context, store);
		return MultiModelChatPanel.current;
	}

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly context: vscode.ExtensionContext,
		private readonly store: SessionStore,
	) {
		this.wire = new WireBuilder(store);
		this.panel.webview.html = buildPanelHtml(this.panel.webview, context.extensionUri);
		this.panel.webview.onDidReceiveMessage(
			(message: unknown) => void this.onMessage(message),
			null,
			this.disposables,
		);
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
	}

	// #region 对外命令

	/** 新建一个空白会话（保留当前勾选的模型）。 */
	public async newSession(): Promise<void> {
		this.stopAll();
		this.session = createSession(this.session.selectedModels);
		if (this.ready) {
			await this.postSession();
		}
	}

	/** 切换历史会话侧栏的显隐。 */
	public toggleHistory(): void {
		this.post({ type: 'toggleHistory' });
	}

	/** 模型集合发生变化时刷新界面。 */
	public async refreshModels(): Promise<void> {
		const { models, visible, selected, warning } = await discoverModels(this.session.selectedModels);
		this.models = models;
		this.session.selectedModels = selected;
		this.post({ type: 'models', models: visible, selected, warning });
	}

	// #endregion

	// #region 消息路由

	/**
	 * 收窄并分发 Webview 消息。
	 *
	 * 这里不再需要 `message as unknown as {...}`：`parseWebviewMessage` 已经把原始
	 * 消息归一成判别联合，`switch` 会按 `type` 自动收窄类型，字段名与类型在编译期
	 * 就与 `protocol.ts` 对齐。
	 */
	private async onMessage(raw: unknown): Promise<void> {
		const message = parseWebviewMessage(raw);
		if (!message) {
			return;
		}

		switch (message.type) {
			case 'ready':
				this.ready = true;
				await this.refreshModels();
				await this.postSession();
				break;

			case 'send':
				await this.handleSend(message);
				break;

			case 'stop':
				this.stopAll();
				break;

			case 'regenerate':
				await this.handleRegenerate(message);
				break;

			case 'editPrompt':
				await this.handleEditPrompt(message);
				break;

			case 'newSession':
				await this.newSession();
				break;

			case 'selectModels':
				await this.handleSelectModels(message);
				break;

			case 'setContext':
				await this.handleSetContext(message);
				break;

			case 'clearContext':
				await this.handleClearContext();
				break;

			case 'updateTurnView':
				await this.handleUpdateTurnView(message);
				break;

			case 'loadSession':
				await this.handleLoadSession(message.id);
				break;

			case 'deleteSession':
				await this.handleDeleteSession(message.id);
				break;

			case 'requestSessions':
				await this.sendSessions();
				break;

			case 'openLink':
				await this.handleOpenLink(message.href);
				break;

			case 'importToCopilot':
				await this.handleImportToCopilot(message);
				break;
		}
	}

	// #endregion

	// #region 会话操作

	private async handleSelectModels(message: Extract<WebviewMessage, { type: 'selectModels' }>): Promise<void> {
		this.session.selectedModels = message.selected;
		await this.saveSession();
	}

	private async handleSetContext(message: Extract<WebviewMessage, { type: 'setContext' }>): Promise<void> {
		if (!message.turnId || !message.key) {
			return;
		}
		const response = findResponse(this.session, message.turnId, message.key);
		if (!response || response.status !== 'done' || !response.text.trim()) {
			this.notify('warn', '只有已完成且有内容的回答可以设为上下文。');
			return;
		}
		this.session.contextSource = { turnId: message.turnId, modelKey: message.key };
		await this.saveSession();
		await this.postSession();
	}

	private async handleClearContext(): Promise<void> {
		if (!this.session.contextSource) {
			return;
		}
		delete this.session.contextSource;
		await this.saveSession();
		await this.postSession();
	}

	private async handleUpdateTurnView(
		message: Extract<WebviewMessage, { type: 'updateTurnView' }>,
	): Promise<void> {
		if (!message.turnId || !message.view) {
			return;
		}
		const turn = findTurn(this.session, message.turnId);
		if (!turn) {
			return;
		}
		turn.view = {
			focusKey: message.view.focusKey,
			compareKeys: [...new Set(message.view.compareKeys ?? [])],
		};
		await this.saveSession();
	}

	private async handleLoadSession(id: string | undefined): Promise<void> {
		if (!id) {
			return;
		}
		const loaded = await this.store.load(id);
		if (!loaded) {
			this.notify('error', '这个会话已不存在或已损坏。');
			await this.sendSessions();
			return;
		}
		this.stopAll();
		this.session = loaded;
		await this.postSession();
	}

	private async handleDeleteSession(id: string | undefined): Promise<void> {
		if (!id) {
			return;
		}
		if (this.session.id === id) {
			this.stopAll();
			this.session = createSession(this.session.selectedModels);
		}
		await this.store.remove(id);
		await this.postSession();
	}

	// #endregion

	// #region 发送与重新生成

	private async handleSend(message: Extract<WebviewMessage, { type: 'send' }>): Promise<void> {
		const prompt = (message.prompt ?? '').trim();
		if (!prompt && message.images.length === 0) {
			return;
		}

		const selected = new Set(message.selected ?? this.session.selectedModels);
		const targets = this.models.filter((model) => selected.has(keyOf(model)));
		if (targets.length === 0) {
			this.notify('warn', '请至少勾选一个模型。');
			return;
		}

		const images = await this.persistImages(message);
		const turn: Turn = {
			id: randomUUID(),
			at: Date.now(),
			prompt,
			images,
			responses: {},
		};
		// 未开始的模型先标 pending，界面立刻能画出全部格子
		for (const model of targets) {
			turn.responses[keyOf(model)] = { text: '', status: 'pending' };
		}

		this.session.turns.push(turn);
		if (!this.session.title) {
			this.session.title = prompt.slice(0, 40) || '(图片消息)';
		}
		this.session.selectedModels = [...selected];

		this.post({ type: 'turn', turn: await this.wire.turn(turn) });
		await this.saveSession();
		await this.sendSessions();

		await this.runAndPublish(turn, targets);
		this.post({ type: 'idle' });
	}

	/** 把前端贴进来的图片落盘，并顺手把 data URL 记进缓存（省一次读盘）。 */
	private async persistImages(message: Extract<WebviewMessage, { type: 'send' }>): Promise<ImageAttachment[]> {
		const images: ImageAttachment[] = [];
		for (const incoming of message.images) {
			try {
				const saved = await this.store.saveImage(incoming.dataUrl, incoming.mime || 'image/png');
				images.push(saved);
				this.wire.remember(saved.file, incoming.dataUrl);
			} catch (err) {
				this.notify('warn', `图片保存失败：${errText(err)}`);
			}
		}
		return images;
	}

	private async handleRegenerate(
		message: Extract<WebviewMessage, { type: 'regenerate' }>,
	): Promise<void> {
		const { turnId, key } = message;
		if (!turnId || !key || this.running.has(key)) {
			return;
		}
		const turn = findTurn(this.session, turnId);
		// 只允许重新生成**最新一轮**：历史轮次被改写后，后续轮次会回放
		// 「新提问 + 旧回答」，上下文自相矛盾。
		if (!turn || latestTurn(this.session)?.id !== turnId) {
			return;
		}
		const model = this.models.find((candidate) => keyOf(candidate) === key);
		if (!model || !turn.responses[key]) {
			return;
		}

		this.resetAndNotify(turn, key);
		await this.runAndPublish(turn, [model]);
	}

	/**
	 * 编辑某一轮的提问。
	 *
	 * 只允许改**最新一轮**：历史轮次被改写后，后续轮次会回放「新提问 + 旧回答」，
	 * 上下文自相矛盾，所以宁可不支持。
	 *
	 * `regenerate` 为真时，把该轮**原有**的每个模型回答清空后并发重发 ——
	 * 以该轮 `responses` 里已有的 key 为准，不受之后开关变化影响。
	 */
	private async handleEditPrompt(
		message: Extract<WebviewMessage, { type: 'editPrompt' }>,
	): Promise<void> {
		const { turnId } = message;
		if (!turnId) {
			return;
		}
		if (this.running.size > 0) {
			this.notify('warn', '正在生成回答，请先停止或等完成后再编辑。');
			return;
		}
		const index = turnIndex(this.session, turnId);
		const turn = this.session.turns[index];
		if (!turn) {
			return;
		}
		if (index !== this.session.turns.length - 1) {
			this.notify('warn', '当前只支持编辑最新一轮提问。');
			return;
		}

		const prompt = (message.prompt ?? '').trim();
		if (!prompt && turn.images.length === 0) {
			this.notify('warn', '提问内容不能为空。');
			return;
		}
		await this.applyPromptEdit(turn, index, turnId, prompt);

		if (!message.regenerate) {
			return;
		}
		const models = Object.keys(turn.responses)
			.map((key) => this.models.find((candidate) => keyOf(candidate) === key))
			.filter((candidate): candidate is vscode.LanguageModelChat => !!candidate);
		if (models.length === 0) {
			this.notify('warn', '本轮没有可重新提问的模型。');
			return;
		}
		for (const model of models) {
			this.resetAndNotify(turn, keyOf(model));
		}
		await this.runAndPublish(turn, models);
		this.post({ type: 'idle' });
	}

	/** 写回编辑后的提问，并轻量回推给界面（不整屏重渲染）。 */
	private async applyPromptEdit(turn: Turn, index: number, turnId: string, prompt: string): Promise<void> {
		// 只在内容真的变了的时候才写盘，避免「保存」按钮空点一次也刷新时间
		if (turn.prompt === prompt) {
			return;
		}
		turn.prompt = prompt;
		turn.editedAt = Date.now();
		if (index === 0) {
			this.session.title = prompt.slice(0, 40) || '(图片消息)';
		}
		// 共享上下文指向本轮时，那条回答马上要被改写，先摘掉引用
		if (this.session.contextSource?.turnId === turnId) {
			delete this.session.contextSource;
		}
		await this.saveSession();
		this.post({
			type: 'prompt',
			turnId,
			prompt,
			editedAt: turn.editedAt,
			title: this.session.title,
			// 显式给 null：webview 的 postMessage 会丢掉值为 undefined 的字段，
			// 用 null 才能把「上下文已被清除」这件事传过去
			contextSource: this.session.contextSource ?? null,
		});
		await this.sendSessions();
	}

	/**
	 * 把某个模型在某轮的应答清空为「等待中」，并通知界面重置对应卡片。
	 * 「重新生成」与「编辑后重发」共用这一段。
	 */
	private resetAndNotify(turn: Turn, key: string): void {
		if (!resetResponse(turn, key)) {
			return;
		}
		this.post({ type: 'reset', turnId: turn.id, key });
	}

	/**
	 * 并发跑一组模型，并把请求绑定到**启动时的那个会话**。
	 *
	 * 之所以把 session 显式传下去而不是让请求层读面板字段：一次请求应该回放它
	 * 启动时那份历史，中途换会话不该改变它已经规划好的上下文。
	 */
	private async runAll(turn: Turn, models: vscode.LanguageModelChat[]): Promise<void> {
		const host: RunnerHost = {
			store: this.store,
			running: this.running,
			patch: (turnId, key, patch) => this.patch(turnId, key, patch),
			post: (message) => this.post(message),
		};
		const session = this.session;
		await Promise.all(models.map((model) => runModel(host, session, turn, model)));
	}

	/**
	 * 「提问 / 重新生成 / 编辑后重发」共用的收尾：
	 * 先把 pending 状态落盘（此时界面已经画出了全部格子），跑完再落盘并广播历史列表。
	 */
	private async runAndPublish(turn: Turn, models: vscode.LanguageModelChat[]): Promise<void> {
		await this.saveSession();
		await this.runAll(turn, models);
		await this.saveSession();
		await this.sendSessions();
	}

	private stopAll(): void {
		for (const cts of this.running.values()) {
			cts.cancel();
		}
	}

	// #endregion

	// #region 导入到 Copilot / 打开链接

	/**
	 * 把某个模型的回答写成工作区里的上下文文件并打开，方便在 Copilot Chat 里引用。
	 * 规划在 `session/import.ts`，写盘与失败兜底在 `session/importWriter.ts`。
	 */
	private async handleImportToCopilot(
		message: Extract<WebviewMessage, { type: 'importToCopilot' }>,
	): Promise<void> {
		const key = message.key;
		if (!key) {
			return;
		}
		const modelName = this.models.find((candidate) => keyOf(candidate) === key)?.name ?? key;
		const plan = planImport({
			session: this.session,
			modelName,
			modelKey: key,
			turnId: message.turnId,
			scope: message.scope,
		});
		if (!plan) {
			return;
		}
		await writeImportPlan(plan, {
			workspace: vscode.workspace.workspaceFolders?.[0],
			fallbackDir: this.context.globalStorageUri,
		});
	}

	/** 用系统默认浏览器打开回答里的链接（webview 自己开不了）。 */
	private async handleOpenLink(href: string | undefined): Promise<void> {
		if (!href) {
			return;
		}
		// 只放行明确安全的外部协议，防止被诱导打开本地文件或自定义协议
		if (!/^(https?:\/\/|mailto:)/i.test(href)) {
			return;
		}
		await vscode.env.openExternal(vscode.Uri.parse(href));
	}

	// #endregion

	// #region 与 Webview 的通信

	/** 更新应答的字段并推给界面。找不到目标就静默忽略（轮次可能已被切换掉）。 */
	private patch(turnId: string, key: string, patch: Partial<ModelResponse>): void {
		const response = findResponse(this.session, turnId, key);
		if (!response) {
			return;
		}
		Object.assign(response, patch);
		this.post({ type: 'patch', turnId, key, patch });
	}

	private async postSession(): Promise<void> {
		this.post({
			type: 'session',
			session: await this.wire.session(this.session),
			sessions: await this.store.list(),
		});
	}

	private async sendSessions(): Promise<void> {
		this.post({ type: 'sessions', sessions: await this.store.list() });
	}

	private notify(level: 'info' | 'warn' | 'error', message: string): void {
		this.post({ type: 'notice', level, message });
	}

	/** 更新时间戳并落盘。会话的每次可见改动都要经过这里。 */
	private async saveSession(): Promise<void> {
		this.session.updatedAt = Date.now();
		await this.store.save(this.session);
	}

	private post(message: HostMessage): void {
		// 面板关闭后访问 panel.webview 会抛 "Webview is disposed"，所以先看自己的标志位
		if (this.disposed) {
			return;
		}
		void this.panel.webview.postMessage(message);
	}

	// #endregion

	private dispose(): void {
		this.disposed = true;
		MultiModelChatPanel.current = undefined;
		this.stopAll();
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}
}
