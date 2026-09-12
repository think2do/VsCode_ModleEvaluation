// 纯逻辑单元测试：直接加载 `out/` 下编译好的模块，在 Node 里跑断言。
//
// 只测**不依赖 vscode 运行时**的模块 —— 它们全都用 `import type` 引入 vscode，
// 编译后不产生 `require('vscode')`，所以能直接加载。业务规则恰恰集中在这些
// 模块里（上下文回放、模型筛选、勾选收敛、协议收窄），是最值得锁住的部分。
//
// 前置：先 `npm run compile`（`npm test` 会通过 pretest 自动做）
// 用法：node scripts/unit-test.mjs
import { createRequire } from 'module';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'out');

if (!existsSync(join(out, 'lm', 'models.js'))) {
	console.error('找不到 out/，请先运行 npm run compile');
	process.exit(1);
}

const models = require(join(out, 'lm', 'models.js'));
const context = require(join(out, 'lm', 'context.js'));
const protocol = require(join(out, 'protocol.js'));
const imports = require(join(out, 'session', 'import.js'));

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
		console.log(`      实际：${JSON.stringify(actual)}`);
	}
}

function eq(label, actual, expected) {
	check(label, JSON.stringify(actual), JSON.stringify(expected));
}

/** 只看「有几个 / 哪些」的时候用，避免把整条记录都写进断言。 */
const roles = (entries) => entries.map((e) => e.role);
const texts = (entries) => entries.map((e) => e.text);

// ─────────────────────────── 夹具 ───────────────────────────
const image = (file) => ({ file, mime: 'image/png', name: file });

function turn(id, prompt, responses, extra = {}) {
	return { id, at: 0, prompt, images: [], responses, ...extra };
}

const done = (text, extra = {}) => ({ text, status: 'done', ...extra });
const failed = (text = '') => ({ text, status: 'error', error: 'boom' });

// ─────────────────────────── keyOf ───────────────────────────
console.log('keyOf');
eq('拼成 vendor:id', models.keyOf({ vendor: 'customendpoint', id: 'a' }), 'customendpoint:a');

// ─────────────────────────── filterModels ───────────────────────────
console.log('\nfilterModels');
const refs = [
	{ key: 'customendpoint:a', vendor: 'customendpoint', name: 'A' },
	{ key: 'copilot:b', vendor: 'copilot', name: 'B' },
];
const filter = (over = {}) => ({ cap: 0, vendors: ['customendpoint'], onlyPreferred: true, ...over });

check('白名单命中时只留白名单', models.filterModels(refs, filter()).visible, (v) => v.length === 1 && v[0].key === 'customendpoint:a');
check('白名单命中时没有提示', models.filterModels(refs, filter()).notes, (n) => n.length === 0);
check(
	'白名单落空时退回全部并提示',
	models.filterModels(refs, filter({ vendors: ['nope'] })).visible,
	(v) => v.length === 2,
);
check(
	'白名单落空时给出明确提示',
	models.filterModels(refs, filter({ vendors: ['nope'] })).notes,
	(n) => n.some((t) => t.includes('没有匹配到任何模型')),
);
check('关闭白名单时列出全部', models.filterModels(refs, filter({ onlyPreferred: false })).visible, (v) => v.length === 2);
check('白名单为空数组时不过滤', models.filterModels(refs, filter({ vendors: [] })).visible, (v) => v.length === 2);
check(
	'vendor 比较大小写不敏感',
	models.filterModels([{ key: 'Custom:b', vendor: 'CustomEndpoint', name: 'B' }], filter()).visible,
	(v) => v.length === 1,
);
check(
	'没有任何模型时给出排查提示',
	models.filterModels([], filter()).notes,
	(n) => n.some((t) => t.includes('没有找到可用模型')),
);

// ─────────────────────────── reconcileSelection ───────────────────────────
console.log('\nreconcileSelection');
eq('保留仍可见的已勾选', models.reconcileSelection(['customendpoint:a'], refs, 0).keys, ['customendpoint:a']);
eq('已勾选的都不可见时默认全选', models.reconcileSelection(['gone'], refs, 0).keys, [
	'customendpoint:a',
	'copilot:b',
]);
eq('从未勾选过时默认全选', models.reconcileSelection([], refs, 0).keys, ['customendpoint:a', 'copilot:b']);
eq('不可见的模型会被移除（隐藏即不可选）', models.reconcileSelection(['gone', 'customendpoint:a'], refs, 0).keys, [
	'customendpoint:a',
]);
eq('超过上限时截断', models.reconcileSelection([], refs, 1).keys, ['customendpoint:a']);
check(
	'截断时明确告知用户',
	models.reconcileSelection([], refs, 1).notes,
	(n) => n.some((t) => t.includes('已只勾选前 1 个')),
);
check('上限为 0 表示不限制', models.reconcileSelection([], refs, 0).notes, (n) => n.length === 0);
check('相等时不算超限', models.reconcileSelection([], refs, 2).notes, (n) => n.length === 0);

