# 说明性文案迁移台账（InfoHint ⓘ，2026-10）

> 团队目标：把 dsh-config-manager 客户端的**说明性文案**收敛到 ⓘ（`common/InfoHint.tsx`），页面更简洁；
> **错误 / 安全 / 状态 / 空态**文案保持常驻。
> 本文是这次迁移的**单一台账**：冻结规则、逐目录判定、deferred、渲染契约、护栏与复核命令。
> 视觉规范落在 `DESIGN.md` §6（组件）与 §7「说明性文案分层」（规则）；本文只做台账与索引。

**状态**：t1–t10 已完成（原语 → 面板收敛 → 聚合验证 → 评审 → 修复 → 复评 → 收口）；
**2026-10-12 追加 t7 波次**（用户要求「把**所有**描述都收进 ⓘ，页面更简洁」）：
在既有 42 个 MOVE 键之外，再把上一轮判为 KEEP 的**静态**安全/机制说明与**静态**页级/分区级副标题收进 ⓘ，
**MOVE 合计 83 键**，守卫 `info-hint-guard.test.ts` 13/13 pass。规则边界见 `DESIGN.md` §7（t7 清单在「本次落地」段末）。

---

## 1. 冻结的分层规则（逐字适用，不得扩大或缩小）

**MOVE → ⓘ**（改为 `<InfoHint text={t('原键')} label={t('common.infoHint')} />`，并删掉原来那一行可见说明）：
- 纯说明性文案：机制怎么工作 / 为什么这样设计 / 补充背景 / 边界与限制 / 示例 / 省事提示；
- 输入规则类文案（如「仅允许字母数字、空格、- _ .」）—— 因为校验失败时错误文案本身会重申规则。

**KEEP 常驻**（渲染与文案必须与改动前逐字一致，一处都不许动）：
1. 校验错误 / 失败原因（`css.formError`、`ErrorBanner`、`ErrorList`、`ReportView` 的失败文本）；
2. 安全与不可逆操作告警（加密、密钥、覆盖、删除、回滚、恢复、SAFE MODE）；
3. 状态 / 进度 / 等待文本（运行中、已停止、等待 N 分钟、下载中）；
4. 按钮与选项的禁用原因（`title=` 上的解释）；
5. 空态解释（列表为空时说明「为什么什么都没有」的那一行）；
6. 行内防截断的 `title=`（表格 / 列表 / 长路径上的全量提示，**不是**页面文案）；
7. `SectionTitle` 的 `subtitle`（页级 / 分区级副标题）、`css.cellMeta` 元数据；
8. `ConfirmDialog` / `Modal` 内的危险操作说明。

判据边界（本次实测确认）：
- **MOVE 的「纯说明」= 可选的补充信息**：用户「必须看到才能安全决策」的文本一律 KEEP（上表 8 类）；
- 输入规则移入 ⓘ 的前提是**校验失败的错误文案会重申规则**（`export.fileNameInvalid` 等），否则规则就不可见了；
- 组件自带的**源语言回落只作兜底**：每个调用点必须显式给可访问名。

---

## 2. 落地形态（v2）与渲染契约

**形态（v2，全部 41 个 ⓘ 调用点统一）**：

```tsx
<InfoHint text={t('原键')} label={t('common.infoHint')} />
```

- `text` **逐字复用既有字典键**：本次 43 个 MOVE 键没有新增任何一个说明键；
- `label` = **各自命名空间的** `common.infoHint`：主字典 `src/client/locales.ts` + `market-locales.ts` /
  `sync-locales.ts` / `recovery-locales.ts` 各有一份同键同值副本（zh「查看说明」/ en「Show description」），
  `history-locales.ts` 无 ⓘ 故不要求；
- **不跨命名空间传 `t`**（`TranslateNS<'config-manager'>` 与其它命名空间的 `t` 类型不兼容），
  也**不用可能 undefined 的 `copyT`**；
