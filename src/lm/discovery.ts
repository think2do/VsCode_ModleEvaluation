/**
 * 模型发现：拉取全部可用模型 → 按设置筛出可见的 → 把勾选收敛到它们身上。
 *
 * 一整条链路放在一起，是为了守住一条不变量：
 * **`models` 必须与界面上的 `visible` 严格一致**（顺序也一样）。
 * 界面靠 `visible` 渲染，`handleSend` 靠 `models` 算请求目标；两者一旦不一致，
 * 就会出现「勾了 A 却问了 B」这种极难排查的问题。
 */

import * as vscode from 'vscode';
import type { ModelRef } from '../types';
import { errText } from './errors';
import { filterModels, keyOf, reconcileSelection, toModelRef, type VendorFilter } from './models';

/** 一次刷新模型的结果，直接对应要下发给界面的一条 `models` 消息。 */
export interface DiscoveryResult {
	/** 与 `visible` 严格对应的 vscode 模型对象，用来真正发请求 */
	models: vscode.LanguageModelChat[];
	/** 发给界面渲染的模型信息 */
	visible: ModelRef[];
	/** 收敛后应当勾选的模型 key */
	selected: string[];
	/** 需要提示给用户的说明（多条之间用换行分隔，可能为空串） */
	warning: string;
}

/** 读取与模型筛选相关的设置。 */
export function readVendorFilter(): VendorFilter {
	const config = vscode.workspace.getConfiguration('multiModelCompare');
	const raw = config.get<string[]>('preferredVendors') ?? [];
	return {
		cap: config.get<number>('maxSelectedModels') ?? 0,
		// vendor 比较统一转小写，避免大小写差异导致过滤落空
		vendors: raw
			.map((vendor) => String(vendor).trim().toLowerCase())
			.filter((vendor) => vendor.length > 0),
		onlyPreferred: config.get<boolean>('onlyPreferredVendors') ?? true,
	};
}

/**
 * 拉取模型清单并完成筛选与勾选收敛。
 *
 * @param selectedModels 会话里记录的勾选，收敛时优先尊重它
 */
export async function discoverModels(selectedModels: string[]): Promise<DiscoveryResult> {
	let all: vscode.LanguageModelChat[] = [];
	const notes: string[] = [];

	try {
		all = await vscode.lm.selectChatModels({});
	} catch (err) {
		notes.push(`读取模型列表失败：${errText(err)}`);
	}

	const filter = readVendorFilter();
	const { visible, notes: filterNotes } = filterModels(all.map(toModelRef), filter);
	notes.push(...filterNotes);

	const shown = new Set(visible.map((ref) => ref.key));
	const models = all.filter((model) => shown.has(keyOf(model)));

	// 一个模型都没有时不必收敛勾选（reconcileSelection 会给出误导性的「全选」结果）
	let selected = selectedModels;
	if (visible.length > 0) {
		const reconciled = reconcileSelection(selectedModels, visible, filter.cap);
		selected = reconciled.keys;
		notes.push(...reconciled.notes);
	}

	return { models, visible, selected, warning: notes.join('\n') };
}
