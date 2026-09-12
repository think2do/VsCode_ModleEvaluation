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

	const STATUS_TEXT = {
		pending: '等待中',
		streaming: '生成中',
		done: '完成',
		error: '失败',
		cancelled: '已取消',
	};

	/**
	 * 模型识别色。按模型在列表里的下标取色，保证同一模型在
	 * 选项卡 / 卡片 / 右侧预览栏里颜色一致。用 VS Code 的图表色，
	 * 深浅主题都自带合适取值。
	 */
	const MODEL_COLORS = [
		'--vscode-charts-blue',
		'--vscode-charts-purple',
		'--vscode-charts-orange',
		'--vscode-charts-green',
		'--vscode-charts-red',
		'--vscode-charts-yellow',
	];

	const state = {
		models: [],
		/** 参与对比的模型（决定请求发给谁）：由悬浮条上每张卡片的开关控制 */
		selected: new Set(),
		/**
		 * turnId -> { focusKey, compare: Set }
		 *
		 * 每轮的展示设置 —— 「显示哪个模型」与「并排对比哪几个」都只认这里，
		 * 不再另存一份全局状态（两份状态各被读一半，正是悬浮条上点了没反应的原因）。
		 */
		turnViews: new Map(),
		session: { id: '', title: '', selectedModels: [], turns: [] },
		sessions: [],
		attachments: [],
		/** key = `${turnId}|${modelKey}` -> 回答卡片元素集合 */
		cards: new Map(),
		/** key = `${turnId}|${modelKey}` -> 选项卡元素集合 */
		tabs: new Map(),
		/** turnId -> 该轮的元素引用（摘要、缺省提示等） */
		turnEls: new Map(),
		/** modelKey -> 悬浮条里的迷你卡（含两个勾选控件） */
		minis: new Map(),
		sending: false,
		/** 正在编辑提问的轮次 id（同一时刻只编辑一个） */
		editingTurnId: '',
		noticeTimer: 0,
	};

	const el = {
		app: document.getElementById('app'),
		sessionTitle: document.getElementById('session-title'),
		messages: document.getElementById('messages'),
		strip: document.getElementById('strip'),
		stripList: document.getElementById('stripList'),
		input: document.getElementById('input'),
		send: document.getElementById('send'),
		stop: document.getElementById('stop'),
		newSession: document.getElementById('newSession'),
		toggleHistory: document.getElementById('toggleHistory'),
		history: document.getElementById('history'),
		sessionList: document.getElementById('sessionList'),
		attachments: document.getElementById('attachments'),
		notice: document.getElementById('notice'),
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

	// #region 视图模式、聚焦模型与顶部悬浮条

	/** 模型在自己会话里的固定识别色。 */
	function modelColorVar(key) {
		const index = state.models.findIndex((m) => m.key === key);
		return 'var(' + MODEL_COLORS[(index < 0 ? 0 : index) % MODEL_COLORS.length] + ')';
	}

	function latestTurn() {
		const turns = state.session.turns || [];
		return turns.length ? turns[turns.length - 1] : null;
	}

	function turnById(turnId) {
		return (state.session.turns || []).find((t) => t.id === turnId);
	}

	/** 当前界面上的模型 key 列表。 */
	function visibleKeys() {
		return state.models.map((m) => m.key);
	}

	/**
	 * 修正「最新一轮」的聚焦模型。
	 *
	 * 优先沿用该轮已有的选择；选中的模型不在本轮、或已经不可见时，回落到本轮
	 * 第一个问过的模型，再退回列表里的第一个 —— 否则这一轮会只剩一句
	 * 「本轮未向 X 提问」，看起来像坏了。
	 */
	function ensureFocusKey() {
		const available = visibleKeys();
		const last = latestTurn();
		if (!last) {
			return;
		}
		const view = viewForTurn(last.id);
		const asked = Object.keys(last.responses || {});
		view.focusKey =
			(asked.includes(view.focusKey) && available.includes(view.focusKey) ? view.focusKey : '') ||
			asked.find((key) => available.includes(key)) ||
			available[0] ||
			'';
	}

	/**
	 * 悬浮条是「最新一轮」的快捷控制条 —— 它左侧的复选框与卡片正文都写进
	 * **最新一轮**的展示设置（`turn.view`），不另开一份全局状态。
	 *
	 * 早先这里存过一份全局的 `state.compare` / `state.focusKey`，但真正决定布局
	 * 的是每轮的 `turn.view`，两份状态各被读一半，结果就是「点了悬浮条除了打钩
	 * 什么都没变」。现在统一到 `turn.view` 这一个真相源上。
	 *
	 * 还没有任何轮次时返回 null（此时悬浮条上的控件本就不可用）。
	 */
	function latestViewInfo() {
		const last = latestTurn();
		return last ? { turnId: last.id, view: viewForTurn(last.id) } : null;
	}

	/**
	 * 点悬浮条的卡片正文 = 单模型阅读这个模型（并排对比会因此退出）。
	 *
	 * 作用于**最新一轮**：悬浮条是「现在」的控制条；历史轮次各自的看法由那一轮
	 * 的选项卡控制。卡片正文上的模型名走的是 `setTurnFocus`，因为那里天然知道
	 * 自己属于哪一轮。
	 */
	function setFocus(key) {
		if (!key) {
			return;
		}
		const info = latestViewInfo();
		if (!info) {
			return;
		}
		// 单读和并排是两种互斥的看*法*：进入单读要清掉并排勾选，
		// 否则"点了卡片却什么都没变"，会让人以为点击失效。
		const wasCompare = info.view.compare.size > 0;
		info.view.compare.clear();
		if (key === info.view.focusKey && !wasCompare) {
			return;
		}
		info.view.focusKey = key;
		saveTurnView(info.turnId);
		applyVisibility();
	}

	/** 是否处于「并排对比」：最新一轮勾了至少一个左复选框。 */
	function isCompareMode() {
		const info = latestViewInfo();
		return !!info && info.view.compare.size > 0;
	}

	/**
	 * 切换某模型的「并排对比」勾选（悬浮条卡片左侧的复选框）。
	 * 只影响**怎么展示**，和「是否参与提问」无关。
	 */
	function setCompare(key, on) {
		const info = latestViewInfo();
		if (!info) {
			return;
		}
		if (on) {
			info.view.compare.add(key);
		} else {
			info.view.compare.delete(key);
		}
		saveTurnView(info.turnId);
		applyVisibility();
	}

	/** 切换某个模型是否参与提问（悬浮条卡片右侧的开关）。 */
	function setModelSelected(key, on) {
		if (on) {
			state.selected.add(key);
		} else {
			state.selected.delete(key);
		}
		renderStripActive();
		updateSendEnabled();
		vscode.postMessage({ type: 'selectModels', selected: Array.from(state.selected) });
	}

	/**
	 * 记住滚动位置：重排前抓一个「锚点」轮次，重排后把它的相对偏移还原回去。
	 * 否则切换聚焦模型 / 进出并排时，视口会莫名其妙跳走。
	 */
	function captureScrollAnchor() {
		const containerRect = el.messages.getBoundingClientRect();
		const turns = Array.from(el.messages.querySelectorAll('.turn'));
		const anchor = turns.find((turn) => turn.getBoundingClientRect().bottom > containerRect.top) || turns[turns.length - 1];
		return anchor
			? { anchor, offset: anchor.getBoundingClientRect().top - containerRect.top }
			: null;
	}

	function restoreScrollAnchor(snapshot) {
		if (!snapshot || !snapshot.anchor.isConnected) {
			return;
		}
		const containerRect = el.messages.getBoundingClientRect();
		const currentOffset = snapshot.anchor.getBoundingClientRect().top - containerRect.top;
		el.messages.scrollTop += currentOffset - snapshot.offset;
	}

	function viewForTurn(turnId) {
		let view = state.turnViews.get(turnId);
		if (!view) {
			const turn = turnById(turnId);
			const previous = state.session.turns[Math.max(0, (state.session.turns || []).findIndex((item) => item.id === turnId) - 1)];
			const inherited = turn && turn.view ? turn.view : previous && previous.view;
			view = {
				focusKey: inherited?.focusKey || Object.keys(turn?.responses || {})[0] || state.models[0]?.key || '',
				compare: new Set(inherited?.compareKeys || []),
			};
			state.turnViews.set(turnId, view);
		}
		return view;
	}

	function saveTurnView(turnId) {
		const view = viewForTurn(turnId);
		vscode.postMessage({
			type: 'updateTurnView',
			turnId,
			view: { focusKey: view.focusKey, compareKeys: Array.from(view.compare) },
		});
	}

	function setTurnFocus(turnId, key) {
		const view = viewForTurn(turnId);
		view.focusKey = key;
		view.compare.clear();
		saveTurnView(turnId);
		applyVisibility();
	}

	function setTurnCompare(turnId, key, on) {
		const view = viewForTurn(turnId);
		if (on) view.compare.add(key); else view.compare.delete(key);
		saveTurnView(turnId);
		applyVisibility();
	}

	/**
	 * 统一刷新「谁可见、谁是当前项」。
	 *
	 * 两种展示方式是**按轮**的（每轮各自记住自己的看法）：
	 * - **并排对比**（该轮勾了左复选框）：同时列出被勾选的那几个模型，横向排开；
	 * - **单模型阅读**（没勾）：只显示该轮聚焦模型的回答。
	 *
	 * 右侧开关只决定「是否提问」，不影响能不能看它已有的回答。
	 */
	function applyVisibility() {
		const scrollAnchor = captureScrollAnchor();
		const previousOverflowAnchor = el.messages.style.overflowAnchor;
		el.messages.style.overflowAnchor = 'none';

		for (const [turnId, info] of state.turnEls) {
			const turn = turnById(turnId);
			const view = viewForTurn(turnId);
			const compare = view.compare.size > 0;
			info.cards.classList.toggle('tile', compare);
			info.section.classList.toggle('tile', compare);
			for (const entry of state.cards.values()) {
				if (entry.turnId !== turnId) continue;
				const visible = compare ? view.compare.has(entry.key) : entry.key === view.focusKey;
				entry.card.classList.toggle('hidden', !visible);
				entry.card.classList.toggle('tile', compare);
			}
			for (const tab of info.tabbar.querySelectorAll('.tab')) {
				const key = tab.dataset.key;
				const inCompare = view.compare.has(key);
				tab.classList.toggle('on', compare ? inCompare : key === view.focusKey);
				// 选项卡上的复选框也要跟着状态走：否则「点了卡片名退出并排」之后
				// 复选框还停在勾选态，再点一次反而被当成取消勾选，要点两下才有反应。
				const box = tab.querySelector('.tab-check');
				if (box) {
					box.checked = inCompare;
				}
			}
			for (const stale of Array.from(info.cards.querySelectorAll('.tile-missing'))) stale.remove();
			if (compare && turn) {
				for (const key of view.compare) {
					if ((turn.responses || {})[key]) continue;
					const cell = document.createElement('article');
					cell.className = 'card tile-missing';
					cell.textContent = '本轮未向该模型提问。';
					info.cards.appendChild(cell);
				}
			}
			const missing = !compare && turn && !(turn.responses || {})[view.focusKey];
			info.missing.classList.toggle('hidden', !missing);
			if (missing) info.missing.textContent = '本轮未向该模型提问。';
		}
		renderStripActive();
		restoreScrollAnchor(scrollAnchor);
		requestAnimationFrame(() => {
			restoreScrollAnchor(scrollAnchor);
			el.messages.style.overflowAnchor = previousOverflowAnchor;
		});
	}

	/**
	 * 顶部悬浮条：列出**全部**可见模型。
	 *
	 * 每张迷你卡同时承担三件事（左 / 中 / 右各一个）：
	 * - 左侧复选框 → 加入并排对比（只影响怎么看）
	 * - 卡片正文   → 单模型阅读这个模型
	 * - 右侧开关   → 该模型是否参与提问（只影响问不问它）
	 * 空会话（还没有任何回答）时也照常列出，这样第一次提问前就能在这里选模型。
	 */
	function renderStrip() {
		const list = state.models;
		el.stripList.textContent = '';
		state.minis.clear();
		// 悬浮条只反映最新一轮的并排勾选（它就是这个看法的最新状态）
		const latest = latestViewInfo();
		const comparing = latest ? latest.view.compare : new Set();

		for (const model of list) {
			const mini = document.createElement('div');
			mini.className = 'mini';
			mini.style.setProperty('--c', modelColorVar(model.key));

			// ── 左：加入并排对比
			const compareLabel = document.createElement('label');
			compareLabel.className = 'mini-check';
			const compareBox = document.createElement('input');
			compareBox.type = 'checkbox';
			compareBox.disabled = !hasAnyTurn();
			compareBox.checked = comparing.has(model.key);
			compareBox.addEventListener('change', () => setCompare(model.key, compareBox.checked));
			compareLabel.appendChild(compareBox);
			compareLabel.title = hasAnyTurn()
				? '勾选后，该模型的回答会在这里并排展示，方便和其它模型逐条对比。\n只影响怎么看，不影响是否向它提问。'
				: '还没有回答可以对比 —— 先提问后再勾选。';
			compareLabel.addEventListener('click', (event) => event.stopPropagation());

			// ── 中：点这里 = 单模型阅读这个模型
			const body = document.createElement('div');
			body.className = 'mini-body';
			body.title = '只看 ' + modelLabel(model) + ' 的回答（退出并排对比）';

			const top = document.createElement('div');
			top.className = 'mini-top';
			const dot = document.createElement('span');
			dot.className = 'dot';
			const name = document.createElement('span');
			name.className = 'mini-name';
			name.textContent = modelLabel(model);
			name.title = model.key;
			const badge = document.createElement('span');
			badge.className = 'mini-badge';
			top.appendChild(dot);
			top.appendChild(name);
			if (model.supportsImages === false) {
				const noImg = document.createElement('span');
				noImg.className = 'no-image';
				noImg.textContent = '无图';
				noImg.title = '该模型不支持图片输入';
				top.appendChild(noImg);
			}
			top.appendChild(badge);

			body.appendChild(top);
			body.addEventListener('click', () => setFocus(model.key));

			// ── 右：开关 = 是否参与提问（等价于原来底部的「参与对比」勾选）
			const toggle = document.createElement('label');
			toggle.className = 'mini-switch';
			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = state.selected.has(model.key);
			checkbox.addEventListener('change', () => setModelSelected(model.key, checkbox.checked));
			const track = document.createElement('i');
			toggle.appendChild(checkbox);
			toggle.appendChild(track);
			toggle.title =
				'打开后该模型参与提问；\n关闭只是不再向它提问，已有的回答仍可以点开看。';
			// 点开关不应连带触发聚焦
			toggle.addEventListener('click', (event) => event.stopPropagation());

			mini.appendChild(compareLabel);
			mini.appendChild(body);
			mini.appendChild(toggle);
			el.stripList.appendChild(mini);

			state.minis.set(model.key, {
				root: mini,
				dot,
				badge,
				checkbox,
				compareBox,
				compareLabel,
			});
			refreshMini(model.key);
		}

		const count = list.length;
		el.strip.classList.toggle('hidden', count === 0);
		// 悬浮条出现时消息区要额外留出它的高度（见 style.css 的 .strip-on）
		el.app.classList.toggle('strip-on', count > 0);
		renderStripActive();
	}

	function hasAnyTurn() {
		return (state.session.turns || []).length > 0;
	}

	/**
	 * 只刷新某个模型的迷你卡（流式输出时高频调用，避免整条重建）。
	 * 状态与耗时都取自**最新一轮**；没参与过本轮就只留个灰点。
	 */
	function refreshMini(key) {
		const mini = state.minis.get(key);
		if (!mini) {
			return;
		}
		const turn = latestTurn();
		const res = turn ? (turn.responses || {})[key] : undefined;
		if (!res) {
			mini.dot.className = 'dot d-idle';
			mini.badge.textContent = '';
			return;
		}
		updateDot(mini.dot, res.status);
		mini.badge.textContent = statusBrief(res);
	}

	/** 迷你卡与选项卡上共用的状态点。 */
	function updateDot(dot, status) {
		dot.className = 'dot d-' + status;
	}

	/** 状态短标签：完成显示耗时，其它显示中文状态。 */
	function statusBrief(res) {
		if (res.status === 'done' && typeof res.elapsedMs === 'number') {
			return (res.elapsedMs / 1000).toFixed(1) + 's';
		}
		return STATUS_TEXT[res.status] || res.status;
	}

	function renderStripActive() {
		const info = latestViewInfo();
		const compare = !!info && info.view.compare.size > 0;
		const focus = info ? info.view.focusKey : '';
		const hasTurn = hasAnyTurn();
		for (const [key, mini] of state.minis) {
			const comparing = !!info && info.view.compare.has(key);
			mini.root.classList.toggle('active', !compare && key === focus);
			mini.root.classList.toggle('off', !state.selected.has(key));
			mini.root.classList.toggle('comparing', comparing);
			mini.checkbox.checked = state.selected.has(key);
			mini.compareBox.checked = comparing;
			// 还没有任何回答时，没有内容可比，复选框置灰
			mini.compareBox.disabled = !hasTurn;
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

	// #region 会话渲染

	function renderSessionHeader() {
		el.sessionTitle.textContent = state.session.title || '新会话';
		el.sessionTitle.title = '会话 ID：' + state.session.id;
		let contextBadge = document.getElementById('context-badge');
		if (!contextBadge) {
			contextBadge = document.createElement('button');
			contextBadge.id = 'context-badge';
			contextBadge.className = 'btn tiny context-badge';
			contextBadge.addEventListener('click', () => vscode.postMessage({ type: 'clearContext' }));
			el.sessionTitle.parentElement.appendChild(contextBadge);
		}
		const source = state.session.contextSource;
		const sourceTurn = source && (state.session.turns || []).find((turn) => turn.id === source.turnId);
		const sourceModel = sourceTurn && state.models.find((model) => model.key === source.modelKey);
		contextBadge.hidden = !source || !sourceTurn || !sourceModel;
		if (source && sourceTurn && sourceModel) {
			contextBadge.textContent = '上下文：' + modelLabel(sourceModel) + ' · 第 ' + ((state.session.turns || []).indexOf(sourceTurn) + 1) + ' 轮 ×';
			contextBadge.title = '当前使用“被选中的模型回答”作为后续所有模型的共享上下文，点击清除';
		}
	}

	function renderSession() {
		renderSessionHeader();
		el.messages.textContent = '';
		state.cards.clear();
		state.tabs.clear();
		state.turnEls.clear();
		state.turnViews.clear();
		for (const turn of state.session.turns || []) {
			appendTurn(turn, false);
		}
		if ((state.session.turns || []).length === 0) {
			const hint = document.createElement('div');
			hint.className = 'welcome';
			hint.innerHTML =
				'<p>把同一个问题同时发给多个模型，再挑着读它们的回答。</p>' +
				'<ul>' +
				'<li>顶部每张卡片上：<b>左侧复选框</b> = 勾几个就<b>并排对比</b>几个；</li>' +
				'<li><b>点卡片正文</b> = 只看这一个（退出并排）；<b>右侧开关</b> = 它是否参与提问</li>' +
				'<li>回车发送，Shift+回车换行；可直接粘贴或拖入图片</li>' +
				'</ul>';
			el.messages.appendChild(hint);
		}
		ensureFocusKey();
		applyVisibility();
		renderStrip();
		scrollToBottom();
	}

	function appendTurn(turn, doScroll) {
		const welcome = el.messages.querySelector('.welcome');
		if (welcome) {
			welcome.remove();
		}

		const section = document.createElement('section');
		section.className = 'turn';

		// ── 轮次头：第 N 轮 · 时间 · 状态摘要
		const head = document.createElement('header');
		head.className = 'q-head';
		const badge = document.createElement('span');
		badge.className = 'q-badge';
		badge.textContent = '第 ' + ((state.session.turns || []).findIndex((item) => item.id === turn.id) + 1) + ' 轮';
		const time = document.createElement('span');
		time.className = 'q-time';
		time.textContent = formatTime(turn.at);
		head.appendChild(badge);
		head.appendChild(time);
		section.appendChild(head);

		// ── 用户提问：聚焦阅读下是一块带底色的「提问」区，平铺模式下是一个气泡
		const qRow = document.createElement('div');
		qRow.className = 'q-row';

		// 提问区头部：左边是「你的提问」标签，右边是「编辑」按钮
		const qBar = document.createElement('div');
		qBar.className = 'q-bar';
		const qTag = document.createElement('div');
		qTag.className = 'q-tag';
		qTag.textContent = '你的提问';
		const qEdited = document.createElement('span');
		qEdited.className = 'q-edited';
		qEdited.textContent = '已编辑';
		qEdited.title = '这条提问在发送后被修改过';
		qEdited.hidden = !turn.editedAt;
		const qActions = document.createElement('div');
		qActions.className = 'q-actions';
		const editBtn = document.createElement('button');
		editBtn.type = 'button';
		editBtn.className = 'q-edit';
		editBtn.textContent = '编辑';
		editBtn.title = '编辑这一轮的提问';
		editBtn.addEventListener('click', () => startEditPrompt(turn.id));
		qActions.appendChild(editBtn);
		qBar.appendChild(qTag);
		qBar.appendChild(qEdited);
		qBar.appendChild(qActions);

		const qText = document.createElement('div');
		qText.className = 'q-text';
		qText.textContent = turn.prompt || '(图片消息)';

		// 编辑态容器：点击「编辑」后才填充 textarea 与按钮
		const editArea = document.createElement('div');
		editArea.className = 'q-edit-area hidden';

		qRow.appendChild(qBar);
		qRow.appendChild(qText);

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
			qRow.appendChild(thumbs);
		}
		qRow.appendChild(editArea);
		section.appendChild(qRow);

		// ── 模型选项卡（仅聚焦模式可见）
		const tabbar = document.createElement('div');
		tabbar.className = 'tabbar';
		section.appendChild(tabbar);

		// ── 「模型回答」小标题（仅聚焦模式可见），把回答区和上面的提问区分开
		const answersLabel = document.createElement('div');
		answersLabel.className = 'answers-label';
		answersLabel.textContent = '模型回答';
		section.appendChild(answersLabel);

		// ── 各模型回答
		const cards = document.createElement('div');
		cards.className = 'cards';
		const keys = Object.keys(turn.responses || {});

		const missing = document.createElement('div');
		missing.className = 'pane-missing hidden';
		cards.appendChild(missing);

		if (keys.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'empty-tip';
			empty.textContent = '本轮没有可用的模型。';
			cards.appendChild(empty);
		}
		for (const key of keys) {
			tabbar.appendChild(createTab(turn.id, key, turn.responses[key]));
			cards.appendChild(createCard(turn.id, key, turn.responses[key]));
		}
		section.appendChild(cards);

		state.turnEls.set(turn.id, {
			section,
			missing,
			tabbar,
			cards,
			qText,
			qEdited,
			editBtn,
			editArea,
			editing: false,
		});
		el.messages.appendChild(section);

		refreshPromptActions();
		if (doScroll !== false) {
			scrollToBottom();
		}
		return section;
	}

	// #region 编辑提问（仅最新一轮）

	/**
	 * 刷新「编辑」按钮的可用性：
	 * 只有**最新一轮**才显示编辑入口（历史轮次改写会让后续上下文自相矛盾），
	 * 生成中也不允许编辑。
	 */
	function refreshPromptActions() {
		const last = latestTurn();
		for (const [turnId, info] of state.turnEls) {
			if (!info.editBtn) {
				continue;
			}
			const isLast = !!last && last.id === turnId;
			info.editBtn.hidden = !isLast;
			info.editBtn.disabled = !isLast || state.sending;
		}
	}

	/** 进入编辑态：把提问文字换成 textarea。 */
	function startEditPrompt(turnId) {
		if (state.sending) {
			return;
		}
		const info = state.turnEls.get(turnId);
		const turn = turnById(turnId);
		if (!info || !turn || info.editing) {
			return;
		}
		// 同一时刻只允许一处编辑
		if (state.editingTurnId && state.editingTurnId !== turnId) {
			cancelEditPrompt();
		}
		state.editingTurnId = turnId;
		info.editing = true;
		info.qText.classList.add('hidden');
		info.editArea.textContent = '';
		info.editArea.classList.remove('hidden');
		// 已经在编辑了，顶部的「编辑」按钮先收起来（退出编辑时由 refreshPromptActions 还原）
		info.editBtn.hidden = true;

		const input = document.createElement('textarea');
		input.className = 'q-edit-input';
		input.rows = 3;
		input.value = turn.prompt;
		input.placeholder = '输入问题…';
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				cancelEditPrompt();
				return;
			}
			// Cmd/Ctrl + 回车 = 保存并重新生成（与「回车发送」的直觉一致）
			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				commitEditPrompt(turnId, true);
			}
		});

		const actions = document.createElement('div');
		actions.className = 'q-edit-actions';

		const save = document.createElement('button');
		save.type = 'button';
		save.className = 'btn tiny';
		save.textContent = '仅保存';
		save.title = '只修改提问文字，不重新向模型提问';
		save.addEventListener('click', () => commitEditPrompt(turnId, false));

		const rerun = document.createElement('button');
		rerun.type = 'button';
		rerun.className = 'btn tiny primary';
		rerun.textContent = '保存并重新生成';
		rerun.title = '用新提问重新问本轮的这些模型（Cmd/Ctrl + 回车）';
		rerun.addEventListener('click', () => commitEditPrompt(turnId, true));

		const cancel = document.createElement('button');
		cancel.type = 'button';
		cancel.className = 'btn tiny';
		cancel.textContent = '取消';
		cancel.title = '放弃修改（Esc）';
		cancel.addEventListener('click', () => cancelEditPrompt());

		actions.appendChild(save);
		actions.appendChild(rerun);
		actions.appendChild(cancel);
		info.editArea.appendChild(input);
		info.editArea.appendChild(actions);

		if (turn.images && turn.images.length) {
			const tip = document.createElement('div');
			tip.className = 'q-edit-tip';
			tip.textContent = '本轮图片会原样保留，编辑不会改动图片。';
			info.editArea.appendChild(tip);
		}

		// 注意：编辑期间不能重建卡片（否则 textarea 会被顶掉），所以这里不调 applyVisibility
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
	}

	/** 退出编辑态，并把提问文字恢复成 `prompt`。 */
	function closeEditPrompt(turnId, prompt) {
		const info = state.turnEls.get(turnId);
		state.editingTurnId = '';
		if (!info) {
			return;
		}
		info.editing = false;
		info.editArea.classList.add('hidden');
		info.editArea.textContent = '';
		info.qText.classList.remove('hidden');
		if (typeof prompt === 'string') {
			info.qText.textContent = prompt || '(图片消息)';
		}
		refreshPromptActions();
	}

	/** 提交编辑。`regenerate` 为真时会请求扩展侧重新向本轮原有模型提问。 */
	function commitEditPrompt(turnId, regenerate) {
		const info = state.turnEls.get(turnId);
		if (!info || !info.editing) {
			return;
		}
		const input = info.editArea.querySelector('.q-edit-input');
		const prompt = input ? input.value : '';
		closeEditPrompt(turnId, prompt);
		if (regenerate) {
			setSending(true);
		}
		vscode.postMessage({ type: 'editPrompt', turnId, prompt, regenerate });
	}

	function cancelEditPrompt() {
		const turnId = state.editingTurnId;
		if (!turnId) {
			return;
		}
		const turn = turnById(turnId);
		closeEditPrompt(turnId, turn ? turn.prompt : '');
	}

	// #endregion

	/** 聚焦模式下每轮顶部的模型选项卡。 */
	function createTab(turnId, key, response) {
		const model = state.models.find((m) => m.key === key);
		const tab = document.createElement('button');
		tab.type = 'button';
		tab.className = 'tab';
		tab.dataset.key = key;
		tab.style.setProperty('--c', modelColorVar(key));
		tab.title = (model ? model.key : key) + '\n点击后只切换本轮展示的模型';

		const dot = document.createElement('span');
		dot.className = 'dot';
		const name = document.createElement('span');
		name.className = 'nm';
		name.textContent = model ? modelLabel(model) : key;
		const time = document.createElement('span');
		time.className = 'tm';

		const check = document.createElement('input');
		check.type = 'checkbox';
		check.className = 'tab-check';
		check.checked = viewForTurn(turnId).compare.has(key);
		check.addEventListener('click', (event) => event.stopPropagation());
		check.addEventListener('change', () => setTurnCompare(turnId, key, check.checked));
		tab.appendChild(check);
		tab.appendChild(dot);
		tab.appendChild(name);
		tab.appendChild(time);
		tab.addEventListener('click', () => setTurnFocus(turnId, key));

		const entry = { tab, dot, tm: time, key };
		state.tabs.set(cardKey(turnId, key), entry);
		updateTab(entry, response);
		return tab;
	}

	function updateTab(entry, res) {
		const status = (res && res.status) || 'pending';
		updateDot(entry.dot, status);
		entry.tm.textContent = statusBrief(res || { status });
	}

	function createCard(turnId, key, response) {
		const model = state.models.find((m) => m.key === key);

		const card = document.createElement('article');
		card.className = 'card';
		card.style.setProperty('--c', modelColorVar(key));

		const head = document.createElement('div');
		head.className = 'card-head';

		const dot = document.createElement('span');
		dot.className = 'dot';

		const name = document.createElement('span');
		name.className = 'card-name';
		name.textContent = model ? modelLabel(model) : key;
		name.title = key;
		// 作用于这一张卡片所属的那一轮，不是「最新一轮」
		name.addEventListener('click', () => setTurnFocus(turnId, key));

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

		const importOne = document.createElement('button');
		importOne.className = 'card-copy card-import';
		importOne.type = 'button';
		importOne.textContent = '导入单条';
		importOne.title = '导入这条回答到 Copilot Chat';
		importOne.addEventListener('click', () => vscode.postMessage({ type: 'importToCopilot', turnId, key, scope: 'one' }));

		const importModel = document.createElement('button');
		importModel.className = 'card-copy card-import';
		importModel.type = 'button';
		importModel.textContent = '导入本组';
		importModel.title = '导入该模型在本会话中的全部对话到 Copilot Chat';
		importModel.addEventListener('click', () => vscode.postMessage({ type: 'importToCopilot', turnId, key, scope: 'model' }));

		const setContext = document.createElement('button');
		setContext.className = 'card-copy card-context';
		setContext.type = 'button';
		setContext.textContent = '设为上下文';
		setContext.title = '将这条回答作为后续所有模型共享的上下文';
		setContext.addEventListener('click', () => vscode.postMessage({ type: 'setContext', turnId, key }));

		const status = document.createElement('span');
		status.className = 'card-status';

		const actions = document.createElement('div');
		actions.className = 'card-actions';
		actions.appendChild(copy);
		actions.appendChild(regenerate);
		actions.appendChild(importOne);
		actions.appendChild(importModel);
		actions.appendChild(setContext);

		head.appendChild(dot);
		head.appendChild(name);
		head.appendChild(status);
		head.appendChild(actions);
		card.appendChild(head);

		const body = document.createElement('div');
		body.className = 'card-body';
		card.appendChild(body);

		const entry = {
			key,
			turnId,
			card,
			body,
			copy,
			dot,
			status,
			regenerate,
			importOne,
			importModel,
			setContext,
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
		entry.status.textContent = parts.join(' · ');
		entry.status.className = 'card-status s-' + res.status;
		entry.card.dataset.status = res.status;
		updateDot(entry.dot, res.status);

		// 选项卡、右侧预览栏、本轮摘要都跟着状态走
		const tab = state.tabs.get(cardKey(entry.turnId, entry.key));
		if (tab) {
			updateTab(tab, res);
		}
		const last = latestTurn();
		if (last && last.id === entry.turnId) {
			refreshMini(entry.key);
		}

		// 没有内容就没什么可复制的
		entry.copy.disabled = !entry.text;
		entry.regenerate.hidden = !last || last.id !== entry.turnId || res.status === 'streaming' || res.status === 'pending';
		const importDisabled = !entry.text || res.status === 'streaming' || res.status === 'pending';
		entry.importOne.disabled = importDisabled;
		entry.importModel.disabled = importDisabled;
		entry.setContext.disabled = !entry.text || res.status !== 'done';
		entry.setContext.textContent = state.session.contextSource && state.session.contextSource.turnId === entry.turnId && state.session.contextSource.modelKey === entry.key
			? '当前上下文'
			: '设为上下文';

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
			const last = latestTurn();
			if (last && last.id === turnId) {
				refreshMini(key);
			}
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
		// 开始生成时先把编辑态收起来，避免改到一半被新回答覆盖
		if (value && state.editingTurnId) {
			cancelEditPrompt();
		}
		refreshPromptActions();
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
		if (event.key !== 'Escape') {
			return;
		}
		// Esc 的优先级：先关图片预览，没有预览时才取消编辑
		if (lightbox && lightbox.classList.contains('show')) {
			closeLightbox();
			return;
		}
		if (state.editingTurnId) {
			cancelEditPrompt();
		}
	});

	window.addEventListener('message', (event) => {
		const message = event.data || {};
		switch (message.type) {
			case 'models':
				state.models = message.models || [];
				state.selected = new Set(message.selected || []);
				renderSessionHeader();
				renderStrip();
				if (message.warning) {
					notice('warn', message.warning);
				}
				break;

			case 'session':
				state.session = message.session;
				state.sessions = message.sessions || [];
				// 勾选状态以会话里记录的为准；各轮的展示设置由 renderSession 从该会话
				// 自己的 turn.view 重建，所以不会把上一个会话的看法带过来。
				state.selected = new Set(message.session.selectedModels || []);
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
				// 新的一轮若没问过当前聚焦的模型，ensureFocusKey 会切到本轮问过的
				// 第一个模型，否则这一轮会只剩一句「本轮未向 X 提问」。
				ensureFocusKey();
				applyVisibility();
				// 已经有回答了，左复选框从此刻起可用
				renderStrip();
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

			case 'prompt': {
				// 扩展侧改完提问后的轻量回推：只刷新这一轮的提问区，不整屏重渲染
				const turn = (state.session.turns || []).find((t) => t.id === message.turnId);
				if (turn) {
					turn.prompt = message.prompt;
					turn.editedAt = message.editedAt;
				}
				const info = state.turnEls.get(message.turnId);
				if (info && !info.editing) {
					info.qText.textContent = message.prompt || '(图片消息)';
					info.qEdited.hidden = !message.editedAt;
				}
				if (typeof message.title === 'string') {
					state.session.title = message.title;
				}
				if ('contextSource' in message) {
					state.session.contextSource = message.contextSource || undefined;
				}
				renderSessionHeader();
				break;
			}

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