- UiT 消费方（`DiskUsageCard`，文案走 `src/ui/i18n.ts`）取不到主字典 → 由有主字典的调用方
  （`SnapshotsPanel`）显式传 `infoHintLabel={t('common.infoHint')}`。

**渲染契约（t9 修 T7-F1/F2）**：
- 气泡**必须经 `createPortal` 渲进插件根容器**（`resolveModalRoot()` = `MODAL_ROOT_ID` = `#dsh-config-manager-root`，
  与 `Modal.tsx` 共用同一份实现；**绝不挂 `document.body`**）。
  根因：`.dialogContentCenter` 带常驻 `transform: translate(-50%,-50%)` ⇒ 按 CSS Transforms L1 成为后代
  `position: fixed` 的**包含块**；裸 fixed 的气泡在 Modal 内会整体偏移卡片位移，并被
  `.dialogBody{overflow-y:auto}` 裁剪（当时 11/41 个调用点在 Modal 内）。守卫：`t9-1`。
- **气泡边界 = 宿主画布 ∪ 锚点（画布 564×720），不是浏览器视口**：夹紧矩形取**插件根容器的可见矩形 ∩ 窗口**
  （容器缺失 / 尺寸为 0 / 交集退化时才回落窗口），并**并进锚点矩形**（只放宽、不收紧）—— 弹窗卡片是
  `position:fixed`、相对浏览器窗口居中，会伸出画布左缘，严格夹进画布会把气泡推离自己的 ⓘ
  （2026-10-04 用户反馈「位置有偏移」）；「下方空间不足且上方更宽裕 → 向上翻转」保留。守卫：`t9-2` + `t11-2`。
- 交互四通道：悬停打开 / 键盘聚焦打开 / 点击固定（再点取消固定）/
  **固定态下按下任意位置取消固定并关闭**（`mousedown` 捕获阶段、触发按钮自身放行；守卫 `t10`，
  2026-10-04 用户反馈：此前只能再点一次同一颗 ⓘ 才能退出）/ Esc 关闭（捕获阶段 `stopPropagation`，
  不连带关掉外层 Modal/抽屉）；鼠标移出且未固定时关闭。**键盘聚焦只认用户发起**：Radix 弹窗挂载时
  `focusFirst(...)` 会把初始焦点派给容器内第一个可聚焦元素（标题行 trailing 的 ⓘ 常常正是它），
  该次聚焦的 `relatedTarget` 在弹窗之外 → 不弹气泡；焦点环同时只在气泡打开时绘制
  （2026-10-04 用户反馈「一进弹窗就自动选中 ⓘ」，守卫 `t11-1`）。无障碍：`<button type="button">` +
  `aria-label` + `aria-describedby`（多实例 id 由 `useId` 归一化保证唯一），**不依赖原生 `title`**。
- 样式只进 `config-manager.module.css`（`.infoHint / .infoHintBtn / .infoHintBubble`），颜色/底色/边框/阴影
  全走 `--dsw-*` token；坐标由组件量测后写内联 `top/left`（动态值无法用静态类表达）。

---

## 3. 逐目录台账

### 3.1 MOVE（**83 键**，全量；机器化清单 = `info-hint-guard.test.ts` 的 `MOVE_PINS`）

> **t7 波次（2026-10-12，41 键）**：页级/分区级副标题 → `SectionTitle.info`；卡片/字段说明 → 标题行或字段标签行的 ⓘ
> （`Field.info` 是本次新加的原语入口）。逐键清单与「同轮仍常驻」的有意例外见 `DESIGN.md` §7 t7 段。
> 新增原语：`SectionTitle.info` / `Field.info`（都接受 `<InfoHint …/>` 节点）+ CSS `.sectionTitleRow`。

