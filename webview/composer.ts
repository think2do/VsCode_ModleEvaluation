/**
 * 输入区：文字/图片的收集、发送、停止，以及**编辑提问**（仅最新一轮）。
 *
 * 为什么「编辑提问」也在这个文件里，而不是单独一个模块：
 * `commitEditPrompt()` 要调 `setSending()`，而 `setSending(true)` 又要
 * `cancelEditPrompt()` 把编辑态收起来 —— 两边互相调用。放在同一个模块里
 * 就不必为了一处互相调用去绕一层回调，也不会形成 ESM 循环依赖。
 */

import { state, el, latestTurn, turnById, MAX_IMAGES, MAX_IMAGE_BYTES } from './state.js';
import { notice, openLightbox } from './ui.js';
import { post } from './host.js';

// #region 发送 / 停止

export function updateSendEnabled(): void {
	el.send.disabled = state.sending || state.selected.size === 0;
}

/** 切换「生成中」状态：停止按钮、发送按钮、编辑入口都跟着它走。 */
export function setSending(value: boolean): void {
	state.sending = value;
	el.stop.disabled = !value;
	updateSendEnabled();
	// 开始生成时先把编辑态收起来，避免改到一半被新回答覆盖
	if (value && state.editingTurnId) {
		cancelEditPrompt();
	}
	refreshPromptActions();
}

// #endregion

// #region 图片附件

export function renderAttachments(): void {
	el.attachments.textContent = '';
	if (!state.attachments.length) {
		return;
	}
	state.attachments.forEach((item, index) => {
		const wrap = document.createElement('div');
		wrap.className = 'attachment';
		const img = document.createElement('img');
		img.src = item.dataUrl;
		img.alt = item.name || '图片';
		img.title = '点击放大';
		img.addEventListener('click', () => openLightbox(item.dataUrl));
		const remove = document.createElement('button');
		remove.className = 'attachment-remove';
		remove.textContent = '✕';
		remove.title = '移除';
		remove.addEventListener('click', () => {
			state.attachments.splice(index, 1);
			renderAttachments();
		});
		wrap.appendChild(img);
		wrap.appendChild(remove);
		el.attachments.appendChild(wrap);
	});
}

/** 粘贴或拖入的图片文件 → 待发送的附件。非图片、超限的会被跳过并提示。 */
export function addFiles(files: FileList | File[]): void {
	for (const file of Array.from(files)) {
		if (!file.type || !file.type.startsWith('image/')) {
			continue;
		}
		if (state.attachments.length >= MAX_IMAGES) {
			notice('warn', '最多一次发送 ' + MAX_IMAGES + ' 张图片。');
			break;
		}
		if (file.size > MAX_IMAGE_BYTES) {
			notice('warn', '图片超过 20MB，已跳过：' + (file.name || ''));
			continue;
		}
		const reader = new FileReader();
		reader.onload = () => {
			state.attachments.push({
				mime: file.type,
				dataUrl: String(reader.result),
				name: file.name,
			});
			renderAttachments();
		};
		reader.readAsDataURL(file);
	}
}

// #endregion

/** 收集输入区内容并发出提问。成功后立刻清空输入区并进入「生成中」。 */
export function doSend(): void {
	if (state.sending) {
		return;
	}
	const prompt = el.input.value.trim();
	if (!prompt && state.attachments.length === 0) {
		return;
	}
	if (state.selected.size === 0) {
		notice('warn', '请至少勾选一个模型。');
		return;
	}
	post({
		type: 'send',
		prompt,
		images: state.attachments,
		selected: Array.from(state.selected),
	});
	el.input.value = '';
	state.attachments = [];
	renderAttachments();
	setSending(true);
}

// #region 编辑提问（仅最新一轮）

/**
 * 刷新「编辑」按钮的可用性：
 * 只有**最新一轮**才显示编辑入口（历史轮次改写会让后续上下文自相矛盾），
 * 生成中也不允许编辑。
 */
export function refreshPromptActions(): void {
	const last = latestTurn();
	for (const [turnId, info] of state.turnEls) {
		const isLast = !!last && last.id === turnId;
		info.editBtn.hidden = !isLast;
		info.editBtn.disabled = !isLast || state.sending;
	}
}

