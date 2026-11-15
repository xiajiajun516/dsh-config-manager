## 1. 现状摘要

- **审查范围**：Shell（`src/client/ConfigManagerSection.tsx`）、四张主页面（`src/client/{home,library,sync,environment}/`）、七个流程与弹窗域（`src/client/{export,import,market,recovery,history,about,chat}/`）、公共原语与状态层（`src/client/common/`、`src/client/locales*.ts`、`src/ui/`）及样式唯一入口 `src/client/config-manager.module.css`（§1–§17）。
- **规范与历史审计去重**：已通读 `DESIGN.md`（1–1708 行）、`AGENTS.md`、`docs/architecture/client-dependencies.md`，并与四份历史审计（`docs/archive/2026-11-01-visual-pass.md`、`docs/archive/2026-11-01-technical-audit.md`、`207521cc68ef:docs/design/ui-audit-2026-09-20.md`、`docs/archive/2026-10-05-ui-redesign-v3.md`）逐项比对去重。
- **执行命令**：`npx tsx --test src/client/bundle-selfcontained.test.ts src/client/client-route-parity.test.ts src/client/http-usage-guard.test.ts src/client/plan-text-redaction.test.ts src/client/skeleton-guard.test.ts src/client/css-motion-guard.test.ts src/client/css-scale-guard.test.ts src/client/css-token-guard.test.ts src/client/icon-layer-guard.test.ts src/client/nav-menu-clip-guard.test.ts tests/i18n-hardcoded-guard.test.ts`。
- **守卫测试基线**：11 个测试文件共 **63 项子测试全部 PASS（0 FAIL，耗时 11544.75ms）**；其中 `css-token-guard`（7/7 PASS）、`css-scale-guard`（6/6 PASS）、`css-motion-guard`（6/6 PASS）、`icon-layer-guard`（5/5 PASS）、`i18n-hardcoded-guard`（`scope=ALL files=550 hits=0 allowlisted=134`，2/2 PASS）、`bundle-selfcontained`（7/7 PASS）、`client-route-parity`（2/2 PASS）、`skeleton-guard`（9/9 PASS）、`http-usage-guard`（4/4 PASS）、`plan-text-redaction`（11/11 PASS）、`nav-menu-clip-guard`（4/4 PASS）。
- **结论概览**：色彩三层 token、字号/间距/动效档位、图标体系、自包含 bundle 与 i18n 零硬编码均已由静态守卫钉死；现存问题集中在 **多通道契约断路（S3/Gist 在产物库与同步咨询中缺失载荷）**、**跨页深链状态漏写**、**内部 `SectionId`/适配器枚举裸露**、**局部错误横幅与弹窗底栏未走统一原语** 以及 **少内容态画布底部留白**，共 12 项（P0 4 项、P1 6 项、P2 2 项）。

---

## 2. 体检表

| 编号 | 维度(D1–D7) | 页面/组件 | 证据(file:line) | 现象 | 违反的条款或约束 | 严重度 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| F-01 | D4 / D7 | 产物库 `LibraryPanel`、`LibraryActions` | `src/client/library/LibraryPanel.tsx:84,127-139`<br>`src/client/library/LibraryActions.tsx:643-654,660-666` | 远端快照拉取与动作载荷只识别 `'git'` 与 `'webdav'`；当用户配置 `s3` 或 `gist` 同步通道时，产物库「远端快照」恒为空列表，且拉取/下载/删除/咨询直接抛 `sync channel address is unavailable`。 | `DESIGN.md` §1.1（产物库统一收纳远端快照）、D4 状态完整性 | P0 |
| F-02 | D4 / D7 | 同步差异确认 `SyncConfirmView` | `src/client/sync/SyncConfirmView.tsx:98-106`<br>`src/client/library/LibraryActions.tsx:638-641,660-665` | 一键同步回退到差异确认弹窗时，`api.consult({ type: 'remote-snapshot', id: snapshotId, snapshotId })` 未携带远端通道地址载荷，被宿主 `prepareSync` 以 400 拒绝并被 `.catch` 静默吞掉，导致迁移前咨询卡片永不显示。 | `DESIGN.md` §4.3.1（破坏性导入前展示影响咨询）、D4 状态完整性 | P0 |
| F-03 | D5 / D3 | 首页 `HomePanel` | `src/client/home/HomePanel.tsx:342-344,464-476`<br>`src/client/ConfigManagerSection.tsx:334-338` | 首页状态条出现异常/残留锁告警时，点击调用 `navRecovery()` 仅写入 `runStore.patch({ panel: 'environment' })`，漏写 `profiles: { subView: 'maintenance' }`，用户被送到「档案列表」而非「维护与诊断」急救台。 | `DESIGN.md` §4.4 铁律 2（急救可达性：异常条点击直达恢复视图） | P0 |
| F-04 | D6 | 产物库 / 同步 / 导入 / 市场（5 处组件） | `src/client/library/BackupInspectView.tsx:42,80`<br>`src/client/sync/SyncConfirmView.tsx:485`<br>`src/client/sync/SyncLogList.tsx:189,197`<br>`src/client/import/ImportWizardView.tsx:107`<br>`src/client/market/MarketPanel.tsx:659` | 备份详情徽章與适配器列、同步结果徽章、同步历史日志徽章、导入收尾重启列表、市场分区筛选下拉框直接把 `pluginFiles`、`credentialsStatus` 等内部 `SectionId`/适配器 id 裸渲染给用户。 | `DESIGN.md` L1231, L1466（分区显示名唯一映射，禁向用户暴露 `pluginFiles` 等内部 id） | P0 |
| F-05 | D4 / D6 | 产物库 `LibraryActions` | `src/client/library/LibraryActions.tsx:547-548,622-625` | 删除本机快照的二次确认弹窗标题走了 `timeText(confirmDelete)`，但正文参数写成 `confirmDelete.title.kind === 'time' ? confirmDelete.title.iso : ''`，把裸 ISO 时间戳（如 `2026-11-15T00:00:00.000Z`）直接展示给用户，且快照名为文本时传空串。 | `src/client/library/LibraryActions.tsx:622` 自定契约（绝不把裸 ISO 甩给用户）、D6 一致性 | P1 |
| F-06 | D4 / D6 | 首页 / 环境 / 恢复 / 市场 / 关于（6 处组件） | `src/client/home/BackupScheduleCard.tsx:66,105,239-244`<br>`src/client/environment/EnvironmentPanel.tsx:574-578`<br>`src/client/recovery/RecoveryPanel.tsx:528-533`<br>`src/client/recovery/RollbackCard.tsx:477-481,600-605`<br>`src/client/market/MarketPanel.tsx:618-624`<br>`src/client/about/AboutPanel.tsx:115-122` | 错误横幅绕过 `ErrorBanner`（内部调 `toActionableError()` + `redact()`），手写 `<Banner kind="error">`；其中 `BackupScheduleCard.tsx:66` 用 `const [, setError] = useState` 直接丢弃错误原因，只渲染静态「加载失败」文案。 | `AGENTS.md` 代码节（错误链：`toActionableError()` → `ErrorBanner`）、`DESIGN.md` D4（位置+原因+修法） | P1 |
| F-07 | D3 / D5 | 产物库 / 同步 / 回滚点（3 处 Modal） | `src/client/library/LibraryActions.tsx:569-578`<br>`src/client/sync/SyncPanel.tsx:1545-1575`<br>`src/client/sync/SyncConfirmView.tsx:233-237,331-350,380-384`<br>`src/client/recovery/RollbackCard.tsx:734-928` | 产物库「查看与对比」弹窗无 `Modal.Footer`；一键同步确认弹窗与回滚点预览/结果弹窗将底部主按钮（确认导入/回退到此点/取消/关闭）塞在 `Modal.Body scroll` 内部，长列表时主操作随内容滚走或底部缺少固定分隔栏。 | `DESIGN.md` §6 Modal 契约（`Modal.Header` + `Modal.Body` + `Modal.Footer`，动作固定在滚动区外） | P1 |
| F-08 | D6 / D5 | 回滚点 / 同步 / 市场（4 处表单控件） | `src/client/recovery/RollbackCard.tsx:434-439,821-832`<br>`src/client/sync/SyncConfirmView.tsx:294-302`<br>`src/client/market/MarketPanel.tsx:753-761`<br>`src/client/market/MyConfigsView.tsx:797-805` | 回滚点会话选择器使用原生 `<select className={css.input}>` 而非公共 `Select`；回滚点顶栏「拨动即生效」的自动留点开关误用 `<Checkbox>` 而非 `<Switch>`；同步确认与市场免责声明使用裸 `<input type="checkbox">` 而非 `<Checkbox>`。 | `AGENTS.md` UI 节（原语复用）、`DESIGN.md` §6（拨动即生效用 `Switch`，表单勾选统一 `Checkbox`/`Select`） | P1 |
| F-09 | D7 / D4 | 同步页 `SyncPanel` | `src/client/sync/SyncPanel.tsx:538-550` | `loadAutosync()` 调用 `api.autosyncStatusAll()` 后，仅对 `'git'` 与 `'webdav'` 调用 `patchChannelState`，遗漏 `'s3'` 与 `'gist'`，导致 `statusAll` 失败回退路径下 S3/Gist 的自动同步状态丢失。 | D4 状态完整性、D7 多通道状态对称性 | P1 |
| F-10 | D1 | 首页 `HomePanel`、同步页 `SyncLogList` | `src/client/home/HomePanel.tsx:506-517,524`<br>`src/client/sync/SyncLogList.tsx:78-92`<br>`src/client/config-manager.module.css:435-466` | 首页首次使用空态（`emptyState === true`）的 `<Card className={css.activityCard}>` 未挂载 `css.activityCardFill`；同步页底部 `SyncLogList` 的 `<Card>` 未挂载填充类，在窄画布 564×720 且通道折叠时底部留下 350–480px 纯背景空洞。 | `DESIGN.md` §0.3 画布纪律（禁止无意义纯背景区域，尾卡须用 `.fillCard`/`.activityCardFill` 吃满剩余高度） | P1 |
| F-11 | D6 / D4 | 同步 / 市场 / 选择器（4 处空态） | `src/client/sync/SyncLogList.tsx:78-84`<br>`src/client/sync/MergePreviewView.tsx:143-145`<br>`src/client/market/MarketImportReview.tsx:276,294,356`<br>`src/client/common/ContentPicker.tsx:335,596` | 空态未复用 `common/ui.tsx` 的 `<Empty>` 原语，各自手写 `<Card><strong>...<p>` 或 `<div/span className={css.hint}>`，导致空态垂直内边距、字重与层级不统一。 | `AGENTS.md` UI 节（原语复用：`common/ui.tsx` 能解决就禁重建）、`DESIGN.md` D4/D6 | P2 |
| F-12 | D6 / D5 | 市场 / 同步设置页签及 5 处静态内联间距 | `src/client/market/MarketPanel.tsx:437-456`<br>`src/client/sync/SyncSettingsDialog.tsx:157-176`<br>`src/client/home/BackupScheduleCard.tsx:409`<br>`src/client/sync/SyncChannelEntryCard.tsx:110`<br>`src/client/sync/WorkDirCard.tsx:93`<br>`src/client/sync/AutosyncCard.tsx:142,239` | `MarketPanel` 与 `SyncSettingsDialog` 手写 `<div role="tablist"><button role="tab">` 而未复用 `<Segmented>` 原语；4 个组件残留 5 处静态 `style={{ marginTop: 8 }}` / `style={{ marginBottom: 8 }}`（靠 `css-scale-guard.test.ts` 的 `tsx-02` 豁免维持）。 | `AGENTS.md` UI 节（样式只进 `config-manager.module.css`；原语优先复用 `Segmented`）、`css-scale-guard.test.ts` | P2 |

