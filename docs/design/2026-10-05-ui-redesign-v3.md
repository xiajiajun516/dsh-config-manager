# UI 重做 v3：信息架构 + 视觉体系（2026-10-05）

> **状态**：**已实施**（2026-10-06 起；见本文 §14「实施结果」与 `DESIGN.md` 的采用声明）。未落地项与偏差见 §14.3。
> **取代声明**：本文取代 `docs/design/2026-10-02-ui-rebuild-v2-skeleton.md` 的 §4（IA）/§5（外壳）/§7–§9（页面模式）
> 与 `DESIGN.md` 的 §1、§1.1、§2、§3–§5、§6、§9。v2 文档降级为「被推翻的上一版」评审记录。
> **基线**：HEAD `e6b5e83`（2026-10-05 实测，见 §0）。
> **不变量**：宿主画布 564×720 / 零硬编码色 / 唯一样式表 / 零新增依赖 / 引擎与 77 条路由零改动 /
> 救援可达性 / 同步双通道（今 4 通道）独立语义 / 凭据逐项确认 —— 全部见任务书 §3，本文不重复。

---

## 0. Phase 0：基线核对与差异

实测命令（PowerShell / node，脚本见 §0.3），对任务书 §1 的每个数字重跑：

| 项 | 任务书 | 本次实测 | 判定 |
|---|---|---|---|
| 样式表行数 | 4093 | **4957 总行 / 4317 非空行** | **不符**（两种口径都不是 4093） |
| 样式表体积 | 138.8 KB | 138.8 KB | 一致 |
| 顶层类名 | 414 | 410（严格 `^\\.x{`） / 414（宽松） | 一致 |
| 顶层规则 | 614 | 665（depth-0 启发式） | 口径差异，不据此下结论 |
| 不同 px 值 | 68 | **77（全数值口径）** / 68（`\\d+px` 子串口径，会把 `11.5px` 计成 `5px`） | 任务书用子串口径；**全数值口径 77** |
| `!important` | 0 | 0 | 一致 |
| 硬编码颜色 | 1 处（`#fff`） | **代码内 0 处**；5 处全在注释（L88-90、L3546） | 更准确：零硬编码 |
| `--dsw-*` 引用 | 449 | 449 | 一致 |
| 零引用顶层类 | 11 | 11（逐个 grep 复核） | 一致 |
| TSX 组件 | 61 | 62（不含 .test.tsx） | 差 1，以实测为准 |
| 最大文件 | SyncPanel 1487 / RecoveryPanel 1351 / EnvironmentPanel 819 | SyncPanel **1567**（非空 1487）/ RecoveryPanel **1424**（非空 1351）/ EnvironmentPanel **903**（非空 862） | Sync/Recovery 非空行与任务书一致（任务书用非空行口径）；Environment 略有出入 |
| 内联 `style={{}}` | 74 | **71** | 差 3 |
| 字典 | 1737 / 680 / 639 | **1798 / 684 / 659** | 全线大于任务书 |
| `PanelId` | 6 值（含 `import`） | 一致：`overview\|library\|import\|sync\|market\|profiles` | 一致 |
| `TaskKind` | 7 值 | 一致 | 一致 |
| 画布 | 564×720 | 一致（宿主 settings.section） | 一致 |

**追加实测（任务书未列，本文新增证据）**：

| 项 | 实测值 |
|---|---|
| 字号档位 | **10 档**：9.5 / 10 / 10.5×14 / 11×42 / 11.5×28 / 12×25 / 12.5×19 / 13×5 / 14×1 / 30×1 |
| 半像素字号实例 | 61 处（10.5/11.5/12.5） |
| 圆角档位 | **9 档**：3/4/5/6/7/8/9/10/999px |
| z-index 档位 | **7 档（代码内）**：1/2/90/100/101/110×2/120（1000 仅出现在注释） |
| line-height 档位 | 5 档：1/1.4/1.45/1.5/1.6 |
| gap 档位 | 10 档：1/2/3/4/5/6/7/8/10/18px |
| 弹窗阴影 | 3 套一次性值：`0 10px 26px` / `0 12px 32px` / `0 8px 24px`（+ 焦点环 18%/45%/55% 三档透明度手写） |
| 四态语义实现份数 | Badge / Banner / StatusDot / `.kindTag*`(5 类) / choiceCard —— 至少 5 份并行 |
| 媒体外完全重复的顶层规则块 | **9 个**（各 ×2）：`.dataTable tbody tr` `.dangerButton` `.dataTable td` `.stepperLabel` `.consultScroll` `.viewBody` `.conflictDetail` `.snapshotPickerRow` `.cliCommand`；媒体查询内的覆盖属正常，不计 |
| `--cm-*` 自定义 token | 定义 6 个（4 个 motion + 1 个磁盘卡高度 + 1 个？），引用 59 处 |
| 置顶/取消置顶能力 | **已由用户要求下线**（2026-10-03）；UI 侧残留死代码：`ArtifactCapability` 的 `'pin'\|'unpin'`、`library.cap.pin/unpin` 字典、`api.setSnapshotPinned` 与 `routes/snapshots.ts:190` 路由仍在 |

### 0.1 结论
任务书的数字**方向全部正确、多处偏旧或口径不同**；以本表实测为准。**新增的关键事实是「scale 漂移」与「重复块」**：
声明的 4 档字号 / 5 档间距 / 5 档圆角，实际分别是 10 / 10+ / 9 档，且有 9 个媒体外同名选择器被重复定义（媒体查询内的覆盖属正常）—— 说明
`DESIGN.md` §4/§5 是**散文规范**，没有任何机制阻止新值产生。这正是 v3 要修的第一性问题。

### 0.2 扫描纪律
只看 `src/`、`tests/`、`DESIGN.md`、`AGENTS.md`、`DEVELOPERS.md`、`docs/`；排除 `outputs/`、`lib/`、`dist/`、`node_modules/`。

### 0.3 测量命令（可复核）
```powershell
# 行数/体积/px 分布/!important/硬编码色/token 引用
node -e "const fs=require('fs');const c=fs.readFileSync('src/client/config-manager.module.css','utf8');console.log(c.split('\n').length, (Buffer.byteLength(c)/1024).toFixed(1));const px={};for(const m of c.matchAll(/(-?\d+(?:\.\d+)?)px/g))px[m[1]]=(px[m[1]]||0)+1;console.log(Object.entries(px).sort((a,b)=>b[1]-a[1]).slice(0,25));console.log('hard',(c.replace(/\/\*[\s\S]*?\*\//g,'').match(/#[0-9a-fA-F]{3,8}\b/g)||[]).length)"
# 字号/圆角/层级/间距档位
node -e "const fs=require('fs');const c=fs.readFileSync('src/client/config-manager.module.css','utf8');for(const k of ['font-size','border-radius','z-index','gap','line-height']){const m={};for(const x of c.matchAll(new RegExp(k+':\\s*([^;}]+)','g')))m[x[1].trim()]=(m[x[1].trim()]||0)+1;console.log(k,Object.keys(m).length,Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,12))}"
# 零引用类复核：对每个类名 grep src（排除 .css 自身）
```

---

## 1. 现状问题清单

编号 = `P-域-序号`；严重度 blocker/high/medium/low；「违反条款」指任务书 §3 不变量或 DESIGN.md 章节。

