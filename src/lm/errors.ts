/**
 * 错误处理：错误码中文化 + 「这个错误到底算不算失败」。
 *
 * 集中放一处，是因为界面上要区分三件不同的事：
 * 1. 用户主动停止（`CancellationError`）→ 显示「已取消」，不是失败；
 * 2. 模型侧返回的业务错误码（`LanguageModelError`）→ 显示原始 code + 中文建议；
 * 3. 其它异常（读盘失败、网络异常）→ 直接显示 message。
 */

import * as vscode from 'vscode';

/** 常见错误码的中文补充说明，让用户一眼知道该做什么，而不用去查文档。 */
export const LM_ERROR_HINT: Record<string, string> = {
	NoPermissions:
		'本扩展尚未获得该模型的使用授权。请在命令面板执行「管理语言模型访问 / Manage Language Model Access」授权，或按弹出的提示允许。',
	Blocked: '该模型请求被安全策略拦截。企业环境请检查组织策略设置。',
	NotFound: '找不到该模型，可能已被移除，或当前账户无权访问。',
	Unknown: '模型侧返回了未知错误，可稍后重试，或检查该端点配置。',
};

/**
 * 把错误码与消息拼成给用户看的文案。
 *
 * `code` 可能是 `'NotFound'`，也可能是 `'LanguageModelError.NotFound'`，
 * 所以统一取最后一段去查提示表。
 */
export function formatModelError(code: string, message: string): string {
	const name = code.includes('.') ? code.split('.').pop() ?? code : code;
	const hint = LM_ERROR_HINT[name];
	return hint ? `[${code}] ${message}\n${hint}` : `[${code}] ${message}`;
}

/** 把任意抛出的值转成一行可读的错误文案。 */
export function errText(err: unknown): string {
	if (err instanceof vscode.LanguageModelError) {
		return formatModelError(err.code, err.message);
	}
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

/** 用户主动停止 / 请求被取消 —— 这不是「失败」，界面上要区分开。 */
export function isCancellation(err: unknown): boolean {
	return err instanceof vscode.CancellationError;
}