> **后期变更（2026-10-04）**：用户要求移除产物库页首标题行，`snapshots.retentionHint` 的保留期说明**整体删除**
> （不再有任何 ⓘ 承载）→ MOVE 台账 **43 → 42**。本表已按现值更新；§1 / §5 与验收表里的「43/43」是 t1–t5 当时的口径，
> 保留为历史记录。字典键本身仍在 `locales.ts`（zh/en 各一处），只是没有渲染点。

| 目录 | 字典键 | 渲染点 | 理由 |
|---|---|---|---|
| common/ | `runs.retentionHint` | RunsCenter.tsx · 列表头部摘要行 | 机制+省事提示：保留 30 分钟的机制 + 完整审计去「迁移历史」看；空列表解释仍由 runs.empty（KEEP⑤）承担 |
| common/ | `picker.sessionWorkspaceLinked` | ContentPicker.tsx · 工具栏（仅配对存在时） | 机制：会话↔工作区联动的勾选规则；不解释错误、不表达状态 |
| sync/ | `channel.perChannelHint` | ChannelConfigDialog.tsx · 弹窗顶部 | 机制：各通道独立配置 |
| sync/ | `config.repoUrlHint` | ChannelConfigDialog.tsx · 仓库 URL 字段 | 输入规则：URL 形态；失败时错误文案重申 |
| sync/ | `github.description` | ChannelConfigDialog.tsx · GitHub 分区 | 机制：GitHub 通道是什么、怎么用 |
| sync/ | `webdav.presetHint` | ChannelConfigDialog.tsx · 预设字段 | 输入规则：预设 URL 形态 |
| sync/ | `webdav.urlHint` | ChannelConfigDialog.tsx · WebDAV 地址字段 | 输入规则：地址形态 |
| sync/ | `webdav.usernameHint` | ChannelConfigDialog.tsx · 用户名字段 | 输入规则：用户名形态 |
| sync/ | `config.saveHint` | ChannelConfigDialog.tsx · 底部 | 机制：保存写到哪里、何时生效 |
| sync/ | `mode.sessionsPickHint` | SyncSectionPickerDialog.tsx · 会话选择步 | 机制：显式勾选优先于数量上限 |
| sync/ | `mode.pickerHint` | SyncSectionPickerDialog.tsx · 选择步 | 机制：选择器怎么用 |
| sync/ | `mode.sessionsLimitHint` | SyncSectionPickerDialog.tsx · 数量上限 | 输入规则：上限取值语义 |
| sync/ | `mode.sectionsHint` | SyncSectionPickerDialog.tsx · 分区步 | 机制：分区选择语义 |
| sync/ | `mode.hint` | SyncSettingsView.tsx · 模式行 | 机制：默认/高级模式差别 |
| sync/ | `mode.persistHint` | SyncSettingsView.tsx · 模式行 | 边界：选择持久化到哪里、何时写 |
| sync/ | `channel.openHint` | SyncChannelEntryCard.tsx · 入口卡 | 省事提示：点这里打开通道设置 |
| sync/ | `autosync.description` | AutosyncCard.tsx · 卡头 | 机制：自动同步怎么工作 |
| sync/ | `autosync.intervalHint` | AutosyncCard.tsx · 间隔字段 | 输入规则：间隔取值语义 |
| ~~snapshots/~~ | ~~`snapshots.retentionHint`~~ | **2026-10-04 移除**（原：SnapshotsListTable.tsx · 表格上方；后搬产物库页首行） | 机制：保留上限 + 去哪看完整审计；该表只在非空时渲染，空态解释由 SnapshotsEmptyState 承担 |
| snapshots/ | `backupFiles.hint` | SnapshotsPanel.tsx · 备份文件卡头 | 机制：列表管理方式 + 定时备份保留最近 10 个；空态解释由 backupFiles.empty（KEEP⑤）承担 |
| snapshots/ | `diskUsage.backupRetention` | DiskUsageCard.tsx · 磁盘占用卡 | 机制：保留 N 个 / X 天回收怎么算 |
| snapshots/ | `backupSchedule.hint` | BackupScheduleCard.tsx · 卡头 | 机制+背景：备份内容 / 存放位置 / 随什么迁移 |
| snapshots/ | `backupSchedule.enabledHint` | BackupScheduleCard.tsx · 启用后 | 机制：启用即先执行一次 |
| snapshots/ | `backupSchedule.customHint` | BackupScheduleCard.tsx · 自定义档 | 边界：自定义周期 + 错过不补跑 |
| snapshots/ | `retention.hint` | BackupScheduleCard.tsx · 保留策略 | 边界：保留策略怎么工作 + 豁免 |
| snapshots/ | `retention.keepLastHint` | BackupScheduleCard.tsx · 保留输入 | 输入规则：keepLast 取值语义（三个 hint 按原分隔符合并进同一个 ⓘ） |
| snapshots/ | `retention.keepMonthlyHint` | BackupScheduleCard.tsx · 保留输入 | 输入规则：keepMonthly 取值语义 |
| snapshots/ | `retention.keepYearlyHint` | BackupScheduleCard.tsx · 保留输入 | 输入规则：keepYearly 取值语义 |
| snapshots/ | `retention.appliesTo` | BackupScheduleCard.tsx · 保留策略 | 边界：保留策略的生效范围 |
| export/ | `export.hint` | ExportView.tsx · 工具栏末尾 | 机制+省事提示：默认导出推荐分区 + 去哪儿调整勾选 |
| export/ | `export.fileNameHint` | ExportView.tsx · 文件名字段标签旁 | 输入规则：留空自动命名 / 自动补 .zip；非法时 export.fileNameInvalid（KEEP①）重申字符集 |
| export/ | `export.noteHint` | ExportView.tsx · 备注字段标签旁 | 背景：备注的用途 |
| market/ | `myconfigs.login.hint` | MyConfigsLoginCard.tsx · 卡头 | 机制+背景：登录后能做什么、仓库怎么创建 |
| market/ | `myconfigs.update.zipHint` | MyConfigsWizard.tsx · 更新步 | 机制：更新需新 zip → 自动校验 → 可更新 |
| market/ | `myconfigs.upload.form.nameHint` | MyConfigsWizard.tsx · 名称字段 | 省事提示：名称可预填可改；字段校验失败由 css.formError 重申 |
| about/ | `about.diag.hint` | AboutPanel.tsx · 诊断标题旁 | 背景：与实际不符时该查什么 |
| about/ | `about.feedbackHint` | AboutPanel.tsx · CopyButton 旁 | 省事提示：复制环境信息粘进 issue |
| about/ | `about.update.offline` | AboutPanel.tsx · 更新标题旁 | 边界：会访问 npm registry、离线失败属正常；失败原因仍由 about.update.failed 常驻 |
| about/ | `about.cli.hint` | AboutPanel.tsx · CLI 标题旁 | 背景/机制：救援 CLI 是什么 |
| profiles/ | `profiles.create.hint` | ProfilesPanel.tsx · 新建区标题旁 | 机制：建了什么文件、第三方插件要单独装 |
| profiles/ | `profiles.list.hint` | ProfilesPanel.tsx · 列表标题旁 | 省事提示：点行看详情；同一键的行内 title=（KEEP⑥）仍常驻 |
| recovery/ | `sessions.desc` | RecoveryPanel.tsx · 会话体检卡标题旁 | 机制+边界：扫什么、为什么修复只能走离线 CLI（只读语义由 sessions.readOnly 徽章承担） |
| recovery/ | `recovery.preview.hint` | RecoveryPanel.tsx · 恢复预览标题旁 | 机制：预览只读零写入、确认后才执行（危险动作说明仍常驻 ConfirmDialog） |