| 编号 | 严重度 | 问题 | 证据 | 违反 | 归因 |
|---|---|---|---|---|---|
| **P-IA-1** | high | **「市场」有两个家**：`MarketPanel` 既是页面（`panel='market'`）又是 Task（`kind='market'`），同一组件两处渲染、两份 `initFromStore` 状态 | `ConfigManagerSection.tsx:489-491`（页面）与 `:644-655`（面板）；`MarketPanel.tsx:181-199`；v2 §14 决策日志「市场不再是页签」与其 `§9` 自相矛盾 | §4 覆盖矩阵无空白格（同一能力两个状态源） | v2 定案未落地：实现期保留了页签 |
| **P-IA-2** | medium | **`PanelId` 死值 `'import'`**：页面不存在，但有 `goto` 特判 + 持久化镜像 | `run-store.ts:85`；`ConfigManagerSection.tsx:307-312`；`run-store.ts:1251-1255` | 工程纪律（死代码） | v1→v2 迁移残留 |
| **P-IA-3** | medium | **`MainView` 是 v1 化石**：`view` 字段仅为 `panel==='import'` 镜像而活，旧载荷还必须带它 | `run-store.ts:77,452,509,529,1206,1255` | 工程纪律（死状态） | v1 主视图概念未清除 |
| **P-IA-4** | medium | **`TaskKind 'publish'` 死值**：全仓零打开点、零渲染点；发布流实际住在市场页的 `myconfigs` 子视图 | `run-store.ts:93`；grep `kind === 'publish'` → 0 命中；`MarketPanel.tsx:80,442` | 工程纪律 | v2 计划「发布市场=独立 task」未落地 |
| **P-IA-5** | medium | **`snapshots.subTab` 持久化化石**：v1 备份页子 tab 仍在落盘，唯一活引用是首页借 `snapshots.subTab.schedule` 键名当弹窗标题 | `run-store.ts:255,339,1125,1265-1267`；`HomePanel.tsx:593,597`；**且迁移分支实际不生效**——`snapshotsSubTab` 在 L1205 初始化为 `'restore'` 后从未重新赋值，L1265-1267 的「强制为 recovery」注释与实现不符 | 工程纪律 | v1 子 tab 未随页面解散清掉 |
| **P-IA-6** | medium | **首页保留 v2 明确要移出的三块**（备份位置卡 / 分区构成卡 / 活动视口），首页成 v1+v2 拼接 | `HomePanel.tsx:478-528,532-551,554-583` vs v2 §7「移出首页」三条 | DESIGN.md §0 Canvas 纪律（底部空洞由拼接填充） | v2 §7 决策未执行 |
| **P-IA-7** | medium | **同步页有隐式「当前通道」全局**：页面级加密/解密/同步内容卡绑定 `state.channel`，靠点击某张通道卡内的按钮被悄悄切换 —— 视觉上它们像全局设置 | `SyncPanel.tsx:1301-1355,1103,1063-1070,1177,1181,1184` | **§3-19 同步语义**：用户会以为两/四通道共用一份加密/分区设置 | v2 §8「分区选择进通道卡」只做了一半：分区卡进了通道，加密/解密留在了页面级 |
| **P-IA-8** | high | **4 张通道卡把同步页撑爆**：git/webdav/s3/gist 恒显示，每张已配置通道再缀 2 张卡（内容+动作），页面可达 12+ 张卡 —— v2 的 56+176 预算（2 通道）失效 | `SyncPanel.tsx:1265-1268,1131-1243`；通道数由 v2 的 2 增至 4（git log t79/t90 S3+gist） | DESIGN.md §0 Canvas 纪律 | 通道扩容未同步重算页面预算 |
| **P-IA-9** | low | **只读视图入口不一致**：活动/关于有导航图标，迁移历史没有（仅首页按钮 + ⌘K） | `ConfigManagerSection.tsx:554-565`（3 个图标）；`HomePanel.tsx:448-450` | DESIGN.md §9 #4 一致性 | v2 §5.9 未定义图标位 |
| **P-IA-10** | low | **状态栏未兑现 v2 §5.10**：只有「N 个任务进行中」文本，无任务名/进度条 | `ConfigManagerSection.tsx:370-381,677-700` | — | v2 承诺未实现 |
| **P-IA-11** | low | **壳层 SAFE MODE 横幅用内联 style** 做布局 | `ConfigManagerSection.tsx:571` | §3-3 样式只进 CSS | 紧急修复期留下的补丁 |
| **P-IA-12** | low | **`client/snapshots/` 目录名不副实**：`DiskUsageCard`/`BackupScheduleCard`/`RestorePlanView` 挂在下游页 | `environment/EnvironmentPanel.tsx` 引用 `../snapshots/DiskUsageCard.tsx`；v2 §12 第 4 步自认 | 结构纪律 | v2 收口未搬 |
| **P-VS-1** | high | **scale 无执行机制**：声明 4 档字号/5 档间距/5 档圆角，实际 10/10+/9 档（含半像素 61 处、9.5px、30px 离群） | §0 追加实测 | DESIGN.md §4/§5 自我否定 | 规范是散文，无守卫 |
| **P-VS-2** | high | **四态语义重复实现 ≥5 份**（Badge/Banner/StatusDot/.kindTag×5/choiceCard），色值各自 color-mix | `ui.tsx:127-175`；`config-manager.module.css:4133-4166` | §2 原则「状态即语义」无单一来源 | 缺中间 token 层 |
| **P-VS-3** | medium | **CSS 没有真分层**：头注释声明 §1-§15，实际只有 5 处分隔注释（L85 §2 Shell、L2399/L3276/L3462/L4700 无标题）；页面规则与原语规则混排；头注释仍是 v1「Workbench Design System」 | `css:8-23` vs 分节符 L85/2399/3276/3462/4700 | DEVELOPERS.md 分层约定 | 每次追加都就地插入 |
| **P-VS-4** | medium | **9 个媒体外完全重复的顶层规则块**（后定义覆盖前定义）；媒体查询内的覆盖是合法的，不计 | §0 追加实测（严格解析：媒体外顶层规则 588 条） | 工程纪律（级联漂移） | 就地追加而未归并 |
| **P-VS-5** | medium | **阴影/焦点环无 token**：3 套弹窗阴影 + 3 档环透明度手写 | `css:722,1568,2244,2332,614,4209,4278` | §2 Token 驱动 | 缺 shadow/ring token |
| **P-VS-6** | medium | **11 个死类**（badgeOk/badgeInfo/badgeWarn/badgeError/rowDivider/tabRow/emptyHero/emptyHeroSymbol/emptyHeroTitle/emptyHeroBody/cellMetaNote） | 逐个 grep `src/`（排除 css）零引用 | 工程纪律 | 组件删除未连带清样式 |
| **P-VS-7** | low | **71 处内联 style**，其中一半集中在 `ReleaseNotesDialog`(21)/`BackupScheduleCard`(14) | §0 实测分布 | §3-3（允许极小修补） | 布局补丁 |
| **P-C-1** | high | **`SyncPanel` 单组件 1230 行 + 30+ handler + 组件内伪 store**（`commit`/`patch` 复制 run-store 模式） | `SyncPanel.tsx:298-1529,372-401` | AGENTS.md「逻辑下沉 / 组件只装配」 | 通道扩容就地加功能 |
| **P-C-2** | medium | **`RecoveryPanel` 627 行 + `SessionHealthDialog` 434 行**同文件 | `RecoveryPanel.tsx:360-794,796-1423` | 同上 | 维护项只增不减 |
| **P-C-3** | low | **`EnvironmentPanel` 783 行**含档案 + 维护两域 | `EnvironmentPanel.tsx:111-894` | 同上 | 双子视图未拆 |
| **P-IA-13** | low | **`pin/unpin` 残留死代码**：能力已按用户要求下线，但 union/字典/API/路由仍在，`LibraryActions` 无 case（落 default） | `ui/artifact-view.ts:91,183-184,224`；`artifact-view.test.ts:91`；`client/api.ts:680`；`routes/snapshots.ts:190` | 工程纪律（死代码） | 下线时只改了分派，未清残留 |
| **P-DOC-1** | low | `DESIGN.md` 1135 行、边写边补的「案例法」；多处描述与实现不符（如 §1 导航列「首页/产物库/导入/同步/市场/环境」6 项，而实现是 5 页签且无导入、有市场；同文件 §1.1 的表又只列 4 页） | `DESIGN.md:29,34-39` vs `ConfigManagerSection.tsx:70-81,492-502` | §9 文档同步 | 文档滞后于实现 |

**审计遗留**：2026-09 那份 UI 审计（26 条，2026-10-28 已移出仓库，取回 `git show 6f2864b:docs/design/ui-audit-2026-09-20.md`）已**全部**在 v2 落地（抽查 `UI-20`=`ErrorBanner.tsx:34-40`、`UI-25`=`ImportWizardView.tsx:275-276` 均有修复注释）。本清单不含未修审计项。

---

## 2. v2 逐条评估与「可推翻项」

### 2.1 v2 的三个根因现在解决了没有

| 根因 | 状态 | 证据 |
|---|---|---|
| ① 导航把「装不下」当可发现性问题（隐藏滚动条） | **已解决** | `ui/nav-model.ts` 纯函数 + `ConfigManagerSection.tsx:105-138` 实测宽度 + `MoreMenu` 降级；滚动条/渐隐遮罩已删 |
| ② 备份页 4 个子视图混四种心智 | **已解决** | `SnapshotsPanel` 已删（v2 §12 第 6 步）；内容归产物库/首页/环境 |
| ③ 同一配置 4 套 UI | **已解决** | `ui/artifact-view.ts` 四源合一 + `LibraryPanel` + `ArtifactRow`；能力由 `capabilities` 分派 |

**结论：v2 的 IA 方向是对的、三个根因确实解决了。** 本次「重做」的落点不是推翻方向，而是：
(a) 完成 v2 未落地的定案（市场归位、状态栏、首页瘦身、加密/分区入通道）；
(b) 清除 v1 化石（PanelId/MainView/subTab/publish）；
(c) **重做视觉体系**（v2 明确把字号/间距/token 列为非目标，见 v2 §2「不做主题/token/字号体系的重做」—— 这正是本轮的主战场）；
(d) 拆巨石组件。

### 2.2 可推翻的 v2 自有选择（每条：现状 → 证据 → 替代 → 替代如何解决同一问题 → 回归风险与对策）

1. **一级页签集合（5 项→4 项，市场退出导航）**
   - 现状：`overview|library|sync|market|profiles` 5 个页签。
   - 证据：v2 §14 自己定了「市场不再是页签」，实现保留了页签并造成 P-IA-1（同一组件两个家、两套状态）。
   - 替代：`home|library|sync|environment` 4 项；逛市场/发布市场都是 Task；命令面板 + 产物库底栏为入口（底栏补回第 4 项「发布到市场」）。
   - 如何解决同一问题：市场从「页面态」收敛为「流程态」，状态只有一个源（task payload），也顺手把导航容量余量从 -1 项变为 +1 项。
   - 回归风险：用户习惯从页签进市场。对策：① 产物库底栏常驻「逛市场」；② ⌘K 有 `market.open`/`market.publish.open`；③ v2 文档已决定过，属兑现而非新决策。**待确认（§8-Q1）**。
2. **容器判据**
   - 现状：一句话「多阶段向导 → Task 面板；单次决策+报告 → Modal」，但只读视图（runs/history/about）在实践中也进了 Task，判据未覆盖。
   - 证据：`run-store.ts:93` 的 TaskKind 含三种只读视图；`ConfigManagerSection.tsx:660-671`。
   - 替代：**三判据**：① 多阶段向导（有阶段推进/跨步状态）→ Task；② 只读浏览（无写入决策）→ Task（复用同壳）；③ 单次决策+报告 → Modal。并明写「页面 = 常驻任务域」，禁止第四种容器。
   - 如何解决同一问题：判据可判定（对任意新功能都能一句话归类），且解释了为什么 runs/history/about 在 Task 里。
   - 回归风险：无（只补文档与命名）。
3. **「每页 ≤3 子视图」**
   - 现状：环境页 2 个 Segmented 子视图；同步页无 Segmented 却有 12+ 卡。
   - 证据：`EnvironmentPanel.tsx:406-420`；`SyncPanel.tsx:1265-1268`。
   - 替代：改为「**每页 ≤2 个并列子视图，且必须是同域并列**；跨域一律 Task/Modal/独立页面；子视图不设上限的收益由『每卡自带折叠』承担」。
   - 如何解决同一问题：原来想防的是「一页塞四种心智」；新判据改为**禁止跨域**（更本质），而非数字限制。
   - 回归风险：同步页 4 通道仍多。对策：通道卡默认只展开**已配置**的；未配置恒 56px 矮态；每张已配置卡自带折叠（v2 当初拒绝手动折叠是因为只有 2 通道，4 通道下必须补回）。
4. **侧滑 Task 面板形态**
   - 现状：`absolute; inset:0` 于 `.shellContent`、无遮罩、底页保持挂载。
   - 证据：`task/TaskShell.tsx`；DESIGN.md §6「删抽屉的四条理由」。
   - 替代：**保留**（这是 v2 最成功的决定之一），只补两处：`escToClose` 覆盖面（只读 3 种，已一致）与市场双容器修复后 origin 语义简化。
   - 回归风险：无。
5. **状态栏与导航条形态**
   - 现状：导航动作 3 图标（⌘K/活动/关于）；状态栏 28px「N 个任务进行中」文本。
   - 证据：`ConfigManagerSection.tsx:547-566,677-700`；P-IA-9/P-IA-10。
   - 替代：导航动作 **4 图标**（⌘K/活动/历史/关于）；状态栏执行期显示「任务名 + 4px 进度条（有百分比定长 / 无百分比不定态）」，点击开 runs。
   - 如何解决同一问题：入口一致（三种只读视图都有图标位）；状态栏兑现「一边跑一边干别的」。
   - 回归风险：导航条宽度（4 页签 + 4 图标）。对策：`navLayout` 实测兜底，放不下自动进「更多」。
6. **语义色板**
   - 现状：`--dsw-*` 直接散布 449 处；四态实现 ≥5 份（P-VS-2）。
   - 证据：§0 追加实测 + `css:1175-1250`（Badge/Banner）、`css:4133-4166`（kindTag）。
   - 替代：新增 `--cm-*` 中间层（全部由 `--dsw-*` 经 `color-mix()` 派生），四态各三要素（fg/bg/bd），组件一律消费 token。
   - 如何解决同一问题：改一处语义 = 改一处；亮暗/皮肤切换只由 DSH token 传导。
   - 回归风险：大面积替换易漏。对策：源级守卫（新增 `css-token-guard.test.ts`）禁止在状态类里直接写 `--dsw-*`（白名单：token 定义块 + 基础层）。
