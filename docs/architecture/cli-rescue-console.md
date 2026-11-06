# 离线救急台的设计系统（IBM Carbon + Raycast，2026-10）

`dcm web`（离线救急台）是唯一不挂在 DSH GUI 内的界面：服务端直出 HTML、零脚本、零外链、零构建，
样式全部内联在 `src/cli/web/page.ts` 的 `STYLE` 常量里，CSP 是 `default-src 'none'`。
因此它**不消费 `--dsw-*` token、也不进 CSS Modules**（见 `DESIGN.md` §4 的救急台条目）。

本文是该界面的**设计系统出处与映射表**：改了 `STYLE` 必须先改这里，反之亦然。

## 1. 出处与只取哪些章节

| 用途 | 出处 | 取了什么 |
|---|---|---|
| 亮色主体 | `reference/ibm-DESIGN.md`（IBM Carbon 分析） | §2 Colors（语义四色 / surface 画布 / hairline）、§3 Typography 的 12–18px 档、§4 Components 的 Buttons / Inputs & Forms / Cards、§5 Spacing System 的 4–48 阶、§7 Do's and Don'ts |
| 暗色 | `reference/raycast-DESIGN.md` | `canvas #07080a → surface #0d0d0d → surface-card #121212` 的 surface 阶梯、`hairline #242728`、`accent-blue/green/yellow/red` 四个语义 accent |

两份原文件按 MIT 逐字保存（只读参考，**不得当作可执行规范直接照抄**——它们是营销页面分析，含大量本页用不到的 hero / 摄影 / display 排版）。

**明确不取**：IBM 的 display 档（42–76px 轻字重）、页脚反色块、摄影几何；Raycast 的红色渐条 hero、Inter 的 ss03 字型特性；
两者的 `spacing.section`（88–96px 营销节奏）；任何自定义字体（`@font-face` 会被 CSP 与「零外链」承诺同时否掉）。

## 2. 亮色 token（IBM Carbon 语义）

| token | 值 | Carbon 出处 | 对比度（对底色） |
|---|---|---|---|
| `--fg` | `#161616` | `ink` | 18.10:1 on `--card` |
| `--muted` | `#525252` | `ink-muted` | 7.81:1 on `--card` |
| `--bg` | `#f4f4f4` | `surface-1` | 页面底 |
| `--card` | `#fff` | `canvas` | 卡片面 |
| `--surface` | `#f4f4f4` | `surface-1` | 填充：chip / 表单字段 / `.consequence` / 骨架 |
| `--line` | `#e0e0e0` | `hairline` | 1px 分隔 |
| `--accent` | `#0f62fe` | `primary`（IBM Blue） | 5.00:1 |
| `--accent-hover` | `#0043ce` | blue-70（Carbon 的 pressed 档） | 7.79:1 |
| `--on-accent` | `#fff` | `on-primary` | 5.00:1 on `--accent` |
| `--ok` | `#198038` | green-60（**不是** `semantic-success` #24a148） | 5.02:1 |
| `--warn` | `#8e6a00` | yellow-60 加深（**不是** `semantic-warning` #f1c21b） | 4.99:1 |
| `--bad` | `#da1e28` | `semantic-error` / red-60 | 5.00:1 |
| `--scrim` | `rgba(22,22,22,.45)` | 自定 | 弹窗遮罩 |

## 3. 暗色 token（Raycast 阶梯）

| token | 值 | Raycast 出处 | 对比度（对底色） |
|---|---|---|---|
| `--fg` | `#f4f4f6` | `ink` | 17.69:1 on `--card` |
| `--muted` | `#9c9c9d` | `mute` | 7.09:1 on `--card` |
| `--bg` | `#07080a` | `canvas` | 页面底 |
| `--card` | `#0d0d0d` | `surface` | 卡片面 |
| `--surface` | `#121212` | `surface-card` | 填充 |
| `--line` | `#242728` | `hairline` | 1px 分隔 |
| `--accent` | `#57c1ff` | `accent-blue` | 9.70:1 |
| `--accent-hover` | `#8ad3ff` | 由 `accent-blue` 提亮 | 11.89:1 on `--card` |
| `--on-accent` | `#0a0a0a` | 极性反转 | 9.70:1 on `--accent` |
| `--ok` | `#59d499` | `accent-green` | 10.46:1 |
| `--warn` | `#ffc533` | `accent-yellow` | 12.30:1 |
| `--bad` | `#ff6161` | `accent-red` | 6.60:1 |
| `--scrim` | `rgba(0,0,0,.6)` | 自定 | 弹窗遮罩 |

