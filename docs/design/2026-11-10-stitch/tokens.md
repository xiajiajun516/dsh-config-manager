# 设计稿用色与尺度（取自真实 DSH 主题变量）

来源：`D:/Apps/DSH/resources/app.asar` 内的主题样式表（`latin1` 扫描，静态色板块 + `:root` 亮色块 + `[data-ds-dark-theme]` 暗色块，别名递归解析）。
设计稿只覆盖亮色；暗色值一并留档，供后续做暗色稿时对齐。

## 亮色（`:root`）

| 语义 | 变量 | 值 | 设计稿用法 |
| --- | --- | --- | --- |
| 正文 | `--dsw-alias-text-1` | `#0F1115` | 标题、表内主文案 |
| 次级 | `--dsw-alias-text-2` | `#61666B` | 说明、标签 |
| 弱化 | `--dsw-alias-text-3` | `#81858C` | 时间、计数、placeholder |
| 表面 | `--dsw-alias-surface-1` / `-2` | `#FFFFFF` | 窗口、卡片底 |
| 输入底 | `--dsw-alias-input-bg` | `#FFFFFF` | 搜索框、下拉 |
| 描边 1 | `--dsw-alias-line-1` | `#0000000A` | 极淡分隔 |
| 描边 2 | `--dsw-alias-line-2` | `#0000001A` | 卡片 1px 边 |
| 描边 3 | `--dsw-alias-line-3` | `#0000001F` | 控件 0.5px 边 |
| 描边 4 | `--dsw-alias-line-4` | `#00000029` | 强调边 |
| 主色 | `--dsw-alias-accent` | `#4176E6` | 链接、进度条、占比条 |
| 主色悬停 | `--dsw-alias-accent-hover` | `#7AAAFF` | — |
| 成功 | `--dsw-alias-ok` | `#22C55E` | 状态点、成功徽章 |
| 警告 | `--dsw-alias-warn` | `#F59E0B` | 「待处理」徽章、崩溃条 |
| 错误 | `--dsw-alias-error` | `#EC1313` | 删除按钮、冲突已中止 |
| 主按钮底 | `--dsw-alias-primary-fill` | `#0F1115` | 黑底主按钮 |
| 主按钮悬停 | `--dsw-alias-primary-hover` | `#43454A` | — |
| 悬停底 | `--dsw-alias-hover` | `#2631480F` | 行悬停 |
| 选中底 | `--dsw-alias-active` | `#2631481A` | 行选中 |
| ghost 选中底 | `--dsw-alias-ghost-active-fill` | `#EBEEF2` | 页签 / 分段控件选中 |
| ghost 选中边 | `--dsw-alias-ghost-active-border` | `#979DA6` | 分段控件选中边 |
| 遮罩 | `--dsw-alias-mask` | `#0000003D` | 浮层遮罩（命令面板、恢复弹窗） |
| 菜单面 | `--dsw-alias-menu-surface` | `#FCFDFEB3` | 浮层/菜单底 |
| 骨架 | `--dsw-alias-skeleton` | `#0000000A` | 加载骨架 |
| 空闲点 | `--dsw-alias-idle` | `#D4D4D4` | 未启用状态点 |
| 危险悬停 | `--dsw-alias-hover-danger` | `#EC13130D` | 删除按钮悬停 |

## 暗色（`[data-ds-dark-theme]`，本轮未出稿）

`text-1 #F9FAFB`、`surface-1 #232324`、`accent #7AAAFF`、`error #F25A5A`，其余别名同构。

## 尺度

- 字号四档：11 / 12 / 12.5 / 13px（行高 1.25 / 1.5）
- 间距九档：2 / 4 / 6 / 8 / 10 / 12 / 14 / 16 / 24px
- 圆角：4 / 8 / 12 / 16 / 999px
- 描边：控件 0.5px、卡片 1px
- 画布：插件内容区 564×720，宿主设置弹窗 800×800（宿主导航 188px 不归插件）
- 弹窗：`.dialogCard` = `min(600px, calc(100vh - 64px), 92%)`；`.dialogWide` = `min(720px, …, 96%)`
- 字体栈：`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", …`（设计稿渲染用 Inter 代替，仅观感示意）
- 阴影：`stroke + 0 4px 16px #00000008 + 0 0 24px #00000008`；浮层用 `0 8px 32px rgba(0,0,0,0.10~0.12)`

## 注意

设计稿 HTML 里的颜色是 Stitch 自选的近似值，**不要**当 token 用。落地仍走 `--cm-*` → `--dsw-*` 两层单向依赖，颜色只出现在 `--cm-*` 定义行（`src/client/css-token-guard.test.ts` 会拦）。