7. **字号与间距 scale**
   - 现状：10 档字号 / 10+ 档间距（P-VS-1）。
   - 替代：字号 **4 档**（11 / 12 / 12.5 / 13）；间距 **7 档**（2/4/6/8/10/12/16）+ 语义变量 `--cm-sp-*`；行高 2 档（1.25 标题 / 1.5 正文）。
   - 如何解决同一问题：**加源级守卫**（`css-scale-guard.test.ts`：`font-size` 只允许 4 档 + token；`padding/margin/gap` 的 px 只允许 7 档），把散文规范变成红灯。
   - 回归风险：全量替换触碰每一页。对策：M1 一次性完成并跑守卫；映射表见 §4.4。
8. **圆角与阴影**
   - 现状：9 档圆角；3 套阴影 + 3 档环透明度手写。
   - 替代：圆角 **4 档**（4 小标签 / 6 控件 / 8 卡片与分段条 / 999 药丸）；阴影 **2 档**（`--cm-shadow-1` 浮层、`--cm-shadow-2` 弹窗）+ `--cm-ring`（统一焦点/选中环）。
   - 回归风险：低（视觉微调）。
9. **密度基准**
   - 现状：基准字号 12.5、卡片 padding 12、页面 padding 16、行高 1.5；但控件高散落 24/26/28/32/44。
   - 替代：**保留 12.5 基准**（避免全站视觉地震），把控件高收敛为 **3 档**：24（sm 图标按钮/表格行内）/28（标准控件）/32（分段条、状态条）。行高统一 1.5/1.25。
   - 回归风险：少数按钮尺寸变化，可逐页比对。
10. **图标体系**
    - 现状：lucide-react 深路径 + `Icon.tsx` 语义出口 + morphicons 仅 `ExpandChevron`/`CopyStateIcon`。
    - 替代：**保留不动**（已符合不变量 §3-5）。仅新增导航/命令所需图标（若 4 图标方案需要 `history`）。
11. **空态与骨架呈现**
    - 现状：`Skeleton*` 与 `Spinner` 分工已定义且被遵守；空态有 `Empty` 原语与首用 `Stepper`，但各页仍有 `.activityEmpty`/`.libraryListState` 等一次性类。
    - 替代：空态统一走 `Empty`（含参数化 CTA），页专属空态类收敛进原语；骨架/转圈判据不变。
    - 回归风险：低。
12. **DESIGN.md §9 的 15 条 anti-patterns**
    - 替代：重写为 14 条（见 §4.7），新增「token 绕过」「scale 越界」「页面级隐式全局态」三条；删除「第二套入口卡」中与市场无关的表述等。

### 2.3 v2 带产品理由的决定（如推翻，谁来解决那个用户问题）

| v2 决定 | 产品理由 | v3 处理 | 用户问题由谁解决 |
|---|---|---|---|
| 两个同步通道卡恒显示 | 配完 Git 回来发现 WebDAV 卡消失会被当 bug | **推广为 4 通道恒显示**，但未配置恒 56px 矮态；新增「已配置卡可折叠」（v2 拒绝折叠是因为 2 通道放得下，4 通道放不下） | 恒显示保留（卡不消失）；折叠状态不持久化（瞬态），折叠只影响当前视图 |
| 不做手动折叠 | 少一层用户状态与持久化字段 | 4 通道下改为「自动折叠未配置 + 已配置卡可手动折叠」 | 折叠态住组件内存、刷新归零；不新增持久化字段 |
| 分区选择在通道卡内 | `autosync`/`sync-selection` 按通道独立 | **强化**：把加密/解密/同步内容从页面级收进通道卡（+通道配置弹窗），彻底消灭隐式 current channel | 每通道自己的按钮打开自己的弹窗（显式传 channel，v2 §12 第 5 步已做一半） |
| 「维护与诊断」用页脚入口而非第 3 个 Segmented | 低频诊断不该与档案平起平坐 | 保留（环境页 2 子视图） | 不变；救援可达性仍由全局横幅 + 首页健康段 + 命令面板三条保证 |

---

## 3. 交付物 A：新 IA

### 3.1 页面清单（4 页）与唯一职责

| 页面 | PanelId | 回答的问题 | 承担 | 不承担（去别处） |
|---|---|---|---|---|
| **首页** | `home` | 这台机器现在怎么样？我下一步做什么？ | 状态条（健康 + 4 指标段，可点）+ 动作工具栏（立即备份/导出/导入/从其它 agent 导入/一键同步）+ 提醒区（备份失败/同步失败/更新可用）+ 最近产物 3 行 + 首用空态 | 备份位置卡（→ 状态条指标 + 定时备份设置弹窗内「位置」小节）；分区构成卡（→ 导出流程「本次将导出」+ 产物库行展开）；活动视口（→ runs 面板） |
| **产物库** | `library` | 我手上有什么配置产物？能对它做什么？ | 四源混合平铺 + 来源筛选 + 搜索 + 行能力动作（restore/import/pull/install/inspect/download/consult/pin/unpin/delete）+ 底栏 4 入口 | 远端快照的「发生了什么」（→ 同步页日志）；市场陈列（→ market task） |
| **同步** | `sync` | 跨机同步这条管道通不通？怎么配？ | 4 通道卡（git/webdav/s3/gist，恒显示；未配置 56px 矮态）+ 每通道自带：内容摘要/选择、安全摘要、自动同步、动作行、历史快照 + 操作日志 + 指路行 | 远端快照对象（→ 产物库）；加密/解密密码输入（→ 通道配置弹窗） |
| **环境** | `environment` | 这台机器有哪些 DSH 实例？健康吗？ | 2 子视图：**档案**（本机概况 + 档案列表 + 实例启停）+ **维护与诊断**（事故处理 + 磁盘占用 + 会话体检 + 救援模式） | 档案详情原文（弹窗）；磁盘清理细节（弹窗/卡内） |

### 3.2 导航模型与容量

- 一级 = 4 项，图标 + 短标签（复用 v2 `navLayout` 实测 + `MoreMenu` 降级，判定在 `ui/nav-model.ts`）。
- 导航动作区 = 4 个纯图标按钮：⌘K / 活动(runs) / 历史(history) / 关于(about)。
- **未来加页面的规则（确定、可单测）**：新页先按 §3.3 判据判定容器 —— 若是「常驻任务域」才允许进一级导航，且必须先证明
  「中英双语下 4+1 项加 4 图标仍不溢出」（`nav-model` 单测加一条 5 项用例）；否则改为 Task/Modal/页内子视图。
  超过 5 项时，从末项起进「更多 ▾」，**永不隐藏滚动条**。

### 3.3 容器判据（一条可判定规则）

> **有阶段推进或跨步骤状态（多阶段向导）→ Task 面板；无写入决策的只读浏览 → Task 面板（同壳）；单次决策 + 报告（一个弹窗内完成）→ Modal；其余常驻任务域 → 页面。没有第四种容器。**

判定流程图：
```
新功能 → 是否常驻、可独立回答一个问题？ ── 否 → 是否多阶段/有跨步状态？ ── 是 → Task
                │ 是                                              └─ 否 → 是否只读浏览？ ── 是 → Task
                └→ 页面                                          └─ 否 → Modal（单次决策+报告）
```

### 3.4 命令面板定位
第二入口，覆盖：4 个页面、5 个产物库来源、导出/导入/逛市场/发布市场、维护与诊断、事故恢复、救援模式、活动/历史/关于。
命令表仍是纯数据（`src/ui/commands.ts`），壳层 `runCommand` 逐条对应（现有源码级双向守卫保留）。

### 3.5 状态归属（哪些进 run-store）

| 状态 | 归属 | 持久化 |
|---|---|---|
| `panel`（4 值）、`library.*`（sourceFilter/query/sort/expandedKey）、`export`/`import` 向导进度、`sync` 通道配置与勾选、`market` 勾选与决策、`environment.subView`、`profiles` 进行中态 | run-store 切片 | 是（非敏感字段） |
| `task`、`paletteOpen`、`scheduleOpen`、`libraryAction`、`foreignImportOpen`、`starPrompt`、`releaseNotes` | 组件/壳层内存 | 否 |
| 密码/凭据/解密密钥/`secretInputs`/`archiveUnlocked`/`conflictCollector` | 仅内存，白名单外 | **否（硬约束）** |
| runs/history/about 面板内 loading | 组件内存 | 否 |
| 同步页 `SyncUiState` | 保留（镜像 `runStore.sync`）但**拆组件**后收敛到每通道子状态 | 与现状一致 |

### 3.6 救援可达性（不变量 18 复核）
① 全局 SAFE MODE 横幅常驻（改 CSS 类，去掉内联 style）；② 任一页面 ≤2 次交互到维护与诊断：全局面板「去处理」1 次、首页健康段 1 次、命令面板 `recovery.open`/`rescue.open` 1 次；③ 命令面板补齐**两条**命令：`recovery.open`（事故恢复）与 `rescue.open`（救援模式）。

---

## 4. 交付物 B：新视觉体系

### 4.1 Token 层（唯一新增的抽象；全部由 `--dsw-*` 派生）

```css
.section {
  /* 文本 */      --cm-text-1: var(--dsw-alias-label-primary);
                  --cm-text-2: var(--dsw-alias-label-secondary);
                  --cm-text-3: var(--dsw-alias-label-tertiary);
  /* 表面 */      --cm-surface-0: transparent;                    /* 宿主面板底，不铺 */
                  --cm-surface-1: var(--dsw-alias-bg-base);        /* 根底 */
                  --cm-surface-2: var(--dsw-alias-bg-layer-2);     /* 卡片 */
                  --cm-surface-hover: var(--dsw-alias-interactive-bg-hover);
  /* 描边 */      --cm-line-1: var(--dsw-alias-border-l1);
                  --cm-line-2: var(--dsw-alias-border-l2);
  /* 主色 */      --cm-accent: var(--dsw-alias-state-business-primary);
                  --cm-accent-hover: var(--dsw-alias-button-info-hover);
                  --cm-accent-tint: color-mix(in srgb, var(--cm-accent) 16%, transparent);
                  --cm-accent-line: color-mix(in srgb, var(--cm-accent) 45%, transparent);
  /* 四态 × 三要素 */  --cm-ok-fg/--cm-ok-bg/--cm-ok-bd 与 info/warn/error 同构（fg=state-*，bg=fg 10% tint，bd=fg 35% tint）
  /* 尺寸 */      --cm-fs-meta: 11px; --cm-fs-table: 12px; --cm-fs-base: 12.5px; --cm-fs-title: 13px;
                  --cm-sp-1: 2px; --cm-sp-2: 4px; --cm-sp-3: 6px; --cm-sp-4: 8px; --cm-sp-5: 10px; --cm-sp-6: 12px; --cm-sp-7: 14px; --cm-sp-8: 16px; --cm-sp-9: 24px;
                  --cm-r-1: 4px; --cm-r-2: 6px; --cm-r-3: 8px; --cm-r-pill: 999px;
                  --cm-h-sm: 24px; --cm-h-md: 28px; --cm-h-lg: 32px;
  /* 阴影与环 */  --cm-shadow-1: 0 10px 26px color-mix(in srgb, var(--dsw-alias-bg-base) 45%, transparent);
                  --cm-shadow-2: 0 12px 32px color-mix(in srgb, var(--dsw-alias-bg-base) 40%, transparent);
                  --cm-ring: 0 0 0 2px color-mix(in srgb, var(--cm-accent) 18%, transparent);
                  --cm-ring-strong: 0 0 0 2px color-mix(in srgb, var(--cm-accent) 45%, transparent);
  /* 层级 */      --cm-z-raise: 1; --cm-z-sticky: 2; --cm-z-task: 90; --cm-z-modal: 101; --cm-z-pop: 110; --cm-z-toast: 120;
  /* 动效（保留现有 5 个） */ --cm-motion-fast/base/slow + ease-out/ease-in-out
}
```