---

## 3. 优化条目

### P0 级（阻断用户完成核心任务 / 违反核心不变量，共 4 条）

#### F-01：打通产物库对 S3 与 Gist 远端通道的读取与操作载荷
- **问题**：当用户使用 S3 或 GitHub Gist 作为同步通道时，产物库的「远端快照」列表恒为空，且无法对远端快照执行拉取、下载、删除与迁移前咨询。
- **证据**：
  - `src/client/library/LibraryPanel.tsx:84,127-139`（`loadRemote` 只判断 `status.lastSyncChannel === 'webdav'` 与 `status.repoUrl`，对 `s3`/`gist` 令 `payload = null` 并直接返回 `[]`）。
  - `src/client/library/LibraryActions.tsx:643-654,660-666`（`remotePayload(syncApi)` 只处理 `'webdav'` 与 `'git'`，其余返回 `null`，调用方抛 `new Error('sync channel address is unavailable')`）。
  - 对照实现：`src/client/sync/SyncPanel.tsx:580-586,1371-1374` 与 `src/ui/sync-settings-view.ts` 的 `channelRemoteReady`、`buildSyncChannelBody` 已完整支持 `git | webdav | s3 | gist` 四通道。
- **依据**：`DESIGN.md` §1.1（产物库统一管理本地导出包、自动快照与远端快照）与评审维度 D4/D7。
- **改法**：
  1. 在 `src/client/library/LibraryActions.tsx:643-654` 重构 `remotePayload(syncApi)`：优先调 `syncApi.statusAll()`（若失败再回退 `syncApi.status()`），取当前激活或就绪的通道（按 `lastSyncChannel` 优先，再遍历 `['git', 'webdav', 's3', 'gist']` 中满足 `channelRemoteReady(ch, settings)` 的通道），复用 `src/ui/sync-settings-view.ts` 的 `buildSyncChannelBody(channel, settings)` 生成完整通道请求体（含 `channel`、`repoUrl`/`branch`、`webdav`、`s3`、`gist`）；导出该函数供 `LibraryPanel` 共用。
  2. 在 `src/client/library/LibraryPanel.tsx:127-139` 的 `loadRemote` 中削除只认 `webdav`/`repoUrl` 的手写分支，改为调用上述共用 `remotePayload(syncApi)` 获取 `payload`；若 `payload === null` 则返回 `[]`，否则调用 `syncApi.remoteList(payload)`。
  3. 删除 `src/client/library/LibraryPanel.tsx:84` 已失效的注释 `// 远端列表：走 syncApi.status() 拿默认通道（git repoUrl 或 webdav），没配通道静默返空`。
- **影响文件清单**：
  - `src/client/library/LibraryActions.tsx`
  - `src/client/library/LibraryPanel.tsx`
- **验收判据**：
  - 配置仅含 S3 或仅含 Gist 通道时，切换到「产物库 → 远端」筛选标签能正常发出 `POST /sync/remote/list`（携带 `channel: 's3'` 或 `'gist'` 载荷）并渲染远端快照行；点击行上的「查看」「拉取」「下载」「删除」不再抛 `sync channel address is unavailable`。
  - 运行 `npm run typecheck` 与 `npm test` 全部 PASS。
- **回归面**：
  - 触达产物库远端列表加载与远端快照 4 个操作按钮；影响守卫测试 `src/client/client-route-parity.test.ts`、`src/client/http-usage-guard.test.ts`。
- **风险与代价**：
  - `syncApi.statusAll()` 已在宿主侧对所有通道做短缓存，替代或前置 `syncApi.status()` 不会增加额外子进程开销；需确保单元测试 mock 中若只提供 `status()` 时有向后兼容 fallback。

