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
		/** 加入了并排对比的模型（只影响怎么看）：由悬浮条卡片左侧的复选框控制。
		 *  非空时会话区进「并排对比」，只看这几个；空时回到单模型聚焦阅读。 */
		compare: new Set(),
		/** 聚焦阅读的对象：单模型阅读时整个会话只显示这个模型的回答 */
		focusKey: '',
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
	 * 保证有一个可读的聚焦模型。
	 * 优先沿用当前选择；失效时回落到最新一轮的第一个模型，再退回列表里的第一个。
	 */
	function ensureFocusKey() {
		const available = visibleKeys();
		if (state.focusKey && available.includes(state.focusKey)) {
			return;
		}
		const last = latestTurn();
		const lastKeys = last ? Object.keys(last.responses || {}) : [];
		state.focusKey = lastKeys.find((key) => available.includes(key)) || available[0] || '';
	}

	/** 点卡片正文 = 单模型阅读这个模型（并排对比会因此退出）。 */
	function setFocus(key) {
		if (!key) {
			return;
		}
		// 单读和并排是两种互斥的看*法*：进入单读要清掉并排勾选，
		// 否则"点了卡片却什么都没变"，会让人以为点击失效。
		const wasCompare = isCompareMode();
		state.compare.clear();
		if (key === state.focusKey && !wasCompare) {
			return;
		}
		state.focusKey = key;
		applyVisibility();
	}

	/** 是否处于「并排对比」：勾了至少一个左复选框。 */
	function isCompareMode() {
		return state.compare.size > 0;
	}

	/**
	 * 切换某模型的「并排对比」勾选（悬浮条卡片左侧的复选框）。
	 * 只影响**怎么展示**，和「是否参与提问」无关。
	 */
	function setCompare(key, on) {
		if (on) {
			state.compare.add(key);
		} else {
			state.compare.delete(key);
		}
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

	/** 模型在列表里的下标，用来给并排的格子排序（flex 的 order 属性）。 */
	function modelOrder(key) {
		const index = state.models.findIndex((m) => m.key === key);
		return index < 0 ? 999 : index;
	}

	/** 当前并排对比的模型，按模型列表顺序。 */
	function compareKeys() {
		return state.models.filter((m) => state.compare.has(m.key)).map((m) => m.key);
	}

	/**
	 * 统一刷新「谁可见、谁是当前项」。
	 *
	 * 两种展示方式：
	 * - **并排对比**（勾了左复选框）：每一轮同时列出被勾选的那几个模型，横向排开；
	 * - **单模型阅读**（没勾）：只显示当前聚焦模型的回答。
	 *
	 * 右侧开关只决定"是否提问"，不影响能不能看它已有的回答。
	 */
	function applyVisibility() {
		const compare = isCompareMode();
		const focus = state.focusKey;
		el.app.classList.toggle('compare', compare);

		for (const entry of state.cards.values()) {
			const visible = compare ? state.compare.has(entry.key) : entry.key === focus;
			entry.card.classList.toggle('hidden', !visible);
			entry.card.classList.toggle('tile', !!compare);
			entry.card.style.order = compare ? String(modelOrder(entry.key)) : '';
		}

		for (const tab of state.tabs.values()) {
			const on = compare ? state.compare.has(tab.key) : tab.key === focus;
			tab.tab.classList.toggle('on', on);
			tab.tab.classList.toggle('muted', !state.selected.has(tab.key));
		}

		// 并排时每一轮都换成横排布局；缺席的模型补一个占位格子，
		// 这样各轮列出的模型始终一致，不会被误读成"这个模型答得短"。
		for (const [turnId, info] of state.turnEls) {
			const turn = turnById(turnId);
			info.cards.classList.toggle('tile', compare);
			info.section.classList.toggle('tile', compare);

			for (const stale of Array.from(info.cards.querySelectorAll('.tile-missing'))) {
				stale.remove();
			}
			if (compare && turn) {
				for (const key of compareKeys()) {
					if ((turn.responses || {})[key]) {
						continue;
					}
					const model = state.models.find((m) => m.key === key);
					const cell = document.createElement('article');
					cell.className = 'card tile-missing';
					cell.style.setProperty('--c', modelColorVar(key));
					cell.style.order = String(modelOrder(key));
					const head = document.createElement('div');
					head.className = 'card-head';
					const name = document.createElement('span');
					name.className = 'card-name';
					name.textContent = model ? modelLabel(model) : key;
					head.appendChild(name);
					const body = document.createElement('div');
					body.className = 'card-body';
					body.textContent = '本轮未向该模型提问。';
					cell.appendChild(head);
					cell.appendChild(body);
					info.cards.appendChild(cell);
				}
			}
		}

		// 并排对比时每轮都有多个模型，没有"没向谁提问"这回事；
		// 单读时若当前模型本轮缺席，给一句占位说明。
		const name = focusModelName();
		for (const [turnId, info] of state.turnEls) {
			const turn = turnById(turnId);
			const missing = !compare && turn && !(turn.responses || {})[focus];
			info.missing.classList.toggle('hidden', !missing);
			if (missing) {
				info.missing.textContent =
					'本轮未向「' + name + '」提问，点其它模型卡片或选项卡可以看别人的回答。';
			}
		}

		renderStripActive();
	}

	function focusModelName() {
		const model = state.models.find((m) => m.key === state.focusKey);
		return model ? modelLabel(model) : state.focusKey;
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
			compareBox.checked = state.compare.has(model.key);
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
		const compare = isCompareMode();
		const hasTurn = hasAnyTurn();
		for (const [key, mini] of state.minis) {
			mini.root.classList.toggle('active', !compare && key === state.focusKey);
			mini.root.classList.toggle('off', !state.selected.has(key));
			mini.root.classList.toggle('comparing', state.compare.has(key));
			mini.checkbox.checked = state.selected.has(key);
			mini.compareBox.checked = state.compare.has(key);
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
	}

	function renderSession() {
		renderSessionHeader();
		el.messages.textContent = '';
		state.cards.clear();
		state.tabs.clear();
		state.turnEls.clear();
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
		const summary = document.createElement('span');
		summary.className = 'q-summary';
		head.appendChild(badge);
		head.appendChild(time);
		head.appendChild(summary);
		section.appendChild(head);

		// ── 用户提问：聚焦阅读下是一块带底色的「提问」区，平铺模式下是一个气泡
		const qRow = document.createElement('div');
		qRow.className = 'q-row';
		const qTag = document.createElement('div');
		qTag.className = 'q-tag';
		qTag.textContent = '你的提问';
		const qText = document.createElement('div');
		qText.className = 'q-text';
		qText.textContent = turn.prompt || '(图片消息)';
		qRow.appendChild(qTag);
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

		state.turnEls.set(turn.id, { section, summary, missing, tabbar, cards });
		el.messages.appendChild(section);
		updateTurnSummary(turn.id);

		if (doScroll !== false) {
			scrollToBottom();
		}
		return section;
	}

	/** 聚焦模式下每轮顶部的模型选项卡。 */
	function createTab(turnId, key, response) {
		const model = state.models.find((m) => m.key === key);
		const tab = document.createElement('button');
		tab.type = 'button';
		tab.className = 'tab';
		tab.style.setProperty('--c', modelColorVar(key));
		tab.title = (model ? model.key : key) + '\n点一下退出并排对比，只读该模型';

		const dot = document.createElement('span');
		dot.className = 'dot';
		const name = document.createElement('span');
		name.className = 'nm';
		name.textContent = model ? modelLabel(model) : key;
		const time = document.createElement('span');
		time.className = 'tm';

		tab.appendChild(dot);
		tab.appendChild(name);
		tab.appendChild(time);
		tab.addEventListener('click', () => setFocus(key));

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

	/** 这一轮的概况：几个模型、各自什么状态。 */
	function updateTurnSummary(turnId) {
		const info = state.turnEls.get(turnId);
		const turn = turnById(turnId);
		if (!info || !turn) {
			return;
		}
		const responses = Object.values(turn.responses || {});
		if (responses.length === 0) {
			info.summary.textContent = '本轮没有可用的模型';
			return;
		}
		const count = (status) => responses.filter((r) => r.status === status).length;
		const parts = [];
		if (count('done')) {
			parts.push(count('done') + ' 成功');
		}
		if (count('streaming') + count('pending')) {
			parts.push(count('streaming') + count('pending') + ' 进行中');
		}
		if (count('error')) {
			parts.push(count('error') + ' 失败');
		}
		if (count('cancelled')) {
			parts.push(count('cancelled') + ' 已取消');
		}
		info.summary.textContent = responses.length + ' 个模型 · ' + parts.join(' / ');
	}


	function createCard(turnId, key, response) {
		const model = state.models.find((m) => m.key === key);

		const card = document.createElement('article');
		card.className = 'card';
		card.style.setProperty('--c', modelColorVar(key));

		// ── 标题栏：状态点 + 模型名 + 状态 + 操作按钮
		const head = document.createElement('div');
		head.className = 'card-head';

		const dot = document.createElement('span');
		dot.className = 'dot';

		const name = document.createElement('span');
		name.className = 'card-name';
		name.textContent = model ? modelLabel(model) : key;
		name.title = key;
		// 并排对比时点模型名 = 退出并排，只读这一个
		name.addEventListener('click', () => setFocus(key));

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

		const status = document.createElement('span');
		status.className = 'card-status';

		const actions = document.createElement('div');
		actions.className = 'card-actions';
		actions.appendChild(copy);
		actions.appendChild(regenerate);
		actions.appendChild(importOne);
		actions.appendChild(importModel);

		head.appendChild(dot);
		head.appendChild(name);
		head.appendChild(status);
		head.appendChild(actions);
		card.appendChild(head);

		// ── 正文
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
		updateDot(entry.dot, res.status);

		// 选项卡、右侧预览栏、本轮摘要都跟着状态走
		const tab = state.tabs.get(cardKey(entry.turnId, entry.key));
		if (tab) {
			updateTab(tab, res);
		}
		updateTurnSummary(entry.turnId);
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
				renderSessionHeader();
				renderStrip();
				if (message.warning) {
					notice('warn', message.warning);
				}
				break;

			case 'session':
				state.session = message.session;
				state.sessions = message.sessions || [];
				// 勾选状态以会话里记录的为准；并排对比不跨会话保留
				state.selected = new Set(message.session.selectedModels || []);
				state.compare.clear();
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
				// 新的一轮里没有当前聚焦的模型时，跟着切到本轮的第一个模型，
				// 否则新的一轮会只剩一句「本轮未向 X 提问」。
				if (state.focusKey && !(message.turn.responses || {})[state.focusKey]) {
					const keys = Object.keys(message.turn.responses || {});
					if (keys.length) {
						state.focusKey = keys[0];
					}
				}
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