**硬约束**：颜色/阴影只能取自本层；组件规则里出现裸 `--dsw-*` 即违规（守卫白名单：本 token 块 + 基础层 `.section` 的 `color`/`font-family`）。

### 4.2 字号与行高

| 档 | 值 | 用途 | 迁移来源 |
|---|---|---|---|
| meta | 11px | 徽章、hint、cellMeta、mono 值、日志 | 10 / 10.5 / 11 / 11.5（弱化类） |
| table | 12px | 数据表、密集列表 | 11.5（名列）/ 12 |
| base | 12.5px | 正文、按钮、输入、标签 | 12.5 基准保留 |
| title | 13px | 页面/区块标题 | 13 / 14 |
| — | 删 | 9.5 / 30 | 9.5→11；30 只在死类里 |

行高：**1.25**（标题）/ **1.5**（正文）；删 1 / 1.4 / 1.45 / 1.6。

### 4.3 间距 / 圆角 / 控件高 / 层级

- 间距 **9 档** `--cm-sp-1..9` = 2/4/6/8/10/12/14/16/24。**14 与 24 是数据挣来的**：`14` 被 `session-dialog-mount.test.ts` 硬钉、是用户实测「挤在一起」后定的值（`.snapshotRow{padding:12px 14px}`）；`24` 用于空态 hero 的大内边距与宽间距（3 处）。其余越界值按 §12.2 收敛；**布局偏移**（`-4px` 图标对齐、`22px/38px` 缩进）不走节奏档，进 §12.5 显式豁免白名单。
- 圆角 4 档 = 4/6/8/999；删 3/5/7/9/10。
- 控件高 3 档 = 24/28/32；删 26/44（44 是 taskHead，归 32+padding 或保留为布局尺寸）。
- 层级 6 档语义（上方 token 表）；删 `100`（遮罩并入 modal 档表达）。
- 阴影 2 档 + 2 档环；焦点环统一 `--cm-ring`。

### 4.4 迁移映射表（旧值 → 新档）

| 属性 | 旧 → 新 |
|---|---|
| font-size | 9.5/10/10.5 → 11；11.5 → 11(meta) 或 12(表/名)；12 → 12；12.5 → 12.5；13 → 13；14 → 13；30 → 随死类删 |
| padding/margin/gap | 1,2 → 2；3,4 → 4；5,6 → 6；7,8 → 8；9,10 → 10；11,12 → 12；13,14 → 14；15–20 → 16；21–24 → 24；缩进/负偏移按 §12.5 豁免 |
| border-radius | 3,4 → 4；5,6 → 6；7,8,9,10 → 8；999 → pill |
| line-height | 1 → 1.25；1.4/1.45/1.5/1.6 → 1.5（标题 1.25） |
| z-index | 1 → raise；2 → sticky；90 → task；100/101 → modal；110 → pop；120 → toast |
| box-shadow | 三套 → `--cm-shadow-1/2`；环 → `--cm-ring` |

### 4.5 组件清单（保留 / 新增 / 合并 / 删除）

| 处置 | 项 |
|---|---|
| **保留**（成熟，不动行为） | Button/IconButton/StatusDot/Badge/Banner/Segmented/Card/Field/SectionTitle/Empty/Checkbox/Stepper/Spinner/Skeleton*（common/Skeleton.tsx）/Collapse/ViewSwitch/Modal(+Header/Body/Footer)/ConfirmDialog/Select/MoreMenu/InfoHint/CopyButton/ToastViewport/ErrorBanner/ErrorList/ReportView/ProgressBar/ContentPicker/SectionComposition/CommandPalette/RunsCenter/Icon(ExpandChevron/CopyStateIcon) |
| **新增** | `--cm-*` token 层；`css-scale-guard.test.ts` + `css-token-guard.test.ts`（源级守卫，把规范变成红灯）；`.stack/.row` 两个布局类（用 gap token 取代散落 margin） |
| **合并** | `.kindTag*`（5 类）折叠为 `.tag[data-tone]`，与 Badge 共用 `--cm-{tone}-*`；`.banner/.badge` 同样消费 token；★ 保留类名兼容由 CSS 别名过渡（M1 完成后再删） |
| **删除** | 11 个死类（§1 P-VS-6）；9 个媒体外重复块的后定义副本（合并进首定义）。**保留** `.dialogMask`/`.dialogCard` —— 它们是 `common/Modal.tsx:112,114`（Radix）在用的活类；v2 DESIGN 所说「仅余注释」指的是**组件内联用法**已迁移，而非类本身 |

### 4.6 密度基准与动效纪律

- 密度：基准 12.5px；列表行 **48px**（标题 18 + meta 16 + padding 7×2 ≈ 48；产物库现 52 → 收敛，仍为高密度）；表格行 32px；卡片 padding 12px；页面 padding 16px（窄视口 12px）。
- 动效：保留 v2 全集（页面/弹窗/面板/通知入场、状态点脉冲、骨架 shimmer、折叠 180ms、进度 300ms）；`prefers-reduced-motion` 下关装饰性动效、**保留旋转与不定态进度**；形变仅 `ExpandChevron`/`CopyStateIcon`，硬约定 `reducedMotion="user"` + `spring={MORPH_SPRING}`。新增：禁止用 `transition: all`（现无，写入 anti-pattern）。

### 4.7 亮/暗与皮肤验证点（Phase 3 逐项截图）
1. 四态徽章/横幅在 layer-2 表面上的对比度；2. 焦点环（键盘 Tab）在亮/暗两套下可见；3. diff 红绿（`.diffCellAdd/Del`）；4. 状态点 4 色；5. 主色按钮上的 Spinner（currentColor）；6. `.section` 不铺底色（避免与宿主面板底色形成通栏色块 —— v2 已证）；7. 原生滚动条与自绘弹层（Select/MoreMenu/InfoHint）在暗色下不出现系统亮底；8. 皮肤切换（宿主 presets）下所有 `color-mix` 派生仍可读。

---

## 5. 交付物 C：迁移映射

### 5.1 PanelId / TaskKind / MainView 新旧对照

| 旧 | 新 | 说明 |
|---|---|---|
| `overview` | `home` | 改名；`panel` 持久化旧值映射 |
| `library` | `library` | 不变 |
| `import` | `library`（+ 不自动开面板） | 删除死值；旧载荷落在产物库 |
| `sync` | `sync` | 不变 |
| `market` | `library`（`sourceFilter='market'`） | 市场退出导航；旧载荷落在产物库并预置来源筛选 |
| `profiles` | `environment` | 改名；语义升级为环境 |
| （更旧）`snapshots`/`recovery`/`lifecycle`/`about`/`history`/`more`/`export` | 现逻辑保留 → `home`/`library`/`environment` | 复用现有 `parsePersistedState` 分支 |
| `MainView`（`view` 字段） | **删除** | parse 时忽略该字段（不再要求存在、不再镜像写回） |
| `SnapshotsSubTab`/`snapshots.subTab` | **删除** | 旧载荷忽略；首页弹窗标题改用专属键 `home.schedule.title` |
| `TaskKind 'publish'` | **删除** | task 不持久化，无存量兼容问题 |
| `SnapshotsStoreSlice.importBackup` | 挪为 `LibraryStoreSlice.pendingZip` | 外部 agent 导入通道；**该字段从不落盘**（`toPersistedState` L1123-1124 恒写 null），故**无需旧载荷迁移**，只挪运行时归属 |

### 5.2 旧载荷兼容（`dsh.cfgMgr.state.v1`）

- **不 bump key、不 bump `v`**：沿用现有「同 key + 字段级映射」先例（`parsePersistedState` L1207-1253）。
- 旧载荷必须：① 不崩溃（JSON 解析失败 → 返回 null → 默认状态）；② 不让页面消失（旧 `panel` 值全部有映射，unknown → 默认页 `home`）；
  ③ 不丢向导进度（`export`/`import` 两个对象原样保留）。
- 迁移用例（`run-store.test.ts` 新增）：旧 `market` → `library`+筛选；旧 `profiles` → `environment`；旧 `import` → `library`；
  旧 `snapshots.subTab='recovery'` → `environment` + `profiles.subView='maintenance'`；无 `view` 字段的载荷仍可解析；
  旧 `snapshots.importBackup` → `library.pendingZip`；`more.moreSub` 忽略不报错（现有用例保留）。
- 敏感字段：`toPersistedState()` 白名单与新字段同步（`pendingZip` 只含 `{zipPath,name,containerType?}`，非敏感）。

### 5.3 组件文件处置清单

| 文件 | 处置 |
|---|---|
| `client/ConfigManagerSection.tsx` | 改：NAV_ITEMS 5→4；market 页面 case 删；动作区 3→4 图标；SAFE MODE 横幅去内联 style；状态栏接任务进度；命令分发增 `market.open`/`market.publish.open`/`rescue.open`，删 `go.market` |
| `client/run-store.ts` | 改：PanelId 4 值、删 MainView/`snapshots.subTab`/`publish`、`importBackup`→`library.pendingZip`、parse 映射重写、持久化白名单同步 |
| `client/sync/SyncPanel.tsx` | 拆：`SyncChannelCard.tsx`（每通道一卡，含内容摘要/安全摘要/动作/自动同步/快照）+ `SyncPanel.tsx`（页面编排 + 日志 + 指路）；页级加密/解密卡删除，迁入 `ChannelConfigDialog` |
| `client/snapshots/DiskUsageCard.tsx` | 移 → `client/environment/maintenance/DiskUsageCard.tsx` |
| `client/snapshots/BackupScheduleCard.tsx` | 移 → `client/home/BackupScheduleCard.tsx`（唯一调用点是首页弹窗） |
| `client/snapshots/RestorePlanView.tsx` | 移 → `client/library/RestorePlanView.tsx`（唯一调用点是恢复动作） |
| `client/recovery/SessionHealthDialog.tsx` | 新（从 `RecoveryPanel.tsx` 拆出 434 行弹窗） |
| `client/environment/maintenance/MaintenanceView.tsx` | 新（RecoveryPanel 主体更名/瘦身，状态机与文案逐字保留） |
| `client/home/HomePanel.tsx` | 改：删备份位置卡/分区构成卡/活动表，保留状态条+工具栏+提醒+最近产物 3 行+首用空态 |
| `client/library/LibraryPanel.tsx` | 改：底栏 3→4 入口（+发布到市场） |
| `client/market/MarketPanel.tsx` | 改：只作为 Task 渲染（删页面用法）；`subView` 由 task payload 指定 |
| `client/overview/`、`client/snapshots/SnapshotsPanel*` | 已不存在（v2 已删）；复核无残留 |
| `client/config-manager.module.css` | 重排为 §1 TOKENS / §2 BASE / §3 PRIMITIVES / §4 PATTERNS / §5 SHELL / §6 PAGES / §7 MOTION；删死类与重复块；全量套 token |

