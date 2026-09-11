/**
 * Markdown 渲染器（零依赖，浏览器 / Node 双用）。
 *
 * 设计取舍：
 * - **不用成熟库**：项目是零构建的（tsc + 直接复制 media/），引入 markdown-it
 *   就要加打包步骤，还会牵动 install:local 脚本。
 * - **不做代码高亮**：需要额外库且体积大，留白给 VS Code 自己的编辑器看更好。
 * - **安全第一**：所有文本先 `escapeHtml`，链接只放行 http/https/mailto 与相对路径，
 *   `javascript:` / `data:` 一律拒绝。渲染结果可以安全地塞进 innerHTML。
 *
 * 支持的语法：标题、粗体、斜体、删除线、行内代码、围栏代码块、有序/无序列表（含嵌套）、
 * 表格、链接、引用块、分隔线。
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === 'object' && module.exports) {
		module.exports = api;
	}
	if (root) {
		root.MarkdownRenderer = api;
	}
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	const HTML_ESCAPES = {
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
	};

	/** 行内代码的占位符用 NUL 包裹，避免与正常内容冲突。 */
	const PLACEHOLDER = '\u0000';

	function escapeHtml(text) {
		return String(text).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
	}

	/** 只放行安全的链接协议，挡住 javascript: / data: 之类。 */
	function sanitizeUrl(url) {
		const value = String(url).trim();
		if (!value) {
			return null;
		}
		if (/^(https?:\/\/|mailto:|#|\/|\.)/i.test(value)) {
			return value;
		}
		return null;
	}

	/** 行内元素：行内代码 / 链接 / 粗体 / 斜体 / 删除线。 */
	function renderInline(text) {
		if (text == null) {
			return '';
		}
		let out = escapeHtml(text);

		// 1) 先把行内代码抽成占位符，否则里面的 * _ ~ 会被误当成强调符号
		const codes = [];
		out = out.replace(/(`+)([\s\S]*?)\1/g, (_match, _ticks, code) => {
			codes.push(code);
			return PLACEHOLDER + (codes.length - 1) + PLACEHOLDER;
		});

		// 2) 链接。href 已在 escapeHtml 之后取值，因此不会破坏属性引号
		out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
			const safe = sanitizeUrl(href);
			if (!safe) {
				return match;
			}
			return '<a href="' + safe + '">' + label + '</a>';
		});

		// 3) 粗体先于斜体，这样 **x** 不会被斜体规则吃掉
		out = out.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
		out = out.replace(/__([\s\S]+?)__/g, '<strong>$1</strong>');
		out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
		out = out.replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1<em>$2</em>');
		out = out.replace(/~~([\s\S]+?)~~/g, '<del>$1</del>');

		// 4) 还原行内代码
		out = out.replace(
			new RegExp(PLACEHOLDER + '(\\d+)' + PLACEHOLDER, 'g'),
			(_match, index) => '<code>' + codes[Number(index)] + '</code>',
		);

		// 5) 段落内换行保留为 <br>
		return out.replace(/\n/g, '<br>');
	}

	/** 渲染代码块，语言标签作为代码块内部的角标（无语言时省略）。 */
	function renderCodeBlock(raw) {
		const newline = raw.indexOf('\n');
		const lang = newline >= 0 ? raw.slice(0, newline).trim() : '';
		const code = (newline >= 0 ? raw.slice(newline + 1) : raw).replace(/\n$/, '');
		const badge = lang ? '<span class="code-lang">' + escapeHtml(lang) + '</span>' : '';
		return (
			'<pre class="code' +
			(lang ? ' has-lang' : '') +
			'">' +
			badge +
			'<code>' +
			escapeHtml(code) +
			'</code></pre>'
		);
	}

	/** 分隔线：--- / *** / ___（允许中间有空格）。 */
	function isThematicBreak(line) {
		return /^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line);
	}

	/** 列表项：- / * / + 或 1. / 1)。 */
	function isListItem(line) {
		return /^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/.test(line);
	}

	/** 表格分隔行：| --- | :---: | 之类。 */
	function isTableSeparator(line) {
		const trimmed = line.trim();
		if (!trimmed.includes('|') || !trimmed.includes('-')) {
			return false;
		}
		return trimmed.replace(/[\s|:-]/g, '') === '';
	}

	function splitTableRow(line) {
		let value = line.trim();
		if (value.startsWith('|')) {
			value = value.slice(1);
		}
		if (value.endsWith('|')) {
			value = value.slice(0, -1);
		}
		return value.split('|').map((cell) => cell.trim());
	}

	function renderTable(header, rows) {
		let html = '<table><thead><tr>';
		for (const cell of header) {
			html += '<th>' + renderInline(cell) + '</th>';
		}
		html += '</tr></thead><tbody>';
		for (const row of rows) {
			html += '<tr>';
			for (let index = 0; index < header.length; index++) {
				const cell = row[index];
				html += '<td>' + renderInline(cell === undefined ? '' : cell) + '</td>';
			}
			html += '</tr>';
		}
		return html + '</tbody></table>';
	}

	/** 把 tab 展开成 4 个空格，便于按缩进判断嵌套层级。 */
	function expandIndent(whitespace) {
		return whitespace.replace(/\t/g, '    ').length;
	}

	/** 收集从 start 开始的连续列表项（含续行）。 */
	function parseList(lines, start) {
		const items = [];
		let index = start;

		while (index < lines.length) {
			const match = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[index]);
			if (!match) {
				break;
			}

			const indent = expandIndent(match[1]);
			const ordered = /^\d/.test(match[2]);
			let content = match[3];
			index++;

			// 续行：缩进 ≥2 空格且本身不是新的列表项
			while (
				index < lines.length &&
				lines[index].trim() &&
				!/^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/.test(lines[index]) &&
				/^\s{2,}/.test(lines[index])
			) {
				content += '\n' + lines[index].trim();
				index++;
			}

			items.push({ indent, ordered, content });
		}

		return { html: buildList(items), next: index };
	}

	/** 按缩进递归构建列表，支持一层以上的嵌套。 */
	function buildList(items) {
		if (items.length === 0) {
			return '';
		}

		const baseIndent = items[0].indent;
		const tag = items[0].ordered ? 'ol' : 'ul';
		let html = '<' + tag + '>';
		let index = 0;

		while (index < items.length) {
			const item = items[index];

			if (item.indent > baseIndent) {
				// 没有父项的子项，包一层避免结构错乱
				const children = [];
				while (index < items.length && items[index].indent > baseIndent) {
					children.push(items[index]);
					index++;
				}
				html += '<li>' + buildList(children) + '</li>';
				continue;
			}

			index++;
			let inner = renderInline(item.content);

			// 紧跟其后的更深缩进项属于当前项的子列表
			if (index < items.length && items[index].indent > baseIndent) {
				const children = [];
				while (index < items.length && items[index].indent > baseIndent) {
					children.push(items[index]);
					index++;
				}
				inner += buildList(children);
			}

			html += '<li>' + inner + '</li>';
		}

		return html + '</' + tag + '>';
	}

	/** 块级元素：标题 / 分隔线 / 引用 / 表格 / 列表 / 段落。 */
	function renderBlocks(text) {
		const lines = String(text).split('\n');
		const out = [];
		let paragraph = [];

		function flushParagraph() {
			if (paragraph.length === 0) {
				return;
			}
			const body = renderInline(paragraph.join('\n'));
			if (body.trim()) {
				out.push('<p>' + body + '</p>');
			}
			paragraph = [];
		}

		let index = 0;
		while (index < lines.length) {
			const line = lines[index];

			if (!line.trim()) {
				flushParagraph();
				index++;
				continue;
			}

			if (isThematicBreak(line)) {
				flushParagraph();
				out.push('<hr>');
				index++;
				continue;
			}

			const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
			if (heading) {
				flushParagraph();
				const level = heading[1].length;
				out.push(
					'<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>',
				);
				index++;
				continue;
			}

			if (/^\s*>/.test(line)) {
				flushParagraph();
				const quoted = [];
				while (index < lines.length && /^\s*>/.test(lines[index])) {
					quoted.push(lines[index].replace(/^\s*>\s?/, ''));
					index++;
				}
				out.push('<blockquote>' + renderBlocks(quoted.join('\n')) + '</blockquote>');
				continue;
			}

			if (index + 1 < lines.length && line.includes('|') && isTableSeparator(lines[index + 1])) {
				flushParagraph();
				const header = splitTableRow(line);
				index += 2;
				const rows = [];
				while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
					rows.push(splitTableRow(lines[index]));
					index++;
				}
				out.push(renderTable(header, rows));
				continue;
			}

			if (isListItem(line)) {
				flushParagraph();
				const result = parseList(lines, index);
				out.push(result.html);
				index = result.next;
				continue;
			}

			paragraph.push(line);
			index++;
		}

		flushParagraph();
		return out.join('');
	}

	/**
	 * 渲染完整 Markdown。
	 *
	 * 先按 ``` 切分，奇数段是代码块（原样保留、只转义），偶数段走块级解析，
	 * 这样代码块里的 Markdown 语法不会被误解析。
	 */
	function render(source) {
		if (source == null) {
			return '';
		}
		const segments = String(source).split('```');
		let html = '';
		for (let index = 0; index < segments.length; index++) {
			html += index % 2 === 1 ? renderCodeBlock(segments[index]) : renderBlocks(segments[index]);
		}
		return html;
	}

	return {
		render,
		escapeHtml,
		renderInline,
	};
});
