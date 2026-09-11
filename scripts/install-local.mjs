// 把扩展安装到用户的 VS Code 扩展目录，重启后即可长期使用。
//
// 这是一个「本地安装」：直接复制构建产物，不需要下载任何东西，也不用打包 .vsix。
// 装完之后，只要改动代码后重新运行本脚本（或 npm run compile && npm run install:local），
// 再重载 VS Code 窗口就能生效。
//
// 用法：node scripts/install-local.mjs
import { readFileSync, existsSync, mkdirSync, rmSync, cpSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');

const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));

if (!pkg.publisher || !pkg.name || !pkg.version) {
	console.error('package.json 缺少 publisher / name / version，无法安装。');
	process.exit(1);
}
if (!existsSync(join(projectRoot, 'out', 'extension.js'))) {
	console.error('没有找到 out/extension.js，请先运行 npm run compile。');
	process.exit(1);
}

const extensionId = `${pkg.publisher}.${pkg.name}`;
const targetName = `${extensionId}-${pkg.version}`;
const extensionsDir = join(homedir(), '.vscode', 'extensions');
const targetDir = join(extensionsDir, targetName);

// 要装进去的内容：只包含运行期真正需要的文件
const INCLUDE = ['package.json', 'out', 'media', 'README.md'];
if (existsSync(join(projectRoot, 'LICENSE'))) {
	INCLUDE.push('LICENSE');
}

console.log(`扩展 ID   ：${extensionId}`);
console.log(`目标目录 ：${targetDir}`);
console.log('');

// 卸载模式：删掉这个扩展的所有版本，然后退出
if (process.argv.includes('--uninstall')) {
	let removed = 0;
	if (existsSync(extensionsDir)) {
		for (const name of readdirSync(extensionsDir)) {
			if (name.startsWith(`${extensionId}-`)) {
				rmSync(join(extensionsDir, name), { recursive: true, force: true });
				console.log(`· 已移除 ${name}`);
				removed++;
			}
		}
	}
	console.log('');
	console.log(removed > 0 ? `卸载完成，共移除 ${removed} 个版本。` : '未找到已安装的版本。');
	console.log('重启 VS Code 后生效。');
	process.exit(0);
}

// 1. 清掉这个扩展的所有旧版本（只匹配自己的 ID，不动别人的扩展）
if (existsSync(extensionsDir)) {
	for (const name of readdirSync(extensionsDir)) {
		if (name.startsWith(`${extensionId}-`) && name !== targetName) {
			rmSync(join(extensionsDir, name), { recursive: true, force: true });
			console.log(`· 已移除旧版本 ${name}`);
		}
	}
} else {
	mkdirSync(extensionsDir, { recursive: true });
}

// 2. 覆盖式安装当前版本
rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });

for (const item of INCLUDE) {
	const from = join(projectRoot, item);
	if (!existsSync(from)) {
		console.log(`· 跳过不存在的 ${item}`);
		continue;
	}
	cpSync(from, join(targetDir, item), { recursive: true });
	console.log(`· 已复制 ${item}`);
}

console.log('');
console.log('安装完成。');
console.log('');
console.log('下一步：');
console.log('  1. 完全退出并重新打开 VS Code（Cmd+Q 后重新启动）');
console.log('  2. 按 Cmd+Shift+P 执行「多模型对比: 打开对比对话面板」');
console.log('');
console.log('若命令面板里搜不到，可在扩展面板搜索 "多模型对比对话" 确认它已启用。');