### 5.4 新增纯逻辑模块（`src/ui/`，node 可测）

| 模块 | 内容 | 测试 |
|---|---|---|
| `ui/nav-model.ts` | 保留（4+1 项与 4 图标下的容量判定） | 现有 + 新增 5 项用例 |
| `ui/home-view.ts`（或复用 `overview-view.ts`） | 首页指标/健康/提醒/首用空态投影（删分区构成与活动投影） | 现有测试改造 |
| `ui/sync-channel-view.ts` | 每通道卡的状态投影（折叠态、安全摘要、内容摘要、按钮可用性）—— 把 SyncPanel 里的可测判定下沉 | 新增 |
| `ui/commands.ts` | 20 条命令（+market.open/market.publish.open/rescue.open/import.foreign，renamed go.*） | 现有双向守卫扩展 |
| `ui/state-migration.ts`（可选） | 抽 `parsePersistedState` 的映射表为纯函数便于穷举测试 | 新增 |

### 5.5 守卫锚点更新清单

| 守卫 | 需改什么 |
|---|---|
| `src/client/icon-layer-guard.test.ts` | 若新增导航图标（history）：扫源码字符串字面量规则不变，无需改锚点；新增图标走三处登记 |
| `src/client/common/info-hint-guard.test.ts` | `MOVE_PINS` 里同步页/首页路径与文案键随拆分/改名更新（sync → SyncChannelCard、snapshots.subTab.schedule → home.schedule.title） |
| `tests/client/locale-hardcode-guard.test.ts` | 新增/改名字典键；删除死键（含 `snapshots.subTab.*`、`task.title.publish`） |
| `src/client/common/plan-text-redaction.test.ts` | `RENDER_POINTS` 文件路径：`snapshots/*` → 新位置；SyncPanel 拆分后的渲染点重登记（保持「每点恰 1 次 + 裸写法 0 次」） |
| `src/client/common/runs-center-guard.test.ts` | `RunsCenter` 仍住 `common/`，无需改；若移动需改 |
| `src/client/common/menu-scroll-guard.test.ts` | Select/MoreMenu 未动，无需改 |
| `src/client/common/http-usage-guard.test.ts` | 组件禁直接 fetch —— 拆分后 `SyncChannelCard` 必须继续走 api 类；守卫扫描范围覆盖新文件 |
| `src/client/import/foreign-import-view-guard.test.ts` | 外部 agent 导入路径若随 `library.pendingZip` 改动，需同步锚点 |
| `src/client/bundle-selfcontained.test.ts` | 无新增依赖，应继续绿；build 后跑 |
| **`src/client/snapshots/files-layout.test.ts`** | 读 CSS + `snapshots/DiskUsageCard.tsx` + `library/LibraryPanel.tsx`；硬钉 `.diskUsageCard` 的 height/min-height/max-height、`--cm-disk-card-h:\d+px`、`.artifactList`/`.libraryFilters`/`.librarySearch`/`.libraryFooter` —— **M1 改 CSS 与 M3 搬 DiskUsageCard 都必须同步更新本文件路径与类名断言** |
| **`src/client/recovery/session-dialog-mount.test.ts`** | 读 `recovery/RecoveryPanel.tsx`（M3 拆出 `SessionHealthDialog` 会打断 `indexOf('function SessionHealthDialog(')…indexOf('function RecoveryPanel(')` 窗口 → 必须改为读新文件）+，并**硬钉三条 CSS**：`.snapshotRow{padding:12px 14px}`、`.snapshotList.reportScroll{padding:10px 12px 10px 10px}`、`.snapshotList{gap:10px}` |
| **新增** `src/client/css-scale-guard.test.ts` | 断言 module.css 的 `font-size`/`border-radius`/`z-index`/`gap`/`padding`/`margin` 只用允许档位或 token；显式白名单（`%`/`auto`/`calc(`/`0`/`1px` 发丝线/`ch` 单位） |
| **新增** `src/client/css-token-guard.test.ts` | 断言组件规则中不出现裸 `--dsw-*`（token 定义块与基础层白名单除外）；断言四态只经 `--cm-{tone}-*` |

---

## 6. 交付物 D：功能覆盖矩阵

> 左列 = 现有全部用户可达能力（按页/容器分组，证据列省略，见子代理盘点与代码）；右列 = v3 落点。
> **空 = 被砍**。本表**无空白格**；`★` 表示落点相对现状有变化，变化理由见括注。

### 6.1 全局（壳层）

| 能力 | v3 落点 |
|---|---|
| 一级导航 5 页签 | 4 页签（★ 市场退出导航，见 §2.2-1） |
| 导航「更多 ▾」降级 | 保留（`nav-model` + `MoreMenu`） |
| ⌘K 命令面板 | 保留；命令 17→19（★ 见 6.7） |
| 导航动作：⌘K/活动/关于 | 4 图标：⌘K/活动/历史/关于（★ 补历史图标，P-IA-9） |
| 全局 SAFE MODE 横幅 + 「去处理」 | 保留（★ 去内联 style，class 化） |
| 状态栏：状态点 + 就绪/进行中 + 版本 | 保留；★ 执行期显示任务名 + 4px 进度条 |
| 状态栏「N 个任务进行中」→ runs | 保留（整句可点） |
| Toast 通知视口 | 保留 |
| Star 引导弹窗（去点 Star / 不再提示） | 保留 |
| 版本更新内容弹窗（确认/永不提示） | 保留 |
| 救援可达性三条 | 保留 + 命令补 `rescue.open`（★ 见 §3.6） |

### 6.2 首页

| 能力 | v3 落点 |
|---|---|
| 状态条健康段（有待处理时→环境·维护） | 保留（→`environment`+`subView='maintenance'`） |
| 4 指标段跳转（备份文件/安全快照/定时备份/远程同步） | 保留（定时备份→本页弹窗） |
| [立即备份] | 保留 |
| [导出 ZIP] → export task | 保留 |
| [导入] → import task | 保留 |
| [从其它 agent 导入] | 保留 |
| [一键同步] → 同步页 | 保留 |
| [活动 →] → runs | 保留 |
| 备份目录复制 | 删除卡（★ 目录与复制迁入「定时备份设置」弹窗「位置」小节，server 状态条指标覆盖日常查看） |
| 活动行摘要复制 | 删除该视口（★ 活动迁 runs/history 面板，面板内已有导出与复制；见 6.6） |
| 首用空态三步 + 2 按钮 | 保留 |
| 定时备份设置弹窗（加载/保存/立即备份） | 保留（★ 增「备份位置」小节） |
| （新增）提醒区：备份失败/同步失败/更新可用 | 新增（★ 补齐 v2 §7 承诺） |
| （新增）最近产物 3 行 → 产物库并展开该行 | 新增（★ 补齐 v2 §7 承诺） |

### 6.3 产物库

| 能力 | v3 落点 |
|---|---|
| 来源筛选（全部/快照/备份文件/远端/市场） | 保留 |
| 搜索 / 排序 / 行展开 | 保留 |
| 行能力 restore | 保留（LibraryActions 恢复计划→确认→报告） |
| 行能力 import（含加密先解锁文案） | 保留 |
| 行能力 pull（远端→落地 ZIP→导入） | 保留 |
| 行能力 install（市场条目→直达） | 保留 |
| 行能力 inspect（查看与对比） | 保留 |
| 行能力 download | 保留 |
| 行能力 consult（迁移前咨询） | 保留 |
| 行能力 pin/unpin | **不适用**：已由用户 2026-10-03 要求下线（非 v3 砍除）；v3 只清理 UI 侧死代码（union/字典），**保留路由与引擎**（§3-17） |
| 行能力 delete（三种确认） | 保留 |
| 来源失败提示 + 重试 | 保留 |
| 底栏 导出/导入/逛市场 | 保留；★ 补第 4 项「发布到市场」（市场退出导航后的入口，P-IA-1） |
| 7 个弹窗（咨询/拉取进度/恢复计划/恢复确认/删除确认/查看对比/恢复报告） | 保留 |

### 6.4 同步

| 能力 | v3 落点 |
|---|---|
| 4 通道卡恒显示（git/webdav/s3/gist） | 保留；★ 未配置 56px 矮态 + 已配置卡可折叠（P-IA-8） |
| [配置] → ChannelConfigDialog（git/webdav/s3/gist 表单） | 保留；★ 加密/解密设置迁入此弹窗（P-IA-7） |
| GitHub 登录设备流（发起/取消/轮询）/仓库选择/新建仓库 | 保留（弹窗内） |
| [断开]→确认→clearChannel | 保留 |
| 同步内容（分区勾选/会话数量/逐会话点名/重置） | 保留；★ 只在**该通道卡内**（不再有页面级「当前通道」卡） |
| [一键同步] | 保留（卡内） |
| [推送]→预览→执行→结果 | 保留 |
| [拉取]→差异预览 | 保留 |
| 历史快照 Select + 刷新 | 保留（卡内） |
| 自动同步开关 + 间隔 | 保留（卡内） |
| 加密开关 + 导出密钥 + 加密密码×2 | 保留；★ 迁入通道配置弹窗 |
| 解密密码 + 删除已保存密码 | 保留；★ 迁入通道配置弹窗 |
| 操作日志 SyncLogList（含重试/骨架/空态） | 保留 |
| 「远端快照已搬到产物库」指路行 | 保留 |
| unreadable 快照常驻告知 | 保留 |
| 页面级加载失败 + 重试 | 保留 |
| 5 弹窗（通道配置/断开确认/分区选择/push 预览/push 结果/pull 差异/一键同步差异确认含回滚） | 保留 |

### 6.5 环境（档案 + 维护与诊断）