目录小计：`common/ 2` · `sync/ 16` · `snapshots/ 10` · `export/ 3` · `market/ 3` · `about/ 4` · `profiles/ 2` · `recovery/ 2` = **42**
（t1–t5 原为 43；2026-10-04 起 `snapshots.retentionHint` 退出）。
**零 MOVE 的目录**：`history/`、`overview/`、`import/`、`consult/`（其 `.hint` 类站点全部命中 KEEP）。

### 3.2 KEEP（常驻；渲染与文案逐字未动）

完整规则见 §1 的 8 类（边界经 t7 修订：**动态**告警常驻，**静态**机制说明进 ⓘ）。机器化钉子 =
`info-hint-guard.test.ts` 的 `KEEP_PINS`（**36 条**；t7 从原 46 条里移走 10 条静态安全说明转 MOVE）：

| 类别 | 条数 | 代表键（全量见 `KEEP_PINS`） |
|---|---|---|
| ① 错误 / 失败原因 | 10 | `runs.loadFailed` · `picker.unitsUnavailable` · `export.fileNameInvalid` · `diskUsage.partial` · `about.update.noCommand` · `nextSteps.unresolved.hint` … |
| ② 安全与不可逆告警（**动态**） | 5 | `privateRepoHint` · `backupFiles.encryptedHint` · `review.rollbackHint` · `nextSteps.secrets.hint` · `profiles.duplicate.includeModulesHint`（原 14 条中的 9 条静态说明已按 t7 转 MOVE：`config.tokenHint` / `mode.encryptHint` / `mode.includeSecretsHint` / `export.encryptHint` / `export.includeSecretsHint` / `diskUsage.clean.hint` / `import.secrets.hint` / `recovery.safeMode.detail` / `sessions.repair.desc` / `recovery.rescue.desc`） |
| ③ 状态 / 等待 / 计数 | 5 | `mode.decryptPasswordSaved` · `syncflow.noSnapshots` · `history.corruptedCount` · `overview.sections.total` · `import.skipPending` |
| ⑤ 空态解释 | 10 | `runs.empty` · `backupFiles.empty` · `export.compositionEmpty` · `profiles.running.none` · `review.changeEmpty` · `overview.empty.body` / `overview.activity.empty` · `history.empty` / `history.emptyHint` · `snapshots.plan.diffIdentical` |
| ⑥ / ⑦ title= 与元数据 | 2 | `picker.highRiskHint`（行内 title） · `export.selectionWarnings`（设备相关告警） |
| ⑧ Modal 内决策 / 危险说明 | 5 | `syncflow.adoptHint` · `syncflow.bulkHint` · `about.update.commandHint` / `about.update.copyCommand` · `profiles.duplicate.onlyManifest` |