#### F-02：补齐一键同步差异确认弹窗（`SyncConfirmView`）迁移前咨询的远端通道载荷
- **问题**：在同步页触发一键同步并进入差异确认弹窗时，`SyncConfirmView` 请求 `api.consult` 漏传远端通道配置，被宿主 400 挡回并静默吞掉，导致迁移前咨询（`ConsultCard`）永远不显示。
- **证据**：
  - `src/client/sync/SyncConfirmView.tsx:46-54`（`SyncConfirmViewProps` 只接收 `snapshotId?: string` 与 `api?: ConfigManagerApi`，未接收远端通道请求体）。
  - `src/client/sync/SyncConfirmView.tsx:98-106`（调用 `api.consult({ type: 'remote-snapshot', id: snapshotId, snapshotId })`，`.catch(() => { if (!cancelled) setConsultReport(null); })`）。
  - `src/client/library/LibraryActions.tsx:638-641,660-665`（已明确注释并修复同类问题：`宿主 prepareSync 要地址，只给快照 id 会被 400 repoUrl is required 挡回（真机反馈）`）。
  - `src/client/sync/SyncPanel.tsx:1563-1573`（挂载 `<SyncConfirmView>` 时已知当前 `confirmModal.channel` 与 `channelSettings(confirmModal.channel)`，但未传入）。
- **依据**：`DESIGN.md` §4.3.1（导入/同步覆盖前展示兼容性与风险咨询）与评审维度 D4/D7。
- **改法**：
  1. 在 `src/client/sync/SyncConfirmView.tsx:46-54` 的 `SyncConfirmViewProps` 中新增可选属性 `remoteChannelBody?: Record<string, unknown>`。
  2. 在 `src/client/sync/SyncConfirmView.tsx:98-106` 的 `useEffect` 中，将请求参数改为 `api.consult({ ...(remoteChannelBody ?? {}), type: 'remote-snapshot', id: snapshotId, snapshotId })`（依赖数组加入 `remoteChannelBody`）。
  3. 在 `src/client/sync/SyncPanel.tsx:1563-1573` 渲染 `<SyncConfirmView>` 处，传入 `remoteChannelBody={buildSyncChannelBody(confirmModal.channel, channelSettings(confirmModal.channel))}`。
- **影响文件清单**：
  - `src/client/sync/SyncConfirmView.tsx`
  - `src/client/sync/SyncPanel.tsx`
- **验收判据**：
  - 一键同步遇到冲突打开 `SyncConfirmView` 且存在 `snapshotId` 时，`POST /consult` 请求体包含当前通道的完整地址字段（如 `repoUrl` 或 `webdav`/`s3`/`gist`），宿主返回 200 后弹窗顶部正常渲染 `ConsultCard`。
  - 运行 `npm run typecheck` 与 `npm test` 全部 PASS。
- **回归面**：
  - 仅影响一键同步差异确认弹窗（`SyncConfirmView`）；关联守卫测试 `src/client/http-usage-guard.test.ts`、`src/client/plan-text-redaction.test.ts`。
- **风险与代价**：
  - `remoteChannelBody` 仅包含通道非敏感定位信息（凭据槽位引用而非明文密码），不触碰安全红线。

#### F-03：修复首页健康度异常告警点击未跳转至「环境 → 维护与诊断」子视图
- **问题**：当首页顶栏健康度出现红色/黄色告警（未解决事故、残留锁、中断残留）时，用户点击告警被带到「环境 → 档案列表」默认子视图，找不到解锁与恢复入口。
- **证据**：
  - `src/client/home/HomePanel.tsx:342-344`：`const navRecovery = (): void => { runStore.patch({ panel: 'environment' }); };`
  - `src/client/home/HomePanel.tsx:464-476`：顶栏异常按钮 `onClick={healthState.tone === 'ok' ? undefined : navRecovery}`。
  - 对照证据：`src/client/ConfigManagerSection.tsx:334-338` 的 `openRecoveryPanel` 明确写有注释 `// 跳环境页并落到「维护与诊断」子视图（只 patch panel 会落在「档案」列表上，等于没送到）` 并执行 `runStore.patch({ panel: 'environment', profiles: { subView: 'maintenance' } })`。
- **依据**：`DESIGN.md` §4.4 首页五条铁律之 2（急救可达性：异常状态点击一跳直达事故恢复/维护视图）与评审维度 D5/D3。
- **改法**：
  - 将 `src/client/home/HomePanel.tsx:342-344` 的 `navRecovery` 改为：
    ```ts
    const navRecovery = (): void => {
      runStore.patch({ panel: 'environment', profiles: { subView: 'maintenance' } });
    };
    ```
- **影响文件清单**：
  - `src/client/home/HomePanel.tsx`
- **验收判据**：
  - 当 `profiles.subView` 处于 `'list'` 且首页 `healthState.tone` 为 `'warn'` 或 `'danger'` 时，点击首页状态条第一段，`runStore.getState().panel` 变为 `'environment'` 且 `runStore.getState().profiles.subView` 变为 `'maintenance'`，界面直接展示 `RecoveryPanel` 与 `SessionHealthCard`。
  - 运行 `npm run typecheck` 与 `npm test` 全部 PASS。
- **回归面**：
  - 仅影响首页状态条异常点击跳转；可在 `src/ui/run-store.test.ts` 或首页测试中补充断言。
- **风险与代价**：
  - 改动仅 1 行，零副作用。

#### F-04：消除 5 处组件直接向用户渲染内部 `SectionId` / 适配器机器枚举
- **问题**：备份详情、同步结果、同步历史、导入收尾重启提示及市场分区筛选直接将 `pluginFiles`、`credentialsStatus`、`agentPresets` 等内部机器枚举渲染在界面上，未走 `sectionLabel(id, t)` 映射。
- **证据**：
  - `src/client/library/BackupInspectView.tsx:42`（`<Badge key={s.section} kind="info" className={css.inspectBadge}>{s.section}: {s.count}</Badge>`）与 `L80`（`<span className={css.mono + ' ' + css.inspectAdapter}>{item.adapter}:</span>`）。
  - `src/client/sync/SyncConfirmView.tsx:485`（`{result.applied.map((sid) => <Badge key={sid} kind="ok">{sid}</Badge>)}`）。
  - `src/client/sync/SyncLogList.tsx:189,197`（`{row.conflictedSections.map((sid) => <Badge key={sid} kind="warn">{sid}</Badge>)}` 与 `{row.appliedSections.map((sid) => <Badge key={sid} kind="ok">{sid}</Badge>)}`）。
  - `src/client/import/ImportWizardView.tsx:107`（`{restartItems.map((item) => <li key={item.id}>{item.adapter}: {redact(item.description)}</li>)}`）。
  - `src/client/market/MarketPanel.tsx:659`（`...sectionOptions.map((s) => ({ value: s, label: s }))`）。
  - 对照证据：`src/client/common/ContentPicker.tsx:85-87` 已实现 `export function sectionLabel(id: string, t: (k: LocaleKey) => string): string`（查 `SECTION_LABEL_KEYS[id]`，未知 id 才回退原串），且 `DESIGN.md:1231,1466` 明确规定：「所有分区标题统一走 `sectionLabel(id, t)`，不再让用户看见 `pluginFiles` 这类适配器 id」。
- **依据**：`DESIGN.md` L1231、L1466，`AGENTS.md` 代码节（i18n 禁硬编码/禁渲染裸枚举），评审维度 D6。
- **改法**：
  1. `src/client/library/BackupInspectView.tsx`：从 `../common/ContentPicker.ts` 引入 `sectionLabel`；将 L42 改为 `{sectionLabel(s.section, t)}: {s.count}`；将 L80 改为 `{sectionLabel(item.adapter, t)}:`（并去掉机器码专用的 `css.mono`）。
  2. `src/client/sync/SyncConfirmView.tsx`：从 `../common/ContentPicker.ts` 引入 `sectionLabel`；将 L485 改为 `<Badge key={sid} kind="ok">{sectionLabel(sid, t)}</Badge>`。
  3. `src/client/sync/SyncLogList.tsx`：从 `../common/ContentPicker.ts` 引入 `sectionLabel`；将 L189 与 L197 的 `{sid}` 均改为 `{sectionLabel(sid, t)}`。
  4. `src/client/import/ImportWizardView.tsx`：已引入 `ContentPicker.ts`，在 L18 补充引入 `sectionLabel`；将 L107 改为 `<li key={item.id}>{sectionLabel(item.adapter, t)}: {redact(item.description)}</li>`。
  5. `src/client/market/MarketPanel.tsx`：已引入 `sectionLabel`（L28），将 L659 的 `{ value: s, label: s }` 改为 `{ value: s, label: sectionLabel(s, t) }`。
