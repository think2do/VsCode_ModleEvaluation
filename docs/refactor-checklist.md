# 重构回归清单

重构期间**每改一处 UI / 交互逻辑**，都手工过一遍这个清单。
这里列的每一条都是实际踩过坑之后固化下来的，删掉任何一条都等于把坑重挖一遍。

自动化能覆盖的部分先跑：

```bash
npm run compile   # tsc -b 必须无错（同时编扩展侧与 Webview 侧）
npm test          # markdown.js 的 70 项 + 纯逻辑的 52 项（共 122 项）
```

前端（`webview/`）目前**没有 DOM 测试环境**（上 jsdom 会违反「零下载」约定），
所以下面这些只能手工验证。最快的验证方式是浏览器预览页：

```bash
python3 -m http.server 8000     # 在仓库根目录
# 浏览器打开 http://localhost:8000/scripts/preview.html
```

> ⚠️ 不能直接双击 `preview.html`：前端是原生 ESM，`file://` 下会被 CORS 拒掉。
> 预览页用的是与真实 Webview 一致的 CSP，所以它也能验证 CSP 下的加载行为。

---

## 1. 展示状态（最容易改坏的地方）

**不变量：展示状态只有一个真相源 —— 每轮的 `turn.view`（`state.turnViews`）。**
历史教训：曾经同时存在全局 `state.compare` / `state.focusKey` 和每轮 `turn.view`，
两份状态各被读一半，导致悬浮条上的控件点了完全没反应（详见 commit `fix(ui): 统一并排对比状态`）。

- [ ] 悬浮条左侧复选框 → 真的进入并排布局（不只是打个钩）
- [ ] 点悬浮条卡片正文 → 真的切换显示的模型（不只是移动高亮）
- [ ] 点卡片标题栏的模型名 → 只作用于**它自己那一轮**，退出并排、单读它
- [ ] 点某轮的选项卡 → 切换**那一轮**的显示，且该轮的并排复选框同步取消勾选
- [ ] 单读与并排互斥：进单读会清掉该轮的并排勾选
- [ ] 并排时某模型本轮未参与 → 该轮出现虚线占位格，且各格按模型列表顺序排列
- [ ] 每一轮的展示设置互相独立，改第 1 轮不影响第 3 轮
- [ ] 切换会话后，展示状态从该会话自己的 `turn.view` 重建，不带入上一个会话的看法
- [ ] 新的一轮会继承上一轮的看法（并排仍有勾选）
- [ ] 最新一轮没问过当前聚焦的模型时，自动切到本轮问过的第一个（否则只剩一句「本轮未向 X 提问」）

### `applyVisibility()` 的同步义务

改这个函数时，**所有**派生 UI 都要跟着刷新，漏一处就会出现
「要点两下才有反应」这类问题（曾经就漏了 `.tab-check` 的 `checked`）：

- [ ] `.cards` / `.turn` 的 `.tile` 类
- [ ] 每张 `.card` 的 `.hidden` / `.tile`
- [ ] `.tab` 的 `.on` 类 **和** `.tab-check` 的 `checked`
- [ ] `.tile-missing` 占位格的增删
- [ ] `.pane-missing` 的显隐
- [ ] `renderStripActive()` 里的 active / off / comparing / checked / disabled

---

## 2. 两种勾选语义不能混

| 控件 | 作用 | 影响 |
|---|---|---|
| 悬浮条右侧开关 | 是否**参与提问** | 决定请求发给谁（`state.selected` → `selectModels`） |
| 悬浮条左侧复选框 / 选项卡复选框 | 是否**并排展示** | 只影响怎么看（`turn.view.compare`） |

- [ ] 关掉右侧开关后，该模型已有的回答**仍能点开看**（只是不再问它）
- [ ] 左侧复选框在空会话（还没有任何回答）时置灰
- [ ] 右侧开关关掉的模型，卡片内容变淡但开关本身保持清晰可点

---

## 3. 多轮与会话

- [ ] 并发流式：多个模型同时输出，互不干扰
- [ ] 单模型失败 / 取消 → **不污染**其它模型的上下文（每个模型只回放自己答完的轮次）
- [ ] 状态点区分：等待中（`pending`）、生成中（`streaming`）、完成（`done`）、失败（`error`）、已取消（`cancelled`）
- [ ] 完成时显示耗时（`已用 x.xs`）
- [ ] 单条「重新生成」只对最新一轮可用
- [ ] 停止按钮能中断所有进行中的请求
- [ ] 历史侧栏两段式删除（先点成「确认」，再点才真删）
- [ ] 复制按钮复制的是 **Markdown 原文**（不是渲染后的 HTML）
- [ ] 新建会话保留当前勾选的模型

---

## 4. 编辑提问（仅最新一轮）

- [ ] 「编辑」按钮**只在最新一轮**出现，生成中禁用
- [ ] 「编辑」按钮常驻低对比度、可点击（**不要**用 hover 隐藏 + `pointer-events:none`，会导致点不到）
- [ ] 仅保存 / 保存并重新生成 / 取消（Esc）三个出口都正常
- [ ] Cmd/Ctrl + 回车 = 保存并重新生成
- [ ] 编辑期间**不能重建卡片**，否则 textarea 会被顶掉
- [ ] 内容没变时不写盘（避免空点「保存」也刷新时间）
- [ ] 该轮是共享上下文来源时，编辑会先摘掉上下文引用
- [ ] 扩展侧回推的 `contextSource` 必须是 `null` 而非 `undefined`（postMessage 会丢掉 undefined 字段）

---

## 5. 图片

