// 离线冒烟测试：直接加载 media/markdown.js 在 Node 里跑断言。
//
// 重点验证两件事：
//   1. 安全性 —— 模型返回的内容（可能包含恶意 HTML）必须被转义，不能当标签执行；
//   2. 正确性 —— 各类 Markdown 语法能渲染成预期结构。
//
// 用法：node scripts/smoke-render.mjs
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const { render, escapeHtml, renderInline } = require(join(here, '..', 'media', 'markdown.js'));

let failures = 0;
let passed = 0;

function check(label, actual, expected) {
	const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
	if (ok) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failures++;
		console.log(`  ✗ ${label}`);
		console.log(`      实际输出：${JSON.stringify(actual)}`);
	}
}

const has = (needle) => (value) => typeof value === 'string' && value.includes(needle);
const lacks = (needle) => (value) => typeof value === 'string' && !value.includes(needle);
const isString = (value) => typeof value === 'string';
/** 统计某个标签出现次数，如 times('<p>') 返回断言函数。 */
const times = (pattern, expected) => (value) =>
	(String(value).match(new RegExp(pattern, 'g')) || []).length === expected;

// ─────────────────────────── 转义 ───────────────────────────
console.log('escapeHtml');
check('转义尖括号', escapeHtml('<b>'), has('&lt;b&gt;'));
check('转义 & 与引号', escapeHtml('&"\''), has('&amp;&quot;&#39;'));

// ─────────────────────────── 安全 ───────────────────────────
console.log('\n安全性（XSS 防护）');
check('裸 <script> 不逃逸成标签', render('<script>alert(1)</script>'), lacks('<script>'));
check('<img onerror> 被转义', render('<img src=x onerror=alert(1)>'), lacks('<img'));
check('代码块内的闭合标签被转义', render('```\n</code></pre><script>x</script>\n```'), lacks('<script>'));
check('行内代码里的标签被转义', render('看这个 `<b>x</b>` 标签'), lacks('<b>x</b>'));
check('列表项里的标签被转义', render('- <img src=x onerror=alert(1)>'), lacks('<img'));
check('表格单元格里的标签被转义', render('| a |\n|---|\n| <script>x</script> |'), lacks('<script>'));
check('引用块里的标签被转义', render('> <script>x</script>'), lacks('<script>'));
check('标题里的标签被转义', render('# <script>x</script>'), lacks('<script>'));
check('javascript: 链接被拒绝', render('[x](javascript:alert(1))'), lacks('<a '));
check('data: 链接被拒绝', render('[x](data:text/html,evil)'), lacks('<a '));
check('正常 https 链接被放行', render('[x](https://example.com)'), has('<a href="https://example.com">'));
check(
	'链接属性里的引号不会断开属性',
	render('[x](https://a.com/")'),
	lacks('href="https://a.com/"">'),
);

// ─────────────────────────── 代码块 ───────────────────────────
console.log('\n代码块');
check('围栏外壳', render('```\ncode\n```'), has('<pre class="code"><code>'));
check('内容中的 < 被转义', render('```\nif (a < b) {}\n```'), has('a &lt; b'));
check('语言标签存在', render('```js\nlet a = 1;\n```'), has('class="code-lang"'));
check('语言标签内容', render('```js\nlet a = 1;\n```'), has('>js<'));
check('有语言时外壳带 has-lang', render('```js\nlet a = 1;\n```'), has('class="code has-lang"'));
check('无语言时不带 has-lang', render('```\ncode\n```'), lacks('has-lang'));
check('语言标签在 pre 内部', render('```js\nx\n```'), has('<pre class="code has-lang"><span class="code-lang">js</span><code>'));
check('未闭合围栏不抛异常', render('```\nfoo'), isString);
check('代码块内的 Markdown 不被解析', render('```\n**not bold**\n```'), lacks('<strong>'));

