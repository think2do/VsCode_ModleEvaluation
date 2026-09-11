// 手工打包 .vsix（零依赖，不需要下载 vsce）。
//
// .vsix 本质是一个特定结构的 zip：
//   [Content_Types].xml        声明各扩展名的 MIME 类型
//   extension.vsixmanifest     扩展元数据（Id / Version / Publisher / Engine）
//   extension/                 扩展本体（package.json + 运行期文件）
//
// 用法：node scripts/package-vsix.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execFileSync } from 'child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const { publisher, name, version, displayName, description, engines, license } = pkg;
if (!publisher || !name || !version) {
	console.error('package.json 缺少 publisher / name / version');
	process.exit(1);
}
if (!existsSync(join(root, 'out', 'extension.js'))) {
	console.error('找不到 out/extension.js，请先运行 npm run compile');
	process.exit(1);
}

const stage = join(root, '.vsix-stage');
const distDir = join(root, 'dist');
const vsixPath = join(distDir, `${name}-${version}.vsix`);

// ── 1. 清理并重建暂存目录
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'extension'), { recursive: true });
mkdirSync(distDir, { recursive: true });

// ── 2. 复制扩展本体（只包含运行期需要的文件）
const INCLUDE = ['package.json', 'out', 'media', 'README.md'];
if (license && existsSync(join(root, 'LICENSE'))) {
	INCLUDE.push('LICENSE');
}
for (const item of INCLUDE) {
	const from = join(root, item);
	if (!existsSync(from)) {
		console.log(`· 跳过不存在的 ${item}`);
		continue;
	}
	cpSync(from, join(stage, 'extension', item), { recursive: true });
}

// ── 3. [Content_Types].xml
// 必须为 zip 里出现的每种扩展名声明类型，否则严格解析器会拒绝。
const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="map" ContentType="application/json" />
  <Default Extension="css" ContentType="text/css" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="xml" ContentType="text/xml" />
  <Default Extension="txt" ContentType="text/plain" />
</Types>
`;
writeFileSync(join(stage, '[Content_Types].xml'), contentTypes, 'utf8');

// ── 4. extension.vsixmanifest
const esc = (text) =>
	String(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(name)}" Version="${esc(version)}" Publisher="${esc(publisher)}" />
    <DisplayName>${esc(displayName || name)}</DisplayName>
    <Description xml:space="preserve">${esc(description || '')}</Description>
    <Tags>ai,chat,multi-model,llm</Tags>
    <Categories>AI,Chat,Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(engines?.vscode || '*')}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace,ui" />
      <Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="false" />
    </Properties>
    <License>${esc(license || 'MIT')}</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
`;
writeFileSync(join(stage, 'extension.vsixmanifest'), manifest, 'utf8');

// ── 5. 打包成 zip（-X 去掉额外的文件属性，与 vsce 行为一致）
rmSync(vsixPath, { force: true });
execFileSync('zip', ['-r', '-X', '-q', vsixPath, '.'], { cwd: stage });

// ── 6. 清理暂存目录
rmSync(stage, { recursive: true, force: true });

// ── 7. 顺便把「给朋友的安装说明」也放到 dist，方便一起发送
const guideSrc = join(root, 'docs', '给朋友的安装说明.md');
let guideOut = null;
if (existsSync(guideSrc)) {
	guideOut = join(distDir, '安装说明（先看这个）.md');
	cpSync(guideSrc, guideOut);
}

const size = readFileSync(vsixPath).length;
console.log('');
console.log(`已生成：${vsixPath.replace(root + '/', '')}`);
console.log(`大小：  ${(size / 1024).toFixed(0)} KB`);
if (guideOut) {
	console.log(`配套说明：${guideOut.replace(root + '/', '')}`);
}
console.log('');
console.log('把上面两个文件一起发给朋友，他双击 .vsix 即可安装。');
console.log('也可以用命令行：code --install-extension <文件名>.vsix');
