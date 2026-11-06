# 全站视觉 pass（2026-11-01）

> **只读存档（2026-11 文档重建起）**：本文冻结、不再修订；现行结论看 `docs/index.md` 指向的对应文档。与代码冲突时以代码为准。

> 范围：Backup & Migration 插件的 4 个一级页（Home / Artifact library / Sync / Environment 含 Profiles、Maintenance 两个二级页）+ Task 面板（市场）。
> 深度：**视觉 + 局部结构**（删装饰块、合并重复卡、调区块顺序），**不动** IA、路由、页签数量。
> 方法：基线截图 → 四份只读审查（每页 top-3）→ 逐页施工 → 守卫全绿 → after 截图回看。

## 判据来源与冲突裁决

外部设计资料（app-screens / house rules 那套 23 屏研究）只作**审查视角**，不作施工规范：

- **DESIGN.md 优先**：字号 4 档（11/12/12.5/13）、间距 9 档、圆角 5 档、脏线 0.5/1px，全部按仓库既有 scale 执行。外部资料的「正文 ≥16px」在本项目不可执行 —— 真实画布是 564px 宽的设置弹窗，16px 正文会把信息量砍半，且 `css-scale-guard.test.ts` 会直接红灯。
- **可采纳的部分**：结构判据（卡内空带 / 双圈边框 / 同排控件同高 / 一屏一个主行动 / 列头自释语义 / 零值降权 / 数字右对齐 tabular）—— 这些与仓库规范不冲突，且此前完全没有被写下来。
- 结论落成 DESIGN.md 的新审条：§5 的「列表密度按行高+内边距一起调，不单独缩字号」「列表要不要列头」，以及 §9 anti-patterns #19–#24。

## 四页共性问题

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| 卡片里出现「洞」/两圈同心框 | 卡内容器自带 `border + radius + bg-base`，而 `.card` 已有一层外框 | 卡内滚动区一律透明无框（`.activityRows`、`.diskUsageScroll`） |
| 卡内下方大片纯空 | 最后一张卡用 `.fillCard` 吃掉剩余高度，内容撑不满 | 卡片高度随内容，长列表用 `max-height` 内滚，留白交给页面层级 |
| 整屏最亮的是 chrome | 每个列表行都挂 `variant="primary"` 的实心按钮 | 行内动作常态 ghost，hover / 展开 / pending 才升 primary |
| 两个主按钮抢焦点 | 「入口」与「本页主行动」没区分 | 每页只留一个 primary（Library 的导出；Sync 的 merge/push/test 由状态决定） |
| 同一状态说两三遍 | 徽章 + 行内文字 + 禁用按钮各说一次 | 合并为一个徽章；「当前」不渲染禁用按钮 |

## 逐页记录

### Home
1. `.activityRows` 去掉自带 1px 外框 + `bg-base` 深底（双圈 + 空洞），加 `scrollbar-gutter: stable`。
2. 活动表四列化：`72px 96px minmax(0,1fr) auto`（时间 / 动作 / 详情 / 结果），配 12px 灰列头；行高 32 → 40px。此前 kind 文本挤在摘要里，长前缀把尾部区分信息挤出可视宽度。
3. 摘要改中段省略（`midEllipsis(s, 34)` + `title` 全文），文件名类信息后缀仍可辨。
4. 健康档补 warn：自动备份关闭且只有手动备份时，顶部不再显示「一切正常」（`overview-view.ts` 加 `health.autoBackupOff`）。
5. 去掉 `.fillCard`：8 行记录下方原本约 150px 纯卡面读作「还没加载完」。

### Artifact library
1. 八行 Restore/Import/Pull 从 primary 降 ghost，hover/展开才升 primary（CSS 读 `li[data-expanded]`，不引入重渲染）。
2. 文件名走 `.mono` + `midEllipsis(name)`（DESIGN.md §9-5：尾部截断禁用）。
3. `.artifactList` 加 `scrollbar-gutter: stable` + 底部 4px：滚动条出现时行宽不再跳 5px，末行不贴底栏线。
4. 底栏「16 total」在无筛选时不再显示（与 All 16 chip 重复），有筛选时改显示 shown / total。
5. 底栏只有「导出」升 primary —— 它是这一页唯一的产品级动作，其余三个是「拿别人的东西进来」。