| 能力 | v3 落点 |
|---|---|
| Segmented 档案/维护 | 保留 |
| 实例行 打开/停止（当前实例禁用） | 保留 |
| 启动被挡 → 终端命令 + 复制 | 保留 |
| 启动回执 打开/复制 URL/关闭 | 保留 |
| 复制回执 复制安装命令/关闭 | 保留 |
| 新建档案（名称+模板+校验） | 保留 |
| 刷新列表 | 保留 |
| 行 详情弹窗（只读，原文 redact） | 保留 |
| 行 启动/停止/复制/重命名/删除 | 保留 |
| 5 弹窗（详情/复制/重命名/停止/删除确认） | 保留 |
| 崩溃归因 Banner | 保留 |
| 救援模式 进入（danger 确认）/退出 | 保留 |
| 残留副本删除 + 解除 SAFE MODE | 保留 |
| 磁盘占用 刷新/回收勾选/立即清理+确认 | 保留（★ 卡搬 maintenance/） |
| 会话体检 打开/扫描/逐条修复/一键修复/台账回滚/下载 ZIP/离线命令 | 保留（★ 弹窗拆文件） |
| incident 行点击/执行恢复/重试/放弃 | 保留 |
| 残留锁回收 | 保留 |
| SAFE MODE 解除 | 保留 |
| 面板错误重试 | 保留 |
| 维护项顺序：事故→磁盘→体检→救援 | 保留 |

### 6.6 只读视图与流程面板（Task）

| 能力 | v3 落点 |
|---|---|
| export（选内容/安全选项/命名/进度/报告/构成卡） | Task（保留） |
| import 6 阶段（来源/ZIP/咨询/冲突/路径映射/选择/密钥补录/确认/执行/结果） | Task（保留） |
| 从其它 agent 导入 | Task（保留；★ 状态字段 `library.pendingZip`） |
| market 逛市场（列表/筛选/详情/免责→导入审阅向导/安装直达） | Task only（★ 页面用法删除） |
| market 我的配置（上传向导/登录/更新/装回本地/PR 链接） | Task（★ 由 `market.publish.open` 或市场内子视图直达） |
| runs 运行中心（卡片/终止/跳过/决策框/锁回收/保留期 ⓘ） | Task（保留） |
| history 迁移历史（过滤/导出 JSON/CSV） | Task（保留；★ 导航补图标入口） |
| about 关于（状态/更新检查/诊断/CLI 命令/反馈/作者） | Task（保留） |
| Task 外壳（返回/仅只读 Esc/不重挂） | 保留 |

### 6.7 命令面板（17 → 20）

| 旧 id | 新 id | 备注 |
|---|---|---|
| `go.overview` | `go.home` | 改名 |
| `go.library` | `go.library` | 不变 |
| `go.sync` | `go.sync` | 不变 |
| `go.market` | **删** | 市场不再是一级页 |
| `go.profiles` | `go.environment` | 改名 |
| — | `market.open` | ★ 新增（task 'market'） |
| — | `market.publish.open` | ★ 新增（task 'market' + subView myconfigs） |
| `library.source.all/snapshot/backupFile/remote/market` | 同 | 5 条不变 |
| `export.open` | 同 | 不变 |
| `import.open` | 同 | 不变 |
| — | `import.foreign` | ★ 新增（从其它 agent 导入：开导入面板并停在「来源选择」，与首页工具栏同一入口） |
| `maintenance.open` | 同 | 不变 |
| `activity.open` | 同 | → runs |
| `history.open` | 同 | 不变 |
| `about.open` | 同 | 不变 |
| `recovery.open` | 同 | 事故恢复 |
| — | `rescue.open` | ★ 新增（救援模式，直达维护与诊断救援卡） |

**覆盖结论**：原能力 **0 项被砍**（3 项「备份位置卡展示」「首页活动视口」「市场页签」为**落点迁移**而非删除，均有承接；
其中「首页活动行复制」由 runs/history 面板的既有复制/导出承接）。新增 5 项（提醒区/最近产物/底部发布入口/两条命令）。

---

## 7. 文本线框图（564×720，纵向预算）

> 预算口径：`.shellNav` 46px + `GlobalBanner`（仅 SAFE MODE 时 ≈44px）+ `.shellMain` 剩余 + `.statusBar` 28px。
> 常态（无横幅）内容区 ≈ 646px；有横幅 ≈ 602px。页内 padding 16（窄视口 12）。

### 7.1 首页
```
┌─ shellNav 46 ───────────────────────────────────────────────┐
│ [首页][产物库][同步][环境]              ⌘K 活动 历史 关于  │
├─ shellMain ≈646 ────────────────────────────────────────────┤
│ ╭ statStrip 40 ───────────────────────────────────────────╮ │
│ │ ● 就绪  备份文件 12·2h前  快照 3  定时 每24h  同步 Git  │ │
│ ╰─────────────────────────────────────────────────────────╯ │
│ ╭ toolRow 40 ─────────────────────────────────────────────╮ │
│ │ [立即备份][导出 ZIP][导入][其它 agent][一键同步]   [活动]│ │
│ ╰─────────────────────────────────────────────────────────╯ │
│ ╭ 提醒区（仅异常时；每条 32，最多 3 条）─ 0~96 ───────────╮ │
│ │ ⚠ 最近一次定时备份失败                          [去设置] │ │
│ ╰─────────────────────────────────────────────────────────╯ │
│ ╭ 最近产物（3 行 × 44 = 132）─────────────────────────────╮ │
│ │ 本机快照 · 10-01 22:36   1,204 条目 · 42 插件            │ │
│ │ 备份文件 · dsh-config-1b.zip   自动 · 12.1 MB            │ │
│ │ 远端快照 · 09-28 19:03   Git · 12 分区                   │ │
│ ╰─────────────────────────────────────────────────────────╯ │
│ 剩余高度由「最近产物」卡 flex:1 吃掉（Canvas 纪律）；行多则卡内滚 │
├─ statusBar 28 ──────────────────────────────────────────────┤
│ ● 就绪                                   插件 vX · DSH Y   │
└─────────────────────────────────────────────────────────────┘
首用空态替换「最近产物」卡：三步 Stepper（备份→导出→导入）+ [立即备份][一键同步]，整卡 fill。
内滚条件：提醒 >3 条或最近产物 >3 行 → 卡内滚动，页面不滚。
```

### 7.2 产物库
```
├─ shellMain ≈646 ────────────────────────────────────────────┤
│ 来源条 32： [全部 6][本机快照 3][备份文件 2][远端 1][市场 0]│
│ 搜索行 32： 🔍 搜索文件名 / 备注 / 快照 id            [刷新]│
│ 计数行 22： 共 6 个 · 2 个加密                              │
│ ┌ 列表 flex:1（≈446；行 48，约 9 行）─────────────────────┐ │
│ │ ▸ 本机快照 · 10-01 22:36  [置顶]  [恢复] [⋯]             │ │
│ │   1,204 条目 · 42 插件                                   │ │
│ │ ▸ 备份文件 · dsh-config-1b.zip [加密] [导入] [⋯]         │ │
│ │   自动 · 12.1 MB                                         │ │
│ │ ▸ 远端快照 · 09-28 19:03 [当前基线] [拉取] [⋯]           │ │
│ │ ▸ 市场配置 · 某配置名 [将改动] [安装] [⋯]                │ │
│ │ ⋮ 列表内滚（页面不滚）                                   │ │
│ └──────────────────────────────────────────────────────────┘ │
│ 底栏 48： 6 个 · 2 加密 ⓘ   [导出][导入][逛市场][发布市场] │
└─ statusBar 28 ──────────────────────────────────────────────┘
内滚条件：>9 行；底栏恒贴底（flex:none）。
```

### 7.3 同步
```
├─ shellMain ≈646 ────────────────────────────────────────────┤
│ SectionTitle 34：同步 · 跨机同步这条管道                    │
│ ┌ Git 通道卡 已配置，可折叠（展开 ≈176 / 折叠 44）────────┐ │
│ │ Git · 已配置 · 令牌已保存                        [⌄][⋯] │ │
│ │ 上次同步 2h前 · 12 分区 · 含历史会话                     │ │
│ │ 自动同步 [开] 每 24h                                     │ │
│ │ [一键同步 primary][推送][拉取]   快照 [最新 ▾][刷新]     │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌ WebDAV 通道卡：未配置 56 ───────────────────────────────┐ │
│ │ WebDAV · 未配置                                  [配置]  │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌ S3 通道卡 56 / Gist 通道卡 56（同 WebDAV 矮态）─────────┐ │
│ 同步记录（日志表，flex:1 内滚）                             │
│ 指路行 28：远端快照已移至产物库 →  [去看看]                 │
└─ statusBar 28 ──────────────────────────────────────────────┘
常态预算：176 + 56×3 + 34 + 28 = 406，日志余 ≈240（≥6 行）。
内滚条件：日志表自身内滚；已配置通道 >2 时保证至少一张展开、其余可折叠。
4 通道全配置时：默认折叠 3 张（只展开最近使用），每张展开态 176 → 折叠 44，总高 44×3+176+34+28 = 502，日志余 ≈144。
```

### 7.4 环境（档案 / 维护与诊断）
```
├─ shellMain ≈646 ────────────────────────────────────────────┤
│ SectionTitle 34 + Segmented 32：[档案][维护与诊断]          │
│ ┌ 运行状态卡 96 ──────────────────────────────────────────┐ │
│ │ 当前档案 web · 0.1.5-rc.1 · 42 插件                      │ │
│ │ cmtest :3099 本插件启动   [打开][停止]                   │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌ 新建档案卡 88 ──────────────────────────────────────────┐ │
│ │ [名称输入________________][模板 ▾][新建]                 │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌ 档案列表 flex:1（行 56；表头 28）───────────────────────┐ │
│ │ 档案 4 个 · 2 个运行中                          [刷新]    │ │
│ │ web    当前运行 · 42 插件                   [详情]        │ │
│ │ cmtest :3099 运行中                    [停止][详情][⋯]   │ │
│ │ desktop 桌面独占 · 不可启动                [详情]        │ │
│ │ prova  可启动                          [启动][详情][⋯]   │ │
│ └──────────────────────────────────────────────────────────┘ │
└─ statusBar 28 ──────────────────────────────────────────────┘
维护与诊断子视图（同区）：
  崩溃归因 Banner(0/44) → 救援模式卡 88 → 残留副本卡(0/72) →
  磁盘占用卡 420 → 会话体检卡 88 → SAFE MODE 卡(0/96) → incident 列表 flex:1
  纵向总计 >646 ⇒ 由 .shellMain 整页滚动（该子视图允许页面滚，其余页禁止）。
```

### 7.5 Task 面板与命令面板
```
Task（覆盖 shellContent，不盖 nav/banner/statusBar）：
┌ taskHead 44： [← 返回首页]  导出配置   ● Step 2/4 ───────────┐
│ taskBody flex:1（内部滚动；内容宽 532）                       │
└──────────────────────────────────────────────────────────────┘
命令面板（Modal，min(640,95%)×min(600,92%)）：
┌ 🔍 输入命令… ────────────────────────────────────────────────┐
│ 导航 ── 首页 / 产物库 / 同步 / 环境 / 活动 / 历史 / 关于      │
│ 流程 ── 导出配置 / 导入配置 / 逛市场 / 发布到市场             │
│ 产物 ── 全部 / 本机快照 / 备份文件 / 远端快照 / 市场产物      │
│ 维护 ── 维护与诊断 / 事故恢复 / 救援模式                      │
└──────────────────────────────────────────────────────────────┘
```

