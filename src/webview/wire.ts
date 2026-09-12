/**
 * 落盘结构 → 可直接发给 Webview 的结构。
 *
 * 唯一的区别是图片：会话文件里只存文件名（避免会话 JSON 膨胀），
 * 而界面要直接渲染，所以得补上 data URL。
 */

import type { SessionStore } from '../store';
import type { Session, Turn, WireImage, WireSession, WireTurn } from '../types';

export class WireBuilder {
	/** 文件名 -> data URL，避免同一张图每次重渲染都读一次盘 */
	private readonly imageCache = new Map<string, string>();

	constructor(private readonly store: SessionStore) {}

	async session(session: Session): Promise<WireSession> {
		const turns: WireTurn[] = [];
		for (const turn of session.turns) {
			turns.push(await this.turn(turn));
		}
		return { ...session, turns };
	}

	async turn(turn: Turn): Promise<WireTurn> {
		const images: WireImage[] = [];
		for (const image of turn.images) {
			let dataUrl = this.imageCache.get(image.file);
			if (!dataUrl) {
				try {
					const bytes = await this.store.readImage(image.file);
					dataUrl = `data:${image.mime};base64,${Buffer.from(bytes).toString('base64')}`;
					this.imageCache.set(image.file, dataUrl);
				} catch {
					continue; // 图片文件丢了，界面就不显示这张
				}
			}
			images.push({ file: image.file, mime: image.mime, name: image.name, dataUrl });
		}
		return { ...turn, images };
	}

	/**
	 * 刚贴进来的图：已经落盘且手头就有 data URL，直接记进缓存，
	 * 省掉随后 `turn()` 的一次读盘。
	 */
	remember(file: string, dataUrl: string): void {
		this.imageCache.set(file, dataUrl);
	}
}