### Sync
1. Syncable sections 与下方 9 selected 曾出现 0 与 9 两个数字 —— 统一读 `cs.syncSections.length`。
2. `.factGrid` 由写死 4 列改 `auto-fit, minmax(150px, 1fr)`：实际只有两项事实，右侧两列恒空。
3. Configure… 由 primary 降 ghost（主行动由 `pickSyncPrimary` 决定）。
4. Auto Sync 去掉内层 `<Card>`（卡套卡，白吃 22px + 多一圈边界），改卡内小节（0.5px 分隔线）。
5. Sync Sections 独立卡（一行文字 + 一个按钮 + 右侧 400px 空白）并入动作卡成一行。
6. Auto Sync 的策略项（interval / realtime / tier / conflict / 状态 / 失败原文）改为「启用才渲染」：关闭态原本铺满两屏，把主要动作推出首屏。

### Environment
1. Runtime 卡两种行合成一种（原先「当前：web」+「web · :3277 · 当前实例」说两遍，两行值起点一 110px 一 12px）。
2. 当前实例不再渲染禁用的 Stop（禁用按钮读作「这里有个坏掉的东西」）。
3. profile 行去掉 Running / 当前 / :3277 三重徽章的重复：当前档案只留一个 ok 徽章，非当前档案才显示端口徽章。
4. 行摘要删掉详情弹窗已有的两个徽章语义，只留层 / 补丁 / 依赖三个计数；en 复数改短式（3 layers · 5 patches · 1 deps），不再被截成半句。

### Maintenance
1. `.diskUsageScroll` 去双圈 + 深洞（同 Home）。
2. **flex 压扁子项**：卡片固定 420px + flex column，内容一多把 `.cellMeta` 压到 4px、文字被裁半个字。改为「除明细表外一律 `flex-shrink: 0`，只有明细表滚动」。
3. 四列显式宽度（78 / 86 / 160），内容列允许换行、数值列不省略 —— 此前 Cleanup policy 只剩约 118px，而它正是「这块数据能不能删」的唯一答案。
4. Legacy data 行尾部再重复一次 hint 已说完的话，删掉。

### 市场（Task 面板）
仓库地址那张卡只有标题 + 两个按钮，右侧 400px 恒空 —— 改一行（标题 / spacer / Refresh / Browse），省约 50px。

## 未做 / 已知限制

- **英文 (s)/(ies) 括号复数的全站改造**：改动值可能触碰 `engine-locale` 的键指纹，且与视觉 pass 无关，单列。
- **导入 / 同步确认 / 恢复三处 Modal 未做视觉审查**：需要真实远端与文件选择器，本轮无法在隔离环境复现（NOT VERIFIED）。
- 维护页明细表在卡片固定高度内滚动，末行可能被视口边缘切一半 —— 滚动可见；卡片固定高度是刻意设计，未改。
- Home 活动表的 Detail 列仍会出现「手动备份完成: 」这类前缀，与 Action 列语义部分重叠；前缀由 host 侧摘要生成，属数据层，本轮不动。

## 验收

- `npm run typecheck` / `npm run build` 通过；`css-scale-guard` / `css-token-guard` / `icon-layer-guard` / `engine-locale` / `i18n-hardcoded-guard` / `file-size-ratchet` 全绿。
- before / after 截图：`.tmp/visual-pass/{before,after}/`（before 为 800x800 dialog 元素截图，after 为 900x860 viewport 截图）。
- `src/client/locales.ts` 因新增 8 个键从 1776 → 1795 行，棘轮已按规则上调并在 tech-debt #22 记录。
