/**
 * Webview 前端的入口：绑定事件 + 启动。
 *
 * 只负责「接线」，不含业务逻辑：
 * - 工具栏 / 输入区 / 拖拽 / 快捷键的事件绑定
 * - 把扩展侧消息转给 `messages.ts`
 *
 * 模块划分（依赖自上而下）：
 *
 * ```
 *   main.ts          入口：事件绑定 + 启动
 *   messages.ts      扩展侧消息分发
 *   turn.ts          轮次渲染（整屏重建 / 追加一轮）
 *   card.ts  tab.ts  strip.ts  sessions.ts     各区块的 DOM
 *   composer.ts      输入区 + 编辑提问
 *   display.ts       展示状态 + applyVisibility（叶子）
 *   ui.ts  state.ts  host.ts                   工具 / 状态 / 通信（叶子）
 * ```
 */

import { el, state } from './state.js';
import { post } from './host.js';
import { closeLightbox, isLightboxOpen } from './ui.js';
import { addFiles, cancelEditPrompt, doSend, renderAttachments } from './composer.js';
import { handleHostMessage } from './messages.js';

function bindEvents(): void {
	el.send.addEventListener('click', doSend);

	el.stop.addEventListener('click', () => post({ type: 'stop' }));

	el.newSession.addEventListener('click', () => post({ type: 'newSession' }));

	el.toggleHistory.addEventListener('click', () => el.history.classList.toggle('hidden'));

	el.input.addEventListener('keydown', (event) => {
		// isComposing：中文输入法选词时按回车不能当成发送
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			doSend();
		}
	});

	// 粘贴图片
	el.input.addEventListener('paste', (event) => {
		const files: File[] = [];
		const items = event.clipboardData?.items ?? [];
		for (const item of items) {
			if (item.kind === 'file') {
				const file = item.getAsFile();
				if (file) {
					files.push(file);
				}
			}
		}
		if (files.length) {
			event.preventDefault();
			addFiles(files);
		}
	});

	// 拖入图片
	el.composer.addEventListener('dragover', (event) => {
		event.preventDefault();
		el.composer.classList.add('dragging');
	});
	el.composer.addEventListener('dragleave', () => el.composer.classList.remove('dragging'));
	el.composer.addEventListener('drop', (event) => {
		event.preventDefault();
		el.composer.classList.remove('dragging');
		if (event.dataTransfer?.files) {
			addFiles(event.dataTransfer.files);
		}
	});

	// 回答里的链接交给系统浏览器打开（webview 自己开不了）
	el.messages.addEventListener('click', (event) => {
		const target = event.target as HTMLElement | null;
		const link = target?.closest?.('a[href]');
		if (link) {
			event.preventDefault();
			const href = link.getAttribute('href');
			if (href) {
				post({ type: 'openLink', href });
			}
		}
	});

	// Esc 的优先级：先关图片预览，没有预览时才取消编辑
	document.addEventListener('keydown', (event) => {
		if (event.key !== 'Escape') {
			return;
		}
		if (isLightboxOpen()) {
			closeLightbox();
			return;
		}
		if (state.editingTurnId) {
			cancelEditPrompt();
		}
	});

	window.addEventListener('message', (event) => handleHostMessage(event.data));
}

bindEvents();
renderAttachments();
post({ type: 'ready' });
