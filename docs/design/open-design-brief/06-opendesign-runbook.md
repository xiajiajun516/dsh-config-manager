# 06 · OpenDesign 执行手册（DSH 自己看）

## 0 已验证的能力（真实调用，不是文档摘抄）

| 能力 | 工具 | 关键事实 |
| --- | --- | --- |
| 建项目 | `eac_design_project_create({ title, kind: 'website', brief })` | 返回 projectId（uuid） |
| 存成品 | `eac_design_artifact_save({ projectId, name, content })` | 返回本地文件 `path`（`.eac/design/files/<uuid>/r<N>.html`）、修订数组 |
| 看状态 | `eac_design_state({ sessionId? })` | 项目 + 全部修订历史 |
| 查库 | `eac_library_list({ kind, query })` / `eac_library_read({ kind, id, source? })` | 过滤**只认** `kind` 与 `query`，多带键会报 `data must NOT have additional properties` |
| 系统浏览器预览 | `/api/design/artifacts/<id>/preview` | **401**：要 DSH web 会话 cookie，受控浏览器拿不到 ⇒ 别走这条路 |

**可用且已实测的看图路径**：`eac_design_artifact_save` 返回的本地 `path` → 受控 Chrome `navigate_page({ pageId: 1, url: 'file:///D:/...' })` → `resize_page` 到 564×720 → `take_screenshot`。
（`navigate_page` / `take_screenshot` / `evaluate_script` 的 `pageId` 必须是 **number**，字符串会报 `expected number, received string`。）
注意 `pageId` 固定为当前唯一页（编号 1）。

## 1 三张风格票选谁

| 票 | design system | 为什么选它 | 预期风险 |
| --- | --- | --- | --- |
| T1 | `od-ds-linear-app` | 与现状基调最近（Linear 风）：密、暗、克制 → 用来验证「不换气质只换秩序」能走多远 | 容易只是把现状重排一遍，看不出改进 |
| T2 | `od-ds-raycast` | 更工具化、以键盘与命令为中心、行内动作密度高 → 逼出「一屏一焦点」的做法 | 可能过度紧凑，读不出层次 |
| T3 | `od-ds-warp` | 暖近黑 + 土灰药丸主按钮 + 只用边框不用阴影 → 「不靠颜色也能做出焦点」的对照组，与 T1 冷蓝紫、T2 蓝黑+红彼此拉开 | 暖色底可能与本仓 r-surface 冷灰并存时观感冲突 |

三票**同一份 `00-brief.md`、同一画幅 564×720、同一内容**，只换视觉语言。
（T3 原票是 `od-ds-shadcn`，实测它是 light-only（`--bg #ffffff`）与宿主深色面板不匹配，已换 warp；若三票都不满意，第四票候选：`od-ds-supabase`（`#171717` + Postgres 绿 `#3ecf8e`）、`od-ds-vercel`（更极端的中性与分割线）。）

## 2 执行步骤

```
1  建项目 3 个（或 1 个项目存 3 个成品）：
   eac_design_project_create({ title: 'cm-home-style-tiles', kind: 'website', brief: <00-brief 正文> })
2  逐票读 design system 内容：
   eac_library_read({ kind: 'design-system', id: 'od-ds-linear-app', source: true })
   —— 目标是拿到它的 tokens.css 与组件原语，不要照抄它的品牌色（要换成本仓 --cm-*）
3  逐票写 HTML（单文件、内联 CSS、:root 变量表、data-block 标注、内联 SVG 图标）
   eac_design_artifact_save({ projectId, name: 'home-T1-linear.html', content })
   命名：home-T<序号>-<ds>.html
4  逐票截图：navigate_page(file:///<返回的 path>) → resize_page(564×720) → take_screenshot
5  三张并排给用户选（一张截图 + 一段「它赢在哪/输在哪」，不要只说好看）
6  用户选定 → 进 Stage C：同风格出 4 页 + 3 流程，命名 <page>-T<sel>.html
```

## 3 每张票的评审打分表（对着 `00` §7 逐条）

| 维度 | 判据 | 权重 |
| --- | --- | --- |
| 3 秒结论 | 不看文字也能找到「上次备份什么时候 / 现在用不用备份」 | 高 |
| 焦点唯一 | 全屏只有一个视觉最强点（主按钮或健康结论） | 高 |
| 密度 | 564×720 内四块内容全在，无 >40px 底部空带 | 高 |
| 可点性 | 所有可交互元素在未 hover 时可辨 | 中 |
| 三态覆盖 | 空/加载/错误都被设计过（哪怕只是一个框内说明） | 中 |
| 可搬运性 | `:root` 变量表完整、无规则内字面量、区块语义标记齐全 | 高（不合格直接打回重写，不是「改一改」） |

## 4 落地顺序（D 阶段，不要一次全铺）

