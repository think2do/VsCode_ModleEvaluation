/**
 * 模型发现、筛选与勾选收敛。
 *
 * 这里只做**纯逻辑**（`import type` 一个 vscode，编译后不产生运行时依赖），
 * 所以可以直接在 Node 里单测。读设置、读模型列表这些 vscode 边界的活留给
 * `panel.ts`。
 */

import type * as vscode from 'vscode';
import type { ModelRef } from '../types';

/** 模型的稳定标识，形如 `vendor:id`。 */
export function keyOf(model: { vendor: string; id: string }): string {
	return `${model.vendor}:${model.id}`;
}

/**
 * 探测模型是否支持图片输入。
 *
 * `vscode.lm` 的**消费侧**目前没有暴露稳定的能力查询接口，只有在「提供模型」
 * 那一侧才有 `LanguageModelChatCapabilities`。这里先尝试在运行时读一下，
 * 读不到就返回 `undefined`，由调用方走「带图试一次、失败再去图重试」的降级路径。
 */
export function detectImageSupport(model: vscode.LanguageModelChat): boolean | undefined {
	const caps = (model as unknown as { capabilities?: { imageInput?: boolean } }).capabilities;
	if (caps && typeof caps.imageInput === 'boolean') {
		return caps.imageInput;
	}
	return undefined;
}

/** 把 vscode 的模型对象转成可以发给 Webview 的纯数据结构。 */
export function toModelRef(model: vscode.LanguageModelChat): ModelRef {
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

/** 与模型筛选相关的设置。 */
export interface VendorFilter {
	/** 默认勾选上限，`0` 表示不限制 */
	cap: number;
	/** 已经小写化、去空白的来源白名单 */
	vendors: string[];
	/** 是否只显示白名单里的来源 */
	onlyPreferred: boolean;
}

/**
 * 按设置算出界面该显示哪些模型。
 *
 * 默认只列出「你自己添加的模型」——即 `chatLanguageModels.json` 里的自定义端点
 * （vendor = `customendpoint`）。Copilot 自带的那十几个默认不列、不勾选。
 *
 * 但若白名单**一个都没匹配上**，宁可退回显示全部并明确提示，也不要让界面
 * 变成空的 —— 用户看不到模型时是没法自己排查的。
 */
export function filterModels(all: ModelRef[], filter: VendorFilter): { visible: ModelRef[]; notes: string[] } {
	const notes: string[] = [];
	let visible = all;

	if (filter.onlyPreferred && filter.vendors.length > 0) {
		const wanted = new Set(filter.vendors);
		const kept = all.filter((ref) => wanted.has(ref.vendor.toLowerCase()));
		if (kept.length > 0) {
			visible = kept;
		} else {
			notes.push(
				`设置 multiModelCompare.preferredVendors（${filter.vendors.join('、')}）没有匹配到任何模型，` +
					'本次临时显示全部可用模型。',
			);
		}
	}

	if (visible.length === 0) {
		notes.push(
			'没有找到可用模型。请确认已登录并授权使用语言模型，' +
				'并在命令面板执行「管理语言模型 / Manage Language Models」检查自定义端点是否可用。',
		);
	}

	return { visible, notes };
}

/**
 * 让勾选状态与当前可见模型保持一致，并返回需要提示给用户的说明。
 *
 * 规则：
 * 1. 已勾选的模型若仍可见就保留（尊重用户的选择）；
 * 2. 若一个都没勾上（首次使用，或之前勾的都被隐藏了）则默认全选；
 * 3. 数量超过 `cap` 时只勾选前 N 个并明确告知 —— 避免一次提问并发打到十几个
 *    模型上（费用高、易触发限流、对比视图也没法看）。
 *
 * 注意：此处会把**不可见**的模型从勾选列表里移除，即「隐藏即不可选」，
 * 防止出现「看不见但仍在偷偷参与对比」的情况。
 */
export function reconcileSelection(
	current: string[],
	visible: ModelRef[],
	cap: number,
): { keys: string[]; notes: string[] } {
	const available = new Set(visible.map((ref) => ref.key));
	const kept = current.filter((key) => available.has(key));
	let keys = kept.length > 0 ? kept : visible.map((ref) => ref.key);
	const notes: string[] = [];

	if (cap > 0 && keys.length > cap) {
		notes.push(
			`符合默认勾选条件的模型有 ${keys.length} 个，已只勾选前 ${cap} 个` +
				`（受 multiModelCompare.maxSelectedModels 限制），其余请按需手动勾选。`,
		);
		keys = keys.slice(0, cap);
	}

	return { keys, notes };
}