> 各面板的**完整** KEEP 判定清单（含未进 46 钉子的站点与逐条理由）在 t1–t5 的任务 output 里；
> 本节只保留机器可复核的那一份。判定口径复核：`git diff` 中 `src/client` 的删除行里
> **0 行含 KEEP 键**（t6 已取证）。

---

## 4. deferred 清单（判定需要缩短 / 新增键但本轮未做）

| # | 位置 | 内容 | 为什么不做 | 处置 |
|---|---|---|---|---|
| D-1 | `common/ContentPicker.tsx`（`picker.loadingItems`） | 「正在读取条目…（大分区如会话可能较慢）」括号内是省事提示（MOVE 类） | 拆句**需要新增字典键**，与「本轮不新增说明键」的硬约束冲突 | 原样保留常驻（③ 状态文本）；后续批次若要拆，需单独加键 |
| D-2 | `common/RunsCenter.tsx`（`runs.cancelStuck`） | 句内含「环境锁由本进程持有，重启即释放…」的机制说明 | 整句是**等待超阈值时的出路 / 安全告警**（KEEP ③②），必须常驻可见，拆开会让「怎么办」不可见 | 不拆，保持常驻 |
| D-3 | `snapshots/DiskUsageCard.tsx` | 该卡文案走 `UiT`（`src/ui/i18n.ts`），不能取主字典的 `common.infoHint` | UiT 字典不在本次允许新增的范围内 | **已解决**：新增必填 prop `infoHintLabel`，由 `SnapshotsPanel` 传 `t('common.infoHint')`（无硬编码、无新键） |
| D-4 | `DESIGN.md` §6 导出页 / 档案列表描述 | 仍在描述迁移前的可见 `.hint` 行（T7-F3 / T10-F1） | 文档漂移，随收口处理 | **已解决**（t8，见 §6） |