亮/暗 **颜色 token 名完全一致**（只换值），所以 `STYLE` 里只写一套规则、靠 `prefers-color-scheme` 换值；
`--font` / `--mono` 是两套共用的字体栈，**只在亮色块里定义一次**（暗色不重复）。
R3-02 断言的就是这条：亮色是 token 全集、暗色不得定义亮色没有的名字、且 13 个颜色 token 必须逐个覆盖，
每个 `var(--x)` 都要有定义。

## 4. 排版与间距标尺

- **正文 14px / 行高 1.6 / `letter-spacing:.16px`**：字号与字距来自 Carbon（`body-sm` + Carbon 的 0.16px 精度细节），
  但**行高按 1.6 上调** —— Carbon 的 1.29 是给拉丁文的，中文会挤在一起。
- 分区标题 `h2` 16px/600；品牌 18px/600；caption 档（`.sub`/`.kv`/`.chip`/`.gatePath`/`th`）12px；行内 `code` 用 `.9em` 跟随上下文。
- 表格：`th` 12px/600/`letter-spacing:.32px`（**句首大写、不做全大写** —— Carbon 的 do/don't），`td` 14px；数字列 `tabular-nums`。
- 按钮：14px/600、高 **40px**（Carbon 的 md 档）、`padding:0 16px`。
- 间距只用 Carbon 阶 **4 / 8 / 12 / 16 / 24 / 32 / 48**：卡片内边距 16、块间距 24、`main` 24、网格 gap `8×24`（`.grid`）与 16（`.actions`）。
- **处方角**：全表无 `border-radius`（Carbon 的「半径为 0 才是品牌」），胶囊 chip / `.cov` 一并改方。
- **层级只用 surface 变化 + 1px hairline，无阴影**（Carbon）。
- **焦点可见**：全局 `:focus-visible` 2px `--accent` 描边；表单字段用 `outline-offset:-2px` 内嵌（Carbon 的输入框聚焦形态）。
- 字体：`--font` 是系统栈 + 中文族（`PingFang SC` / `Hiragino Sans GB` / `Microsoft YaHei` / `Noto Sans SC`），`--mono` 是系统等宽栈。
  IBM 的 §Note on Font Substitutes 允许替换字族；本页**不允许任何外链**，所以只继承字号阶 / 字重 / 字距，不继承字族。

## 5. 偏离记录（每条都要有理由）

1. **危险按钮不用 Carbon 的实心红**（保留描边红 + 悬停 12% 红底）：救急台的破坏性按钮常与主操作成对出现（实例卡里的「启动 / 停止」），
   双实心按钮会互相抢层级；而且红色在本页已被 `banner.bad` 与 `.sev` 占为**状态**语义，实心红会把「状态」和「动作」混为一谈。
   整页本就危险的重装页已有 `banner bad` 起头，不需要按钮再喊一遍。
2. **不受 Carbon「不要加粗标题」的约束**：那条针对 42px+ 的 display headline（Plex 300）。救急台不存在 display 排版，
   `h2` 是 productive 层级的 16px/600，属 Carbon 的 body-emphasis 家族。
3. **保留入场动画与骨架屏**（IBM 未定义动效）：这是本页既有的**无脚本渐进增强**（禁用 JS 时骨架层同样存在、2.4s 后由 CSS 自己隐藏），
   属功能而非装饰。只删掉 active 态的 `translateY(1px)`（与扁平处方角不一致），并保留 `prefers-reduced-motion` 全局闸门。
4. **`.chip` / `.cov` 从胶囊改方**：Carbon 明令禁止 pill，圆角也会破坏整页的处方角语言。

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
