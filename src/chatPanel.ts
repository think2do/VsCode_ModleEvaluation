import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { SessionStore, type PanelSettings } from './store';
import type {
	ImageAttachment,
	ModelRef,
	ModelResponse,
	Session,
	SessionSummary,
	Turn,
	WireSession,
	WireTurn,
} from './types';

/** 单次请求中已经解码好的图片。 */
interface ResolvedImage {
	data: Uint8Array;
	mime: string;
}

/** Webview 发过来的图片负载。 */
interface IncomingImage {
	dataUrl: string;
	mime?: string;
	name?: string;
}

function keyOf(model: { vendor: string; id: string }): string {
	return `${model.vendor}:${model.id}`;
}

/**
 * 探测模型是否支持图片输入。
 *
 * `vscode.lm` 的**消费侧**目前没有暴露稳定的能力查询接口，只有在"提供模型"那一侧
 * 才有 `LanguageModelChatCapabilities`。这里先尝试在运行时读一下，读不到就返回
 * `undefined`，由调用方走"带图试一次、失败再去图重试"的降级路径。
 */
function detectImageSupport(model: vscode.LanguageModelChat): boolean | undefined {
	const caps = (model as unknown as { capabilities?: { imageInput?: boolean } }).capabilities;
	if (caps && typeof caps.imageInput === 'boolean') {
		return caps.imageInput;
	}
	return undefined;
}

function toModelRef(model: vscode.LanguageModelChat): ModelRef {
	return {
		key: keyOf(model),
		id: model.id,
		vendor: model.vendor,
		family: model.family,
		name: model.name,
		maxInputTokens: model.maxInputTokens,
		supportsImages: detectImageSupport(model),
	};
}

