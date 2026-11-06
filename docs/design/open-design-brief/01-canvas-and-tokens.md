# 01 · 画布与 token 表

> 唯一权威是仓库根 `DESIGN.md` 与 `src/client/config-manager.module.css` 的 token 定义块（css 第 65–185 行）。
> 本文是给 OpenDesign 的**可换算摘要**：它给出任何字面量，我们必须能在这张表里找到落地位置，找不到就是需要**新增 token**（要写进 DESIGN.md）。

## 1 画布

| 项 | 值 | 说明 |
| --- | --- | --- |
| 可用宽度 | 564 px | 宿主弹窗 800 减左侧导航 188 与内边距 |
| 可用高度 | 720 px | 同上 |
| 页面骨架 | `viewBody` = flex column，间距 `--cm-sp-4`(8) / `--cm-sp-5`(10) | 四页共用 |
| 滚动 | 只有列表/表格区域自身内滚 | 整页不滚 |

## 2 字体

- 家族：**只跟随宿主** `--dsw-font-family`，实际为等宽栈 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`（无网络字体）。
- 等宽专用：文件名、路径、大小、时间戳 → `.mono` 类。
- 字号 4 档（+`--cm-fs-card` 为生态里少数卡片标题的档位）：

| token | 值 | 用途 |
| --- | --- | --- |
| `--cm-fs-meta` | 11px | 元信息、徽章、列头 |
| `--cm-fs-table` | 12px | 表格行、列表副行 |
| `--cm-fs-base` | 12.5px | 正文（**刻意比原生最小正文 13px 密半档**，因画布窄） |
| `--cm-fs-title` | 13px | 区块标题 / 页面标题 |

行高 2 档：`1.25`（标题、表格行）/ `1.5`（正文）。

## 3 间距 / 圆角 / 控件高

- 间距 9 档：`sp-1` 2 · `sp-2` 4 · `sp-3` 6 · `sp-4` 8 · `sp-5` 10 · `sp-6` 12 · `sp-7` 14 · `sp-8` 16 · `sp-9` 24（px）。
- 圆角 5 档（按角色挑，不是按大小随便挑）：`r-1` 4（小标记）· `r-2` 8（紧凑控件）· `r-3` 12（行/卡/输入）· `r-surface` 16（浮层）· `r-pill` 999。
- 控件高 3 档：`h-sm` 24 · `h-md` 28 · `h-lg` 32。

## 4 颜色：三层单向依赖

```
宿主 --dsw-*  →  --cm-*  →  组件规则
```

- `--dsw-*` **只允许出现在 `--cm-*` 的定义行**；组件里写 `var(--dsw-*)` 直接违规（守卫 `src/client/css-token-guard.test.ts` 会红）。
- 每处 `var(--dsw-*)` 必须带兜底值（老宿主没有新 token 时不能失效成 `unset`）。
- 派生色一律 `color-mix(in srgb, var(--cm-*) <pct>%, transparent)`，禁止手写半透明 hex。
- token 必须定义在 `body`（不是 `:root`/`.section`），否则 Portal 到 body 的弹窗拿不到。

### 语义色（组件真正能用的）

| token | 来源 | 语义 |
| --- | --- | --- |
| `--cm-text-1` / `-2` / `-3` | `--dsw-alias-label-primary/secondary/tertiary` | 三级文字 |
| `--cm-text-on-accent` | `--dsw-alias-label-primary-foreground` | 主色上的文字 |
| `--cm-surface-1` / `-2` | `--dsw-alias-bg-layer-1/2` | 页面底 / 卡面 |
| `--cm-surface-hover` / `--cm-hover` / `--cm-active` | `--dsw-alias-interactive-bg-*` | 交互态 |
| `--cm-line-1` / `-2` | `--dsw-alias-border-l1/l2` | 1px 分割线 / 强调边 |
| `--cm-input-bg` | `--dsw-specific-input-major` | 输入框底 |
| `--cm-accent` / `-fill` / `-hover` | `--dsw-alias-state-business-primary` / `button-info-*` | 主色与主按钮 |
| `--cm-ok` / `--cm-warn` / `--cm-error` / `--cm-info` / `--cm-idle` / `--cm-brand` | `--dsw-alias-state-*` | 五态（**DSH 没有 state-info，业务主色即 info**） |
| `--cm-hover-danger` | `--dsw-alias-interactive-bg-hover-danger` | 危险悬停 |
| `--cm-ghost-active-fill` / `-border` | `--dsw-alias-button-ghost-active-*` | 幽灵按钮激活 |
| `--cm-primary-fill` / `--cm-primary-hover` | `--dsw-alias-button-primary-*` | 主按钮实心 |
| `--cm-skeleton` | `--dsw-alias-bg-skeleton` | 骨架 |
| `--cm-focus-color` / `-width` | `--dsw-focus-ring-*` | 焦点环（指针输入时宿主置 transparent，鼠标不画环） |

### 浮层与系统

`--cm-menu-surface` / `--cm-menu-backdrop` / `--cm-menu-icon` / `--cm-tooltip-bg` / `--cm-tooltip-fg` / `--cm-toast-bg` / `--cm-toast-fg` / `--cm-mask` / `--cm-mask-blur` / `--cm-shadow-1` / `--cm-shadow-2` / `--cm-warn-label`。

### 唯一例外：聊天气泡

`--cm-chat-bubble` 走 `--dsw-specific-bubble`，是「把插件的回退入口做成宿主同款»的那一小块（`.chatEntryScope`），**不属于本次重做范围**。

## 5 层级与动效

- z：`raise` 1 · `sticky` 2 · `task` 90 · `mask` 100 · `modal` 101 · `pop` 110 · `toast` 120。
- 时长：`fast` 120ms · `base` 180ms · `slow` 300ms · `draw` 340ms（**只给勾形描边**）。
- 曲线：`ease-out` / `ease-in-out` / `ease-draw` / `press-spring`。

## 6 OpenDesign 配色怎么换算（评审时逐条过）

1. 它写的背景色 → 落到 `surface-1`/`surface-2` 之一；两个都不像，说明它在造第二套画布底色 ⇒ 打回。
2. 它写的主色 → 只能是 `accent`（或 `primary-fill`）。若它给一个更亮的品牌色，那要走 `brand`，且必须**OTA 到 DESIGN.md** 并说明为何不用宿主主色。
3. 它写的状态色 → 只能 `ok/warn/error/info/idle` 五选一，不许自己调一个「更柔和的绿」。
4. 它的半透明层 → 换成 `color-mix(in srgb, var(--cm-X) N%, transparent)`，N 落在 4/8/12/16/45 这些既有档。
5. 它的阴影 → 只能用 `--cm-shadow-1/2`；第三档阴影 = 新增 token，先改 DESIGN.md。
6. 字号不在 11/12/12.5/13 四档 → 打回（唯一放宽：一个页面级大数字可用 20，且只此一处）。
