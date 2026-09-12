/**
 * 通用界面工具：文案、时间、状态点、提示条、图片放大、复制。
 *
 * 这些函数不参与业务编排，只是被各处调用，所以单独一层。
 */

import { state, el, MODEL_COLORS, STATUS_TEXT } from './state.js';
import type { ModelRef, ModelResponse } from '../src/types.js';
import { post } from './host.js';

/** 模型的展示名：不同 vendor 下有同名模型时补上 vendor 以便区分。 */
export function modelLabel(model: ModelRef | undefined): string {
	if (!model) {
		return '';
	}
	const duplicated = state.models.filter((m) => m.name === model.name).length > 1;
	return duplicated ? model.name + ' · ' + model.vendor : model.name;
}

export function formatTime(ts: number | undefined): string {
	const d = new Date(ts || 0);
	const pad = (n: number): string => String(n).padStart(2, '0');
	return (
		d.getFullYear() +
		'-' + pad(d.getMonth() + 1) +
		'-' + pad(d.getDate()) +
		' ' + pad(d.getHours()) +
		':' + pad(d.getMinutes())
	);
}

/** 顶部提示条。`level` 决定配色（info / warn / error）。 */
export function notice(level: string, message: string): void {
	if (!message) {
		return;
	}
	el.notice.textContent = message;
	el.notice.className = 'notice show ' + (level || 'info');
	clearTimeout(state.noticeTimer);
	state.noticeTimer = setTimeout(() => {
		el.notice.className = 'notice';
	}, 8000);
}

/** 消息区是否已经滚到底部附近（决定流式输出时要不要自动跟随）。 */
export function nearBottom(): boolean {
	return el.messages.scrollTop + el.messages.clientHeight >= el.messages.scrollHeight - 80;
}

export function scrollToBottom(): void {
	el.messages.scrollTop = el.messages.scrollHeight;
}

/** 模型在自己的列表里的固定识别色（写在元素的 `--c` 上）。 */
export function modelColorVar(key: string): string {
	const index = state.models.findIndex((m) => m.key === key);
	return 'var(' + MODEL_COLORS[(index < 0 ? 0 : index) % MODEL_COLORS.length] + ')';
}

/** 迷你卡与选项卡上共用的状态点。 */
export function updateDot(dot: HTMLElement, status: string): void {
	dot.className = 'dot d-' + status;
}

/** 状态短标签：完成显示耗时，其它显示中文状态。 */
export function statusBrief(res: Partial<ModelResponse> | undefined): string {
	const status = res?.status ?? 'pending';
	if (status === 'done' && typeof res?.elapsedMs === 'number') {
		return (res.elapsedMs / 1000).toFixed(1) + 's';
	}
	return STATUS_TEXT[status] || status;
}

// #region 图片放大

// webview 里 window.open 会被拦截，所以自己做一个遮罩层。
let lightbox: HTMLElement | null = null;
let lightboxImg: HTMLImageElement | null = null;

export function openLightbox(src: string): void {
	if (!lightbox || !lightboxImg) {
		lightbox = document.createElement('div');
		lightbox.className = 'lightbox';
		lightboxImg = document.createElement('img');
		lightboxImg.alt = '图片预览';
		lightbox.appendChild(lightboxImg);
		lightbox.addEventListener('click', () => closeLightbox());
		document.body.appendChild(lightbox);
	}
	lightboxImg.src = src;
	lightbox.classList.add('show');
}

export function closeLightbox(): void {
	if (lightbox?.classList.contains('show') && lightboxImg) {
		lightbox.classList.remove('show');
		lightboxImg.removeAttribute('src');
	}
}

/** 图片预览是否开着（Esc 的处理要优先关它）。 */
export function isLightboxOpen(): boolean {
	return !!lightbox && lightbox.classList.contains('show');
}

// #endregion

// #region 复制

/** `navigator.clipboard` 不可用时的兜底（老版 webview / 非安全上下文）。 */
function fallbackCopy(text: string): boolean {
	const area = document.createElement('textarea');
	area.value = text;
	area.setAttribute('readonly', '');
	area.style.position = 'fixed';
	area.style.top = '-1000px';
	area.style.opacity = '0';
	document.body.appendChild(area);
	area.select();
	let ok = false;
	try {
		ok = document.execCommand('copy');
	} catch {
		ok = false;
	}
	area.remove();
	return ok;
}

/** 复制文本，并把按钮临时改成「已复制」作为反馈。 */
export function copyWithFeedback(text: string, button: HTMLButtonElement): void {
	const original = button.textContent;
	const succeed = (): void => {
		button.textContent = '已复制';
		button.classList.add('copied');
		setTimeout(() => {
			button.textContent = original;
			button.classList.remove('copied');
		}, 1500);
	};
	const fail = (): void => notice('error', '复制失败，请手动选中文本复制。');

	if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
		navigator.clipboard.writeText(text).then(succeed, () => {
			if (fallbackCopy(text)) {
				succeed();
			} else {
				fail();
			}
		});
		return;
	}
	if (fallbackCopy(text)) {
		succeed();
	} else {
		fail();
	}
}

// #endregion

/** 回答里的链接交给系统浏览器打开（webview 自己开不了）。 */
export function openExternalLink(href: string): void {
	post({ type: 'openLink', href });
}
