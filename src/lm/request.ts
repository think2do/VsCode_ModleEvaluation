/**
 * 单模型的流式请求与降级重试。
 *
 * 这一层负责把「上下文规划」变成真正的 `sendRequest`，并把流式增量一块块推给
 * 界面。同时处理三种收尾：正常完成、用户取消、出错（含**去图重试**）。
 *
 * 面板的状态（会话、取消令牌、推送通道）通过 `RunnerHost` 回调传进来，
 * 而不是把整个面板塞进来 —— 这样这一层只依赖它真正用到的那几件事。
 */

import * as vscode from 'vscode';
import type { ImageAttachment, ModelResponse, Session, Turn } from '../types';
import type { HostMessage } from '../protocol';
import type { SessionStore } from '../store';
import { planContext } from './context';
import { errText, isCancellation } from './errors';
import { detectImageSupport, keyOf } from './models';

/** 单次请求中已经解码好的图片。 */
export interface ResolvedImage {
	data: Uint8Array;
	mime: string;
}

/** 流式请求一层需要面板提供的几件事。 */
export interface RunnerHost {
	readonly store: SessionStore;
	/** key -> 进行中请求的取消令牌（面板用它实现「全部停止」） */
	readonly running: Map<string, vscode.CancellationTokenSource>;
	/** 更新应答的字段并推给界面 */
	patch(turnId: string, key: string, patch: Partial<ModelResponse>): void;
	/** 推一条消息给界面 */
	post(message: HostMessage): void;
}

/** 图片文件 → 字节。丢了的图片跳过，不让整个请求失败。 */
async function resolveImages(store: SessionStore, images: ImageAttachment[]): Promise<ResolvedImage[]> {
	const out: ResolvedImage[] = [];
	for (const image of images) {
		try {
			out.push({ data: await store.readImage(image.file), mime: image.mime });
		} catch {
			// 图片丢了就跳过
		}
	}
	return out;
}

function buildParts(
	text: string,
	images: ResolvedImage[],
): Array<vscode.LanguageModelTextPart | vscode.LanguageModelDataPart> {
	const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelDataPart> = [];
	// 纯图片消息也要有文本部分，部分端点不接受空文本
	parts.push(new vscode.LanguageModelTextPart(text.trim() ? text : ' '));
	for (const image of images) {
		parts.push(vscode.LanguageModelDataPart.image(image.data, image.mime));
	}
	return parts;
}

/** 按 `planContext()` 给出的条目构造真正的消息序列（图片在这一步才解码）。 */
async function buildMessages(
	host: RunnerHost,
	session: Session,
	turn: Turn,
	model: vscode.LanguageModelChat,
	currentImages: ImageAttachment[],
): Promise<vscode.LanguageModelChatMessage[]> {
	const entries = planContext(
		session,
		turn,
		keyOf(model),
		detectImageSupport(model) !== false,
		currentImages,
	);

	const messages: vscode.LanguageModelChatMessage[] = [];
	for (const entry of entries) {
		if (entry.role === 'user') {
			const parts = buildParts(entry.text, await resolveImages(host.store, entry.images));
			messages.push(vscode.LanguageModelChatMessage.User(parts));
		} else {
			messages.push(vscode.LanguageModelChatMessage.Assistant(entry.text));
		}
	}
	return messages;
}

/** 发起一次流式请求，把增量累积进 `response` 并逐块推给界面。 */
async function streamInto(
	host: RunnerHost,
	session: Session,
	turn: Turn,
	model: vscode.LanguageModelChat,
	images: ImageAttachment[],
	response: ModelResponse,
	token: vscode.CancellationToken,
): Promise<void> {
	const key = keyOf(model);
	const messages = await buildMessages(host, session, turn, model, images);
	const chatResponse = await model.sendRequest(messages, {}, token);

	for await (const chunk of chatResponse.text) {
		if (token.isCancellationRequested) {
			break;
		}
		response.text += chunk;
		host.post({ type: 'chunk', turnId: turn.id, key, text: chunk });
	}
}

/**
 * 跑一个模型在这一轮的请求，并负责把状态收敛到 done / cancelled / error。
 *
 * 降级策略分两种，区别很重要：
 * - **明确知道不支持图片**（`supportsImages === false`）→ 直接不发图，不浪费一次失败请求；
 * - **无法判断**（`undefined`）→ 带图试一次，失败后**去掉图片重试一次**。
 *   重试成功会打上 `droppedImages`，之后历史轮次也不再给它发图。
 */
export async function runModel(
	host: RunnerHost,
	session: Session,
	turn: Turn,
	model: vscode.LanguageModelChat,
): Promise<void> {
	const key = keyOf(model);
	const response = turn.responses[key];
	if (!response) {
		return;
	}

	const cts = new vscode.CancellationTokenSource();
	host.running.set(key, cts);
	const started = Date.now();

	/** 收尾：把状态、当前文本与耗时一起推过去。 */
	const settle = (patch: Partial<ModelResponse>): void => {
		host.patch(turn.id, key, { ...patch, text: response.text, elapsedMs: Date.now() - started });
	};

	const knownUnsupported = detectImageSupport(model) === false;
	if (knownUnsupported && turn.images.length > 0) {
		host.patch(turn.id, key, { droppedImages: true });
	}
	const imagesToSend = knownUnsupported ? [] : turn.images;

	try {
		host.patch(turn.id, key, { status: 'streaming' });
		await streamInto(host, session, turn, model, imagesToSend, response, cts.token);
		settle({ status: 'done' });
		return;
	} catch (err) {
		if (isCancellation(err) || cts.token.isCancellationRequested) {
			settle({ status: 'cancelled' });
			return;
		}

		// 图片支持情况未知时，去掉图片重试一次
		if (!knownUnsupported && imagesToSend.length > 0) {
			try {
				response.text = '';
				host.post({ type: 'reset', turnId: turn.id, key });
				await streamInto(host, session, turn, model, [], response, cts.token);
				settle({ status: 'done', droppedImages: true });
				return;
			} catch (retryErr) {
				if (isCancellation(retryErr) || cts.token.isCancellationRequested) {
					settle({ status: 'cancelled' });
					return;
				}
				settle({ status: 'error', error: errText(retryErr) });
				return;
			}
		}

		settle({ status: 'error', error: errText(err) });
	} finally {
		host.running.delete(key);
		cts.dispose();
	}
}
