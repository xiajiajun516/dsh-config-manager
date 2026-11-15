# 离线救急台的设计系统（自研阶梯色板 + Carbon/Raycast 保留规范，2026-11）

`dcm web`（离线救急台）是唯一不挂在 DSH GUI 内的界面：服务端直出 HTML、内联脚本、零外链、零构建，
样式全部内联在 `src/cli/web/page.ts` 的 `STYLE` 常量里，CSP 是 `default-src 'none'`（内联脚本按 `sha256` 放行）。
因此它**不消费 `--dsw-*` token、也不进 CSS Modules**（见 `DESIGN.md` §14 救急台条目）。

本文是该界面的**设计系统出处与映射表**：改了 `STYLE` 必须先改这里，反之亦然。

## 1. 出处与只取哪些章节

| 用途 | 出处 | 取了什么 / 为何保留 |
|---|---|---|
| 阶梯底色与双主题语义色 | 自研 AA 阶梯色板（2026-11，Linear/Raycast 式 3 阶中性灰 + 高饱和 Indigo 主色 + WCAG AA 四态语义色） | 取代旧版零差值 `--bg`/`--surface` 与过暗黑底；实测对比度全项 ≥ 5.3:1 |
| 表单字段、按钮尺寸与焦点规范（保留旧 Carbon） | `reference/ibm-DESIGN.md` §3–§4 & §7 | **逐条保留理由**：① 全局 `:focus-visible` 2px `--accent` 描边与输入框 `-2px` 内嵌聚焦（键盘无障碍基线）；② 主按钮 40px 高度 `md` 触控区；③ 无框表面填充 + 底线输入框；④ 句首自然写法表头与 `tabular-nums` 数字列；⑤ 系统字体栈 |
| 明暗两套三阶阶梯逻辑（保留旧 Raycast 思路） | `reference/raycast-DESIGN.md` | **保留理由**：背景 → 卡片 → 填充面三阶逐级拉开，减少边框分割依赖；配合 `1px hairline`（仅页头与表行保留） |

两份旧参照文件只保留上述可用组件纪律；**明确弃用**：Carbon 的「全直角 `border-radius:0` 处方角」（本轮改为 `8px` 卡片 / `6px` 控件）、`#f4f4f4` 同值双面色与满屏卡片 1px 外框。

## 2. 亮色 token（实测对比度对 `--card #ffffff`）

| token | 值 | 用途 / 出处 | 对比度 |
|---|---|---|---|
| `--fg` | `#111318` | 主正文（自研中性碳黑） | **18.58:1** on `--card` |
| `--muted` | `#5a606b` | 次要文案 / 表头 / 路径元数据 | **6.32:1** on `--card` |
| `--bg` | `#f7f7f9` | 页面画布（L = 0.9314） | 页面底 |
| `--card` | `#ffffff` | 卡片主面（L = 1.0000，无需边框即可与 `--bg` 拉开） | 卡片面 |
| `--surface` | `#eef0f4` | 卡片内次级填充面（L = 0.8703：指标格 / 后果块 / 输入框 / 骨架） | 次级面 |
| `--line` | `#e3e5ea` | 极细分隔与次要按钮描边 | 页头 / 表行 |
| `--accent` | `#4b58e0` | 唯一主操作 Indigo | **5.57:1** on `--card` |
| `--accent-hover` | `#3a46c9` | 主色悬停态 | **7.24:1** on `--card` |
| `--on-accent` | `#ffffff` | 主按钮文字 | **5.57:1** on `--accent` / **7.24:1** on hover |
| `--ok` | `#157a53` | 成功 / 可启动语义 | **5.33:1** on `--card` |
| `--warn` | `#8a5d00` | 警告 / 待排查语义 | **5.76:1** on `--card` |
| `--bad` | `#c72a34` | 错误 / 危险语义 | **5.51:1** on `--card` |
| `--scrim` | `rgba(15,17,22,.42)` | 弹窗遮罩与浮层投影 | 遮罩 / 导航下拉 |
| `--radius` | `8px` | 卡片、横幅、弹窗、折叠面板圆角（只在亮色 `:root` 定义） | — |
| `--radius-sm` | `6px` | 按钮、输入框、标签胶囊、导航项、三段流胶囊圆角（只在亮色 `:root`） | — |