// ─────────────────────────── 行内 ───────────────────────────
console.log('\n行内元素');
check('粗体', renderInline('**粗**'), has('<strong>粗</strong>'));
check('下划线粗体', renderInline('__粗__'), has('<strong>粗</strong>'));
check('斜体', renderInline('*斜*'), has('<em>斜</em>'));
check(
	'两个斜体各自成立',
	renderInline('*a* 和 *b*'),
	(v) => v.includes('<em>a</em>') && v.includes('<em>b</em>'),
);
check('删除线', renderInline('~~删~~'), has('<del>删</del>'));
check('行内代码', renderInline('`x`'), has('<code>x</code>'));
check('行内代码里的强调符号不生效', renderInline('`**x**`'), lacks('<strong>'));
check('行内代码里的下划线不生效', renderInline('`a_b_c`'), lacks('<em>'));
check(
	'粗体与斜体共存',
	renderInline('**a** 和 *b*'),
	(v) => v.includes('<strong>a</strong>') && v.includes('<em>b</em>'),
);
check('段落内换行转 br', renderInline('a\nb'), has('<br>'));

// ─────────────────────────── 块级 ───────────────────────────
console.log('\n块级元素');
check('一级标题', render('# 标题'), has('<h1>标题</h1>'));
check('三级标题', render('### 标题'), has('<h3>标题</h3>'));
check('六级标题', render('###### 标题'), has('<h6>标题</h6>'));
check('七个 # 不是标题', render('####### x'), lacks('<h7'));
check('分隔线（---）', render('---'), has('<hr>'));
check('分隔线（***）', render('***'), has('<hr>'));
check('分隔线（___）', render('___'), has('<hr>'));
check('引用块外壳', render('> 引用'), has('<blockquote>'));
check('引用块内容', render('> 引用'), has('引用'));
check('普通段落', render('一段话'), has('<p>'));
check('空行分段', render('a\n\nb'), times('<p>', 2));

console.log('\n列表');
check('无序列表外壳', render('- a\n- b'), has('<ul>'));
check(
	'无序列表项目',
	render('- a\n- b'),
	(v) => v.includes('<li>a</li>') && v.includes('<li>b</li>'),
);
check('星号列表', render('* a'), has('<li>a</li>'));
check('加号列表', render('+ a'), has('<li>a</li>'));
check('有序列表', render('1. a\n2. b'), has('<ol>'));
check(
	'有序列表项目',
	render('1. a\n2. b'),
	(v) => v.includes('<li>a</li>') && v.includes('<li>b</li>'),
);
check('右括号编号', render('1) a'), has('<ol>'));
check(
	'嵌套列表',
	render('- a\n  - b'),
	(v) => v.includes('<li>a<ul>') && v.includes('<li>b</li>'),
);
check('列表项内可含粗体', render('- **x**'), has('<strong>x</strong>'));
check('单个 - 不是列表', render('-'), lacks('<ul>'));

console.log('\n表格');
const tableMd = '| 名称 | 值 |\n| --- | --- |\n| a | 1 |';
check('表格外壳', render(tableMd), has('<table>'));
check('表头单元格', render(tableMd), has('<th>名称</th>'));
check('表体单元格', render(tableMd), has('<td>1</td>'));
check('对齐分隔行不算数据行', render(tableMd), times('<tr>', 2));
check('冒号对齐分隔行', render('| a |\n| :---: |\n| 1 |'), has('<td>1</td>'));
check('表格内可含行内代码', render('| a |\n| --- |\n| `x` |'), has('<code>x</code>'));

// ─────────────────────────── 组合与边界 ───────────────────────────
console.log('\n组合与边界');
check(
	'代码块 + 段落 + 列表共存',
	render('text\n\n```js\ncode\n```\n\n- item'),
	(v) => v.includes('<p>text</p>') && v.includes('<pre class="code') && v.includes('<li>item</li>'),
);
check('空字符串', render(''), '');
check('null 安全', render(null), '');
check('undefined 安全', render(undefined), '');
check('只有反引号', render('`'), isString);
check('只有井号', render('#'), isString);
check('只有竖线', render('|'), isString);
check('只有大于号', render('>'), isString);
check('只有横线', render('-'), isString);
check('只有空格', render('   '), isString);

console.log('');
if (failures > 0) {
	console.error(`失败 ${failures} 项，通过 ${passed} 项`);
	process.exit(1);
}
console.log(`全部通过（${passed} 项）`);