/** 进入编辑态：把提问文字换成 textarea。 */
export function startEditPrompt(turnId: string): void {
	if (state.sending) {
		return;
	}
	const info = state.turnEls.get(turnId);
	const turn = turnById(turnId);
	if (!info || !turn || info.editing) {
		return;
	}
	// 同一时刻只允许一处编辑
	if (state.editingTurnId && state.editingTurnId !== turnId) {
		cancelEditPrompt();
	}
	state.editingTurnId = turnId;
	info.editing = true;
	info.qText.classList.add('hidden');
	info.editArea.textContent = '';
	info.editArea.classList.remove('hidden');
	// 已经在编辑了，顶部的「编辑」按钮先收起来（退出编辑时由 refreshPromptActions 还原）
	info.editBtn.hidden = true;

	const input = document.createElement('textarea');
	input.className = 'q-edit-input';
	input.rows = 3;
	input.value = turn.prompt;
	input.placeholder = '输入问题…';
	input.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			cancelEditPrompt();
			return;
		}
		// Cmd/Ctrl + 回车 = 保存并重新生成（与「回车发送」的直觉一致）
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			commitEditPrompt(turnId, true);
		}
	});

	const actions = document.createElement('div');
	actions.className = 'q-edit-actions';

	const save = document.createElement('button');
	save.type = 'button';
	save.className = 'btn tiny';
	save.textContent = '仅保存';
	save.title = '只修改提问文字，不重新向模型提问';
	save.addEventListener('click', () => commitEditPrompt(turnId, false));

	const rerun = document.createElement('button');
	rerun.type = 'button';
	rerun.className = 'btn tiny primary';
	rerun.textContent = '保存并重新生成';
	rerun.title = '用新提问重新问本轮的这些模型（Cmd/Ctrl + 回车）';
	rerun.addEventListener('click', () => commitEditPrompt(turnId, true));

	const cancel = document.createElement('button');
	cancel.type = 'button';
	cancel.className = 'btn tiny';
	cancel.textContent = '取消';
	cancel.title = '放弃修改（Esc）';
	cancel.addEventListener('click', () => cancelEditPrompt());

	actions.appendChild(save);
	actions.appendChild(rerun);
	actions.appendChild(cancel);
	info.editArea.appendChild(input);
	info.editArea.appendChild(actions);

	if (turn.images && turn.images.length) {
		const tip = document.createElement('div');
		tip.className = 'q-edit-tip';
		tip.textContent = '本轮图片会原样保留，编辑不会改动图片。';
		info.editArea.appendChild(tip);
	}

	// 注意：编辑期间不能重建卡片（否则 textarea 会被顶掉），所以这里不调 applyVisibility
	input.focus();
	input.setSelectionRange(input.value.length, input.value.length);
}

/** 退出编辑态，并把提问文字恢复成 `prompt`。 */
export function closeEditPrompt(turnId: string, prompt?: string): void {
	const info = state.turnEls.get(turnId);
	state.editingTurnId = '';
	if (!info) {
		return;
	}
	info.editing = false;
	info.editArea.classList.add('hidden');
	info.editArea.textContent = '';
	info.qText.classList.remove('hidden');
	if (typeof prompt === 'string') {
		info.qText.textContent = prompt || '(图片消息)';
	}
	refreshPromptActions();
}

/** 提交编辑。`regenerate` 为真时会请求扩展侧重新向本轮原有模型提问。 */
export function commitEditPrompt(turnId: string, regenerate: boolean): void {
	const info = state.turnEls.get(turnId);
	if (!info || !info.editing) {
		return;
	}
	const input = info.editArea.querySelector<HTMLTextAreaElement>('.q-edit-input');
	const prompt = input ? input.value : '';
	closeEditPrompt(turnId, prompt);
	if (regenerate) {
		setSending(true);
	}
	post({ type: 'editPrompt', turnId, prompt, regenerate });
}

export function cancelEditPrompt(): void {
	const turnId = state.editingTurnId;
	if (!turnId) {
		return;
	}
	const turn = turnById(turnId);
	closeEditPrompt(turnId, turn ? turn.prompt : '');
}

// #endregion