- **影响文件清单**：
  - `src/client/library/BackupInspectView.tsx`
  - `src/client/sync/SyncConfirmView.tsx`
  - `src/client/sync/SyncLogList.tsx`
  - `src/client/import/ImportWizardView.tsx`
  - `src/client/market/MarketPanel.tsx`
- **验收判据**：
  - 上述 5 处界面在 zh/en 语言下均展示「插件与扩展 / Plugins & Extensions」「凭据槽位状态 / Credentials Status」等字典译文，不再出现 `pluginFiles`、`credentialsStatus` 裸枚举；未知扩展分区仍由 `sectionLabel` 安全回退原名。
  - 运行 `npm run typecheck`、`npm test`、`node --test tests/i18n-hardcoded-guard.test.ts` 全部 PASS。
- **回归面**：
  - 触达产物库详情弹窗、一键同步结果、同步历史展开详情、导入收尾页、市场筛选栏；需检查相关组件单测是否断言了裸 `sid` 字符串。
- **风险与代价**：
  - `sectionLabel` 是纯函数且已有完整映射表（覆盖全部 14 个内置分区 + 未知 id 原样兜底），无需新增字典键，风险极低。

---

### P1 级（显著降低效率、错误可行动性或系统一致性，共 6 条）

#### F-05：修复产物库删除快照确认弹窗向用户展示裸 ISO 时间戳
- **问题**：在产物库点击删除本机快照时，确认弹窗正文直接插入了未格式化的 `confirmDelete.title.iso`（如 `2026-11-15T08:30:00.000Z`），且当快照标题为普通文本（`kind === 'text'`）时传入了空字符串。
- **证据**：
  - `src/client/library/LibraryActions.tsx:547-548`：
    - L547：`title={t('snapshots.deleteTitle', { time: timeText(confirmDelete) })}`
    - L548：`message={t('snapshots.deleteConfirm', { time: confirmDelete.title.kind === 'time' ? confirmDelete.title.iso : '' })}`
  - `src/client/library/LibraryActions.tsx:622-625`：文件内自己的 `timeText` 注释写道 `/** 弹窗文案里的时间：走与列表行同一份格式化（绝不把裸 ISO 甩给用户）。 */`。
- **依据**：`src/client/library/LibraryActions.tsx:622` 内部契约与评审维度 D4/D6。
- **改法**：
  - 将 `src/client/library/LibraryActions.tsx:548` 改为：
    ```tsx
    message={t('snapshots.deleteConfirm', { time: timeText(confirmDelete) })}
    ```
- **影响文件清单**：
  - `src/client/library/LibraryActions.tsx`
- **验收判据**：
  - 点击任意本机快照的「删除」，确认弹窗标题与正文中的时间格式完全一致（均为本地化可读时间或快照标题文本），不再出现 `T...Z` 裸 ISO 字符串。
- **回归面**：
  - 仅影响 `LibraryActions` 删除确认弹窗。
- **风险与代价**：
  - 改动 1 行，零风险。

#### F-06：统一 6 处页面/卡片的错误横幅到 `ErrorBanner`（补齐 `toActionableError` 三段式与丢失的错误原因）
- **问题**：首页定时备份卡、环境页、事故恢复页、回滚点卡、配置市场页、关于页在加载或操作失败时手写 `<Banner kind="error">`，未走 `ErrorBanner`（`toActionableError()`），其中定时备份卡直接把 catch 到的错误字符串丢弃。
- **证据**：
  - `src/client/home/BackupScheduleCard.tsx:66,105,239-244`（L66 `const [, setError] = useState<string | null>(null)` 丢弃错误文本；L239-244 渲染无原因的静态 `<Banner kind="error">` 且重试 `<Button>` 未加 `size="sm"`）。
  - `src/client/environment/EnvironmentPanel.tsx:574-578`（手写 `<Banner kind="error">{redact(state.loadError ?? t('profiles.errorLoad'))}<Button size="sm" onClick={load}>...</Button></Banner>`）。
  - `src/client/recovery/RecoveryPanel.tsx:528-533`（手写 `<Banner kind="error"><span>{t('recovery.errorLoad')}: {redact(error)}</span><Button ...>`）。
  - `src/client/recovery/RollbackCard.tsx:477-481,600-605`（两处手写 `<Banner kind="error">` 渲染 `loadError` 与 `actionError`）。
  - `src/client/market/MarketPanel.tsx:618-624` 与 `src/client/about/AboutPanel.tsx:115-122`（手写 `<Banner kind="error">{redact(state.loadError)}</Banner>` 并在外部另起 `<div className={css.actionRow}><Button>` 放重试按钮）。
- **依据**：`AGENTS.md` 代码节（「错误链：`toActionableError()` → `ErrorBanner`，展示文本渲染前过 `redact()`」）与 `DESIGN.md` D4（错误文案须含位置 + 原因 + 修法）。
- **改法**：
  1. `src/client/home/BackupScheduleCard.tsx`：将 L66 改为 `const [error, setError] = useState<string | null>(null)`；在 L239-244 改用 `<ErrorBanner error={error ?? t('schedule.errorLoad')} onRetry={() => void load()} retryLabel={t('schedule.retry')} />`（从 `../common/ErrorBanner.tsx` 引入）。
  2. `src/client/environment/EnvironmentPanel.tsx:574-578`：改用 `<ErrorBanner error={state.loadError ?? t('profiles.errorLoad')} onRetry={() => void load()} retryLabel={t('profiles.retry')} />`。
  3. `src/client/recovery/RecoveryPanel.tsx:528-533`：改用 `<ErrorBanner error={`${t('recovery.errorLoad')}: ${error}`} onRetry={() => void load()} retryLabel={t('recovery.retry')} />`。
  4. `src/client/recovery/RollbackCard.tsx:477-481,600-605`：`loadError` 处改用 `<ErrorBanner error={loadError} onRetry={() => void loadPoints()} retryLabel={t('rollback.refresh')} />`；`actionError` 处改用 `<ErrorBanner error={actionError} onDismiss={() => setActionError(null)} />`。
  5. `src/client/market/MarketPanel.tsx:618-624` 与 `src/client/about/AboutPanel.tsx:115-122`：将 `<Banner kind="error">` + 外部重试 `<div className={css.actionRow}>` 合并为单个 `<ErrorBanner error={state.loadError} onRetry={...} retryLabel={...} />`。
- **影响文件清单**：
  - `src/client/home/BackupScheduleCard.tsx`
  - `src/client/environment/EnvironmentPanel.tsx`
  - `src/client/recovery/RecoveryPanel.tsx`
  - `src/client/recovery/RollbackCard.tsx`
  - `src/client/market/MarketPanel.tsx`
  - `src/client/about/AboutPanel.tsx`
- **验收判据**：
  - 上述 6 处触发网络/宿主错误（如 `HTTP 423`、`SAFE_MODE_ACTIVE`、`timeout`）时，统一由 `ErrorBanner` 渲染出经 `toActionableError()` 映射的「原因 + 可行动建议」及内联操作按钮，且全程经过 `redact()` 脱敏。
  - 运行 `npm run typecheck`、`npm test`、`npx tsx --test src/client/plan-text-redaction.test.ts` 全部 PASS。
- **回归面**：
  - 触达 6 个组件的错误分支；需检查 `src/client/plan-text-redaction.test.ts` 是否对上述文件中的 `redact(` 字面量调用有静态断言（`ErrorBanner` 内部已调 `redact()`，若守卫扫源码字面量，可在传给 `ErrorBanner` 的 `error` 属性上保留 `redact(...)` 包装）。
