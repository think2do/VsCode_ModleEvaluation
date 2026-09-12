/**
 * 把「导入到 Copilot」的规划真正写到磁盘并打开。
 *
 * 与 `import.ts`（纯规划，可单测）分开，是因为这个文件一 `import vscode`
 * 就没法在普通 Node 里加载了。分开之后两边各自职责单一：
 * 一个决定「写什么」，一个负责「怎么写出去、失败了怎么办」。
 *
 * 核心行为：**无论怎样都不让用户白点一次**。写文件失败就退回把完整内容复制到
 * 剪贴板，并明确告知原因。
 */

import * as vscode from 'vscode';
import { errText } from '../lm/errors';
import type { ImportPlan } from './import';

/** 工作区里存放上下文文件的目录名（已加进 .gitignore，别提交）。 */
export const CONTEXT_DIR = '.multi-model-context';

export async function writeImportPlan(
	plan: ImportPlan,
	options: { workspace?: vscode.WorkspaceFolder; fallbackDir: vscode.Uri },
): Promise<void> {
	const { workspace, fallbackDir } = options;
	// 没有打开工作区时退到扩展自己的存储目录，功能不至于直接不可用
	const dir = workspace
		? vscode.Uri.joinPath(workspace.uri, CONTEXT_DIR)
		: vscode.Uri.joinPath(fallbackDir, 'contexts');
	const file = vscode.Uri.joinPath(dir, plan.fileName);

	try {
		await vscode.workspace.fs.createDirectory(dir);
		await vscode.workspace.fs.writeFile(file, Buffer.from(plan.fileText, 'utf8'));
		await vscode.window.showTextDocument(file, { preview: false });
		// 复制成 `#文件名` 而不是绝对路径：Copilot Chat 里 `#` 才能识别成文件引用
		await vscode.env.clipboard.writeText(
			workspace ? `#${vscode.workspace.asRelativePath(file)}` : file.fsPath,
		);
		void vscode.window.showInformationMessage(
			'上下文文件已打开，文件引用已复制。请在 Copilot Chat 中粘贴引用。',
		);
	} catch (err) {
		await vscode.env.clipboard.writeText(plan.query);
		void vscode.window.showWarningMessage(
			`上下文文件创建失败，完整内容已复制到剪贴板。${errText(err)}`,
		);
	}
}