## 3. 暗色 token（实测对比度对 `--card #101114`）

| token | 值 | 用途 / 出处 | 对比度 |
|---|---|---|---|
| `--fg` | `#f0f1f4` | 主正文 | **16.72:1** on `--card` |
| `--muted` | `#8d929c` | 次要文案 / 元数据 | **6.05:1** on `--card` |
| `--bg` | `#08090b` | 页面画布（L = 0.0027） | 页面底 |
| `--card` | `#101114` | 卡片主面（L = 0.0056） | 卡片面 |
| `--surface` | `#17181c` | 卡片内次级填充面（L = 0.0092） | 次级面 |
| `--line` | `#23252b` | 极细分隔与次要按钮描边 | 页头 / 表行 |
| `--accent` | `#7b88ff` | 主色提亮版 | **6.12:1** on `--card` |
| `--accent-hover` | `#96a0ff` | 主色悬停态 | **7.88:1** on `--card` |
| `--on-accent` | `#0a0b12` | 主按钮反色文字 | **6.37:1** on `--accent` / **8.20:1** on hover |
| `--ok` | `#4ed6a4` | 成功 / 可启动语义 | **10.32:1** on `--card` |
| `--warn` | `#f0bf6a` | 警告 / 待排查语义 | **11.12:1** on `--card` |
| `--bad` | `#ff7b7b` | 错误 / 危险语义 | **7.53:1** on `--card` |
| `--scrim` | `rgba(0,0,0,.62)` | 弹窗遮罩与浮层投影 | 遮罩 / 导航下拉 |

亮/暗 **13 个颜色 token 名完全一致**（只换值），`--font` / `--mono` / `--radius` / `--radius-sm` **只在亮色 `:root` 定义一次**（暗色不重复，满足 `R3-02`「暗色不得定义亮色没有的 token」）。
R3-02 同时校验两个暗色块（`@media (prefers-color-scheme:dark)` 与 `:root[data-theme="dark"]`）逐字相同，且全表对均 ≥ 4.5:1 AA。

## 4. 排版、间距标尺与降噪规则

- **4 档字号（行高 1.5–1.55）**：`20px`（品牌 / 首屏启动结论）、`15px`（`h2` / 动作标题 / 横幅标题）、`13px`（正文 / 表格 / 表单 / 按钮 / 副作用说明）、`12px`（次要信息 `.sub`/`.kv`/`th`/`footer`/`.monoMeta`/`code` 降为辅助灰色）。
- **6 档统一间距**：全部 `margin`/`padding`/`gap` 取自 `4 / 8 / 12 / 16 / 24 / 32px`。
- **双档圆角统一**：卡片、横幅、弹窗、折叠区统一 `var(--radius)`（`8px`）；按钮、输入框、导航项、三段流步、徽章统一 `var(--radius-sm)`（`6px`），零直角与圆角混排（仅 `.btnSpinner` 为 `50%` 圆形）。
- **层次靠阶梯与留白，减少分隔线**：取消 `section.card`、`.actionCard`、`footer`、`.themeSwitch`、`.themeBtn`、`.skeletonCard` 的全部外框 `border`，纯分隔用途边框只保留 **`header.top` 底线**与**表格 `th,td` 行底线**两处；`.banner` 与 `.gateCard` 改用左侧内嵌 `box-shadow: inset 4px 0 0`。
- **同屏唯一主色**：每屏至多 1 个 `.btnPrimary`，首页首屏第 1 建议动作使用 `.btnPrimary`，其余建议与多项目列表的后续操作一律降为 `.btnPlain` 或 `.btnDanger`。
- **处境分组与首屏收束**：页头导航从平铺 8 项收成 3 个顶层组（`状态总览` / `救援动作` / `检查`，仍全部从 `CONSOLE_PAGE_NAV` 派生）；首页首屏只答「DSH 现在能不能起」+ 最多 3 张带「什么情况下点它」的建议动作卡，能力边界 / 快照备份 / 路径细节折入第二屏 `<details class="foldCard">`。
- **操作三阶段与加载动效**：写操作页渲染 `① 预览与前置检查 → ② 显式确认 → ③ 执行结果` 步进条，结果页按 `ok`/`bad` 分色；表单提交注入 `.btnSpinner` + `执行中…`，页面切换走 CSS `@view-transition{navigation:auto}`，折叠展开 `180ms` 渐显；开 `prefers-reduced-motion: reduce` 时关停一切动画与位移；禁用 JS 时主题切换与复制按钮隐藏，`<details open>` 表单照常可提交。
- **390px 窄屏响应**：`@media (max-width:480px)` 下收紧边距为 `16px`、下拉导航展开为静态块、表格允许横向滚动、输入框全宽不溢出。

