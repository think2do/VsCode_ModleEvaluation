import * as vscode from 'vscode';
import { MultiModelChatPanel } from './panel';
import { SessionStore } from './store';

export function activate(context: vscode.ExtensionContext): void {
	const store = new SessionStore(context.globalStorageUri);
	void store
		.init()
		.catch((err) => console.error('[多模型对比] 初始化存储失败：', err));

	context.subscriptions.push(
		vscode.commands.registerCommand('multiModelCompare.open', () => {
			MultiModelChatPanel.createOrShow(context, store);
		}),
		vscode.commands.registerCommand('multiModelCompare.newSession', async () => {
			await MultiModelChatPanel.createOrShow(context, store).newSession();
		}),
		vscode.commands.registerCommand('multiModelCompare.toggleHistory', () => {
			MultiModelChatPanel.createOrShow(context, store).toggleHistory();
		}),
	);

	// 用户新增 / 移除语言模型（或登录状态变化）时，刷新面板里的模型列表
	context.subscriptions.push(
		vscode.lm.onDidChangeChatModels(() => {
			void MultiModelChatPanel.current?.refreshModels();
		}),
	);

	// 模型范围 / 勾选上限等设置变了，重新计算可见模型与默认勾选
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (
				event.affectsConfiguration('multiModelCompare.preferredVendors') ||
				event.affectsConfiguration('multiModelCompare.onlyPreferredVendors') ||
				event.affectsConfiguration('multiModelCompare.maxSelectedModels')
			) {
				void MultiModelChatPanel.current?.refreshModels();
			}
		}),
	);
}

export function deactivate(): void {
	// 无需清理：所有资源都挂在 context.subscriptions 上
}