- [ ] 粘贴与拖入都能加图，上限 4 张 / 单张 ≤ 20MB
- [ ] 点缩略图放大（webview 里 `window.open` 被拦截，用的是自绘遮罩层）
- [ ] Esc 关图片预览优先于取消编辑
- [ ] 明确不支持图片的模型 → 直接降级为纯文本并提示「该模型不支持图片，本次已仅发送文本」
- [ ] **无法判断**是否支持图片的模型 → 带图试一次，失败后**去掉图片重试一次**
- [ ] 某个模型此前丢过图片，历史轮次里也不要再给它发图片（否则每轮都白失败一次）
- [ ] 纯图片消息也要带一个非空文本部分（部分端点不接受空文本）

---

## 6. 设置与模型来源

- [ ] `preferredVendors` 默认 `["customendpoint"]` + `onlyPreferredVendors` 默认 `true` → 默认只列自己添加的模型
- [ ] 白名单落空时**临时显示全部**并明确提示（宁可退让也不让界面变空）
- [ ] `this.models` 必须与界面上可见的模型严格一致，否则 `handleSend` 算出的 targets 与用户所见不符
- [ ] `maxSelectedModels` 截断时要告知用户被截断了
- [ ] 隐藏即不可选：不可见的模型要从勾选列表里移除（防止「看不见但仍在偷偷参与对比」）

---

## 7. 安全

- [ ] 模型返回的 `<script>` / `<img onerror>` 被转义，不当标签执行（`npm test` 已覆盖各位置）
- [ ] `javascript:` / `data:` 链接被拒绝
- [ ] 回答里的链接由 `handleOpenLink` 交给系统浏览器，且**只放行** `https?://` 与 `mailto:`
- [ ] 图片文件名走 `path.basename()` 防目录穿越
- [ ] CSP 里 `script-src` 用 nonce（改 `buildHtml` 时别把它弄丢）

---

## 8. 约定（不要无意中打破）

- [ ] **零构建步骤**：纯 `tsc` + 原生 JS/CSS，不引入运行时依赖
- [ ] **零下载原则**：打包 / 安装脚本不依赖 `vsce`、不装 npm 依赖
- [ ] UI 只跟随 VS Code 主题变量（`--vscode-*`），不写死颜色
- [ ] 中文注释、中文 UI 文案
- [ ] 打包只含 `package.json` / `out` / `media` / `README.md` / `LICENSE`；
      `scripts/package-vsix.mjs` 与 `install-local.mjs` 里的 `INCLUDE` 是硬编码的，
      新增运行期目录记得同步改这两处
- [ ] **不要重新引入 `.vscodeignore`**：打包走的是白名单（上面那条），没有任何脚本
      读它。v0.9.0 之前它一直是一份「写着却从不生效」的死配置，容易误导人

---

## 9. Webview 的模块系统（v0.9.0 起）

前端源码在 `webview/`（TypeScript），编译成**浏览器原生 ESM** 到 `media/dist/webview/`。
没有打包器，所以有几条硬性约束：

- [ ] **import 路径必须带 `.js` 后缀**（浏览器不认隐式后缀）。
      这一条由 `tsconfig.webview.json` 里的 `module: NodeNext` +
      `webview/package.json` 的 `"type": "module"` 强制，编译器会报错拦住。
- [ ] **`media/markdown.js` 不要改成 ESM**：`scripts/smoke-render.mjs` 用 Node 的
      `require()` 加载它跑 70 项断言。它是普通脚本，挂在 `window.MarkdownRenderer` 上。
- [ ] **`acquireVsCodeApi()` 只能调用一次**：只允许在 `webview/host.ts` 里调，
      其它模块一律用 `host.ts` 导出的 `post()`。
- [ ] **CSP 不能只写 nonce 却去掉 `'strict-dynamic'`**（或在没有实测的情况下改动它）：
      见 `src/webview/html.ts` 里的注释 —— 模块导入会继承入口脚本的 nonce，
      但 `'strict-dynamic'` 把这个信任模型写成了显式的。改完必须用
      `scripts/preview.html`（与真实 CSP 一致）实测。
- [ ] **`media/dist/` 是产物**，已 gitignore；改代码请改 `webview/`，不要手改产物。

### 前端回归可以自动化的部分

`scripts/preview.html` 已经 mock 了 `acquireVsCodeApi`，并且会在收到 `ready` 后
下发演示数据，所以可以用浏览器自动化（如 Playwright）驱动它跑关键交互：
点悬浮条复选框 → 检查 `.turn.tile`、点卡片名退出并排 → 检查 `.tab-check` 同步、
发消息 → 检查 `window.__sent` 里的报文。比人眼点一遍可靠得多。

### 纯 CSS 重构：用 computed style 全量对比验证等价

改样式但又不想改观感时，别靠肉眼看——把旧版 CSS 也加载起来，逐元素逐属性比对：

```bash
git show HEAD:media/style.css > scripts/_old-style.css
sed 's|\.\./media/style\.css|_old-style.css|' scripts/preview.html > scripts/_cmp-old.html
python3 -m http.server 8000
```

然后用浏览器自动化在**两个页面**上遍历 DOM（`#app` 下每个元素，键写成 tag + 索引路径），
对每个元素取一组 computed style（宽度 / 内外边距 / display / 颜色 / 字号 / flex / gap 等），
两边做 diff。**单读模式与并排模式都要跑** —— 并排模式覆盖了一大批 `.turn.tile` 下的覆盖规则。

这一招能抳到肉眼看不出来的回归。实际就靠它抳出过一个自作主张的改动：
把 `.turn.tile .tabbar` 也设成了 `display: none`（原行为是只隐藏 `.answers-label`，
选项卡要留着让人能退出并排）。

> 如果 diff 出现极小的颜色差（如 `oklab(...)` 小数点后几位），先怀疑采样时机：
> 带 `transition` 的属性在点击后可能还在过渡中，加个 `waitForTimeout` 再取。