## 5. 偏离记录（每条都要有理由）

1. **弃用 Carbon 零圆角与全卡片线框**：平铺 1px 灰框配合同值 `--bg`/`--surface` 会制造视觉栅格噪音（改前 `STYLE` 含 29 处 `border` 字符串）；改用明确三阶灰背景差 + `8px/6px` 圆角后，全表纯分隔 `border` 降至 2 处。
2. **危险按钮保持描边红（`.btnDanger`）**：避免与主操作同屏双实心按钮抢层级，并保留实心红/背景淡红给 `.banner.bad` 状态警示。
3. **保留渐进增强骨架与 CSS 过渡**：用无脚本 `.skeleton`（2.4s 自动退出，`prefers-reduced-motion` 下不渲染动画）与 CSS `@view-transition` / `.btnSpinner` 提供加载反馈，在满足零外链/零构建/无 JS 可用的同时不阻塞表单。

## 6. 顺手修掉的三个既有缺陷

1. **暗色弹窗遮罩反了**：旧版 `::backdrop{background:color-mix(in srgb,var(--fg) 45%,transparent)}` —— 暗色下 `--fg` 是近白色，
   遮罩变成「白纱」（越糊越亮）。改由 `--scrim` 提供（亮色深灰 45% / 暗色黑 60%）。
2. **完全没有焦点样式**：键盘用户看不见自己在哪。补全局 `:focus-visible`。
3. **主按钮文字色写死 `#fff`**：暗色下 `--accent` 是浅蓝 `#79a9f0`，白字对比度只有 **2.2:1**（不可读）。
   改由 `--on-accent` 供给（亮色白 / 暗色近黑），暗色按钮拿到 9.70:1。

## 7. 验证与守卫

- `web.test.ts` **R3-01**（既有）：零外链 —— 无 `<link>`、无 `http(s)://`，动画与骨架全在内联 `STYLE` 里。
- `web.test.ts` **R3-02**（本次新增）：亮/暗 token 集合相等；每个 `var(--x)` 都有定义；
  `STYLE` 里无 `@import` / `@font-face` / `url(http`；并按「fg/muted/accent/ok/warn/bad 对 card、on-accent 对 accent」
  逐对断言对比度 ≥ 4.5（两套配色各一遍）。想「恢复」IBM 那个更好看的绿 `#24a148` 会先把这条测试打红。
- 机械校验：`node --test src/cli/web/web.test.ts`、`npm run typecheck`。
- **未覆盖**：真实浏览器里的观感（明暗两套 × 8 个页签）没有自动化手段，交付时应在 `dcm web` 里各看一眼。

## 8. 三态主题（自动 / 浅色 / 深色）

### 8.1 三态语义与 CSS 结构

| 模式 | `<html>` 状态 | 取值来源 |
|---|---|---|
| 自动（默认） | 无 `data-theme` 或 `data-theme="auto"` | `prefers-color-scheme`，跟随系统 |
| 浅色 | `data-theme="light"` | 强制浅色，**系统是暗色也要浅** |
| 深色 | `data-theme="dark"` | 强制深色，**系统是浅色也要深** |

`STYLE` 里对应三条规则（**暗色 token 写两次是刻意的**）：

```css
:root{ …亮色 token…; color-scheme:light dark }                                   /* 基础 = 浅色 */
@media (prefers-color-scheme:dark){ :root:not([data-theme="light"]){ …暗色 token… } }  /* 自动 / 深色跟随系统 */
:root[data-theme="dark"]{ …暗色 token… }                                       /* 强制深色（系统浅色也生效） */
:root[data-theme="dark"]{ color-scheme:dark }  :root[data-theme="light"]{ color-scheme:light }
```