```
home  →  library  →  environment  →  sync
```

理由：home/library 是纯展示 + 少量动作，改坏的代价是视觉；sync 页 4686 行、承载差异确认与冲突处置，改坏代价是数据安全。

每页落地的固定动作：
1. 读现有 TSX，把「区块 → 组件」对应表写出来（不改逻辑，只换结构）
2. 往 `config-manager.module.css` 加新类（旧类**先不删**，等新结构跑通再清理）
3. 一个区块一个 commit 粒度；每次改完跑一次 typecheck（快）
4. 一页做完再跑 `npm test` + `npm run build` + bundle 扫描
5. 页面级对照 `04` §5 的清单打勾

## 5 风险与提前量

| 风险 | 现在就该做的准备 |
| --- | --- |
| OpenDesign 稿"好看但装不下"（它不知道 12.5px 正文与 8 行列表的约束） | 每票先按 `00` §6 的技术要求生成；不合规直接重生，不做「手改稿」 |
| 换算 token 时它给的颜色没有对应档 | 提前决定：新增 token 要连带 `DESIGN.md` 一行动机说明 + 兜底值 |
| 落地时把区块结构改了但视图模型对不上（例如把状态条并进工具栏） | 先改 `src/ui/*-view.ts` 的派生结构 + 单测，再动 TSX |
| 视觉重构把高度契约改坏（底栏不再贴底、空带复现） | 每个页面落地后固定检查：「最空的状态下，底栏是否贴底」 |
| sync 页越改越大 | D 阶段对 sync 只做视觉层：类名与结构，不动 handler 与状态机 |

## 6 与 CHANGELOG / 版本的衔接

- 每页落地后不单独发版；四页 + 流程都完成后写**一条** `## [Unreleased]` 条目（用户视角：设置面板的四页换了信息结构，密度与层级更清楚）。
- SemVer 判定 **MINOR**（视觉与结构改进，功能不减、契约不变）。
- 若中途只完成 home + library，同样写一条但明确范围（「首页与产物库重排」），不要写成「全站重做」。
## 7 已产出（2026-11-07）

三张票已写完并实测，源文件与截图都在 `tiles/`：

| 票 | HTML | 截图 | 实测（564×720） |
| --- | --- | --- | --- |
| T1 Linear | `tiles/home-T1-linear.html` | `tiles/home-T1-linear.png` | body 720 / 行区 client=scroll / 18 行无裁切 |
| T2 Raycast | `tiles/home-T2-raycast.html` | `tiles/home-T2-raycast.png` | body 720 / 行区 468=468 / 按钮高 28 |
| T3 Warp | `tiles/home-T3-warp.html` | `tiles/home-T3-warp.png` | body 720 / 行区 484=484 / 卡底余量 34px |

三张并排：`tiles/compare-home.png`。

三票共同点（都是硬约束，不是风格）：画幅 564×720 不滚整页、四块顺序固定、指标值不显示 0、时间列 74px（mono 11px 下「昨天 22:14」不折行）、结果列 66px（「跳过 2」不折行）、行高 24~25px（18 行刚好填满）。

差异只在视觉语言：

| 维度 | T1 Linear | T2 Raycast | T3 Warp |
| --- | --- | --- | --- |
| 底色 | `#08090a` 冷近黑 | `#07080a` 蓝冷近黑 | `#161412` 暖近黑 |
| 主按钮 | 靛蓝填充 `#5e6ad2` | 反白填充（白底黑字） | 土灰药丸 `#353534`（无色相） |
| 边框 | 1px 半透明线 | 双环（外 `#1b1c1e`）代替边框 | 1px 暖色细线，无阴影 |
| 彩色用量 | 只有主按钮 + 状态点 | 主按钮反白，红只给失败 | 完全不用色相，靠字重与边框分层 |
| 字重/字距 | 510，常规字距 | 500~600，+0.2px | 400~500，常规 |
| 风险 | 与现状最像，改进可能被读成「重排」 | 层次全压在亮度上，暗屏下可能糊 | 暖色与宿主冷灰并存要试 |

**待用户选定**（这是唯一的人工决策点）：选定后 Stage C 按该票的视觉语言出 4 页 + 3 流程。

## 8 Stage C 产出（四页 + 三流程）

四页主稿与三份流程稿都在 `tiles/`，画幅统一 564×720，全部实测 `body.scrollHeight === 720`、滚动区 `clientHeight === scrollHeight`：

- `home-T1-linear` `library-T1-linear` `environment-T1-linear` `sync-T1-linear`
- `flow-sync-confirm-T1-linear` `flow-import-confirm-T1-linear` `flow-artifact-detail-T1-linear`
- `contact-pages.png`（四页并排）

非数据态（空/加载/错误）与三个流程的走法、以及「稿中元素 → 现有类名」的落地映射见 `07-states-and-flows.md`。
