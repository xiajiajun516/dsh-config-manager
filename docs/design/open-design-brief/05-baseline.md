# 05 · 基线截图：缺口与补法

## 结论

**目前没有真机基线截图**，且不是「还没做」，是两条自动化路径都被真实限制挡住了。写下成因，避免下次重复踩。

## 已试过、不成立的路

| 路径 | 结果 | 成因 |
| --- | --- | --- |
| 受控 Chrome（chrome-devtools MCP）打开 `http://127.0.0.1:55442` | 401 / 跳「dsh web authentication required; reopen the URL printed by dsh web.」 | 该地址要 DSH web 会话 cookie（token URL 一次性授予），受控浏览器没有 |
| Electron 桌面窗口（pid 14464）的原生无障碍树 | 只到一层 `Document (RootWebArea)`，内部 web 元素不暴露 | Electron 的 webview 内容不进 UIA 树 ⇒ 原生点击无法定位插件内元素 |
| 键盘快捷键开设置 | `press_key` 报 `unknown key 'comma'`（xdotool 命名），且即便打开也无法读树 | 同上 |

## 两种可行补法

### A 人工 10 秒（最省事，推荐）

你在 DSH 设置里打开「备份与迁移」，停在首页与产物库各一张，我用 `get_app_state` 直接抓窗口截图（原生截图不需要 web 树）。
一次约 10 秒，换 4 张真实基线。

### B 无人工（代价：不是真机像素）

用仓库里的视图模型造一份**结构等价**的静态 HTML（同内容、同画布、同 token），在受控 Chrome 里截图。
它能验证的是构图与信息密度，**不能**验证宿主真实主题色与字体渲染 ⇒ 只能当「结构基线」，报告里必须写明。

## 现阶段怎么继续

Stage B（风格票评审）**不需要基线**：它要的是内容清单与画幅，`00`–`03` 已经齐了。
基线真正被需要是在 **D 落地之后做 before/after 对照**，那时有两个选择：

1. 走 A 拿到 before（顺便拿到集合真机字体的 after）；
2. 用 git 检查点回退到改动前，按 B 造结构基线。

**任何情况下不得伪造基线**，也不得把 OpenDesign 的风格票当基线。

## 已实测：受控浏览器能截图本地 HTML

`eac_design_artifact_save` 返回的 `path` 是本地文件，受控 Chrome 可用 `navigate_page({ pageId: 1, url: 'file:///D:/...' })` 直接打开，再 `resize_page` + `take_screenshot`。
（`pageId` 必须是 number。）所以补法 B 的「结构基线」与 Stage B 的风格票评审都能落地，缺的只有**真机像素**那部分。

## 现有旁证（可替代一部分基线用途）

- 结构：`02`/`03` 的区块表 + 状态矩阵（来自源码逐一核对）
- 视觉规格：`01` 的 token 表（来自 css 定义块）
- 历史决策与事故：`DESIGN.md` 的日期注释（例如「2026-11-01 不再 fillCard 撑满视口 —— 8 行记录撑到 400px 后卡内留约 150px 纯空区，被读成表格还没加载完」）
