# UI / 设计系统 —— 证据与取证方法

> 规则（必须/绝不 + 判据）在 `AGENTS.md` §🎨 与 `DESIGN.md`（UI 唯一权威）；本文件只放「为什么」与可复现的取数方法。

## DSH 原生设计资源的取证方法（2026-10-17 对齐原生的取数口径）

DSH 桌面版把宿主前端整包放在 `<install>/resources/app.asar`。**asar 不是目录**，用下面的最小解析器即可读出任意文件
（头部 16 字节里第 12 字节起 4 字节是 JSON 目录长度），不需要装 `asar`：

```js
// .tmp/dshui-extract2.mjs（工作区临时脚本，勿入库）
const fd = fs.openSync('D:/Apps/DSH/resources/app.asar', 'r');
const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0);
const n = head.readUInt32LE(12);                    // JSON 目录长度
const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, 16);
const dir = JSON.parse(buf.toString('utf8'));       // { files: { ... } } 树
// 逐段下钻 files 拿 { offset, size }；文件内容从 (16 + n + offset) 开始读 size 字节
```

本次取到的三份「原生事实」：

| 产物 | 内容 | 用途 |
|---|---|---|
| `@deepseek-ai/dsh-client-ui-theme/lib/client.js` | **411 个 `--dsw-*` 定义**（`body` 亮色 / `body[data-ds-dark-theme]` 暗色）+ 全局 `:focus-visible` 规则 + 全局滚动条规则 + `@supports` 下的 `*` 级 `corner-shape: superellipse(1.5)` | 校验插件引用的每个 token 是否存在、是否随主题翻转 |
| `@deepseek-ai/dsh-client-ui-primitives/lib/*.module.css` | 原生组件的**真实规格**（Button 36/28px、Input 32-34px、Menu item、Tag tone、Tooltip、Modal、Toast、StateDot、SegmentedControl…） | 组件级「逐值对齐」的取值来源 |
| `@deepseek-ai/dsh-client-ui-primitives/lib/index.js` | 原生组件导出（`Tag`/`Pill`/`StateDot`/`Switch`/`Button`/`Tooltip`…） | 判断哪些组件可以直接复用（帧内惰取 + 回落） |

**核对 token 的存在性必须逐条比对，不能凭命名猜**。本次方法：从主题产物里抽取 `--[a-z-]+(?=\s*:)` 得定义集，
再从插件 CSS 抽取 `var(\((?:--dsw|--dsh)-…\)` 得引用集，做差。

## 坑：DSH **没有** `--dsw-alias-state-info-primary`

2026-10-17 用上面的差集发现：插件引用的 59 个 token 里，`--cm-info` 指向的 `--dsw-alias-state-info-primary`
**在 411 个原生定义里根本不存在**（原生状态色只有 business / success / warn / error / idle）。

后果不是「编译报错」，而是**静默失效**：自定义属性值无效 ⇒ 消费点（任务面板底色、状态点、行首色条）
在 computed-value 阶段整条声明作废，退化 `unset`/继承色 —— 用户看到的只是「这里没有蓝色」，没有任何报错，
typecheck / 构建 / 字号·间距守卫全绿。

判据与修法：
- **凡新增 `--cm-*` 定义行，都要能指出它引用的 `--dsw-*` 来自 411 个定义集里的哪一个**（差集为空才算通过）；
- 语义别名优先（本仓 `--cm-info` 接到 `--cm-accent`，因为原生 Tag 的 info tone 用的就是 business 主色）；
- 守卫 `css-token-guard.test.ts` 的受约束 token 表**不得**收录原生不存在的名字（本次已移除该条）。

## 已知的、刻意保留的偏离

| 项 | 原生 | 本插件 | 理由 |
|---|---|---|---|
| 正文字号 | 13px（`--dsw-font-xs-13`） | **12.5px** | 画布 564×720、高密度表格与清单需更密半档；例外逐条登记在 `css-scale-guard.test.ts` 的 `FONT_TOKEN_EXCEPTIONS` |
| 弹窗圆角 | `radius-panel` 28px | `radius-lg` 16px（= MenuSurface） | 本插件弹窗是**设置面板内**的嵌套弹层，28px 是顶层模态的档 |
| Tooltip 内边距/字号 | 3px 7px / 13px | 8px 10px / 12px | 这里装多行机制说明（1–3 段），原生一行短提示的内边距会挤成一团 |

## 视觉核验方法（无真机安装时的替代）

改 UI 但**不能重启 DSH / 不能重装档案**时（插件改动要重启才生效，而重启会杀掉当前会话），
用「编译产物 + 原生主题 CSS + 手写标记」在浏览器里做**取证级冒烟**：

1. `npm run build` 后从 `lib/client.js` 抽出内联的 `const css = "…"`（CSS Modules 已编译、类名带 hash）；
2. 从 asar 抽出主题 CSS（含 `data-ds-dark-theme` 那一支）；
3. 拼一个静态页：主题 CSS + 原生 `Tag.module.css` + 插件 CSS + 用**真实 hash 类名**写的代表性标记，
   分别以带/不带 `data-ds-dark-theme` 的 `body` 各渲染一次；
4. 用浏览器工具截图，肉眼核验两个主题下的按钮 / 徽章 / 横幅 / 状态点 / 表格 / 通知 / 弹窗 / 提示气泡。

**能证明什么**：token 链真的解析（不是 invalid 值）、两个主题都翻转、文字与底色对比度可读、控件盒模型正常。
**不能证明什么**：真实 React 树的分页交互、溢出行情、Portal/层叠顺序 —— 那些必须在真机上再看一遍。
`file://` 直开会报 `Navigating to local URL is not allowed`，需起一个本地 http 服务。