---

## 5. 用户侧生效方式

- **client 半（`src/client/**`，含文案与样式）改动后必须重新构建**：
  `npm run build`（或仅 `npm run bundle`）→ 产物 `lib/client.js`（CSS Modules 内联其中）+ `lib/`（host）。
- **并重启 DSH 才生效**：宿主在 DSH 启动时加载，**没有热重载**；只改源码不 build，界面仍是旧 UI。
  开发态刷新页面不会替换已加载的 bundle（bundle 由 client loader 注入）。
- **无数据迁移 / 无配置兼容影响**：本次只改渲染层文案位置与组件内部行为，
  不涉及 bundle 格式、schema、同步协议或磁盘布局；升级到带 ⓘ 的版本后，旧备份 / 旧同步快照 / 旧档案照常可用。
- **无新增依赖、无新增分区/路由**：仍只依赖既有的 `react` / `react-dom`（`createPortal`）与
  `@radix-ui/react-dialog`（Modal）等已准入库。

---

## 6. findings 收口状态

| finding | 来源 | 严重度 | 状态 | 依据 |
|---|---|---|---|---|
| T7-F1 气泡在 Modal 内偏移 / 被裁剪 | t7 评审 | high | **已修（t9）** | `createPortal` → `resolveModalRoot()`；守卫 t9-1；真实文件变异实验（改回裸 fixed → 退出码 1） |
| T7-F2 夹紧基准是浏览器视口 | t7 评审 | medium | **已修（t9）** | `canvasBounds()` = 插件根容器 rect ∩ 窗口；守卫 t9-2 |
| T7-F3 `DESIGN.md` §6 两处页面描述漂移 | t7 评审 | low | **已修（t8）** | §6 导出页 / 档案列表两处改写（见下「逐处清单」） |
| T10-F1 `DESIGN.md` §7 未同步 t9 渲染契约 | t10 复评 | low | **已修（t8）** | §7 新增「渲染契约」与「气泡边界 = 宿主画布」两条 + v2 冻结形态 + t1–t5 全量落地清单 |
| t6 构建形态（原生 tsgo 写 `%TEMP%` 被环境拒绝） | t6 验证 | — | **环境性，非代码缺陷** | 改用**仓库内 TEMP 重定向**（`$env:TEMP=$(Join-Path (Get-Location) '.tmp')`）后 build exit 0；captain 同机复现同结论 |
| 原「每面板 ≥3 MOVE」口径 | t6 验证 | — | **非目标（口径修正）** | common / profiles / recovery 各 2，import / consult / history / overview 为 0；改用**全量 43/43** 为验收口径 |

### DESIGN.md 漂移逐处清单（T7-F3 / T10-F1）