// ─────────────────────────── planContext ───────────────────────────
console.log('\nplanContext（上下文回放）');

// 两个模型：A 两轮都答完，B 第二轮失败
const session = {
	id: 's',
	title: 't',
	createdAt: 0,
	updatedAt: 0,
	selectedModels: [],
	turns: [
		turn('t1', 'Q1', { 'v:A': done('A1'), 'v:B': done('B1') }),
		turn('t2', 'Q2', { 'v:A': done('A2'), 'v:B': failed() }),
		turn('t3', 'Q3', { 'v:A': { text: '', status: 'pending' } }),
	],
};

const planA = context.planContext(session, session.turns[2], 'v:A', true, []);
eq('只回放自己答完的轮次 + 当前轮', roles(planA), ['user', 'assistant', 'user', 'assistant', 'user']);
eq('历史顺序是 user/assistant 交替', texts(planA), ['Q1', 'A1', 'Q2', 'A2', 'Q3']);

const planB = context.planContext(session, session.turns[2], 'v:B', true, []);
eq('失败的轮次不回放（上下文不串台）', texts(planB), ['Q1', 'B1', 'Q3']);

check(
	'当前轮之外的历史里不重复包含当前轮',
	context.planContext(session, session.turns[1], 'v:A', true, []),
	(entries) => texts(entries).join('|') === 'Q1|A1|Q2',
);

// 图片
const withImage = {
	...session,
	turns: [turn('t1', 'Q1', { 'v:A': done('A1') }, { images: [image('p.png')] })],
};
const current = turn('t2', 'Q2', { 'v:A': { text: '', status: 'pending' } }, { images: [image('c.png')] });
withImage.turns.push(current);

check(
	'支持图片时历史与当前轮都带图',
	context.planContext(withImage, current, 'v:A', true, current.images),
	(entries) => entries[0].images.length === 1 && entries[2].images.length === 1,
);
check(
	'supportsImages=false 时历史与当前轮都不带图',
	context.planContext(withImage, current, 'v:A', false, []),
	(entries) => entries.every((e) => !e.images || e.images.length === 0),
);
check(
	'当前轮的图片来自调用方传入的那份',
	context.planContext(withImage, current, 'v:A', true, current.images),
	(entries) => entries[2].images[0].file === 'c.png',
);

// droppedImages：该模型此前丢过图，历史里别再发
const dropped = {
	...session,
	turns: [turn('t1', 'Q1', { 'v:A': done('A1', { droppedImages: true }) }, { images: [image('p.png')] })],
};
dropped.turns.push(turn('t2', 'Q2', { 'v:A': { text: '', status: 'pending' } }));
check(
	'该模型此前丢过图 → 历史里不再发图',
	context.planContext(dropped, dropped.turns[1], 'v:A', true, []),
	(entries) => entries[0].images.length === 0,
);

// 共享上下文
const withSource = {
	...session,
	contextSource: { turnId: 't1', modelKey: 'v:B' },
	turns: [
		turn('t1', 'Q1', { 'v:A': done('A1'), 'v:B': done('B1') }),
		turn('t2', 'Q2', { 'v:A': { text: '', status: 'pending' } }),
	],
};
check(
	'共享上下文追加为 assistant',
	context.planContext(withSource, withSource.turns[1], 'v:A', true, []),
	(entries) =>
		// Q1 / A1 / 共享上下文 / Q2
		entries.length === 4 &&
		entries[2].role === 'assistant' &&
		entries[2].text.includes('B1') &&
		entries[2].text.includes(context.CONTEXT_SOURCE_PREFIX),
);
check(
	'共享上下文指向空回答时不追加',
	context.planContext(
		{ ...withSource, contextSource: { turnId: 't2', modelKey: 'v:A' } },
		withSource.turns[1],
		'v:A',
		true,
		[],
	),
	(entries) => entries.length === 3,
);
check(
	'共享上下文指向不存在的轮次时不追加',
	context.planContext(
		{ ...withSource, contextSource: { turnId: 'nope', modelKey: 'v:A' } },
		withSource.turns[1],
		'v:A',
		true,
		[],
	),
	(entries) => entries.length === 3,
);

