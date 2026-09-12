/**
 * Webview 的 HTML 外壳。
 *
 * 只有骨架与 CSP 在这里；样式和逻辑都在 `media/` 下（见 README 的「零构建」约定）。
 * 放在单独一个文件是因为它原来是一个几百行的模板字符串，夹在面板类中间，
 * 让 `panel.ts` 读起来全是 HTML。
 *
 * 加载方式（v0.9.0 起）：
 * - `markdown.js` 仍是**普通脚本**（它是零依赖的独立文件，还被 Node 侧的
 *   `scripts/smoke-render.mjs` 用 `require()` 加载，不能改成 ESM）；
 * - `main.js` 是**模块入口**（`type="module"`），它自己 import 同目录下的其它模块。
 *   产物在 `media/dist/`，源码在 `webview/`。
 */

import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

export function buildPanelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = randomUUID().replace(/-/g, '');
	const asset = (file: string): vscode.Uri =>
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));

	const styleUri = asset('style.css');
	const markdownUri = asset('markdown.js');
	// ESM 入口。它 import 出来的子模块（./state.js、./ui.js ...）用相对路径解析，
	// 落到同一个 media/dist/webview/ 下。
	const scriptUri = asset('dist/webview/main.js');

	/*
	 * 关于 `'strict-dynamic'`（实测结论，别凭直觉改）：
	 *
	 * 直觉上「nonce 只加在入口脚本上，静态 import 的子模块没有 nonce，会被拦掉」，
	 * 但实际不会：**模块图里的静态 import 会继承入口脚本的 nonce**，所以只写
	 * `'nonce-X'` 也能正常加载（在 Chromium 上实测过，带对照组的验证见
	 * `scripts/preview.html` 的 CSP 注释）。
	 *
	 * 保留 `'strict-dynamic'` 不是因为「必须」，而是因为它把这个信任模型写成了
	 * 显式的：入口凭 nonce 受信，由它引入的脚本一并受信，不必依赖上面那条
	 * 非显然的继承规则。代价为零 —— 本来所有脚本都是我们自己签发的 nonce 脚本。
	 *
	 * ⚠️ 反过来说，**不能**靠把 `cspSource` 写进 script-src 来解决授权问题：
	 * CSP3 规定 script-src 里一旦出现 nonce，host-source 就会被忽略。
	 */
	const csp = [
		`default-src 'none'`,
		`img-src ${webview.cspSource} data: blob:`,
		`style-src ${webview.cspSource}`,
		`font-src ${webview.cspSource}`,
		`script-src 'nonce-${nonce}' 'strict-dynamic'`,
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

		<div id="notice" class="notice"></div>

		<div id="body">
			<div class="main-col">
				<aside id="strip" class="strip hidden">
					<div id="stripList" class="strip-list"></div>
				</aside>
				<main id="messages" class="messages"></main>
			</div>
			<aside id="history" class="history">
				<div class="history-head">历史会话</div>
				<ul id="sessionList" class="session-list"></ul>
			</aside>
		</div>

		<footer id="composer">
			<div id="attachments" class="attachments"></div>
			<div class="composer-row">
				<textarea id="input" rows="1" placeholder="输入问题…（回车发送，Shift+回车换行；可粘贴或拖入图片）"></textarea>
				<div class="composer-actions">
					<button id="send" class="btn primary" disabled>发送</button>
					<button id="stop" class="btn danger" disabled>停止</button>
				</div>
			</div>
		</footer>
	</div>
	<script nonce="${nonce}" src="${markdownUri}"></script>
	<script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