两个暗色块**必须逐字相同** —— 它们唯一的区别是「什么时候生效」。R3-02 直接 `assert.equal(darkForced, darkMedia)`，
所以复制粘贴之后忘了同步会被测试拦下，而不是变成两套慢慢分叉的暗色。

`color-scheme` 必须跟着主题走：系统是暗色、用户强制浅色时，若不同步改 `color-scheme`，
输入框、下拉、滚动条这些**原生控件仍然是暗的**（页面对了、控件不对）。

### 8.2 载体 = cookie（不是 storage）

- 键名 `dcm-theme`，值 ∈ `auto|light|dark`，`path=/; max-age=31536000; SameSite=Lax`，**非敏感**（不含密钥、路径、任何用户数据）。
- **为什么不用 storage**：救急台每次启动换随机端口，`localStorage`/`sessionStorage` 按 origin（含端口）隔离 ——
  只有 **cookie 不区分端口**，能跨次记住；另外 `web.test.ts` 的 R1-01 明确禁止本脚本使用 `localStorage`（载体纪律）。
- cookie 被禁用时**静默降级**：写入无效 → 本次点选有效、下次回到自动。不报错、不阻断任何操作。
- 服务端**不读**这个 cookie：主题完全在客户端决定（救急台的服务端仍然只按目录事实渲染）。

### 8.3 首帧之前生效（无闪色）

脚本从 `<body>` 末尾移到 `<head>`（紧跟 `<style>`）：`data-theme` 必须在首次绘制前落到 `<html>` 上，
否则用户选了强制浅色、系统是暗色时，每次导航都会先闪一下暗色。
脚本自身不依赖这一改动：它所有的 DOM 操作（状态恢复、`<details>` 升级、开关选中态）本来就等在 `DOMContentLoaded`，
在 `<head>` 执行只做两件不读 DOM 的事 —— 读 cookie、设 `data-theme`。

### 8.4 无脚本降级：整组隐藏，而不是给个点不动的控件

```css
.themeSwitch{display:none}                          /* 默认隐藏 */
:root[data-dcm-js="1"] .themeSwitch{display:inline-flex}   /* 脚本第一件事就是设这个标记 */
```

禁用 JS 时：开关**不出现**，页面回落到「自动跟随系统」= 本次改造之前的行为（媒体查询那条规则照常生效）。
仍然兑现救急台的既有承诺「禁用 JS 时功能与今天完全一致」—— 主题开关是增强，不是功能依赖。
403/404 的极简页（`renderMessagePage`）继续不内联任何脚本，也不含开关（R2-02 / R3-03 双守卫）。

### 8.5 界面形态

页头品牌行右侧的三方按钮（`自动 | 浅色 | 深色`），处方角、1px hairline、选中态用 `--surface` 填充 + `--fg` 文字，
`aria-pressed` 表达选中（读屏可读），`role="group"` + `aria-label="配色"` 给出组语义。
—— 这是本页**新增的 pattern**（Carbon 的 §4 没有分段控件），按 `DESIGN.md` 的 Missing Design Rule 在此登记。

### 8.6 守卫（R3-03）

三态按钮直出且 `type="button"`（不提交表单）· 开关默认 `display:none` 且只在 `data-dcm-js` 下显示 ·
脚本排在 `<body>` 之前 · 主题走 `document.cookie` 且键名 `dcm-theme` · 不用 `localStorage` ·
媒体查询块排除 `[data-theme="light"]` · 两条 `color-scheme` 规则在场 · 403 极简页无脚本无开关。

## 9. 本次不动的东西

- HTML 结构、类名、服务端渲染逻辑、路由、CSP、`client-script.ts` 一律未动（只动 `page.ts` 的 `STYLE` 与文件头注释）。
- DSH 插件 UI（`src/client/`，走 `--dsw-*` + CSS Modules）是另一套系统，未被本次改动触及。
- 没有新增依赖、字体、图标或构建步骤。