- **风险与代价**：
  - 需注意 `src/client/plan-text-redaction.test.ts` 的源码静态扫描规则：传参写为 `error={redact(rawError)}` 即可同时满足 `ErrorBanner` 原语复用与静态脱敏守卫。

#### F-07：补齐 3 处弹窗的 `Modal.Footer` 固定底栏，将主操作移出滚动区 `Modal.Body`
- **问题**：产物库「查看与对比」弹窗缺失底栏；一键同步差异确认弹窗（`SyncConfirmView`）与回滚点预览/结果弹窗（`RollbackCard`）把「确认导入 / 回退到此点 / 取消 / 关闭」按钮放在 `Modal.Body scroll` 内部，内容较长时操作按钮随滚动条滚走。
- **证据**：
  - `src/client/library/LibraryActions.tsx:569-578`（`inspect` 弹窗只有 `Modal.Header` + `Modal.Body scroll`，无 `Modal.Footer`）。
  - `src/client/sync/SyncPanel.tsx:1545-1575` 与 `src/client/sync/SyncConfirmView.tsx:233-237,331-350,380-384`（`SyncPanel` 用 `<Modal.Body scroll><SyncConfirmView .../></Modal.Body>` 包裹整个视图，而 `SyncConfirmView` 内部的 `.modalActions` 按钮栏跟着内容一起滚动）。
  - `src/client/recovery/RollbackCard.tsx:734-928`（`<Modal open={modalOpen}>` 只有 `<Modal.Header>` 与 `<Modal.Body scroll>`，L846-850 的「取消 / 回退到此点」与 L922-924 的「关闭」都在 `Modal.Body` 内）。
- **依据**：`DESIGN.md` §6 Modal 规范（`Modal.Header` + `Modal.Body` + `Modal.Footer`，历史审计 UI-23 亦规定「所有弹窗底部动作统一进 `Modal.Footer`（固定在滚动区外、顶部分隔线）」）及评审维度 D3/D5。
- **改法**：
  1. `src/client/library/LibraryActions.tsx:569-578`：在 `inspect` 弹窗的 `</Modal.Body>` 后追加 `<Modal.Footer><Button variant="ghost" onClick={closeInspect}>{t('common.close')}</Button></Modal.Footer>`。
  2. `src/client/recovery/RollbackCard.tsx:734-928`：将 L846-850（预览态的「取消」+「回退到此点」按钮）与 L922-924（结果态的「关闭」按钮）从 `<Modal.Body scroll>` 中拆出，放入同级的 `<Modal.Footer>` 中，根据 `rewindResult` / `previewLoading` 状态渲染对应按钮组。
  3. `src/client/sync/SyncPanel.tsx:1545-1575` 与 `src/client/sync/SyncConfirmView.tsx`：支持向 `SyncConfirmView` 传入 `renderFooter?: (footerNode: React.ReactNode) => React.ReactNode` 或由 `SyncConfirmView` 直接渲染 `<Modal.Body scroll>...</Modal.Body><Modal.Footer>...</Modal.Footer>`（将 `SyncPanel.tsx:1557` 的外层 `<Modal.Body scroll>` 下沉到 `SyncConfirmView` 内部，使其顶部筛选/差异表在 `Modal.Body scroll` 内滚动，底部 `.modalActions` 固定在 `<Modal.Footer>` 中）。
- **影响文件清单**：
  - `src/client/library/LibraryActions.tsx`
  - `src/client/recovery/RollbackCard.tsx`
  - `src/client/sync/SyncPanel.tsx`
  - `src/client/sync/SyncConfirmView.tsx`
- **验收判据**：
  - 打开产物库「查看」、一键同步差异确认、回滚点预览三个弹窗时，DOM 结构均为 `.modalHeader` + `.modalBody.modalBodyScroll` + `.modalFooter`；当列表超过弹窗高度产生滚动时，底部操作按钮始终固定在弹窗底栏可见。
  - 运行 `npm run typecheck`、`npm test`、`npm run build` 全部 PASS。
- **回归面**：
  - 触达上述 3 个弹窗；注意 `SyncConfirmView` 若在测试中被独立挂载，保留未包裹 `Modal` 时的兼容渲染。
- **风险与代价**：
  - 结构调整清晰，不改变任何业务状态机与回调逻辑。

#### F-08：将回滚点、同步确认与市场弹窗中的 4 处原生表单控件替换为公共原语（`Select` / `Switch` / `Checkbox`）
- **问题**：4 处交互直接使用了原生 `<select>`、裸 `<input type="checkbox">` 或将立即生效的布尔开关写成了 `<Checkbox>`，偏离公共原语规范。
- **证据**：
  - `src/client/recovery/RollbackCard.tsx:821-832`：回滚点会话选择器使用原生 `<select className={css.input}>`，在深色模式下原生 `<option>` 弹窗不受 `--cm-*` 表面 token 控制。
  - `src/client/recovery/RollbackCard.tsx:434-439`：卡片顶栏「自动留点」总开关点击即调 `togglePrefs` 落盘生效，却使用了表单勾选框 `<Checkbox>` 而非拨动开关 `<Switch>`（对比 `src/client/home/BackupScheduleCard.tsx:266`、`src/client/sync/AutosyncCard.tsx:179` 均使用 `<Switch>`）。
  - `src/client/sync/SyncConfirmView.tsx:294-302`：「高级逐项选择」开关使用裸 `<label className={css.checkboxRow}><input type="checkbox" .../></label>`。
  - `src/client/market/MarketPanel.tsx:753-761` 与 `src/client/market/MyConfigsView.tsx:797-805`：免责声明确认框使用裸 `<label className={css.checkboxRow}><input type="checkbox" .../></label>`。
- **依据**：`AGENTS.md` UI 节（「原语复用：`common/ui.tsx` 原语，能解决就禁重建」）、`src/client/common/ui.tsx:448-451`（`Switch` 用于「设置型 / 模式型的单一布尔、拨动即生效」；`Checkbox` 用于「从一组里挑几个」或先勾再点按钮提交）及评审维度 D5/D6。
- **改法**：
  1. `src/client/recovery/RollbackCard.tsx:821-832`：从 `../common/Select.tsx` 引入 `Select`，将原生 `<select>` 替换为 `<Select value={selectedConvoId} disabled={rewinding} onChange={(v) => { setSelectedConvoId(v); void loadPoints(v); }} options={[{ value: '', label: t('rollback.selectSessionPlaceholder') }, ...conversations.map((c) => ({ value: c.id, label: ... }))]} ariaLabel={t('rollback.sessionPickerLabel')} />`。
  2. `src/client/recovery/RollbackCard.tsx:434-439`：从 `../common/ui.tsx` 引入 `Switch`，将顶栏自动留点 `<Checkbox>` 替换为 `<Switch checked={prefs.enabled} disabled={prefsSaving} onChange={(v) => void togglePrefs(v)} label={t('rollback.autoEnable')} />`。
  3. `src/client/sync/SyncConfirmView.tsx:294-302`、`src/client/market/MarketPanel.tsx:753-761`、`src/client/market/MyConfigsView.tsx:797-805`：从 `../common/ui.tsx` 引入 `Checkbox`，替换为 `<Checkbox checked={...} onChange={...} label={...} />`。
- **影响文件清单**：
  - `src/client/recovery/RollbackCard.tsx`
  - `src/client/sync/SyncConfirmView.tsx`
  - `src/client/market/MarketPanel.tsx`
  - `src/client/market/MyConfigsView.tsx`
- **验收判据**：
  - 全仓 `src/client/**` 中除 `src/client/common/ui.tsx` 与 `src/client/common/ContentPicker.tsx`（带 `indeterminate` 半选态的树节点）外，不再存在裸 `<input type="checkbox"` 或原生 `<select`；回滚点自动留点开关呈现为 `role="switch"`。
  - 运行 `npm run typecheck`、`npm test`、`npm run build` 全部 PASS。
- **回归面**：
  - 触达回滚点卡、同步确认弹窗、市场导入与发布免责声明弹窗。