function createSession(selectedModels: string[]): Session {
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

/** 常见模型错误码的中文补充说明，帮助用户直接知道该怎么办。 */
const LM_ERROR_HINT: Record<string, string> = {
	NoPermissions:
		'本扩展尚未获得该模型的使用授权。请在命令面板执行「管理语言模型访问 / Manage Language Model Access」授权，或按弹出的提示允许。',
	Blocked: '该模型请求被安全策略拦截。企业环境请检查组织策略设置。',
	NotFound: '找不到该模型，可能已被移除，或当前账户无权访问。',
	Unknown: '模型侧返回了未知错误，可稍后重试，或检查该端点配置。',
};

function errText(err: unknown): string {
	if (err instanceof vscode.LanguageModelError) {
		// code 可能是 'NotFound' 也可能是 'LanguageModelError.NotFound'，统一取末段
		const name = err.code.includes('.') ? err.code.split('.').pop() ?? err.code : err.code;
		const hint = LM_ERROR_HINT[name];
		return hint ? `[${err.code}] ${err.message}\n${hint}` : `[${err.code}] ${err.message}`;
	}
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

function isCancellation(err: unknown): boolean {
	return err instanceof vscode.CancellationError;
}

/**
 * 多模型对比对话面板。
 *
 * 每个模型**独立维护自己的上下文**：构造请求时只回放"该模型此前答完的那些轮"，
 * 因此某个模型失败 / 被取消不会污染其它模型的对话历史。
 */
export class MultiModelChatPanel {
	public static current: MultiModelChatPanel | undefined;
	private static readonly viewType = 'multiModelCompare.chat';

	private readonly disposables: vscode.Disposable[] = [];
	/** key = ModelRef.key，正在进行的请求 */
	private readonly running = new Map<string, vscode.CancellationTokenSource>();
	/** 文件名 -> data URL，避免重复读盘 */
	private readonly imageCache = new Map<string, string>();

	private models: vscode.LanguageModelChat[] = [];
	private session: Session = createSession([]);
	private sessionSummaries: SessionSummary[] = [];
	private ready = false;
	/** 面板已关闭。关闭后任何 postMessage 都会抛错，必须拦住。 */
	private disposed = false;
	/** 面板设置（卡片宽度等），从 globalStorage 读取 */
	private settings: PanelSettings = {};
	private readonly settingsReady: Promise<void>;

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
		this.settingsReady = this.store.loadSettings().then((loaded) => {
			this.settings = loaded;
		});
		this.panel.webview.html = this.buildHtml();
		this.panel.webview.onDidReceiveMessage(
			(message: unknown) => void this.onMessage(message as { type?: string }),
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

	/** 读取与模型筛选相关的设置。 */
	private getFilterConfig(): { vendors: string[]; cap: number; onlyPreferred: boolean } {
		const config = vscode.workspace.getConfiguration('multiModelCompare');
		return {
			vendors: (config.get<string[]>('preferredVendors') ?? [])
				.map((v) => v.trim().toLowerCase())
				.filter(Boolean),
			cap: config.get<number>('maxSelectedModels') ?? 0,
			onlyPreferred: config.get<boolean>('onlyPreferredVendors') ?? true,
		};
	}

	/** 模型集合或筛选设置发生变化时刷新界面。 */
	public async refreshModels(): Promise<void> {
		let all: vscode.LanguageModelChat[] = [];
		const notes: string[] = [];

		try {
			all = await vscode.lm.selectChatModels({});
		} catch (err) {
			notes.push(`读取模型列表失败：${errText(err)}`);
		}

		const { vendors, cap, onlyPreferred } = this.getFilterConfig();
		const refs = all.map(toModelRef);

		// 开启「只看我的模型」时，只保留 preferredVendors 下的模型。
		// 若过滤后一个不剩，则回退为全部可见，避免用户面对一个空列表不知道怎么办。
		let visible = refs;
		let fellBack = false;
		if (onlyPreferred && vendors.length > 0) {
			const filtered = refs.filter((r) => vendors.includes(r.vendor.toLowerCase()));
			if (filtered.length > 0) {
				visible = filtered;
			} else if (refs.length > 0) {
				fellBack = true;
			}
		}

		// this.models 必须与界面上看到的模型严格一致，
		// 否则 handleSend 里计算出的 targets 会与用户所见不符。
		const visibleKeys = new Set(visible.map((r) => r.key));
		this.models = all.filter((m) => visibleKeys.has(keyOf(m)));

		if (visible.length === 0) {
			notes.push(
				'没有找到可用模型。请确认已登录并授权使用语言模型，' +
					'并在命令面板执行「管理语言模型 / Manage Language Models」检查自定义端点是否可用。',
			);
		} else {
			if (fellBack) {
				// 常见的首次使用场景：用户没配 preferredVendors 指定的端点。
				// 此时复选框仍是勾选状态却显示了全部模型，必须解释清楚，否则看起来很矛盾。
				notes.push(
					`「只看我的模型」按 multiModelCompare.preferredVendors（${vendors.join('、')}）` +
						`找不到任何模型，已暂时显示全部 ${refs.length} 个可用模型。` +
						'想默认只看某个来源的模型，请把该设置改成对应的 vendor 名。',
				);
			}
			notes.push(...this.reconcileSelection(visible, cap));
			if (visible.length < refs.length) {
				notes.push(
					`已隐藏 ${refs.length - visible.length} 个其它来源的模型；` +
						'需要时取消勾选「只看我的模型」即可查看全部。',
				);
			}
		}

		this.post({
			type: 'models',
			models: visible,
			selected: this.session.selectedModels,
			onlyPreferred,
			warning: notes.join('\n'),
		});
	}

	// #endregion

	// #region 消息分发

	private async onMessage(message: { type?: string }): Promise<void> {
		switch (message.type) {
			case 'ready':
				this.ready = true;
				await this.refreshModels();
				await this.postSession();
				break;
			case 'send':
				await this.handleSend(
					message as unknown as {
						prompt?: string;
						images?: IncomingImage[];
						selected?: string[];
					},
				);
				break;
			case 'stop':
				this.stopAll();
				break;
			case 'newSession':
				await this.newSession();
				break;
			case 'selectModels':
				await this.handleSelectModels((message as unknown as { selected?: string[] }).selected ?? []);
				break;
			case 'loadSession':
				await this.handleLoadSession((message as unknown as { id?: string }).id);
				break;
			case 'deleteSession':
				await this.handleDeleteSession((message as unknown as { id?: string }).id);
				break;
			case 'requestSessions':
				await this.sendSessions();
				break;
			case 'setOnlyPreferred':
				await this.handleSetOnlyPreferred(
					(message as unknown as { value?: boolean }).value === true,
				);
				break;
			case 'saveWidths':
				await this.handleSaveWidths(
					(message as unknown as { widths?: Record<string, number> }).widths ?? {},
				);
				break;
			case 'openLink':
				await this.handleOpenLink((message as unknown as { href?: string }).href);
				break;
			default:
				break;
		}
	}

	/** 记住用户拖拽过的卡片宽度（全局，不限会话）。 */
	private async handleSaveWidths(widths: Record<string, number>): Promise<void> {
		await this.settingsReady;

		const clean: Record<string, number> = {};
		for (const [key, value] of Object.entries(widths)) {
			if (typeof key === 'string' && key && typeof value === 'number' && Number.isFinite(value)) {
				// 夹到合理区间，避免脏数据把布局搞坏
				clean[key] = Math.max(160, Math.min(1600, Math.round(value)));
			}
		}

		this.settings = { ...this.settings, cardWidths: clean };
		await this.store.saveSettings(this.settings);
	}

	/** 用系统默认浏览器打开回答里的链接（webview 自己开不了）。 */
	private async handleOpenLink(href: unknown): Promise<void> {
		if (typeof href !== 'string') {
			return;
		}
		// 只放行明确安全的外部协议，防止被诱导打开本地文件或自定义协议
		if (!/^(https?:\/\/|mailto:)/i.test(href)) {
			return;
		}
		await vscode.env.openExternal(vscode.Uri.parse(href));
	}

	/**
	 * 切换「只看我的模型」。
	 *
	 * 写入用户设置（Global），因此会持久化，也方便用户在设置界面里改。
	 * 写完后由 extension.ts 里的 onDidChangeConfiguration 监听触发刷新，
	 * 保证「界面开关」与「设置项」始终是同一个数据源。
	 */
	private async handleSetOnlyPreferred(value: boolean): Promise<void> {
		await vscode.workspace
			.getConfiguration('multiModelCompare')
			.update('onlyPreferredVendors', value, vscode.ConfigurationTarget.Global);
	}

	private async handleSelectModels(selected: string[]): Promise<void> {
		this.session.selectedModels = selected;
		this.session.updatedAt = Date.now();
		await this.store.save(this.session);
	}

	private async handleLoadSession(id: string | undefined): Promise<void> {
		if (!id) {
			return;
		}
		const loaded = await this.store.load(id);
		if (!loaded) {
			this.post({ type: 'notice', level: 'error', message: '这个会话已不存在或已损坏。' });
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

	// #region 发送与流式请求

	private async handleSend(message: {
		prompt?: string;
		images?: IncomingImage[];
		selected?: string[];
	}): Promise<void> {
		const prompt = (message.prompt ?? '').trim();
		const incoming = message.images ?? [];
		if (!prompt && incoming.length === 0) {
			return;
		}

		const selected = new Set(message.selected ?? this.session.selectedModels);
		const targets = this.models.filter((m) => selected.has(keyOf(m)));
		if (targets.length === 0) {
			this.post({ type: 'notice', level: 'warn', message: '请至少勾选一个模型。' });
			return;
		}

		// 1. 图片落盘
		const images: ImageAttachment[] = [];
		for (const img of incoming) {
			try {
				const mime = img.mime || 'image/png';
				const saved = await this.store.saveImage(img.dataUrl, mime);
				images.push(saved);
				this.imageCache.set(saved.file, img.dataUrl);
			} catch (err) {
				this.post({ type: 'notice', level: 'warn', message: `图片保存失败：${errText(err)}` });
			}
		}

		// 2. 建立本轮结构，未开始的模型先标 pending
		const turn: Turn = {
			id: randomUUID(),
			at: Date.now(),
			prompt,
			images,
			responses: {},
		};
		for (const model of targets) {
			turn.responses[keyOf(model)] = { text: '', status: 'pending' };
		}

		this.session.turns.push(turn);
		if (!this.session.title) {
			this.session.title = prompt.slice(0, 40) || '(图片消息)';
		}
		this.session.selectedModels = [...selected];
		this.session.updatedAt = Date.now();

		this.post({ type: 'turn', turn: await this.toWireTurn(turn) });
		await this.store.save(this.session);
		await this.sendSessions();

		// 3. 并发向所有勾选模型发起请求
		await Promise.all(targets.map((model) => this.runModel(turn, model)));

		// 4. 落盘 + 通知界面解除"发送中"状态
		this.session.updatedAt = Date.now();
		await this.store.save(this.session);
		await this.sendSessions();
		this.post({ type: 'idle' });
	}

	private async runModel(turn: Turn, model: vscode.LanguageModelChat): Promise<void> {
		const key = keyOf(model);
		const response = turn.responses[key];
		if (!response) {
			return;
		}

		const cts = new vscode.CancellationTokenSource();
		this.running.set(key, cts);
		const started = Date.now();

		// 明确不支持图片时，直接降级，不浪费一次失败请求
		const knownUnsupported = detectImageSupport(model) === false;
		const droppedImages = knownUnsupported && turn.images.length > 0;
		if (droppedImages) {
			this.patch(turn.id, key, { droppedImages: true });
		}

		const imagesToSend = knownUnsupported ? [] : await this.loadImages(turn.images);

		try {
			this.patch(turn.id, key, { status: 'streaming' });
			await this.streamInto(turn, model, imagesToSend, response, cts.token);
			this.patch(turn.id, key, {
				status: 'done',
				text: response.text,
				elapsedMs: Date.now() - started,
			});
			return;
		} catch (err) {
			if (isCancellation(err) || cts.token.isCancellationRequested) {
				this.patch(turn.id, key, {
					status: 'cancelled',
					text: response.text,
					elapsedMs: Date.now() - started,
				});
				return;
			}

			// 图片支持情况未知时，去掉图片重试一次
			if (!knownUnsupported && imagesToSend.length > 0) {
				try {
					response.text = '';
					this.post({ type: 'reset', turnId: turn.id, key });
					await this.streamInto(turn, model, [], response, cts.token);
					this.patch(turn.id, key, {
						status: 'done',
						text: response.text,
						droppedImages: true,
						elapsedMs: Date.now() - started,
					});
					return;
				} catch (retryErr) {
					if (isCancellation(retryErr) || cts.token.isCancellationRequested) {
						this.patch(turn.id, key, {
							status: 'cancelled',
							text: response.text,
							elapsedMs: Date.now() - started,
						});
						return;
					}
					this.patch(turn.id, key, {
						status: 'error',
						text: response.text,
						error: errText(retryErr),
						elapsedMs: Date.now() - started,
					});
					return;
				}
			}

			this.patch(turn.id, key, {
				status: 'error',
				text: response.text,
				error: errText(err),
				elapsedMs: Date.now() - started,
			});
		} finally {
			this.running.delete(key);
			cts.dispose();
		}
	}

	private async streamInto(
		turn: Turn,
		model: vscode.LanguageModelChat,
		images: ResolvedImage[],
		response: ModelResponse,
		token: vscode.CancellationToken,
	): Promise<void> {
		const key = keyOf(model);
		const messages = await this.buildMessages(turn, model, images);
		const chatResponse = await model.sendRequest(messages, {}, token);

		for await (const chunk of chatResponse.text) {
			if (token.isCancellationRequested) {
				break;
			}
			response.text += chunk;
			this.post({ type: 'chunk', turnId: turn.id, key, text: chunk });
		}
	}

	/**
	 * 组装发给某个模型的消息序列。
	 *
	 * 只回放**该模型自己**答完的历史轮次，保证各模型上下文互相隔离。
	 */
	private async buildMessages(
		turn: Turn,
		model: vscode.LanguageModelChat,
		currentImages: ResolvedImage[],
	): Promise<vscode.LanguageModelChatMessage[]> {
		const supportsImages = detectImageSupport(model) !== false;
		const messages: vscode.LanguageModelChatMessage[] = [];

		for (const past of this.session.turns) {
			if (past.id === turn.id) {
				continue;
			}
			const answer = past.responses[keyOf(model)];
			if (!answer || answer.status !== 'done' || !answer.text.trim()) {
				continue;
			}
			// 该模型此前就因为不支持图片而丢过附件，历史里也不要再发图片，免得每轮都失败一次
			const pastImages =
				supportsImages && !answer.droppedImages ? await this.loadImages(past.images) : [];
			messages.push(vscode.LanguageModelChatMessage.User(this.buildParts(past.prompt, pastImages)));
			messages.push(vscode.LanguageModelChatMessage.Assistant(answer.text));
		}

		messages.push(vscode.LanguageModelChatMessage.User(this.buildParts(turn.prompt, currentImages)));
		return messages;
	}

	private buildParts(
		text: string,
		images: ResolvedImage[],
	): Array<vscode.LanguageModelTextPart | vscode.LanguageModelDataPart> {
		const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelDataPart> = [];
		// 纯图片消息也要有文本部分，部分端点不接受空文本
		parts.push(new vscode.LanguageModelTextPart(text.trim() ? text : ' '));
		for (const image of images) {
			parts.push(vscode.LanguageModelDataPart.image(image.data, image.mime));
		}
		return parts;
	}

	private async loadImages(images: ImageAttachment[]): Promise<ResolvedImage[]> {
		const out: ResolvedImage[] = [];
		for (const image of images) {
			try {
				out.push({ data: await this.store.readImage(image.file), mime: image.mime });
			} catch {
				// 图片丢了就跳过，不让整个请求失败
			}
		}
		return out;
	}

	private stopAll(): void {
		for (const cts of this.running.values()) {
			cts.cancel();
		}
	}

	// #endregion

	// #region 与 Webview 的通信

	private patch(turnId: string, key: string, patch: Partial<ModelResponse>): void {
		const turn = this.session.turns.find((t) => t.id === turnId);
		const response = turn?.responses[key];
		if (!turn || !response) {
			return;
		}
		Object.assign(response, patch);
		this.post({ type: 'patch', turnId, key, patch });
	}

	private async postSession(): Promise<void> {
		await this.settingsReady;
		this.sessionSummaries = await this.store.list();
		this.post({
			type: 'session',
			session: await this.toWireSession(this.session),
			sessions: this.sessionSummaries,
			cardWidths: this.settings.cardWidths ?? {},
		});
	}

	private async sendSessions(): Promise<void> {
		this.sessionSummaries = await this.store.list();
		this.post({ type: 'sessions', sessions: this.sessionSummaries });
	}

	/**
	 * 让勾选状态与当前可见模型保持一致，并返回需要提示给用户的说明。
	 *
	 * 规则：
	 * 1. 已勾选的模型若仍可见就保留（尊重用户的选择）；
	 * 2. 若一个都没勾上（首次使用，或之前勾的都被隐藏了）则默认全选；
	 * 3. 数量超过 `maxSelectedModels` 时只勾选前 N 个并明确告知 —— 避免一次提问
	 *    并发打到十几个模型上（费用高、易触发限流、对比视图也没法看）。
	 *
	 * 注意：此处会把**不可见**的模型从勾选列表里移除，即“隐藏即不可选”，
	 * 防止出现「看不见但仍在偷偷参与对比」的情况。
	 */
	private reconcileSelection(refs: ModelRef[], cap: number): string[] {
		const available = new Set(refs.map((r) => r.key));
		const kept = this.session.selectedModels.filter((key) => available.has(key));
		let keys = kept.length > 0 ? kept : refs.map((r) => r.key);
		const notes: string[] = [];

		if (cap > 0 && keys.length > cap) {
			notes.push(
				`符合默认勾选条件的模型有 ${keys.length} 个，已只勾选前 ${cap} 个` +
					`（受 multiModelCompare.maxSelectedModels 限制），其余请按需手动勾选。`,
			);
			keys = keys.slice(0, cap);
		}

		this.session.selectedModels = keys;
		return notes;
	}

	private async toWireSession(session: Session): Promise<WireSession> {
		const turns: WireTurn[] = [];
		for (const turn of session.turns) {
			turns.push(await this.toWireTurn(turn));
		}
		return { ...session, turns };
	}

	private async toWireTurn(turn: Turn): Promise<WireTurn> {
		const images = [];
		for (const image of turn.images) {
			let dataUrl = this.imageCache.get(image.file);
			if (!dataUrl) {
				try {
					const bytes = await this.store.readImage(image.file);
					dataUrl = `data:${image.mime};base64,${Buffer.from(bytes).toString('base64')}`;
					this.imageCache.set(image.file, dataUrl);
				} catch {
					continue; // 图片文件丢了，界面就不显示这张
				}
			}
			images.push({ file: image.file, mime: image.mime, name: image.name, dataUrl });
		}
		return { ...turn, images };
	}

	private post(message: unknown): void {
		// 面板关闭后访问 panel.webview 会抛 "Webview is disposed"，所以先看自己的标志位
		if (this.disposed) {
			return;
		}
		void this.panel.webview.postMessage(message);
	}

	// #endregion

	// #region 界面

	private buildHtml(): string {
		const webview = this.panel.webview;
		const nonce = randomUUID().replace(/-/g, '');
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'),
		);
		const markdownUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', 'markdown.js'),
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', 'style.css'),
		);
		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} data: blob:`,
			`style-src ${webview.cspSource}`,
			`font-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');

		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link href="${styleUri}" rel="stylesheet" />
	<title>多模型对比对话</title>
</head>
<body>
	<div id="app">
		<header id="toolbar">
			<div class="tb-left">
				<span class="app-title">多模型对比对话</span>
				<span id="session-title" class="session-badge"></span>
			</div>
			<div class="tb-right">
				<button id="newSession" class="btn">新建会话</button>
				<button id="toggleHistory" class="btn">历史</button>
			</div>
		</header>

		<div id="resultbar" class="hidden">
			<span class="modelbar-label">显示结果</span>
			<div id="resultToggles" class="models"></div>
			<button id="showAllResults" class="btn tiny hidden">全部显示</button>
		</div>

		<div id="modelbar">
			<span class="modelbar-label">参与对比</span>
			<div id="models" class="models"></div>
			<label class="only-mine" title="只显示 preferredVendors 下你配置的模型。\n取消勾选可查看全部可用模型（Copilot 自带的也会列出来）。">
				<input type="checkbox" id="onlyPreferred" />
				<span>只看我的模型</span>
			</label>
		</div>

		<div id="notice" class="notice"></div>

		<div id="body">
			<main id="messages" class="messages"></main>
			<aside id="history" class="history">
				<div class="history-head">历史会话</div>
				<ul id="sessionList" class="session-list"></ul>
			</aside>
		</div>

		<footer id="composer">
			<div id="attachments" class="attachments"></div>
			<div class="composer-row">
				<textarea id="input" rows="3" placeholder="输入问题…（回车发送，Shift+回车换行；可粘贴或拖入图片）"></textarea>
				<div class="composer-actions">
					<button id="send" class="btn primary" disabled>发送</button>
					<button id="stop" class="btn danger" disabled>停止</button>
				</div>
			</div>
		</footer>
	</div>
	<script nonce="${nonce}" src="${markdownUri}"></script>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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