| # | 位置 | 改前 | 改后 |
|---|---|---|---|
| 1 | §6 导出页首句（原 L618） | 「工具栏 → **模式提示** → 安全选项 → …」 | 「工具栏（末尾是 `export.hint` 的 ⓘ）→ 安全选项 → …」 |
| 2 | §6 导出页分组标题条（原 L622-624，UI-12） | 「文件名与备注各带**常驻** `.hint` 规则说明…先说明规则后报错」 | 规则说明已收进字段标签旁 ⓘ；**常驻的只有非法时的 `.formError`**；「先说明规则后报错」改写为「出错时由错误文案重申规则」 |
| 3 | §6 档案列表（原 L739） | 「下接一行 `.hint` 说明「点击行看完整详情」」 | 标题旁 `profiles.list.hint` 的 ⓘ；不再有一行 `.hint`；同一键的行内 `title=` 仍常驻 |
| 4 | §7 冻结形态（原 L836-837） | `<InfoHint text={t('原键')} />`（`t` 可选） | **v2**：`<InfoHint text={t('原键')} label={t('common.infoHint')} />` + 命名空间口径 / 不跨命名空间传 `t` / 不用 `copyT` |
| 5 | §7 用法与边界（原 L858-860） | 只写「位置由组件量测后写入内联 top/left」 | 新增**渲染契约**（portal 到插件根容器、绝不 document.body）与**气泡边界 = 宿主画布，不是浏览器视口**两条 |
| 6 | §7「本次落地」段 | 只有 t1 的 2 键 | t1–t5 **全量 43 键**按目录列全 + 零 MOVE 目录 + `Field.hint` 不整体迁移的理由 |
| 7 | §6 Primitives 的 `InfoHint` 条 | 「右对齐后夹进**视口**」 | 改为 portal 契约 + 夹紧基准 = 宿主画布（插件根容器可见矩形 ∩ 窗口） |

---

## 7. 机器化护栏与复核命令

| 护栏 | 位置 | 钉住什么 |
|---|---|---|
| t6-1 MOVE | `src/client/common/info-hint-guard.test.ts` | **83** 个 MOVE 键（t1–t5 的 42 + t7 的 41）各自仍有一处 `<InfoHint text={t('原键')} …/>` 或 `SectionTitle.info` / `Field.info` 里的同名 ⓘ，且不再出现在可见说明行（`css.hint / modeHint / groupNote / noticeLine`） |
| t6-2 KEEP | 同上 | **36** 个 KEEP 针仍有可见渲染点（错误 / 安全 / 空态三类齐全） |
| t6-3 可访问名 | 同上 | 每一处 `<InfoHint>` 都显式给可访问名（`label={t('common.infoHint')}` / 白名单 prop / 主字典 `t={t}`），且必须自闭合 |
| t6-4 字典口径 | 同上 | 四本带 ⓘ 的字典的 `common.infoHint` zh/en 逐字一致 |
| t6-5 负向自检 | 同上 | 合成片段在「搬走但没进 ⓘ / 缺可访问名」时必须变红 |
| t9-1 气泡渲染路径 | 同上 | `css.infoHintBubble` 必须落在 `createPortal(…, container)` 实参内、第二实参是根容器、全文无 `document.body` |
| t9-2 夹紧基准 | 同上 | 基准 = `resolveModalRoot()` 的 rect ∩ 窗口；`window.innerWidth/innerHeight` 各只允许出现一次；翻转表达式必须存在 |
| t9-3 负向自检 | 同上 | 裸 fixed / 挂 body / 删气泡 / 丢容器 rect / 去 clamp 逐一必须变红 |

复核命令：

```bash
node --test src/client/common/info-hint-guard.test.ts   # 8/8 pass（t6-1…t6-5 + t9-1…t9-3）
npm run typecheck                                        # 根 tsconfig（src/**）
npm run typecheck:tests                                  # src/** + tests/**
npm test                                                 # node --test 全量
# 构建（本会话必须用仓库内 TEMP 重定向 —— 原生 tsgo 写 %TEMP% 被环境拒绝）：
$env:TEMP=(Join-Path (Get-Location) '.tmp'); New-Item -ItemType Directory -Force $env:TEMP | Out-Null; $env:TMP=$env:TEMP; npm run build
node --test src/client/bundle-selfcontained.test.ts      # build 之后跑（产物护栏）
```

**改这块时要一起更新的东西**：新增 MOVE → 得顺手加进 `MOVE_PINS`（键 + 文件 + 类别）与本文 §3.1；
新增 ⓘ 的命名空间字典 → 加 `common.infoHint` 并纳入 `INFO_HINT_DICTS` 的口径校验；
改渲染契约 → `t9-1/t9-2` 会红，同时更新 `DESIGN.md` §7。