- **风险与代价**：
  - `common/Select.tsx` 使用 Portal 挂载到 `document.body` 并带完整键盘导航（ArrowUp/Down/Enter/Escape），在 `Modal` 内打开时层级（`z-index: 1100`）高于 Modal（`z-index: 1000`），不会发生裁剪。

#### F-09：补齐 `SyncPanel.loadAutosync()` 回退路径对 `s3` 与 `gist` 通道的状态写回
- **问题**：当 `SyncPanel` 通过 `loadAutosync()` 单独拉取 `api.autosyncStatusAll()` 时，只将返回结果写回了 `git` 与 `webdav` 两个通道，`s3` 与 `gist` 被忽略。
- **证据**：
  - `src/client/sync/SyncPanel.tsx:538-550`：
    ```ts
    const all = await api.autosyncStatusAll();
    if (all.git) patchChannelState('git', { autosync: all.git });
    if (all.webdav) patchChannelState('webdav', { autosync: all.webdav });
    ```
  - 对照证据：`src/client/sync/SyncPanel.tsx:504-508` 在主路径 `loadStatus` 中遍历了全部 `CHANNELS`（`['git', 'webdav', 's3', 'gist']`）并写入 `autosync: all.autosync?.[id]`。
- **依据**：评审维度 D4（状态完整性）与 D7（前端实现质量）。
- **改法**：
  - 将 `src/client/sync/SyncPanel.tsx:540-541` 改为遍历 `CHANNELS`：
    ```ts
    for (const id of CHANNELS) {
      if (all[id]) patchChannelState(id, { autosync: all[id] });
    }
    ```
- **影响文件清单**：
  - `src/client/sync/SyncPanel.tsx`
- **验收判据**：
  - 当 `statusAll()` 失败降级到 `loadAutosync()` 时，`s3` 与 `gist` 通道的 `autosync` 状态同样从 `autosyncStatusAll()` 得到更新。
  - 运行 `npm run typecheck` 与 `npm test` 全部 PASS。
- **回归面**：
  - 仅影响 `SyncPanel` 的 `loadAutosync` 降级分支。
- **风险与代价**：
  - 改动 3 行，零风险。

#### F-10：消除首页首次空态与同步页少通道态下的 564×720 画布底部空洞
- **问题**：首页在首次无数据空态（`emptyState === true`）时引导卡未挂 `.activityCardFill`，同步页底部的同步历史卡（`SyncLogList`）未挂 `.fillCard`/`.activityCardFill`，在 564×720 画布中留下大块纯背景空洞。
- **证据**：
  - `src/client/home/HomePanel.tsx:506-517`：空态 `<Card className={css.activityCard}>` 未加 `css.activityCardFill`，而 L524 非空态 `<Card className={css.activityCard + ' ' + css.activityCardFill}>` 挂载了该类。
  - `src/client/sync/SyncLogList.tsx:78-92`：空态 `<Card>`（L79）与列表态 `<Card>`（L87）均只用了默认 `Card` 类，而 `SyncPanel.tsx:1357` 的外层是 `.pageBody`（`display: flex; flex-direction: column; flex: 1`），当上方仅配置 0 或 1 个折叠通道卡（高度 `56px`）时，画布下半部 ~400px 为纯背景色。
  - `src/client/config-manager.module.css:435-466`：`.fillCard` 与 `.activityCardFill` 已专门定义为 `flex: 1 1 auto; display: flex; flex-direction: column`。
- **依据**：`DESIGN.md` §0.3 画布纪律（564×720 内禁止大块无意义纯背景区域，页面尾卡须吃满剩余视口高度并内滚）及评审维度 D1。
- **改法**：
  1. 将 `src/client/home/HomePanel.tsx:506` 的 `<Card className={css.activityCard}>` 改为 `<Card className={css.activityCard + ' ' + css.activityCardFill}>`。
  2. 将 `src/client/sync/SyncLogList.tsx:79`（空态 `<Card>`）与 `L87`（列表态 `<Card>`）加上 `className={css.fillCard}`（并在 `SyncLogList` 空态内部使用 `<Empty>` 居中填充）。
- **影响文件清单**：
  - `src/client/home/HomePanel.tsx`
  - `src/client/sync/SyncLogList.tsx`
- **验收判据**：
  - 在 564×720 视口下，首页处于首次空态（无快照、无运行记录、无同步）及同步页处于 0/1 个折叠通道时，页面尾卡（引导卡 / 同步历史卡）自动延展到底部状态栏上方，无纯背景空洞。
  - 运行 `npm run typecheck`、`npm test`、`npx tsx --test src/client/css-scale-guard.test.ts` 全部 PASS。
- **回归面**：
  - 仅影响首页空态与同步页尾卡的 flex 纵向伸展，不影响卡片内部元素尺寸。
- **风险与代价**：
  - 复用已有的 `.activityCardFill` 与 `.fillCard` 样式类，无需新增 CSS 属性，不触碰 `css-scale-guard`。

---

### P2 级（打磨：原语收口与守卫豁免表瘦身，共 2 条）

#### F-11：将同步日志、合并预览、市场审查与内容选择器中的 4 处手写空态收口到 `<Empty>` 原语
- **问题**：4 处组件在列表或筛选为空时手写 `<Card><strong>...<p>` 或 `<div/span className={css.hint}>`，未复用 `common/ui.tsx` 的 `<Empty>` 原语。
- **证据**：
  - `src/client/sync/SyncLogList.tsx:78-84`（`<Card><strong>{t('history.empty')}</strong><p className={css.hint}>{t('history.emptyHint')}</p></Card>`）。
  - `src/client/sync/MergePreviewView.tsx:143-145`（`<div className={css.hint}>{t('merge.empty')}</div>`）。
  - `src/client/market/MarketImportReview.tsx:276,294,356`（3 处 `<div className={css.hint}>{t('review.changeEmpty')}</div>` / `t('review.filterEmpty')`）。
  - `src/client/common/ContentPicker.tsx:335,596`（2 处 `<span className={css.hint}>{t('picker.empty')}</span>`）。
- **依据**：`AGENTS.md` UI 节（「原语复用：`common/ui.tsx` 原语，能解决就禁重建」）与评审维度 D4/D6。
- **改法**：
  1. `src/client/sync/SyncLogList.tsx:78-84`：在 `<Card className={css.fillCard}>` 内改用 `<Empty title={t('history.empty')} hint={t('history.emptyHint')} />`。
  2. `src/client/sync/MergePreviewView.tsx:143-145`、`src/client/market/MarketImportReview.tsx:276,294,356`、`src/client/common/ContentPicker.tsx:335,596`：从 `../common/ui.tsx`（或 `./ui.tsx`）引入 `Empty`，将裸 `<div/span className={css.hint}>` 替换为 `<Empty title={...} />`。
- **影响文件清单**：
  - `src/client/sync/SyncLogList.tsx`
  - `src/client/sync/MergePreviewView.tsx`
  - `src/client/market/MarketImportReview.tsx`
  - `src/client/common/ContentPicker.tsx`
- **验收判据**：
  - 上述 4 处空态统一渲染为 `.empty` 容器（带统一字号、色阶与内边距）。
  - 运行 `npm run typecheck` 与 `npm test` 全部 PASS。
- **回归面**：
  - 仅影响上述 4 个组件的空列表分支。
- **风险与代价**：
  - 纯展示原语替换，无状态逻辑变更。

