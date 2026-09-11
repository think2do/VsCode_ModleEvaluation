import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ImageAttachment, Session, SessionSummary } from './types';

const MIME_EXT: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/bmp': 'bmp',
};

/**
 * 会话与图片的本地持久化。
 *
 * 目录结构（位于扩展的 globalStorageUri 下）：
 * ```
 * sessions/<sessionId>.json    每个会话一个文件
 * images/<uuid>.<ext>          图片二进制，由会话文件按文件名引用
 * ```
 */
export class SessionStore {
	private readonly sessionsDir: string;
	private readonly imagesDir: string;

	constructor(root: vscode.Uri) {
		this.sessionsDir = path.join(root.fsPath, 'sessions');
		this.imagesDir = path.join(root.fsPath, 'images');
	}

	async init(): Promise<void> {
		await fs.promises.mkdir(this.sessionsDir, { recursive: true });
		await fs.promises.mkdir(this.imagesDir, { recursive: true });
		// 清理没有被任何会话引用的孤儿图片，失败不影响主流程
		await this.cleanupOrphanImages().catch(() => undefined);
	}

	private sessionFile(id: string): string {
		// 防目录穿越：只取 basename
		return path.join(this.sessionsDir, `${path.basename(id)}.json`);
	}

	/** 列出全部会话摘要，按最近更新倒序。 */
	async list(): Promise<SessionSummary[]> {
		let names: string[];
		try {
			names = await fs.promises.readdir(this.sessionsDir);
		} catch {
			return [];
		}

		const out: SessionSummary[] = [];
		for (const name of names) {
			if (!name.endsWith('.json')) {
				continue;
			}
			try {
				const raw = await fs.promises.readFile(path.join(this.sessionsDir, name), 'utf8');
				const s = JSON.parse(raw) as Session;
				if (!s || typeof s.id !== 'string') {
					continue;
				}
				out.push({
					id: s.id,
					title: s.title || '(未命名)',
					createdAt: s.createdAt ?? 0,
					updatedAt: s.updatedAt ?? 0,
					turnCount: Array.isArray(s.turns) ? s.turns.length : 0,
				});
			} catch {
				// 跳过损坏 / 无法解析的文件
			}
		}

		out.sort((a, b) => b.updatedAt - a.updatedAt);
		return out;
	}

	async load(id: string): Promise<Session | undefined> {
		try {
			const raw = await fs.promises.readFile(this.sessionFile(id), 'utf8');
			const s = JSON.parse(raw) as Session;
			if (!s || typeof s.id !== 'string' || !Array.isArray(s.turns)) {
				return undefined;
			}
			return s;
		} catch {
			return undefined;
		}
	}

	/** 原子写入：先写 .tmp 再 rename，避免中途崩溃留下半截 JSON。 */
	async save(session: Session): Promise<void> {
		await fs.promises.mkdir(this.sessionsDir, { recursive: true });
		const target = this.sessionFile(session.id);
		const tmp = `${target}.tmp`;
		await fs.promises.writeFile(tmp, JSON.stringify(session, null, 2), 'utf8');
		await fs.promises.rename(tmp, target);
	}

	/** 删除会话，同时清掉它独占的图片。 */
	async remove(id: string): Promise<void> {
		const session = await this.load(id);
		try {
			await fs.promises.unlink(this.sessionFile(id));
		} catch {
			// 已经不存在，忽略
		}
		if (!session) {
			return;
		}
		for (const turn of session.turns) {
			for (const img of turn.images ?? []) {
				await this.unlinkImage(img.file);
			}
		}
	}

	/** 把前端的 data URL 落盘，返回可写入会话文件的引用。 */
	async saveImage(dataUrl: string, mime: string): Promise<ImageAttachment> {
		const comma = dataUrl.indexOf(',');
		const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
		const bytes = Buffer.from(base64, 'base64');
		const ext = MIME_EXT[mime.toLowerCase()] ?? 'bin';
		const file = `${randomUUID()}.${ext}`;

		await fs.promises.mkdir(this.imagesDir, { recursive: true });
		await fs.promises.writeFile(path.join(this.imagesDir, file), bytes);
		return { file, mime, name: file };
	}

	async readImage(file: string): Promise<Uint8Array> {
		const buf = await fs.promises.readFile(path.join(this.imagesDir, path.basename(file)));
		return new Uint8Array(buf);
	}

	private async unlinkImage(file: string): Promise<void> {
		try {
			await fs.promises.unlink(path.join(this.imagesDir, path.basename(file)));
		} catch {
			// 忽略
		}
	}

	private async cleanupOrphanImages(): Promise<void> {
		let sessionNames: string[];
		try {
			sessionNames = await fs.promises.readdir(this.sessionsDir);
		} catch {
			return;
		}

		const used = new Set<string>();
		for (const name of sessionNames) {
			if (!name.endsWith('.json')) {
				continue;
			}
			try {
				const s = JSON.parse(
					await fs.promises.readFile(path.join(this.sessionsDir, name), 'utf8'),
				) as Session;
				for (const turn of s.turns ?? []) {
					for (const img of turn.images ?? []) {
						used.add(img.file);
					}
				}
			} catch {
				// 忽略
			}
		}

		let imageNames: string[];
		try {
			imageNames = await fs.promises.readdir(this.imagesDir);
		} catch {
			return;
		}

		for (const file of imageNames) {
			if (!used.has(file)) {
				await this.unlinkImage(file);
			}
		}
	}
}