---

## 8. 待裁决选项（一次性，含推荐）

| # | 选项 | 推荐 | 影响 |
|---|---|---|---|
| Q1 | 一级导航 **4 项（市场退出）** vs 保持 5 项 | **4 项** | 兑现 v2 定案、消灭双容器；代价 = 市场入口改为流程（底栏/⌘K） |
| Q2 | PanelId **改名** `overview→home`、`profiles→environment` vs 保留旧名仅换显示文案 | **改名** | 命名债清零；代价 = 迁移映射与守卫锚点更新（已列 §5） |
| Q3 | 字号基准 **保留 12.5px + 收敛 4 档** vs 全面整数化（12px 基准） | **保留 12.5** | 避免全站视觉地震；半像素仅剩基准一档（有明确理由），其余全整数 |
| Q4 | 导航动作 **4 图标（+历史）** vs 保持 3 图标 | **4 图标** | 三个只读视图入口一致；宽度由 navLayout 兜底 |
| Q5 | 同步页 **已配置通道卡折叠**（4 通道） vs 恒全展开 | **可折叠** | 4 通道撑爆画布；折叠态不持久化 |

## 9. 决策日志（v3）

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-10-05 | IA 方向**继承 v2**（4 页 + Task + ⌘K），只做「兑现 + 纠偏」 | v2 三根因已解决（证据 §2.1）；全盘换方向会丢已验证的产物库模型与 Task 外壳 |
| 2026-10-05 | 视觉体系**重做**（token 中间层 + 4/7/4 档 scale + 源级守卫） | v2 明确把 token/字号列为非目标；实测 10 档字号/9 档圆角/9 个媒体外重复块，散文规范无法阻止漂移 |
| 2026-10-05 | 市场退出导航、发布进流程 | 消灭 `MarketPanel` 双容器与两套状态（P-IA-1） |
| 2026-10-05 | 加密/解密/分区全部归通道 | 消除隐式「当前通道」页面态（P-IA-7），强化不变量 19 |
| 2026-10-05 | 新增 `css-scale-guard`/`css-token-guard` | 把 DESIGN.md 的 scale 从散文变成红灯 |
| 2026-10-05 | TaskKind 删 `publish`；`importBackup`→`library.pendingZip` | 清除死值与错位归属 |

## 10. 与 v2 的偏差说明（实现期须遵守）
1. v2 的「两个同步通道卡」假定通道只有 2 个；v3 按 4 通道重算（折叠机制）。
2. v2 的「不做手动折叠」在 4 通道下作废（理由见 §2.3）。
3. v2 的「加密/解密并入通道配置弹窗」v3 执行（当前实现是页面级，属偏差）。
4. v2 的「首页移出三块」v3 执行（当前实现未执行）。
5. v2 的「市场不再是页签」v3 执行（当前实现未执行）。

## 11. 实施批次（Phase 1 确认后一口气做完）
- **M1 设计系统落地**：`--cm-*` token 层 + CSS 重排（§1-§7）+ 全量套用 scale + 删死类/重复块 + 两个新守卫；不动 IA。门禁全绿。
- **M2 外壳与导航**：4 页签 + 4 图标 + 状态栏进度 + SAFE MODE class 化 + 命令表（落定 20 条）+ 容器判据落地（nav-model 5 项用例）。
- **M3 逐页迁移**：首页瘦身 → 产物库底栏 → 同步拆卡（SyncChannelCard + 加密入配置弹窗）→ 环境（档案不动、维护拆文件）。每页迁完立即跑门禁。
- **M4 流程容器迁移**：market 只作 Task；export/import 外壳去页面 padding；Task/TaskShell 复核。
- **M5 run-store 迁移**：PanelId 4 值 + 删 MainView/subTab/publish + `pendingZip` + parse 映射重写 + 旧载荷用例 + 守卫锚点更新。
- **M6 收口**：删旧组件与旧样式（零活引用才删）、`DESIGN.md`/`AGENTS.md`/`known-pitfalls.md` 同步、v2 文档标注作废、`docs/design/2026-10-05-ui-redesign-v3.md` 定稿。

**每批门禁**：`npm run typecheck` / `typecheck:tests` / `npm test` / `npm run build` / `node --test src/client/bundle-selfcontained.test.ts`（build 后）/ 新增两个 CSS 守卫。

**环境注意（本机实测，2026-10-05）**：`npm run build` 必须把构建期 `TEMP`/`TMP` 指向**工作区内**目录（如 `.tmp/buildtmp`，已 gitignore），否则 `rolldown-plugin-dts` 的 `tsc.exe` 在 `%TEMP%` 下 `mkdir … Access is denied`、build 退出码 1（嵌套子进程写工作区外被拒；工作区内 TEMP 下 build=0）。命令：`$env:TEMP=$env:TMP=(Join-Path (Get-Location) '.tmp\buildtmp'); npm run build`。

**改动前基线（2026-10-05 22:44，HEAD e6b5e83）**：typecheck=0 / typecheck:tests=0 / test=0（3690 项：3688 pass / 2 skipped / 0 fail）/ build=0（绕行后）/ bundle-guard=0（1 pass）。此基线即 §11 汇报的 before 侧。

---

## 12. M1 预研（执行清单，2026-10-05 实测；不依赖 §8 裁决，除 Q3 字号基准）

### 12.1 逐属性迁移量（module.css）
| 属性 | 声明数 | 现档位数 | 目标档位 |
|---|---|---|---|
| `font-size` | **139** | 10（9.5/10/10.5/11/11.5/12/12.5/13/14/30） | 4（11/12/12.5/13）；30 随死类删 |
| `border-radius` | **72** | 11（0/3/4/5/6/7/8/9/10/50%/999） | 4 + 豁免（0、50%） |
| `line-height` | **25** | 5（1/1.4/1.45/1.5/1.6） | 2（1.25/1.5） |
| `z-index` | **8** | 7（1/2/90/100/101/110/120） | 6 语义（100 并入 modal） |
| `padding` / `margin` / `gap` | 109 / 51 / 129 | — | 值域收敛到 8 档 |

### 12.2 间距类「越界值」全量（实测 40 处，带行号）
| 值 | 处数 | 示例（行号） | 处置 |
|---|---|---|---|
| 5px | 14 | L126 gap / L1871 padding / L2037 margin | →4 或 6 |
| 3px | 7 | L1808 gap / L2135 margin-top / L3365 padding | →2 或 4 |
| 7px | 4 | L1153 gap / L1181 padding | →6 或 8 |
| 9px | 4 | L1925 padding / L2521 / L4075 / L4492 | →8 或 10 |
| 18px | 3 | L3365、L3430 树缩进；L3460 gap | →16 |
| 28px | 3 | L1637 空态 hero padding；L3028 gap；L4239 缩进 | →24 |
| 38px | 2 | L1025、L1030 深层缩进 | **豁免**（布局偏移） |
| 22px | 1 | L3874 缩进 | **豁免**（布局偏移） |
| −4px | 1 | L1959 图标对齐负外边距 | **豁免**（布局偏移） |

（14px 已入档，故不计入越界。）
### 12.3 读 CSS 的既有守卫（M1/M3 必须先登记；同步更新锚点，不得改意图放行）
1. `src/client/snapshots/files-layout.test.ts` —— 读 CSS + `DiskUsageCard.tsx` + `LibraryPanel.tsx`；钉 `.diskUsageCard` 三高度、`--cm-disk-card-h:\d+px`、`.artifactList/.libraryFilters/.librarySearch/.libraryFooter`。
2. `src/client/recovery/session-dialog-mount.test.ts` —— 读 `RecoveryPanel.tsx` + CSS；**硬钉 `.snapshotRow{padding:12px 14px}`**、`.snapshotList.reportScroll{padding:10px 12px 10px 10px}`、`.snapshotList{gap:10px}`。M3 拆出 SessionHealthDialog 会打断其 `indexOf('function SessionHealthDialog(')…indexOf('function RecoveryPanel(')` 窗口 → 必须改为读新文件。
3. `src/client/common/info-hint-guard.test.ts`（t11-3）—— 用 `^\.infoHintBtn([^{]*):focus-visible\s*\{` **行首锚定**；规则必须留在行首、保留 `outline:`、且带 `[data-open]` 限定。

### 12.4 token 替换范围（`--dsw-*` 共 443 处）
| 类别 | 处数 | M1 处置 |
|---|---|---|
| 四态/主色（`state-*` + `button-info-*`） | **140**（business-primary 75 / error 29 / warn 17 / success 16 / info 1 / button-info 2） | **全部换 `--cm-{tone}-*`**；守卫禁止它们出现在 §1 TOKENS 之外 |
| 结构类（label 159 / border 74 / bg 48 / hover 14 / input 4 / font 1） | 302 | **保留直用**（已稳定、语义清晰），守卫不约束 |
| 其他 | 1（`alias-text-secondary`） | 复核后归 label-secondary 或入 token |

### 12.5 守卫豁免白名单（显式、需评审）
`0` / `1px`（发丝线与边框）/ `50%` / `999px`（药丸）/ `ch`（diff 行号列宽）/ `calc(...)` / `%` / `auto` / `min()` `max()` `clamp()` / 媒体查询断点 / `--cm-disk-card-h: 420px`（用户实测高度，已被守卫钉住）/ **布局偏移：`-4px` 图标对齐、`22px`/`38px` 深层缩进（逐条白名单，写在守卫里并注明理由）**。

### 12.6 机械改写纪律
① **只替换值，不重排规则**：顶层选择器必须保持行首（t11-3 行首锚定）；② **不嵌套**（守卫用 `^\.class {` 取规则体）；③ 9 个媒体外重复块合并前必须逐条确认覆盖语义（后定义覆盖前定义是有意的还是漂移）；④ `.dialogMask/.dialogCard` 保留（Modal 活类）；⑤ 每次改写后立即跑 §11 门禁，不攒批次。

### 12.8 `11.5px` 的判定规则（28 处，逐条归类）
**次级文本 → 11px（21 处）**：`.hint` `.formError` `.fieldLabel` `.kvKey` `.infoKey` `.sectionSubtitle` `.modeHint` `.modeTab` `.progressMeta` `.statSeg` `.skeletonCaption` `.infoHintBubble` `.activityEmpty` `.warnList` `.reportProblemReason` `.reportWarningRow` `.reportDetails` `.errorList` `.skipList` `.pickerSubgroupName` `.dangerButton[data-size='sm']`。
**内容/名称/值 → 12px（7 处）**：`.dataTable .num` `.kvValue.mono` `.pickerUnitName` `.restorePlanPath` `.activityRow` `.sectionRow` `.reportProblemText`。
判据：该文本是「说明这个界面/这项操作」（次级 → 11）还是「用户要读的内容本身」（名称/路径/数值 → 12）。