#### F-12：将市场与同步设置的手写 `tablist` 收口到 `<Segmented>`，并清理 5 处静态内联间距豁免
- **问题**：`MarketPanel` 与 `SyncSettingsDialog` 手写 `<div role="tablist"><button role="tab">` 而未复用 `<Segmented>` 原语；4 个组件残留 5 处静态 `style={{ marginTop: 8 }}` / `style={{ marginBottom: 8 }}`，依赖 `css-scale-guard.test.ts` 的豁免名单。
- **证据**：
  - `src/client/market/MarketPanel.tsx:437-456`（手写 `<div className={css.modeTabs} role="tablist">` 切换浏览/我的配置）。
  - `src/client/sync/SyncSettingsDialog.tsx:157-176`（手写 `<div className={css.settingsTabs} role="tablist">` 切换通道/自动同步/本地目录）。
  - 静态内联样式：`src/client/home/BackupScheduleCard.tsx:409`（`style={{ marginTop: 8 }}`）、`src/client/sync/SyncChannelEntryCard.tsx:110`（`style={{ marginTop: 8 }}`）、`src/client/sync/WorkDirCard.tsx:93`（`style={{ marginTop: 8 }}`）、`src/client/sync/AutosyncCard.tsx:142,239`（`style={{ marginBottom: 8 }}`、`style={{ marginTop: 8 }}`），登记在 `src/client/css-scale-guard.test.ts:110-124` 的 `INLINE_STYLE_ALLOWLIST`。
- **依据**：`AGENTS.md` UI 节（「样式只进 `src/client/config-manager.module.css`：禁内联 `<style>`」、「原语复用：`common/ui.tsx` 原语」）及 `src/client/css-scale-guard.test.ts`（`tsx-02` 守卫）。
- **改法**：
  1. 在 `src/client/market/MarketPanel.tsx:437-456` 与 `src/client/sync/SyncSettingsDialog.tsx:157-176` 中引入 `Segmented`（来自 `../common/ui.tsx`），替换手写的 `role="tablist"` 按钮组（与 `EnvironmentPanel.tsx:409-417`、`MarketImportReview.tsx:287-292` 保持一致）。
  2. 将 `BackupScheduleCard.tsx:409`、`SyncChannelEntryCard.tsx:110`、`WorkDirCard.tsx:93`、`AutosyncCard.tsx:142,239` 的静态 `style={{ marginTop: 8 }}` / `style={{ marginBottom: 8 }}` 替换为父级 `.stackSm`（`gap: 8px`）或 `config-manager.module.css` 中已有的间距组合，并同步从 `src/client/css-scale-guard.test.ts:110-124` 的 `INLINE_STYLE_ALLOWLIST` 中移除这 4 个文件的豁免项。
- **影响文件清单**：
  - `src/client/market/MarketPanel.tsx`
  - `src/client/sync/SyncSettingsDialog.tsx`
  - `src/client/home/BackupScheduleCard.tsx`
  - `src/client/sync/SyncChannelEntryCard.tsx`
  - `src/client/sync/WorkDirCard.tsx`
  - `src/client/sync/AutosyncCard.tsx`
  - `src/client/css-scale-guard.test.ts`
- **验收判据**：
  - 市场页顶栏与同步设置弹窗顶栏使用 `<Segmented>` 渲染，`src/client/css-scale-guard.test.ts` 中 `INLINE_STYLE_ALLOWLIST` 缩减 4 条文件记录后运行 `npx tsx --test src/client/css-scale-guard.test.ts` 依然 PASS。
- **回归面**：
  - 触达 `css-scale-guard.test.ts` 与上述 6 个组件；若 `MarketPanel` 单测通过 `css.modeTabActive` 断言，需确认或保留类名兼容。
- **风险与代价**：
  - 减少守卫白名单债务，防止后续复制粘贴扩散内联 `style`。

---

## 4. 不做清单

### 4.1 四份历史审计已修复、本次复核确认无问题的项（不重复立项）
- **`docs/archive/2026-11-01-visual-pass.md` 已闭环项**：字号 6 档收敛与 `--cm-fs-*` 变量化、间距 7 档与圆角 4 档、`--dsw-*` 到 `--cm-*` 三层单向映射、`backdrop-filter` 移除、图标尺寸收敛为 `14/16/20` 三档、弹簧参数统一 `MORPH_SPRING`、首页顶栏 3 段状态条 + 2 主动作卡 + 近期活动列表布局 — 均已由 `css-token-guard`、`css-scale-guard`、`css-motion-guard`、`icon-layer-guard` 钉死且 PASS，确认无问题。
- **`docs/archive/2026-11-01-technical-audit.md` 已闭环项**：`ConfigManagerSection` 热键仅在焦点位于插件容器内触发（`src/client/ConfigManagerSection.tsx:524-546`）、`Modal` 打开时焦点陷阱与关闭后焦点归还触发器（`src/client/common/Modal.tsx:92-160`）、`Select` 下拉 Portal 定位与键盘上下键导航（`src/client/common/Select.tsx:76-184`）、`runStore` 轮询卸载清理与防重入（`src/ui/run-store.ts`）、错误与报告渲染前强制经过 `redact()`（`src/client/plan-text-redaction.test.ts` 11/11 PASS）— 确认无问题。
- **`207521cc68ef:docs/design/ui-audit-2026-09-20.md` 与 `docs/archive/2026-10-05-ui-redesign-v3.md` 已闭环项**：四页一级导航（首页 / 产物库 / 同步 / 环境）收敛、任务中心并入状态栏弹出层 `RunsCenter`、关于与市场移入顶栏溢出菜单 `⋯`、导入向导三步流（选源→预览与挑选→执行与报告）与导出向导两步流 — 均已落地并由 `nav-menu-clip-guard`、`skeleton-guard` 守卫，确认无问题。

### 4.2 历史审计已决策不做 / 受宿主限制做不了 / 需产品决策的项
- **不做全局主题切换器或自定义配色面板**：受宿主限制；插件嵌在 DSH `settings.section` 内，明暗主题完全由宿主在 `body` 上注入的 `--dsw-*` 变量决定（`DESIGN.md` §0.1、§2.1）。
- **不做凭据明文预览或导入后凭据回滚**：受宿主安全限制；DSH credentials 服务只写不回读，插件绝不落盘或向浏览器回传凭据明文（`AGENTS.md` 安全不变量、`docs/known-issues/known-limits.md` §1）。
- **不做 MCP 服务器的增量启停或单条编辑 API**：受宿主限制；DSH 无 MCP 管理 API，前端只能通过 `cordis.patch.yml` 组合行做导入预览与写回（`AGENTS.md` 技术限制）。
- **不把「配置市场」或「历史记录」提回一级导航页签**：历史审计（`2026-10-05-ui-redesign-v3.md`）已决策不做；564px 宽画布顶栏最多容纳 4 个一级页签，市场与运行历史属低频辅助入口，固定从顶栏 `⋯` 菜单或状态栏进入（硬约束 3）。
- **不引入虚拟滚动库（如 `react-window`）或动画库（如 `framer-motion`）**：架构硬约束已决策不做；运行时除 `js-yaml` 外零第三方 UI/动画依赖，长列表统一靠 CSS `*Scroll` 限高内滚与分页/截断解决（`AGENTS.md` 通用节、硬约束 3）。
- **不将导出/导入过程中的布尔等待条改为百分比进度条（除非后端真实回报 `/progress` 步数）**：`DESIGN.md` D4 已决策不做；禁止前端用定时器伪造假进度百分比，无确定分子分母时只用 indeterminate 进度条。
- **不在前端支持离线 CLI 模式下收集 `pluginData`/`pluginAssets`**：架构已决策不做；这两个分区的根在系统主目录（`osHomeDir`），仅 GUI 宿主态可收集（`AGENTS.md` Profile/插件数据节）。
- **是否将「同步页」在已配置 ≥3 个通道时的通道卡片默认折叠策略改为手风琴互斥展开**：需产品决策；当前每个 `SyncChannelEntryCard` 独立维护 `expanded` 状态，若强制互斥展开会打断用户同时比对两个通道状态的操作流，暂不改动。

---

## 5. 落地顺序

