# before 截图集（真实实现，非设计稿）

用途：`dsh-config-manager 前端重构设计稿` 的现状基线。全部为**真实运行中的插件 UI**，未经任何修改、未替换数据。

## 采集环境

- 运行时：`dsh web` 独立实例（`--profile web --host 127.0.0.1 --port 58033/58034 --no-open`），token URL 打开，**没有**触碰用户正在用的 57962 实例。
- 数据来源：本机真实 `~/.dsh`（同 profile，只读浏览，未执行导入/导出/同步/清理）。
- 浏览器：Chrome DevTools Protocol，窗口视口 **1400×1100**（`innerWidth 1400 / innerHeight 949 / devicePixelRatio 1`）。
- 画布：插件根节点 `#dsh-config-manager-root` 实测 `x=512, y=129, 564×722`（CSS px = 设备 px，dpr=1）。
- 落盘方式：`Page.captureScreenshot` 全窗，再按根节点 bounding box 精确裁切 → 每张图 **564×722 px**，只含插件画布，不含宿主设置页的左侧导航与遮罩。

## 文件清单

| 文件 | 屏 | 关键真实内容 |
| --- | --- | --- |
| P-01-before.png | 首页 | 配置状态良好 / 备份文件 10（57 分钟前）/ 安全快照 10 / 定时备份 开启 / 远程同步 开启；最近活动 12 行，结果列全部「待裁决」 |
| P-02-before.png | 产物库 | 全部 31 · 本机快照 10 · 备份文件 10 · 远端快照 10 · 市场配置 1；列表含 `dsh-config-au…-8d69c4.zip`（自动 · 859.8 KB）、`2026/11/10 20:52:15` 远端快照（Git · 10 分区 · 由 yzbtdmz1 推送）等 |
| P-03-before.png | 同步 | Git 私有仓库 · 已配置 · 凭据已配置；地址 `https://github.com/xiajiajun516/dsh-config.git`；上次同步 2026/11/8 19:34:06；同步分区 已勾选 10 / 12；自动同步 30 分钟；本地改动即时同步 开 |
| P-04-before.png | 环境 · 档案 | 运行状态 desktop :57962（其他实例）/ web :58011（当前实例）；全部档案 共 4 个：web（当前运行 :58011，14 层 · patch 18 条）、desktop（57962，31 层 · patch 31 条）、open-design（自定义，2 层）、superagent（3 层） |
| P-05-before.png | 环境 · 维护与诊断 | 恢复：暂无需要处理的恢复事项；救援模式 未开启；磁盘占用 1652.9 MB / `C:\\Users\\yzbtdmz1\\.dsh\\dsh-config-manager` / 49150 个文件；分区明细：备份文件 20.1 MB（11 个）、导入前快照 302.0 KB（76 个）、同步覆盖与工作副本 108.9 MB（1580 个）、遗留数据 checkpoints 56.9 MB（1757 个 不自动删除）；可立即释放 3.0 MB |
| T-01-before.png | 导出面板（首页「导出 ZIP」） | 导出配置：开始导出 / 选择要导出的内容 / 加密备份 / 导出密钥 / 自定义文件名 / 备注；本次将导出 **11 个分区 · 95 个条目 · 约 2.6 MB**，逐分区计数（设置 21 项、Provider 与模型 2 项、插件清单 33 项、MCP 服务器 7 项、技能 53 项、工作区 10 项…） |
| T-02-before.png | 导入向导（首页「导入」） | 导入配置：步骤条 1 选择 → 2 分析 → 3 预览与决策 → 4 确认 → 5 执行 → 6 完成；当前在第 1 步「选择备份文件」，只有「选择 ZIP 文件」按钮 |
| T-03-before.png | 外部 agent 来源（首页「从其它 agent 导入」） | 从其它 agent 导入：Claude Code 已检测到（命中 `.claude` `.claude.json` `.claude/settings.json` `.claude/CLAUDE.md` `.claude/skills` `.claude/projects` `.claude/plugins`）、Codex CLI 已检测到、DSH 会话日志（V0-V3 / V4）已检测到、Google Antigravity、Hermes；千问办公 / ChatGPT 未检测到 |
| T-06-before.png | 活动中心（导航右端「活动」图标） | 活动记录：运行区「自动同步 · 已完成 · 刚刚」，绿色进度条满格；仅一条在册运行（实例刚启动，历史运行未回放） |
| T-07-before.png | 迁移历史（导航右端「迁移历史」图标） | 总数 1002 · 成功 781 · 失败 96 · 跳过 125；自动清理 1000 条（磁盘上 1002 条）；筛选条（操作类型/结果/时间范围/搜索/导出 JSON/导出 Markdown）；分组「回滚 1」「档案新建 4」，条目如 `2026-11-08 22:32 成功 zz-verify-dl 复制档案 Test2 → zz-verify-dl` |
| T-08-before.png | 关于（导航右端「关于」图标） | 官方 · 版本 0.8.0 · DSH 0.2.1-rc.3 · win32-x64；插件清单来源 `C:/Users/yzbtdmz1/.dsh/profiles/web`（profile: web，已识别插件 12 个）；插件更新 当前版本 0.8.0 + 检查更新；相关链接 GitHub 仓库 / 使用文档 / 反馈问题 / 更新内容；CLI 救援工具 `npm install -g dsh-config-manager@latest --omit=peer` |

## 数据真实性

- 全部数字来自本机真实状态：备份文件 10、安全快照 10、产物库 31 条、档案 4 个、迁移历史 1002 条、磁盘占用 1652.9 MB。
- 未做任何写入操作：没有点过「开始导出」「立即备份」「开始清理」「执行导入」「推送/拉取」等动作；面板均为打开状态即截图。
- 首页「最近活动」结果列全为「待裁决」，这是本机当前真实状态（git 自动同步有待裁决项），不是占位。

## 未截到的屏 / 已知边界

1. **P-05 只含首屏视口**：画布固定 722 高，磁盘占用之后还有「会话体检」区块在折叠线以下，未滚到底另截（任务未列该屏）。
2. **T-06 活动中心只有 1 条运行记录**：实例刚启动，运行台账只保留当次「自动同步」；要更多条目需先在本机触发多次备份/同步。
3. **导航右端四个图标按钮 textContent 为空**：活动/迁移历史/关于/命令面板只能按 `aria-label` 点击，按文本匹配会得到 0 命中（第一轮踩坑原因）。
4. **绘制批次差异**：截图取自 2026-11-10 23:2x–23:3x 期间的两个独立实例，同一屏跨实例时间戳（「57 分钟前」等）会有分钟级差异，属正常。

## 复现方式（如需重拍）

```bash
# 1) 起独立实例并抓 token（必须前台/start-b 启动，token 只在启动时打印一次）
"D:\Apps\nodejs\node.exe" "D:\Apps\nodejs\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js" \
  --profile web --host 127.0.0.1 --port 58040 --no-open > .tmp/dsh-web-58040.log 2>&1
# 等日志出现：dsh web: http://127.0.0.1:58040/?token=...
# 2) 打开该 URL → 账号菜单 → 设置 → 备份与迁移 → 等首页出现「分钟前」等真实数据（首挂载会撞宿主冷启动，30s 超时后全变骨架）
# 3) 视口设 1400×1100，取 #dsh-config-manager-root 的 bbox（实测 512,129,564,722），全窗截图后裁切落盘
```

坑（一句话）：实例启动到打印 token 约 75 s；插件首挂载若立刻拍照会全是骨架（等真实数据出现再拍）；图标按钮只能按 aria-label 点。
