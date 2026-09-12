import type { WebviewMessage } from '../src/types.js';

/**
 * 与 VS Code 宿主通信的唯一入口。
 *
 * ⚠️ `acquireVsCodeApi()` **每个 Webview 只能调用一次**，重复调用会抛错。
 * 所以整个前端只在这里取一次，其它模块一律 import 本模块的 `post()`，
 * 不要自己去调 `acquireVsCodeApi`。
 */

export interface VsCodeApi {
	postMessage(message: WebviewMessage): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

/** 发一条消息给扩展侧。 */
export function post(message: WebviewMessage): void {
	api.postMessage(message);
}