### 第一批：低风险独立改动（修断路与导航深链，不改字典与守卫白名单）
- **包含条目**：F-01（产物库 S3/Gist 远端载荷打通）、F-02（`SyncConfirmView` 迁移前咨询补齐通道载荷）、F-03（首页异常告警直达 `maintenance` 子视图）、F-05（删除快照确认弹窗复用 `timeText`）、F-09（`loadAutosync` 补齐 `s3`/`gist`）、F-10（首页空态与同步页尾卡补齐 `.activityCardFill`/`.fillCard`）。
- **预计触达文件数**：5 个文件（`src/client/library/LibraryPanel.tsx`、`src/client/library/LibraryActions.tsx`、`src/client/sync/SyncConfirmView.tsx`、`src/client/sync/SyncPanel.tsx`、`src/client/home/HomePanel.tsx`、`src/client/sync/SyncLogList.tsx` — 共 6 个文件）。
- **验证命令**：
  - `npm run typecheck`
  - `npm test`
  - `npx tsx --test src/client/client-route-parity.test.ts src/client/http-usage-guard.test.ts src/client/css-scale-guard.test.ts`

### 第二批：需连带组件原语、脱敏守卫或样式豁免表的改动
- **包含条目**：F-04（5 处裸 `SectionId`/适配器枚举改走 `sectionLabel(id, t)`）、F-06（6 处错误横幅收口到 `ErrorBanner`）、F-07（3 处弹窗动作收口到 `Modal.Footer`）、F-08（4 处原生表单控件收口到 `Select`/`Switch`/`Checkbox`）、F-11（4 处手写空态收口到 `Empty`）、F-12（2 处 `tablist` 收口到 `Segmented` 并清理 `css-scale-guard.test.ts` 的 4 个文件内联样式豁免）。
- **预计触达文件数**：15 个文件（`src/client/library/BackupInspectView.tsx`、`src/client/library/LibraryActions.tsx`、`src/client/sync/SyncConfirmView.tsx`、`src/client/sync/SyncLogList.tsx`、`src/client/sync/SyncPanel.tsx`、`src/client/sync/SyncSettingsDialog.tsx`、`src/client/sync/MergePreviewView.tsx`、`src/client/sync/SyncChannelEntryCard.tsx`、`src/client/sync/WorkDirCard.tsx`、`src/client/sync/AutosyncCard.tsx`、`src/client/import/ImportWizardView.tsx`、`src/client/market/MarketPanel.tsx`、`src/client/market/MarketImportReview.tsx`、`src/client/market/MyConfigsView.tsx`、`src/client/home/BackupScheduleCard.tsx`、`src/client/environment/EnvironmentPanel.tsx`、`src/client/recovery/RecoveryPanel.tsx`、`src/client/recovery/RollbackCard.tsx`、`src/client/about/AboutPanel.tsx`、`src/client/common/ContentPicker.tsx`、`src/client/css-scale-guard.test.ts` — 与第一批合并去重后共新增 17 个文件）。
- **验证命令**：
  - `npm run typecheck`
  - `npm test`
  - `npx tsx --test src/client/css-token-guard.test.ts src/client/css-scale-guard.test.ts src/client/css-motion-guard.test.ts src/client/icon-layer-guard.test.ts src/client/plan-text-redaction.test.ts tests/i18n-hardcoded-guard.test.ts`
  - `TEMP=.tmp/buildtmp TMP=.tmp/buildtmp npm run build`
  - `npx tsx --test src/client/bundle-selfcontained.test.ts`

### 第三批：需产品拍板后实施的改动
- **包含条目**：4.2 节所列的「多同步通道卡片展开策略（独立展开 vs. 手风琴互斥展开）」。当前 12 条确定性缺陷（F-01 至 F-12）均无需等待产品拍板，可在第一、二批直接闭环。
- **预计触达文件数**：0–2 个文件（若产品决定保持现状则为 0；若改为手风琴互斥则触达 `src/client/sync/SyncPanel.tsx` 与 `src/client/sync/SyncChannelEntryCard.tsx`）。
- **验证命令**：
  - `npm run typecheck && npm test`

---

## 6. 未验证项

1. **宿主 Electron WebView 真实注入的 `--dsw-*` 变量在亮/暗两套主题下的实机像素对比度（未验证）**
   - **未验证原因**：本次审计在 Node/CLI 环境下只读执行，未挂载真实 DSH 桌面宿主 WebView，无法直接测量宿主运行时在 `body` 上动态计算出的 `--dsw-bg` / `--dsw-text-*` 实机对比度。
   - **用户自行验证方式**：在 DSH 宿主中打开「设置 → 配置管理」，分别切换宿主深色与浅色主题，使用 Chrome DevTools Elements 面板检查 `.section` 下 `--cm-text-primary` 与 `--cm-bg-card` 的 Computed 对比度是否 ≥ 4.5:1。
2. **S3 与 Gist 远端通道在真实凭据与公网端点下的端到端拉取耗时与错误码映射（未验证）**
   - **未验证原因**：只读审计环境未配置真实 AWS S3 桶或 GitHub Personal Access Token，F-01 与 F-02 的结论基于 `LibraryPanel.tsx`/`LibraryActions.tsx`/`SyncConfirmView.tsx` 与 `SyncPanel.tsx` 的源码级请求载荷比对得出。
   - **用户自行验证方式**：在「同步 → 设置」中配置一个有效 Gist 或 S3 通道并推送一次快照后，按 F-01 修复代码，切换到「产物库 → 远端」查看列表是否显示该快照，并在 Network 面板确认 `POST /api/dsh-config-manager/sync/remote/list` 返回 200。
3. **聊天消息内嵌回滚点入口（`src/client/chat/ChatRollbackEntry.tsx`）在宿主 `conversation.chat.user.content` 槽位中的真实气泡混排高度（未验证）**
   - **未验证原因**：该组件通过 `renderFactorySlot('conversation.chat.user.content', ...)` 委托宿主聊天流渲染，脱离宿主聊天会话视图时仅能测试 fallback 分支。
   - **用户自行验证方式**：在启用「工作区 + 会话自动留点」后发起一轮真实对话，观察用户消息气泡右下角的回滚点图标是否与宿主原生消息操作栏对齐且不遮挡正文。

---

## 7. 自检表

| 序号 | 验收标准 | 结果 | 自检说明 |
| :--- | :--- | :--- | :--- |
| 1 | 每条 finding 至少 1 个 `file:line` 证据；抽查任意 3 条都能在源码原位置复现。 | **PASS** | F-01 至 F-12 共 12 条均给出精确到行号的源码路径（共 36 处 `file:line` 引用），全部经源码实读核对。 |
| 2 | 无与四份历史审计重复的条目；重复项只出现在「不做清单」。 | **PASS** | 已逐份比对 `2026-11-01-visual-pass.md`、`2026-11-01-technical-audit.md`、`ui-audit-2026-09-20.md`、`2026-10-05-ui-redesign-v3.md`，历史已修项与已决策不做项全部归入「4. 不做清单」。 |
| 3 | P0 ≤ 5 条，且每条都能说明「用户在哪一步被卡住」。 | **PASS** | P0 共 4 条（F-01 至 F-04），每条均明确写出用户被阻断的具体操作步骤与界面现象。 |
| 4 | 任取一条 P1，另一个 agent 只读该条即可动手，无需再调研。 | **PASS** | F-05 至 F-10 每条均给齐目标文件路径、行号、要引入的组件/函数名、替换后的具体 JSX/TS 代码片段及验证命令。 |
| 5 | 方案未提出任何第三方库、新页签、新容器类型。 | **PASS** | 全文零第三方库建议、零新增一级页签、零新增容器类型，全部复用 `src/client/common/` 既有原语与 `src/ui/` 既有纯函数。 |
| 6 | 全文无「建议优化体验/提升美观」这类不可判定表述。 | **PASS** | 全文检索无任何「优化体验」「提升美观」「优化一下」等主观表述；所有验收判据均为具体 DOM 结构、请求载荷字段或测试命令退出码。 |
| 7 | 已如实记录守卫测试的真实结果，没跑过的写 `NOT VERIFIED`。 | **PASS** | 已实跑 11 个守卫测试文件（63/63 PASS，耗时 11544.75ms）并记录于「1. 现状摘要」；宿主流体渲染与公网端到端项已在「6. 未验证项」如实标注原因与验证步骤。 |