### 12.7 干跑实测（`.tmp/m1-migrate-dryrun.cjs`，只读）
脚本逐行扫描 module.css 产出工单，结果：**机械可改 113 处** —— `font-size` 48（10.5→11 ×14、10→11 ×3、14→13 ×1、30→13 ×1、9.5→11 ×1、11.5→11/12 ×28 见 §12.8）+ `border-radius` 12（7→8 ×5、3→4 ×3、5→6 ×2、9→8 ×1、10→8 ×1）+ `line-height` 12 + `z-index` 1（100→101）+ `spacing` 40（§12.2）。
**需逐条判定 34 处**：spacing 中 30 处二选一（5→4/6 ×14、3→2/4 ×7、7→6/8 ×4、9→8/10 ×4、11→10/12 ×1）+ 4 处豁免（38×2、22×1、−4×1）。
**M1 总工作量**：≈113 处机械值改写 + 34 处判定 + **140 处 token 替换** + 新建 2 个守卫 + 更新 3 个既有守卫锚点。风险仍集中在「值改写 → 既有守卫断言」的冲突（§12.3）。

---

## 13. 守卫锚点总表（实测抽样，2026-10-05；M3/M5/M6 施工依据）

| 守卫 | 钉住的对象 | 哪些里程碑会打破它 | 处理 |
|---|---|---|---|
| `src/client/icon-layer-guard.test.ts` | 扫 `src/client` 全体源码里的**字符串字面量**（禁用文本符号图标）；`CLIENT_DIR` | 新增文件（无影响）；新增文本符号即红 | 无需改锚点；M1–M6 不得引入 ▸▾ 等符号 |
| `src/client/common/info-hint-guard.test.ts` | `MOVE_PINS` / `KEEP_PINS` / `LABEL_PROP_PINS` **逐文件硬编码路径**（含 `snapshots/DiskUsageCard.tsx`、`snapshots/BackupScheduleCard.tsx`、`snapshots/RestorePlanView.tsx`、`sync/SyncPanel.tsx`、`sync/SecurityOptionsCard.tsx`、`sync/DecryptPasswordCard.tsx`、`market/MarketPanel.tsx`、`recovery/RecoveryPanel.tsx`、`library/LibraryPanel.tsx`、`home/HomePanel.tsx` …）；t11-3 用**行首锚定**读 CSS | **M3 搬文件/拆 SyncPanel/加密解密入弹窗** | 每个被移动的路径都要改 pins；原文案键若改名同步改；CSS 规则保持行首与 `[data-open]:focus-visible` + `outline:` |
| `src/client/common/plan-text-redaction.test.ts` | `RENDER_POINTS` 表：18 个文件 + 每渲染点「脱敏写法恰 1 次 + 裸写法 0 次」 | **M3 搬 `RestorePlanView`/`BackupScheduleCard`、拆 `SyncPanel`、拆 `LibraryActions`** | 按新文件重建 RENDER_POINTS；任何渲染点被拆成两处都要重新登记（否则出现 0 次 → 红） |
| `src/client/common/http-usage-guard.test.ts` | `API_FILES` 白名单 + 扫 `src/client` 禁组件直接 fetch | **M3 新增 `SyncChannelCard.tsx`** | 新组件必须走 `SyncApi`/`ConfigManagerApi`；不得 fetch |
| `src/client/common/menu-scroll-guard.test.ts` | `FLOATING_MENUS` = `common/Select.tsx` + `common/MoreMenu.tsx` | 不动这两个文件 | 无需改 |
| `src/client/common/runs-center-guard.test.ts` | `common/RunsCenter.tsx`（M5 状态从组件取出、走 run-store 派生） | M5 若改 RunsCenter 内部实现 | 保留 store 订阅与派生语义；如移动文件改锚点 |
| `src/client/import/foreign-import-view-guard.test.ts` | 无显式路径（按源码内容扫描）；外部 agent 导入的围栏 | **M5 `library.pendingZip` 改名** | 以内容断言为准，改名后重跑并按需更新断言里的字段名 |
| `tests/client/locale-hardcode-guard.test.ts` | `SITES` = `locales.ts` + `RestorePlanView.tsx` + `LibraryActions.tsx` + `EnvironmentPanel.tsx` + `ExportView.tsx`（硬编码中文字面量） | **M3 搬上述文件 / 新增文案** | 搬文件同步改 SITES；新文案进字典 |
| `src/client/snapshots/files-layout.test.ts` | 见 §12.3-1（读 CSS + `DiskUsageCard` + `LibraryPanel`） | M1（CSS 值）+ M3（搬 DiskUsageCard） | 同步更新路径与类名断言 |
| `src/client/recovery/session-dialog-mount.test.ts` | 见 §12.3-2（读 `RecoveryPanel.tsx` + 三条硬钉 CSS） | M1（CSS 值）+ M3（拆 SessionHealthDialog） | 改读新文件；CSS 硬钉值随 §4.3 档位同步更新（14px 已入档故 `.snapshotRow` 零改动） |
| `src/client/bundle-selfcontained.test.ts` | `lib/client.js` 自包含（白名单 react 系） | 任何新增依赖 | 零新增依赖 → 持续绿；build 后单独跑 |
| `tests/route/*.test.ts`（route-fence / route-parity / route-channel-guard） | 路由源与计数（77） | **本次不改路由** | 应持续绿；若红说明误改了路由，回退 |
| `src/client/css-scale-guard.test.ts`（新增） | `font-size`/`border-radius`/`z-index`/`line-height`/`padding`/`margin`/`gap` 值域（含 §12.5 豁免） | M1 新建 | 只扫 `src/client/config-manager.module.css`（**不含** `src/cli/web/page.ts` 的救急台自带样式） |
| `src/client/css-token-guard.test.ts`（新增） | 四态/主色 token（`--dsw-alias-state-*`、`--dsw-alias-button-info-*`）只允许出现在 §1 TOKENS 块 | M1 新建 | 结构类 token（label/border/bg/hover/input/font）不约束 |

> 纪律：守卫命中时**同步更新锚点**或**改回**；**不得改守卫意图来放行**。每条锚点更新都要在 M6 汇报里逐条列出。

---

## 14. 实施结果（2026-10-06）与偏差

### 14.1 已落地
| 里程碑 | 内容 | 证据 |
|---|---|---|
| M1 | `--cm-*` 语义 token 层（54 个定义）；四态/主色引用 141 处收敛到中间层；scale 迁移 113 处（字号 48 / 圆角 12 / 行高 12 / 层级 8 / 间距 40）；删 11 个死类；**新增两个源级守卫** | `css-scale-guard.test.ts`（6 项）+ `css-token-guard.test.ts`（5 项）全绿；`npm run build` 0 |
| M2+M5 | PanelId 收敛为 `home/library/sync/environment`；删 `MainView`、`TaskKind 'publish'`、`snapshots.subTab`；`importBackup` → `library.pendingZip`；`parsePersistedState` 映射表重写（旧值全部收敛、认不出的落首页）；导航 4 项 + 4 图标（新增 `history`）；命令 17→19；状态栏任务名 + 不定态进度条；SAFE MODE 横幅去内联 style | `run-store.test.ts` 迁移用例（含 market→library+筛选、snapshots 子视图分流、未知值→首页、pendingZip 瞬态）；`commands.test.ts` 双向守卫 18/18 |
| M3 | 首页删「备份位置卡 + 分区构成卡」（位置/配额信息移入定时备份设置弹窗）、**首页不再触发 export-preview**（最慢请求，12~30s）；产物库底栏补第 4 入口「发布到市场」；市场 `initialSubView` 直达「我的配置」；删同步页**重复渲染**的页面级分区卡 | 全量门禁五绿 |
| M6 | `DESIGN.md` §1/§1.1/§3/§4/§5/§6/§9 改写 + 顶部 v3 权威与 v2 作废声明；`AGENTS.md` UI 铁律 1/2/9 + 环境注意；v2 文档标注作废；本文补实施结果 | 本文 + 上述两文件 |

### 14.2 后补完成（第 4 轮）

| 项 | 内容 |
|---|---|
| **M3c 同步页归位** | 加密/解密两张卡 + unreadable 横幅**移入各自的通道卡**（所有 handler 显式传 channel，不再读隐式的 `state.channel`）—— P-IA-7 消除；已配置通道卡支持**折叠**（缺省展开活跃通道；行尾 chevron 切换，带 `aria-expanded` + `aria-controls`）—— P-IA-8 消除（4 通道不再撑爆 564×720） |
| **M3d 组件归位** | `DiskUsageCard` → `environment/maintenance/`、`BackupScheduleCard` → `home/`、`RestorePlanView` → `library/`；两个测试一并迁出（落在同深度的 `library/`，ROOT 不变）；`snapshots/` 目录删除；4 个守卫锚点同步更新（info-hint 13 / plan-text-redaction 6 / locale-hardcode 1 / files-layout 1） |

### 14.3 未落地（偏差，明确登记）
| 项 | 计划 | 实际 | 原因 / 后续 |
|---|---|---|---|
| CSS 物理重排（§4 的 §1–§7 分节） | 把 4957 行按层重排 | **只加了 token 层与三个新类**，未整体重排 | §12.6 的纪律是「只替换值、不重排规则」（三个守卫用行首锚定取规则体）。整体重排风险高、收益低，**取消该项**（分层由「§1 TOKENS 在文件顶部 + 守卫强制」表达，不再依赖物理顺序）。 |
| `snapshots.subTab` 的 locale 键清理 | 删 `snapshots.subTab.*` | **保留** | 其中 `snapshots.subTab.schedule` 仍被首页弹窗标题借用（`HomePanel`）。改为专用键会牵动 `info-hint-guard` 的 KEEP 台账 —— 与 M3c/M3d 合并处理。 |

### 14.3 与计划的其它偏差（已做但计划未写）
- **首页「最近活动表」保留**：计划要把它移入只读面板，但移除后首页只剩状态条 + 工具栏（约 120px 内容），会直接违反 Canvas 纪律（底部空洞）。活动表留作填充块（`flex:1`），信息与 runs/history 有重叠但**不冲突**。
- **首页「提醒区 / 最近产物」未实现**：状态条已经承担健康与指标（含备份失败时间的附注），再加一块提醒区属于重复入口（anti-pattern #2）。留待有实际需求时再补。
- **`--cm-*` 未提供 `-fg/-bg/-bd` 三要素**：实现只落了 6 个基色 + hover/fill 两个特例；四态 tint 仍在各组件用 `color-mix` 现算（百分比是用法专属的）。守卫已保证「语义只在中间层定义一次」，未过度抽象。
- **既有规则保留字面量档位值**（8px / 12px 等）而非全部改写成 `var(--cm-sp-*)`：守卫按「值 ∈ 档位集合」判定，权力等价而 diff 小一个数量级；新代码请优先用变量。
