// 多模型对比对话 —— Webview 前端
//
// 只负责渲染与交互，所有模型调用都由扩展侧完成。
// Markdown 渲染交给同目录的 markdown.js（挂载在 window.MarkdownRenderer）。
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const MarkdownRenderer = window.MarkdownRenderer;

	const MAX_IMAGES = 4;
	const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
	/** 超过这个长度就不再走 Markdown 渲染，避免重排卡顿 */
	const MD_RENDER_LIMIT = 20000;
	/** 流式输出的合并间隔（毫秒），避免每个 chunk 都触发一次重排 */
	const FLUSH_MS = 90;
	const DEFAULT_CARD_WIDTH = 340;
	const MIN_CARD_WIDTH = 160;
	const MAX_CARD_WIDTH = 1600;

	const STATUS_TEXT = {
		pending: '等待中',
		streaming: '生成中',
		done: '完成',
		error: '失败',
		cancelled: '已取消',
	};

	const state = {
		models: [],
		/** 参与对比的模型（决定请求发给谁） */
		selected: new Set(),
		/** 被隐藏结果的模型（只影响显示，不影响请求） */
		hiddenResults: new Set(),
		/** 模型 key -> 卡片宽度 */
		cardWidths: {},
		session: { id: '', title: '', selectedModels: [], turns: [] },
		sessions: [],
		attachments: [],
		/** key = `${turnId}|${modelKey}` */
		cards: new Map(),
		sending: false,
		noticeTimer: 0,
	};

	const el = {
		sessionTitle: document.getElementById('session-title'),
		models: document.getElementById('models'),
		resultbar: document.getElementById('resultbar'),
		resultToggles: document.getElementById('resultToggles'),
		showAllResults: document.getElementById('showAllResults'),
		messages: document.getElementById('messages'),
		input: document.getElementById('input'),
		send: document.getElementById('send'),
		stop: document.getElementById('stop'),
		newSession: document.getElementById('newSession'),
		toggleHistory: document.getElementById('toggleHistory'),
		history: document.getElementById('history'),
		sessionList: document.getElementById('sessionList'),
		attachments: document.getElementById('attachments'),
		notice: document.getElementById('notice'),
		onlyPreferred: document.getElementById('onlyPreferred'),
	};

	// #region 工具函数

	function cardKey(turnId, key) {
		return turnId + '|' + key;
	}

	/** 模型的展示名：不同 vendor 下有同名模型时补上 vendor 以便区分。 */
	function modelLabel(model) {
		if (!model) {
			return '';
		}
		const duplicated = state.models.filter((m) => m.name === model.name).length > 1;
		return duplicated ? model.name + ' · ' + model.vendor : model.name;
	}

	function formatTime(ts) {
		const d = new Date(ts || 0);
		const pad = (n) => String(n).padStart(2, '0');
		return (
			d.getFullYear() +
			'-' + pad(d.getMonth() + 1) +
			'-' + pad(d.getDate()) +
			' ' + pad(d.getHours()) +
			':' + pad(d.getMinutes())
		);
	}

	function notice(level, message) {
		if (!message) {
			return;
		}
		el.notice.textContent = message;
		el.notice.className = 'notice show ' + (level || 'info');
		clearTimeout(state.noticeTimer);
		state.noticeTimer = setTimeout(() => {
			el.notice.className = 'notice';
		}, 8000);
	}

	function nearBottom() {
		return el.messages.scrollTop + el.messages.clientHeight >= el.messages.scrollHeight - 80;
	}

	function scrollToBottom() {
		el.messages.scrollTop = el.messages.scrollHeight;
	}

	// 图片放大查看。webview 里 window.open 会被拦截，所以自己做一个遮罩层。
	let lightbox = null;
	let lightboxImg = null;

	function openLightbox(src) {
		if (!lightbox) {
			lightbox = document.createElement('div');
			lightbox.className = 'lightbox';
			lightboxImg = document.createElement('img');
			lightboxImg.alt = '图片预览';
			lightbox.appendChild(lightboxImg);
			lightbox.addEventListener('click', closeLightbox);
			document.body.appendChild(lightbox);
		}
		lightboxImg.src = src;
		lightbox.classList.add('show');
	}

	function closeLightbox() {
		if (lightbox && lightbox.classList.contains('show')) {
			lightbox.classList.remove('show');
			lightboxImg.removeAttribute('src');
		}
	}

	// #endregion

	// #region 复制

	function fallbackCopy(text) {
		const area = document.createElement('textarea');
		area.value = text;
		area.setAttribute('readonly', '');
		area.style.position = 'fixed';
		area.style.top = '-1000px';
		area.style.opacity = '0';
		document.body.appendChild(area);
		area.select();
		let ok = false;
		try {
			ok = document.execCommand('copy');
		} catch {
			ok = false;
		}
		area.remove();
		return ok;
	}

	function copyWithFeedback(text, button) {
		const original = button.textContent;
		const succeed = () => {
			button.textContent = '已复制';
			button.classList.add('copied');
			setTimeout(() => {
				button.textContent = original;
				button.classList.remove('copied');
			}, 1500);
		};
		const fail = () => notice('error', '复制失败，请手动选中文本复制。');

		if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
			navigator.clipboard.writeText(text).then(succeed, () => {
				if (fallbackCopy(text)) {
					succeed();
				} else {
					fail();
				}
			});
			return;
		}
		if (fallbackCopy(text)) {
			succeed();
		} else {
			fail();
		}
	}

	// #endregion

	// #region 模型勾选（决定请求发给谁）

	function renderModels() {
		el.models.textContent = '';
		if (state.models.length === 0) {
			const tip = document.createElement('span');
			tip.className = 'empty-tip';
			tip.textContent = '未发现可用模型';
			el.models.appendChild(tip);
		}
		for (const model of state.models) {
			const label = document.createElement('label');
			label.className = 'model-chip';
			label.title =
				model.key +
				'\n最大输入：' + model.maxInputTokens + ' tokens' +
				(model.supportsImages === false ? '\n（不支持图片输入）' : '');

			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = state.selected.has(model.key);
			checkbox.addEventListener('change', () => {
				if (checkbox.checked) {
					state.selected.add(model.key);
				} else {
					state.selected.delete(model.key);
				}
				updateSendEnabled();
				vscode.postMessage({ type: 'selectModels', selected: Array.from(state.selected) });
			});

			const text = document.createElement('span');
			text.textContent = modelLabel(model);

			label.appendChild(checkbox);
			label.appendChild(text);
			if (model.supportsImages === false) {
				const noImg = document.createElement('span');
				noImg.className = 'no-image';
				noImg.textContent = '无图';
				noImg.title = '该模型不支持图片输入';
				label.appendChild(noImg);
			}
			el.models.appendChild(label);
		}
		updateSendEnabled();
	}

	// #endregion

	// #region 显示结果开关（只影响显示，不影响请求）

	/** 当前会话里出现过结果的模型，保持与模型列表一致的顺序。 */
	function modelsWithResults() {
		const seen = new Set();
		for (const turn of state.session.turns || []) {
			for (const key of Object.keys(turn.responses || {})) {
				seen.add(key);
			}
		}
		return state.models.filter((m) => seen.has(m.key));
	}

	function renderResultToggles() {
		const list = modelsWithResults();
		el.resultbar.classList.toggle('hidden', list.length === 0);

		el.resultToggles.textContent = '';
		for (const model of list) {
			const label = document.createElement('label');
			label.className = 'model-chip result-chip';
			label.title =
				'勾选表示显示该模型的回答。\n取消勾选只是隐藏显示，不会影响是否向该模型提问。';

			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = !state.hiddenResults.has(model.key);
			label.classList.toggle('off', !checkbox.checked);
			checkbox.addEventListener('change', () => {
				if (checkbox.checked) {
					state.hiddenResults.delete(model.key);
				} else {
					state.hiddenResults.add(model.key);
				}
				label.classList.toggle('off', !checkbox.checked);
				applyResultVisibility();
				updateShowAllButton();
			});

			const text = document.createElement('span');
			text.textContent = modelLabel(model);

			label.appendChild(checkbox);
			label.appendChild(text);
			el.resultToggles.appendChild(label);
		}
		updateShowAllButton();
	}

	function applyResultVisibility() {
		for (const entry of state.cards.values()) {
			entry.card.classList.toggle('result-hidden', state.hiddenResults.has(entry.key));
		}
	}

	function updateShowAllButton() {
		const hiddenCount = modelsWithResults().filter((m) => state.hiddenResults.has(m.key)).length;
		el.showAllResults.classList.toggle('hidden', hiddenCount === 0);
		if (hiddenCount > 0) {
			el.showAllResults.textContent = '全部显示（' + hiddenCount + ' 项已隐藏）';
		}
	}

	// #endregion

	// #region 卡片宽度拖拽

	let dragState = null;

	function startResize(event, key, handle) {
		event.preventDefault();
		event.stopPropagation();

		const width = state.cardWidths[key] || DEFAULT_CARD_WIDTH;
		dragState = { key, startX: event.clientX, startWidth: width, handle, moved: false };
		handle.classList.add('active');
		document.body.classList.add('resizing');
		try {
			handle.setPointerCapture(event.pointerId);
		} catch {
			// 某些环境不支持 pointer capture，退化为普通拖拽
		}
	}

	function applyCardWidth(key, width) {
		state.cardWidths[key] = width;
		for (const entry of state.cards.values()) {
			if (entry.key === key) {
				entry.card.style.width = width + 'px';
			}
		}
	}

	document.addEventListener('pointermove', (event) => {
		if (!dragState) {
			return;
		}
		const delta = event.clientX - dragState.startX;
		if (Math.abs(delta) > 2) {
			dragState.moved = true;
		}
		const width = Math.max(
			MIN_CARD_WIDTH,
			Math.min(MAX_CARD_WIDTH, Math.round(dragState.startWidth + delta)),
		);
		applyCardWidth(dragState.key, width);
	});

	function endResize() {
		if (!dragState) {
			return;
		}
		const { handle, moved } = dragState;
		dragState = null;
		handle.classList.remove('active');
		document.body.classList.remove('resizing');
		if (moved) {
			vscode.postMessage({ type: 'saveWidths', widths: state.cardWidths });
		}
	}

	document.addEventListener('pointerup', endResize);
	document.addEventListener('pointercancel', endResize);

	// #endregion

	// #region 会话渲染

	function renderSessionHeader() {
		el.sessionTitle.textContent = state.session.title || '新会话';
		el.sessionTitle.title = '会话 ID：' + state.session.id;
	}

	function renderSession() {
		renderSessionHeader();
		el.messages.textContent = '';
		state.cards.clear();
		for (const turn of state.session.turns || []) {
			appendTurn(turn, false);
		}
		if ((state.session.turns || []).length === 0) {
			const hint = document.createElement('div');
			hint.className = 'welcome';
			hint.innerHTML =
				'<p>把同一个问题同时发给多个模型，并排对比它们的回答。</p>' +
				'<ul>' +
				'<li>在「参与对比」里勾选要提问的模型（默认全选）</li>' +
				'<li>回答生成后，可用「显示结果」临时隐藏不想看的回答</li>' +
				'<li>回车发送，Shift+回车换行；可直接粘贴或拖入图片</li>' +
				'<li>拖动卡片右边缘可调整宽度</li>' +
				'</ul>';
			el.messages.appendChild(hint);
		}
		renderResultToggles();
		applyResultVisibility();
		scrollToBottom();
	}

	function appendTurn(turn, doScroll) {
		const welcome = el.messages.querySelector('.welcome');
		if (welcome) {
			welcome.remove();
		}

		const section = document.createElement('section');
		section.className = 'turn';

		// 用户提问
		const user = document.createElement('div');
		user.className = 'user';
		const bubble = document.createElement('div');
		bubble.className = 'bubble';
		bubble.textContent = turn.prompt || '(图片消息)';
		user.appendChild(bubble);

		if (turn.images && turn.images.length) {
			const thumbs = document.createElement('div');
			thumbs.className = 'thumbs';
			for (const img of turn.images) {
				const thumb = document.createElement('img');
				thumb.src = img.dataUrl;
				thumb.alt = img.name || '图片';
				thumb.title = '点击放大';
				thumb.addEventListener('click', () => openLightbox(img.dataUrl));
				thumbs.appendChild(thumb);
			}
			user.appendChild(thumbs);
		}
		section.appendChild(user);

		// 各模型回答卡片
		const cards = document.createElement('div');
		cards.className = 'cards';
		const keys = Object.keys(turn.responses || {});
		if (keys.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'empty-tip';
			empty.textContent = '本轮没有可用的模型。';
			cards.appendChild(empty);
		}
		for (const key of keys) {
			cards.appendChild(createCard(turn.id, key, turn.responses[key]));
		}
		section.appendChild(cards);

		el.messages.appendChild(section);
		if (doScroll !== false) {
			scrollToBottom();
		}
		return section;
	}

	function createCard(turnId, key, response) {
		const model = state.models.find((m) => m.key === key);

		const card = document.createElement('article');
		card.className = 'card';
		card.style.width = (state.cardWidths[key] || DEFAULT_CARD_WIDTH) + 'px';

		// ── 标题栏：模型名 + 复制 + 状态
		const head = document.createElement('div');
		head.className = 'card-head';

		const name = document.createElement('span');
		name.className = 'card-name';
		name.textContent = model ? modelLabel(model) : key;
		name.title = key;

		const copy = document.createElement('button');
		copy.className = 'card-copy';
		copy.type = 'button';
		copy.textContent = '复制';
		copy.title = '复制这条回答（保持 Markdown 原文）';
		copy.disabled = true;

		const regenerate = document.createElement('button');
		regenerate.className = 'card-copy card-regenerate';
		regenerate.type = 'button';
		regenerate.textContent = '重新生成';
		regenerate.title = '重新生成这条回答';
		regenerate.addEventListener('click', () => {
			vscode.postMessage({ type: 'regenerate', turnId, key });
		});

		const status = document.createElement('span');
		status.className = 'card-status';

		head.appendChild(name);
		head.appendChild(copy);
		head.appendChild(regenerate);
		head.appendChild(status);
		card.appendChild(head);

		// ── 正文
		const body = document.createElement('div');
		body.className = 'card-body';
		card.appendChild(body);

		// ── 右边缘拖拽手柄
		const handle = document.createElement('div');
		handle.className = 'card-resize';
		handle.title = '拖动调整宽度（双击恢复默认）';
		handle.addEventListener('pointerdown', (event) => startResize(event, key, handle));
		handle.addEventListener('dblclick', (event) => {
			event.preventDefault();
			event.stopPropagation();
			applyCardWidth(key, DEFAULT_CARD_WIDTH);
			vscode.postMessage({ type: 'saveWidths', widths: state.cardWidths });
		});
		card.appendChild(handle);

		const entry = {
			key,
			turnId,
			card,
			body,
			copy,
			status,
			regenerate,
			text: (response && response.text) || '',
			res: response || { status: 'pending', text: '' },
			timer: 0,
		};

		state.cards.set(cardKey(turnId, key), entry);
		copy.addEventListener('click', () => {
			if (entry.text) {
				copyWithFeedback(entry.text, copy);
			}
		});

		renderBody(entry);
		updateStatus(entry);
		return card;
	}

	function updateStatus(entry) {
		const res = entry.res;
		const parts = [STATUS_TEXT[res.status] || res.status];
		if (typeof res.elapsedMs === 'number' && res.status !== 'streaming' && res.status !== 'pending') {
			parts.push((res.elapsedMs / 1000).toFixed(1) + 's');
		}
		entry.status.textContent = parts.join(' · ');
		entry.status.className = 'card-status s-' + res.status;
		entry.card.dataset.status = res.status;

		// 没有内容就没什么可复制的
		entry.copy.disabled = !entry.text;
		const latestTurn = state.session.turns && state.session.turns[state.session.turns.length - 1];
		entry.regenerate.hidden = !latestTurn || latestTurn.id !== entry.turnId || res.status === 'streaming' || res.status === 'pending';

		let hint = entry.card.querySelector('.card-hint');
		if (res.droppedImages) {
			if (!hint) {
				hint = document.createElement('div');
				hint.className = 'card-hint';
				entry.card.insertBefore(hint, entry.card.querySelector('.card-error'));
			}
			hint.textContent = '该模型不支持图片，本次已仅发送文本。';
		} else if (hint) {
			hint.remove();
		}

		let err = entry.card.querySelector('.card-error');
		if (res.error) {
			if (!err) {
				err = document.createElement('div');
				err.className = 'card-error';
				entry.card.appendChild(err);
			}
			err.textContent = res.error;
		} else if (err) {
			err.remove();
		}
	}

	function renderBody(entry) {
		const text = entry.text || '';
		if (text.length > MD_RENDER_LIMIT) {
			// 超长回答退化为纯文本，避免 Markdown 解析 + 重排开销
			entry.body.classList.remove('md');
			entry.body.textContent = text;
			return;
		}
		entry.body.classList.add('md');
		entry.body.innerHTML = MarkdownRenderer ? MarkdownRenderer.render(text) : text;
	}

	function applyChunk(turnId, key, text) {
		const entry = state.cards.get(cardKey(turnId, key));
		if (!entry) {
			return;
		}
		const stick = nearBottom();
		entry.text += text;
		if (entry.timer) {
			return;
		}
		entry.timer = setTimeout(() => {
			entry.timer = 0;
			renderBody(entry);
			entry.copy.disabled = !entry.text;
			if (stick) {
				scrollToBottom();
			}
		}, FLUSH_MS);
	}

	function applyPatch(turnId, key, patch) {
		const entry = state.cards.get(cardKey(turnId, key));
		const turn = (state.session.turns || []).find((t) => t.id === turnId);
		if (turn && turn.responses && turn.responses[key]) {
			Object.assign(turn.responses[key], patch);
		}
		if (!entry) {
			return;
		}
		entry.res = Object.assign({}, entry.res, patch);
		if (typeof patch.text === 'string') {
			if (entry.timer) {
				clearTimeout(entry.timer);
				entry.timer = 0;
			}
			entry.text = patch.text;
			renderBody(entry);
		}
		updateStatus(entry);
	}

	function resetCard(turnId, key) {
		const entry = state.cards.get(cardKey(turnId, key));
		if (!entry) {
			return;
		}
		if (entry.timer) {
			clearTimeout(entry.timer);
			entry.timer = 0;
		}
		entry.text = '';
		renderBody(entry);
		updateStatus(entry);
	}

	// #endregion

	// #region 历史会话（右侧）

	function renderSessions() {
		el.sessionList.textContent = '';
		if (!state.sessions.length) {
			const li = document.createElement('li');
			li.className = 'empty-tip';
			li.textContent = '暂无历史会话';
			el.sessionList.appendChild(li);
			return;
		}

		for (const summary of state.sessions) {
			const li = document.createElement('li');
			li.className = 'session-item';
			if (summary.id === state.session.id) {
				li.classList.add('active');
			}

			const open = document.createElement('button');
			open.className = 'session-open';
			const title = document.createElement('span');
			title.className = 'session-title';
			title.textContent = summary.title || '(未命名)';
			const meta = document.createElement('span');
			meta.className = 'session-meta';
			meta.textContent = formatTime(summary.updatedAt) + ' · ' + summary.turnCount + ' 轮';
			open.appendChild(title);
			open.appendChild(meta);
			open.addEventListener('click', () => {
				vscode.postMessage({ type: 'loadSession', id: summary.id });
			});

			// 两段式删除，避免误触（webview 里 confirm 不可靠）
			const del = document.createElement('button');
			del.className = 'session-del';
			del.textContent = '✕';
			del.title = '删除该会话';
			del.addEventListener('click', (event) => {
				event.stopPropagation();
				if (del.dataset.armed === '1') {
					vscode.postMessage({ type: 'deleteSession', id: summary.id });
					return;
				}
				del.dataset.armed = '1';
				del.textContent = '确认';
				del.classList.add('armed');
				setTimeout(() => {
					del.dataset.armed = '';
					del.textContent = '✕';
					del.classList.remove('armed');
				}, 3000);
			});

			li.appendChild(open);
			li.appendChild(del);
			el.sessionList.appendChild(li);
		}
	}

	// #endregion

	// #region 输入区

	function updateSendEnabled() {
		el.send.disabled = state.sending || state.selected.size === 0;
	}

	function setSending(value) {
		state.sending = value;
		el.stop.disabled = !value;
		updateSendEnabled();
	}

	function renderAttachments() {
		el.attachments.textContent = '';
		if (!state.attachments.length) {
			return;
		}
		state.attachments.forEach((item, index) => {
			const wrap = document.createElement('div');
			wrap.className = 'attachment';
			const img = document.createElement('img');
			img.src = item.dataUrl;
			img.alt = item.name || '图片';
			img.title = '点击放大';
			img.addEventListener('click', () => openLightbox(item.dataUrl));
			const remove = document.createElement('button');
			remove.className = 'attachment-remove';
			remove.textContent = '✕';
			remove.title = '移除';
			remove.addEventListener('click', () => {
				state.attachments.splice(index, 1);
				renderAttachments();
			});
			wrap.appendChild(img);
			wrap.appendChild(remove);
			el.attachments.appendChild(wrap);
		});
	}

	function addFiles(files) {
		for (const file of files) {
			if (!file.type || file.type.indexOf('image/') !== 0) {
				continue;
			}
			if (state.attachments.length >= MAX_IMAGES) {
				notice('warn', '最多一次发送 ' + MAX_IMAGES + ' 张图片。');
				break;
			}
			if (file.size > MAX_IMAGE_BYTES) {
				notice('warn', '图片超过 20MB，已跳过：' + (file.name || ''));
				continue;
			}
			const reader = new FileReader();
			reader.onload = () => {
				state.attachments.push({
					mime: file.type,
					dataUrl: String(reader.result),
					name: file.name,
				});
				renderAttachments();
			};
			reader.readAsDataURL(file);
		}
	}

	function doSend() {
		if (state.sending) {
			return;
		}
		const prompt = el.input.value.trim();
		if (!prompt && state.attachments.length === 0) {
			return;
		}
		if (state.selected.size === 0) {
			notice('warn', '请至少勾选一个模型。');
			return;
		}
		vscode.postMessage({
			type: 'send',
			prompt,
			images: state.attachments,
			selected: Array.from(state.selected),
		});
		el.input.value = '';
		state.attachments = [];
		renderAttachments();
		setSending(true);
	}

	// #endregion

	// #region 事件绑定

	el.send.addEventListener('click', doSend);

	el.stop.addEventListener('click', () => {
		vscode.postMessage({ type: 'stop' });
	});

	el.newSession.addEventListener('click', () => {
		vscode.postMessage({ type: 'newSession' });
	});

	el.toggleHistory.addEventListener('click', () => {
		el.history.classList.toggle('hidden');
	});

	el.showAllResults.addEventListener('click', () => {
		state.hiddenResults.clear();
		renderResultToggles();
		applyResultVisibility();
	});

	el.onlyPreferred.addEventListener('change', () => {
		vscode.postMessage({ type: 'setOnlyPreferred', value: el.onlyPreferred.checked });
	});

	el.input.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			doSend();
		}
	});

	el.input.addEventListener('paste', (event) => {
		const files = [];
		const items = (event.clipboardData && event.clipboardData.items) || [];
		for (const item of items) {
			if (item.kind === 'file') {
				const file = item.getAsFile();
				if (file) {
					files.push(file);
				}
			}
		}
		if (files.length) {
			event.preventDefault();
			addFiles(files);
		}
	});

	const composer = document.getElementById('composer');
	composer.addEventListener('dragover', (event) => {
		event.preventDefault();
		composer.classList.add('dragging');
	});
	composer.addEventListener('dragleave', () => composer.classList.remove('dragging'));
	composer.addEventListener('drop', (event) => {
		event.preventDefault();
		composer.classList.remove('dragging');
		if (event.dataTransfer && event.dataTransfer.files) {
			addFiles(event.dataTransfer.files);
		}
	});

	// 回答里的链接交给系统浏览器打开
	el.messages.addEventListener('click', (event) => {
		const link = event.target.closest && event.target.closest('a[href]');
		if (link) {
			event.preventDefault();
			vscode.postMessage({ type: 'openLink', href: link.getAttribute('href') });
		}
	});

	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') {
			closeLightbox();
		}
	});

	window.addEventListener('message', (event) => {
		const message = event.data || {};
		switch (message.type) {
			case 'models':
				state.models = message.models || [];
				state.selected = new Set(message.selected || []);
				if (typeof message.onlyPreferred === 'boolean') {
					el.onlyPreferred.checked = message.onlyPreferred;
				}
				renderModels();
				renderSessionHeader();
				renderResultToggles();
				if (message.warning) {
					notice('warn', message.warning);
				}
				break;

			case 'session':
				state.session = message.session;
				state.sessions = message.sessions || [];
				state.cardWidths = message.cardWidths || {};
				// 勾选状态以会话里记录的为准
				state.selected = new Set(message.session.selectedModels || []);
				renderModels();
				renderSession();
				renderSessions();
				setSending(false);
				break;

			case 'sessions':
				state.sessions = message.sessions || [];
				renderSessions();
				break;

			case 'turn':
				state.session.turns = state.session.turns || [];
				state.session.turns.push(message.turn);
				renderSessionHeader();
				appendTurn(message.turn, true);
				renderResultToggles();
				applyResultVisibility();
				setSending(true);
				break;

			case 'chunk':
				applyChunk(message.turnId, message.key, message.text);
				break;

			case 'patch':
				applyPatch(message.turnId, message.key, message.patch || {});
				break;

			case 'reset':
				resetCard(message.turnId, message.key);
				break;

			case 'idle':
				setSending(false);
				break;

			case 'notice':
				notice(message.level, message.message);
				break;

			case 'toggleHistory':
				el.history.classList.toggle('hidden');
				break;

			default:
				break;
		}
	});

	// #endregion

	renderAttachments();
	vscode.postMessage({ type: 'ready' });
})();
