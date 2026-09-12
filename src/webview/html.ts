/**
 * Webview 的 HTML 外壳。
 *
 * 只有骨架与 CSP 在这里；样式和逻辑都在 `media/` 下（见 README 的「零构建」约定）。
 * 放在单独一个文件是因为它原来是一个几百行的模板字符串，夹在面板类中间，
 * 让 `panel.ts` 读起来全是 HTML。
 */

import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

export function buildPanelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = randomUUID().replace(/-/g, '');
	const asset = (file: string): vscode.Uri =>
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));

	const styleUri = asset('style.css');
	const markdownUri = asset('markdown.js');
	const scriptUri = asset('main.js');

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
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