// ─────────────────────────── planImport ───────────────────────────
console.log('\nplanImport（导入到 Copilot）');
const importSession = {
	id: 's',
	title: 'My Chat',
	createdAt: 0,
	updatedAt: 0,
	selectedModels: [],
	turns: [turn('t1', 'Q1', { 'v:A': done('A1') }), turn('t2', 'Q2', { 'v:A': done('A2'), 'v:B': done('B2') })],
};

const planOne = imports.planImport({
	session: importSession,
	modelName: 'A',
	modelKey: 'v:A',
	turnId: 't2',
	scope: 'one',
});
const planWhole = imports.planImport({
	session: importSession,
	modelName: 'A',
	modelKey: 'v:A',
	scope: 'model',
});

check(
	'没有对应回答时返回 undefined',
	imports.planImport({ session: importSession, modelName: 'C', modelKey: 'v:C', turnId: 't1', scope: 'one' }),
	(p) => p === undefined,
);
check('单条导入只含那一轮', planOne, (p) => p.fileText.includes('A2') && !p.fileText.includes('A1'));
check('单条导入带轮次标题', planOne, (p) => p.fileText.includes('## 第 2 轮'));
check('整段导入不含轮次标题', planWhole, (p) => !p.fileText.includes('## 第'));
check('整段导入含全部轮次', planWhole, (p) => p.fileText.includes('A1') && p.fileText.includes('A2'));
eq('文件名带上模型与范围', planWhole.fileName, 'My-Chat-A-完整对话.md');
check(
	'文件名里的中文标题被安全化',
	imports.planImport({
		session: { ...importSession, title: '中文标题' },
		modelName: 'A',
		modelKey: 'v:A',
		scope: 'model',
	}),
	(p) => p.fileName.startsWith('model-'),
);

// ─────────────────────────── parseWebviewMessage ───────────────────────────
console.log('\nparseWebviewMessage（协议收窄）');
const parse = protocol.parseWebviewMessage;

check('非对象被拒绝', parse('nope') === undefined, true);
check('null 被拒绝', parse(null) === undefined, true);
check('未知 type 被拒绝', parse({ type: 'nope' }) === undefined, true);
check('缺少 type 被拒绝', parse({ turnId: 'x' }) === undefined, true);
eq('无参消息', parse({ type: 'ready' }), { type: 'ready' });
eq('stop', parse({ type: 'stop' }), { type: 'stop' });

eq(
	'send 缺省 selected 保留 undefined（表示回落到会话勾选）',
	parse({ type: 'send', prompt: 'hi' }).selected,
	undefined,
);
eq('send 缺省 images 归一成空数组', parse({ type: 'send', prompt: 'hi' }).images, []);
check(
	'send 过滤掉没有 dataUrl 的图片',
	parse({ type: 'send', prompt: 'hi', images: [{ dataUrl: 'data:x' }, { mime: 'image/png' }, 'nope'] }).images,
	(list) => list.length === 1 && list[0].dataUrl === 'data:x',
);
check(
	'selected 过滤掉非字符串项',
	parse({ type: 'selectModels', selected: ['a', 1, null, 'b'] }).selected,
	(list) => list.length === 2 && list[0] === 'a' && list[1] === 'b',
);
eq('send 的 prompt 类型不对时视为未提供', parse({ type: 'send', prompt: 42 }).prompt, undefined);

eq('importToCopilot 的 scope 默认 one', parse({ type: 'importToCopilot', key: 'k' }).scope, 'one');
eq('importToCopilot 保留 model', parse({ type: 'importToCopilot', key: 'k', scope: 'model' }).scope, 'model');
eq('importToCopilot 的未知 scope 退化成 one', parse({ type: 'importToCopilot', key: 'k', scope: 'evil' }).scope, 'one');

eq(
	'updateTurnView 收窄内部结构',
	parse({ type: 'updateTurnView', turnId: 't', view: { focusKey: 'k', compareKeys: ['a', 1] } }).view,
	{ focusKey: 'k', compareKeys: ['a'] },
);
eq('updateTurnView 的 view 缺失时保留 undefined', parse({ type: 'updateTurnView', turnId: 't' }).view, undefined);
eq('regenerate 字段缺失时保留 undefined', parse({ type: 'regenerate' }).turnId, undefined);

console.log('');
if (failures > 0) {
	console.error(`失败 ${failures} 项，通过 ${passed} 项`);
	process.exit(1);
}
console.log(`全部通过（${passed} 项）`);
