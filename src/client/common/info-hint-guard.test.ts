/**
 * t6 守卫：InfoHint（ⓘ）说明文案迁移的回归护栏（源码级、零依赖、只读）。
 *
 * 钉住四件事（对应 t6 契约的 acceptance 第 6~8 条）：
 *  1. **MOVE 键**（t1\u2013t5 判定清单里移入 ⓘ 的 42 个字典键）——每个键都必须落在某处
 *     `<InfoHint text={t('原键')} ... />` 里（逐字复用原键），且**不得再出现在可见说明行**
 *     （渲染到 `css.hint / css.modeHint / css.groupNote / css.noticeLine` 的那些行）；
 *  2. **KEEP 键**（错误 / 安全告警 / 状态 / 空态 / Modal 决策文案）——必须仍在可见位置渲染，
 *     断言失败时点名 文件:行；
 *  3. **每一处 `<InfoHint>` 调用都显式传了可访问名**（`label={t('common.infoHint')}`、
 *     主字典翻译器 `t={t}`、或调用方显式传入的字符串 prop），**不得依赖组件内置的中文回落**；
 *  4. **`common.infoHint` 口径一致**——凡真正出现 \u24d8 调用点的命名空间字典
 *     （主字典 + market / sync / recovery）都必须有该键，且 zh 与 en 值逐字相同。
 *     history 全目录零 MOVE（无 \u24d8），按 t6 契约 rev=4 **不要求**该键，此处也不钉它。
 *  5. **t9 增补：气泡的渲染位置与夹紧基准**（t7 评审 F1 / F2）——气泡必须经 `createPortal`
 *     渲进 `resolveModalRoot()`（`MODAL_ROOT_ID` = `#dsh-config-manager-root`，与 Modal 共用
 *     同一份实现），源码里不得存在「裸 `position: fixed` 渲在 Modal children 子树内」的路径，
 *     也**绝不能**回退 `document.body`；夹紧基准必须是插件根容器的可见矩形（恒与窗口取交集），
 *     窗口矩形仅作兜底，「下方空间不足且上方更宽裕 → 向上翻转」保留。同样带合成片段负向自检（t9-3）。
 *  6. **t10 增补：固定态下点击任意位置取消固定**（2026-10-04 用户反馈）——ⓘ 点开后只有再点一次
 *     同一颗图标才能退出，与「点别处收起」的通用浮层预期不符；必须捕获阶段监听 mousedown、
 *     只作用于固定态、放行触发按钮自身、并在卸载时移除（负向自检：逐条拆掉都必须报红）。
 *  7. **t11 增补：弹窗里 ⓘ 的「自动选中」与气泡偏移**（2026-10-04 用户反馈②）——① Radix 弹窗挂载时的
 *     初始焦点（focusFirst）不得打开气泡（只认用户发起的聚焦，判据 relatedTarget 在同一 [role=dialog] 内）；
 *     ② 焦点环只在气泡打开时绘制（否则程序化初始焦点会画出「选中」蓝框）；③ 气泡夹紧矩形必须并进锚点
 *     （弹窗卡片是 fixed、会伸出画布左缘，否则气泡与自己的 ⓘ 脱开）。三处都带负向自检。
 *
 * 为什么用源码扫描而不是渲染测试：本仓库没有 React 组件测试框架（AGENTS.md：逻辑提炼到
 * `src/ui/`），而「说明行有没有被搬进 ⓘ」恰恰是渲染结构问题 —— 用源码级守卫钉住，
 * 与 `tests/route/route-*.test.ts` / `packages-contract` 同款做法。
 *
 * 注释剥离复用 `src/utils/bundle-scan.ts` 的 `stripJsComments`：InfoHint.tsx 的文件头注释里
 * 就写着 `<InfoHint text={t('原键')} />`，对原文匹配会把它当成第 42 个调用点（假阳性）。
 *
 * 复现：`node --test src/client/common/info-hint-guard.test.ts`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { stripJsComments } from '../../utils/bundle-scan.ts';

/** 仓库根（本文件位于 <root>/src/client/common/）。 */
const ROOT = path.resolve(import.meta.dirname, '../../..');

/**
 * 换行归一（issue #70）。
 *
 * 为什么必须在读取处做：Windows 检出（core.autocrlf=true / CI windows-latest）落的是 CRLF，
 * 而本文件的锚点与扫描器大量含 "\n" 字面量 —— CRLF 下 code.indexOf('\n  }\n') 恒为 -1，
 * 扫描器会拿到整段文件当函数体（end=-1 分支）而**静默变弱**，锚点则直接 assert 失败（硬红）。
 * 先例：tests/route/route-parity.test.ts 同样在读取处归一。
 */
function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** 样式表源码（读入即归一 LF，与 readClientSources 同一口径）。 */
function readStyleSource(): string {
  return normalizeEol(fs.readFileSync(path.join(ROOT, STYLE_FILE), 'utf8'));
}

/** 一份「已剥注释」的客户端源码。 */
interface SourceFile {
  /** 仓库相对 POSIX 路径。 */
  rel: string;
  /** 剥注释后的源码（换行保留，行号与原文一致）。 */
  code: string;
}

/** MOVE 键的类别（用于人工复核「输入规则类是否真的进过 ⓘ」）。 */
type MoveKind = '机制' | '输入规则' | '边界' | '省事提示' | '背景';

/** KEEP 键的类别（错误 / 安全 / 空态三类必须有代表）。 */
type KeepKind = '错误' | '安全' | '空态' | '状态' | 'Modal决策' | '元数据';

interface MovePin {
  key: string;
  file: string;
  kind: MoveKind;
}

interface KeepPin {
  key: string;
  file: string;
  kind: KeepKind;
  /** 非字典字面量形态的渲染针（如 `privateRepoHint(uiT)`）；缺省 = `'key'`。 */
  needle?: string;
}

/** MOVE 判定清单（t1: 2 / t2: 16 / t3: 13 / t4: 9 / t5: 2 = 42 键；t7（2026-10-12）= 41 键，合计 83）。 */
const MOVE_PINS: readonly MovePin[] = [
  // t1：common/
  { key: 'runs.retentionHint', file: 'src/client/common/RunsCenter.tsx', kind: '机制' },
  { key: 'picker.sessionWorkspaceLinked', file: 'src/client/common/ContentPicker.tsx', kind: '机制' },
  // t2：sync/
  { key: 'channel.perChannelHint', file: 'src/client/sync/ChannelConfigDialog.tsx', kind: '机制' },
  { key: 'config.repoUrlHint', file: 'src/client/sync/ChannelConfigDialog.tsx', kind: '输入规则' },
  { key: 'github.description', file: 'src/client/sync/ChannelConfigDialog.tsx', kind: '机制' },
  { key: 'webdav.presetHint', file: 'src/client/sync/ChannelConfigDialog.tsx', kind: '输入规则' },
  { key: 'webdav.urlHint', file: 'src/client/sync/ChannelConfigDialog.tsx', kind: '输入规则' },
  { key: 'webdav.usernameHint', file: 'src/client/sync/ChannelConfigDialog.tsx', kind: '输入规则' },
  { key: 'config.saveHint', file: 'src/client/sync/ChannelConfigDialog.tsx', kind: '机制' },
  { key: 'mode.sessionsPickHint', file: 'src/client/sync/SyncSectionPickerDialog.tsx', kind: '机制' },
  { key: 'mode.pickerHint', file: 'src/client/sync/SyncSectionPickerDialog.tsx', kind: '机制' },
  { key: 'mode.sessionsLimitHint', file: 'src/client/sync/SyncSectionPickerDialog.tsx', kind: '输入规则' },
  { key: 'mode.sectionsHint', file: 'src/client/sync/SyncSectionPickerDialog.tsx', kind: '机制' },
  { key: 'mode.hint', file: 'src/client/sync/SyncPanel.tsx', kind: '机制' },
  { key: 'mode.persistHint', file: 'src/client/sync/SyncPanel.tsx', kind: '边界' },
  { key: 'channel.openHint', file: 'src/client/sync/SyncChannelEntryCard.tsx', kind: '机制' },
  { key: 'autosync.description', file: 'src/client/sync/AutosyncCard.tsx', kind: '机制' },
  { key: 'autosync.intervalHint', file: 'src/client/sync/AutosyncCard.tsx', kind: '机制' },
  // t3：environment/maintenance + home + library + export/（v3 搬移后的落点）
  // UI v2：产物列表搬进产物库 → MOVE 键的渲染点随之改址
  // 2026-10-04 用户要求：产物库页首标题行（含保留期 ⓘ）整体移除 → `snapshots.retentionHint` 退出 MOVE 台账（43 → 42）
  // （备份文件提示随 BackupFilesCard 一起消失，其信息由行内元数据承担）
  { key: 'backupFiles.hint', file: 'src/client/library/LibraryPanel.tsx', kind: '机制' },
  { key: 'diskUsage.backupRetention', file: 'src/client/environment/maintenance/DiskUsageCard.tsx', kind: '机制' },
  { key: 'backupSchedule.hint', file: 'src/client/home/BackupScheduleCard.tsx', kind: '机制' },
  { key: 'backupSchedule.enabledHint', file: 'src/client/home/BackupScheduleCard.tsx', kind: '机制' },
  { key: 'backupSchedule.customHint', file: 'src/client/home/BackupScheduleCard.tsx', kind: '边界' },
  { key: 'retention.hint', file: 'src/client/home/BackupScheduleCard.tsx', kind: '边界' },
  { key: 'retention.keepLastHint', file: 'src/client/home/BackupScheduleCard.tsx', kind: '输入规则' },
  { key: 'retention.keepMonthlyHint', file: 'src/client/home/BackupScheduleCard.tsx', kind: '输入规则' },
  { key: 'retention.keepYearlyHint', file: 'src/client/home/BackupScheduleCard.tsx', kind: '输入规则' },
  { key: 'retention.appliesTo', file: 'src/client/home/BackupScheduleCard.tsx', kind: '边界' },
  { key: 'export.hint', file: 'src/client/export/ExportView.tsx', kind: '机制' },
  { key: 'export.fileNameHint', file: 'src/client/export/ExportView.tsx', kind: '输入规则' },
  { key: 'export.noteHint', file: 'src/client/export/ExportView.tsx', kind: '背景' },
  // t4：market/ + about/ + profiles/
  { key: 'myconfigs.login.hint', file: 'src/client/market/MyConfigsLoginCard.tsx', kind: '机制' },
  { key: 'myconfigs.update.zipHint', file: 'src/client/market/MyConfigsWizard.tsx', kind: '机制' },
  { key: 'myconfigs.upload.form.nameHint', file: 'src/client/market/MyConfigsWizard.tsx', kind: '省事提示' },
  { key: 'about.diag.hint', file: 'src/client/about/AboutPanel.tsx', kind: '背景' },
  { key: 'about.feedbackHint', file: 'src/client/about/AboutPanel.tsx', kind: '省事提示' },
  { key: 'about.update.offline', file: 'src/client/about/AboutPanel.tsx', kind: '边界' },
  { key: 'about.cli.hint', file: 'src/client/about/AboutPanel.tsx', kind: '背景' },
  { key: 'profiles.create.hint', file: 'src/client/environment/EnvironmentPanel.tsx', kind: '机制' },
  { key: 'profiles.list.hint', file: 'src/client/environment/EnvironmentPanel.tsx', kind: '省事提示' },
  // t5：recovery/
  { key: 'sessions.desc', file: 'src/client/recovery/RecoveryPanel.tsx', kind: '机制' },
  { key: 'recovery.preview.hint', file: 'src/client/recovery/RecoveryPanel.tsx', kind: '机制' },
  // t7（2026-10-12 用户要求「所有描述都收进 ⓘ」）：页级 / 分区级副标题 + 卡片 / 字段说明。
  // 判定口径见 DESIGN.md §7（本次把原 KEEP-2 的**静态安全说明**与 KEEP-7 的**静态副标题**一并纳入 MOVE；
  // 动态校验错误 / 状态 / 空态 / 禁用原因 / 确认弹窗内的危险操作说明仍常驻）。
  { key: 'profiles.subtitle', file: 'src/client/environment/EnvironmentPanel.tsx', kind: '机制' },
  { key: 'section.description', file: 'src/client/sync/SyncPanel.tsx', kind: '机制' },
  { key: 'section.description', file: 'src/client/market/MarketPanel.tsx', kind: '机制' },
  { key: 'about.subtitle', file: 'src/client/about/AboutPanel.tsx', kind: '背景' },
  { key: 'history.subtitle', file: 'src/client/history/HistoryPanel.tsx', kind: '机制' },
  { key: 'rollback.desc', file: 'src/client/recovery/RollbackCard.tsx', kind: '机制' },
  { key: 'rollback.preview.hint', file: 'src/client/recovery/RollbackCard.tsx', kind: '机制' },
  { key: 'import.select.hint', file: 'src/client/import/import-wizard-steps.tsx', kind: '机制' },
  { key: 'import.consult.hint', file: 'src/client/import/import-wizard-steps.tsx', kind: '机制' },
  { key: 'import.decryptArchive.hint', file: 'src/client/import/import-wizard-steps.tsx', kind: '机制' },
  { key: 'import.conflicts.hint', file: 'src/client/import/import-wizard-steps.tsx', kind: '机制' },
  { key: 'import.paths.hint', file: 'src/client/import/import-wizard-steps.tsx', kind: '机制' },
  { key: 'foreign.source.hint', file: 'src/client/import/import-wizard-steps.tsx', kind: '机制' },
  { key: 'import.secrets.hint', file: 'src/client/import/import-wizard-steps.tsx', kind: '机制' },
  { key: 'import.picker.hint', file: 'src/client/import/ImportWizardView.tsx', kind: '机制' },
  { key: 'foreign.source.hint', file: 'src/client/import/ForeignImportView.tsx', kind: '机制' },
  { key: 'foreign.lossy.hint', file: 'src/client/import/ForeignImportView.tsx', kind: '机制' },
  { key: 'foreign.previewDryRun', file: 'src/client/import/ForeignImportView.tsx', kind: '机制' },
  { key: 'mode.encryptHint', file: 'src/client/sync/SecurityOptionsCard.tsx', kind: '机制' },
  { key: 'mode.encryptAutosyncNotice', file: 'src/client/sync/SecurityOptionsCard.tsx', kind: '边界' },
  { key: 'mode.includeSecretsHint', file: 'src/client/sync/SecurityOptionsCard.tsx', kind: '机制' },
  { key: 'mode.passwordSavedHint', file: 'src/client/sync/SecurityOptionsCard.tsx', kind: '机制' },
  { key: 'mode.decryptPasswordHint', file: 'src/client/sync/DecryptPasswordCard.tsx', kind: '机制' },
  { key: 'export.encryptHint', file: 'src/client/export/ExportView.tsx', kind: '机制' },
  { key: 'export.includeSecretsHint', file: 'src/client/export/ExportView.tsx', kind: '机制' },
  { key: 'export.compositionHint', file: 'src/client/export/ExportView.tsx', kind: '机制' },
  { key: 'snapshots.selectHint', file: 'src/client/library/LibraryActions.tsx', kind: '省事提示' },
  { key: 'diskUsage.clean.hint', file: 'src/client/environment/maintenance/DiskUsageCard.tsx', kind: '边界' },
  { key: 'recovery.safeMode.detail', file: 'src/client/recovery/RecoveryPanel.tsx', kind: '机制' },
  { key: 'sessions.repair.desc', file: 'src/client/recovery/RecoveryPanel.tsx', kind: '机制' },
  { key: 'recovery.rescue.desc', file: 'src/client/recovery/RecoveryPanel.tsx', kind: '机制' },
  { key: 'sessions.layout.planReadOnly', file: 'src/client/recovery/RecoveryPanel.tsx', kind: '边界' },
  { key: 'recovery.incomplete.hint', file: 'src/client/recovery/IncompleteCopiesSection.tsx', kind: '机制' },
  { key: 'repoPicker.privateOnly', file: 'src/client/sync/SyncRepositoryPicker.tsx', kind: '输入规则' },
  { key: 'config.tokenHint', file: 'src/client/sync/ChannelConfigDialog.tsx', kind: '输入规则' },
  { key: 'webdav.passwordHint', file: 'src/client/sync/ChannelConfigDialog.tsx', kind: '输入规则' },
  { key: 'cloud.secretHint', file: 'src/client/sync/ChannelConfigDialog.tsx', kind: '输入规则' },
  { key: 'cloud.tokenHint', file: 'src/client/sync/ChannelConfigDialog.tsx', kind: '输入规则' },
  { key: 'myconfigs.upload.selectHint', file: 'src/client/market/MyConfigsWizard.tsx', kind: '机制' },
  { key: 'myconfigs.upload.mode.shareHint', file: 'src/client/market/MyConfigsWizard.tsx', kind: '背景' },
];

/** KEEP 判定清单（错误 / 安全 / 空态三类各有代表；每类至少一处，见 t6-2 的覆盖断言）。 */
const KEEP_PINS: readonly KeepPin[] = [
  // ①错误 / 失败原因
  { key: 'history.autosyncError', file: 'src/client/sync/SyncLogList.tsx', kind: '错误' },
  { key: 'snapshots.plan.diffUnreadable', file: 'src/client/library/RestorePlanView.tsx', kind: '错误' },
  { key: 'export.fileNameInvalid', file: 'src/client/export/ExportView.tsx', kind: '错误' },
  { key: 'detail.failed', file: 'src/client/market/MarketPanel.tsx', kind: '错误' },
  { key: 'myconfigs.install.failed', file: 'src/client/market/MyConfigsInstall.tsx', kind: '错误' },
  { key: 'about.update.noCommand', file: 'src/client/about/AboutPanel.tsx', kind: '错误' },
  { key: 'nextSteps.unresolved.hint', file: 'src/client/import/ImportWizardView.tsx', kind: '错误' },
  { key: 'diskUsage.partial', file: 'src/client/environment/maintenance/DiskUsageCard.tsx', kind: '错误' },
  { key: 'picker.unitsUnavailable', file: 'src/client/common/ContentPicker.tsx', kind: '错误' },
  { key: 'runs.loadFailed', file: 'src/client/common/RunsCenter.tsx', kind: '错误' },
  // ②安全与不可逆
  { key: 'privateRepoHint', file: 'src/client/sync/ChannelConfigDialog.tsx', kind: '安全', needle: 'privateRepoHint(uiT)' },
  { key: 'backupFiles.encryptedHint', file: 'src/client/library/ArtifactRow.tsx', kind: '安全' },
  { key: 'review.rollbackHint', file: 'src/client/market/MarketImportReview.tsx', kind: '安全' },
  { key: 'nextSteps.secrets.hint', file: 'src/client/import/ImportWizardView.tsx', kind: '安全' },
  { key: 'profiles.duplicate.includeModulesHint', file: 'src/client/environment/EnvironmentPanel.tsx', kind: '安全' },
  // ⑤空态解释
  { key: 'history.emptyHint', file: 'src/client/sync/SyncLogList.tsx', kind: '空态' },
  { key: 'history.empty', file: 'src/client/history/HistoryPanel.tsx', kind: '空态' },
  { key: 'overview.empty.body', file: 'src/client/home/HomePanel.tsx', kind: '空态' },
  { key: 'overview.activity.empty', file: 'src/client/home/HomePanel.tsx', kind: '空态' },
  { key: 'review.changeEmpty', file: 'src/client/market/MarketImportReview.tsx', kind: '空态' },
  { key: 'export.compositionEmpty', file: 'src/client/export/ExportView.tsx', kind: '空态' },
  { key: 'snapshots.plan.diffIdentical', file: 'src/client/library/RestorePlanView.tsx', kind: '空态' },
  { key: 'profiles.running.none', file: 'src/client/environment/EnvironmentPanel.tsx', kind: '空态' },
  { key: 'backupFiles.empty', file: 'src/client/library/LibraryPanel.tsx', kind: '空态' },
  { key: 'runs.empty', file: 'src/client/common/RunsCenter.tsx', kind: '空态' },
  // ③状态 / 等待 / 计数
  { key: 'mode.decryptPasswordSaved', file: 'src/client/sync/DecryptPasswordCard.tsx', kind: '状态' },
  { key: 'syncflow.noSnapshots', file: 'src/client/sync/SyncPanel.tsx', kind: '状态' },
  { key: 'history.corruptedCount', file: 'src/client/history/HistoryPanel.tsx', kind: '状态' },
  // v3：首页的「分区构成卡」已按 §7 移出（其等价合计在导出流程的「本次将导出」构成卡里，
  // 走 export.composition* 键）。本键随卡片删除，不再是任何界面的渲染点 —— 故从 KEEP 台账移除。
  { key: 'import.skipPending', file: 'src/client/import/ImportWizardView.tsx', kind: '状态' },
  // ⑧ Modal 内决策 / 危险操作说明
  { key: 'syncflow.adoptHint', file: 'src/client/sync/SyncConfirmView.tsx', kind: 'Modal决策' },
  { key: 'syncflow.bulkHint', file: 'src/client/sync/SyncConfirmView.tsx', kind: 'Modal决策' },
  { key: 'about.update.commandHint', file: 'src/client/about/AboutPanel.tsx', kind: 'Modal决策' },
  { key: 'about.update.copyCommand', file: 'src/client/about/AboutPanel.tsx', kind: 'Modal决策' },
  { key: 'profiles.duplicate.onlyManifest', file: 'src/client/environment/EnvironmentPanel.tsx', kind: 'Modal决策' },
  // ⑥/⑦ 行内 title= 与设备告警
  { key: 'picker.highRiskHint', file: 'src/client/common/ContentPicker.tsx', kind: '元数据' },
  { key: 'export.selectionWarnings', file: 'src/client/export/ExportView.tsx', kind: '元数据' },
];

/** label= 白名单：值来自调用方显式传入的字符串 prop（UiT 消费方取不到主字典）。 */
const LABEL_PROP_PINS: Readonly<Record<string, string>> = {
  'src/client/environment/maintenance/DiskUsageCard.tsx': 'infoHintLabel',
};

/** 上表 prop 的提供方：必须由有主字典 t 的文件显式传 `t('common.infoHint')`。 */
// UI v2 第 3 步：维护与诊断（含 DiskUsageCard）搬进环境页 → 提供方随之改址
const LABEL_PROP_PROVIDER = 'src/client/environment/EnvironmentPanel.tsx';

/** 可见说明行的 CSS Modules 类（MOVE 键不得再渲染进这些类）。 */
const VISIBLE_HINT_CLASS_RE = /\bcss\.(hint|modeHint|groupNote|noticeLine)\b/;

/** 自闭合的 InfoHint 调用块（含多行形态）。 */
const HINT_CALL_RE = /<InfoHint\b[\s\S]*?\/>/g;

/** common.infoHint 的规范值（改口径必须同时改 4 本字典 + 本守卫）。 */
const CANON_ZH = '查看说明';
const CANON_EN = 'Show description';

/** 必须带该键的命名空间字典（出现 ⓘ 调用点的命名空间；history 零 MOVE，不参与）。 */
const INFO_HINT_DICTS: readonly string[] = [
  'src/client/locales.ts',
  'src/client/market/market-locales.ts',
  'src/client/sync/sync-locales.ts',
  'src/client/recovery/recovery-locales.ts',
];

/** 读取 src/client 下全部非测试源码（剥注释；server 侧 / tests 不参与）。 */
function readClientSources(): SourceFile[] {
  const out: SourceFile[] = [];
  const visit = (abs: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') visit(child);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      const rel = path.relative(ROOT, child).split(path.sep).join('/');
      // issue #70：锚点是含裸 \n 的源码字面量 ⇒ 读取入口统一折 LF（本文件用 normalizeEol 同一口径）
      out.push({ rel, code: normalizeEol(stripJsComments(fs.readFileSync(child, 'utf8'), true, false)) });
    }
  };
  visit(path.join(ROOT, 'src/client'));
  return out;
}

/** 1-based 行号（`stripJsComments` 保留换行，故行号与原文一致）。 */
function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

/** 把所有 InfoHint 调用块替换成等长空白（保留换行）：用于「该键是否还有可见渲染点」的判定。 */
function maskHintCalls(code: string): string {
  return code.replace(HINT_CALL_RE, (m) => m.replace(/[^\n]/g, ' '));
}

/** 键字面量匹配（单引号形态，与仓库既有写法一致）。 */
function keyLiteral(key: string): string {
  return "'" + key + "'";
}

/**
 * MOVE 违规扫描：
 *  a) 该文件里必须有一处 InfoHint 的 text= 复用原键（否则说明「文案丢了」或没真正 MOVE）；
 *  b) 除 InfoHint 调用外，该键不得再出现在可见说明行（css.hint / css.modeHint / …）。
 */
function findMoveViolations(files: readonly SourceFile[], pins: readonly MovePin[]): string[] {
  const byFile = new Map(files.map((f) => [f.rel, f]));
  const violations: string[] = [];
  for (const pin of pins) {
    const file = byFile.get(pin.file);
    if (file === undefined) {
      violations.push(pin.file + ': 文件不存在（MOVE 键 ' + pin.key + '）');
      continue;
    }
    const hits = [...file.code.matchAll(HINT_CALL_RE)];
    // 允许两种形态：t('key') 与带插值的 t('key', { … })
    const needle = 't(' + keyLiteral(pin.key);
    const shaped = hits.find((m) => {
      const body = m[0] ?? '';
      const at = body.indexOf(needle);
      if (at < 0) return false;
      const next = body.charAt(at + needle.length);
      return next === ')' || next === ',' || next === ' ';
    });
    if (shaped === undefined) {
      violations.push(pin.file + ': 找不到复用原字典键 ' + keyLiteral(pin.key) + ' 的 <InfoHint text=…> 调用（MOVE 未落地或键名写错）');
    }
    const masked = maskHintCalls(file.code);
    masked.split('\n').forEach((line, i) => {
      if (!line.includes(keyLiteral(pin.key))) return;
      if (VISIBLE_HINT_CLASS_RE.test(line)) {
        violations.push(pin.file + ':' + String(i + 1) + ': MOVE 键 ' + keyLiteral(pin.key) + ' 仍渲染在可见说明行：' + line.trim());
      }
    });
  }
  return violations;
}

/**
 * KEEP 违规扫描：该键必须仍在本文件里以可见形态出现（非 InfoHint 的 text=）。
 * 文案本身（字典值）由 t6 的 git diff 逐字核对；这里钉的是「还有没有渲染点」。
 */
function findKeepViolations(files: readonly SourceFile[], pins: readonly KeepPin[]): string[] {
  const byFile = new Map(files.map((f) => [f.rel, f]));
  const violations: string[] = [];
  for (const pin of pins) {
    const file = byFile.get(pin.file);
    if (file === undefined) {
      violations.push(pin.file + ': 文件不存在（KEEP 键 ' + pin.key + '）');
      continue;
    }
    const needle = pin.needle ?? keyLiteral(pin.key);
    if (!maskHintCalls(file.code).includes(needle)) {
      violations.push(pin.file + ': KEEP 键 ' + keyLiteral(pin.key) + ' 的可见渲染点消失了（期望仍在 ' + pin.file + ' 里以 ' + needle + ' 渲染）');
    }
  }
  return violations;
}

/**
 * 可访问名违规扫描：每一处 `<InfoHint>` 都必须显式给可访问名 ——
 *  `label={t('common.infoHint')}` / 白名单字符串 prop / 主字典翻译器 `t={t}`。
 */
function findAccessibleNameViolations(files: readonly SourceFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    for (const m of file.code.matchAll(HINT_CALL_RE)) {
      const body = m[0] ?? '';
      const line = lineOf(file.code, m.index ?? 0);
      if (/label=\{t\('common\.infoHint'\)\}/.test(body)) continue;
      const prop = LABEL_PROP_PINS[file.rel];
      if (prop !== undefined && body.includes('label={' + prop + '}')) continue;
      const translator = /\bt=\{([A-Za-z_$][\w$]*)\}/.exec(body);
      if (translator !== null && new RegExp('\\b' + (translator[1] ?? '') + '\\s*:\\s*TranslateNS<\'config-manager\'>').test(file.code)) continue;
      violations.push(
        file.rel + ':' + String(line) + ': <InfoHint> 没有显式可访问名（不得依赖组件内置的中文回落）：' + body.replace(/\s+/g, ' '),
      );
    }
  }
  return violations;
}

/** 解析一本字典里的 common.infoHint（zh 在前、en 在后，与仓库字典文件结构一致）。 */
function parseInfoHintEntry(rel: string): { zh: string | undefined; en: string | undefined; count: number } {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const values = [...src.matchAll(/['"]common\.infoHint['"]\s*:\s*'([^']*)'/g)].map((m) => m[1] ?? '');
  return { zh: values[0], en: values[1], count: values.length };
}

test('t6-1 MOVE：83 个说明键都已收进 ⓘ（逐字复用原键）且不再有可见说明行', () => {
  const files = readClientSources();
  // 扫描范围自检：客户端源码至少覆盖 t6 涉及的面板目录
  const dirs = new Set(MOVE_PINS.map((p) => p.file.split('/').slice(0, 3).join('/')));
  assert.ok(dirs.size >= 8, 'MOVE 清单必须覆盖全部面板目录（实际 ' + String(dirs.size) + ' 个）');
  assert.ok(MOVE_PINS.length === 82, 'MOVE 清单长度应为 82（实际 ' + String(MOVE_PINS.length) + '）');
  assert.ok(
    MOVE_PINS.filter((p) => p.kind === '输入规则').length >= 5,
    '输入规则类 MOVE 至少 5 处（config.repoUrlHint / webdav.urlHint / mode.sessionsLimitHint / retention.keep*Hint / export.fileNameHint）',
  );
  const violations = findMoveViolations(files, MOVE_PINS);
  assert.deepEqual(violations, [], 'MOVE 键必须只出现在 <InfoHint text=…> 里：\n' + violations.join('\n'));
});

test('t6-2 KEEP：错误 / 安全 / 空态等常驻文案仍有可见渲染点（失败点名文件）', () => {
  const files = readClientSources();
  for (const kind of ['错误', '安全', '空态'] as const) {
    assert.ok(KEEP_PINS.some((p) => p.kind === kind), 'KEEP 清单必须覆盖「' + kind + '」类');
  }
  const violations = findKeepViolations(files, KEEP_PINS);
  assert.deepEqual(violations, [], 'KEEP 键的可见渲染点不得消失（这些是错误/安全/空态/状态文案）：\n' + violations.join('\n'));
});

test('t6-3 每一处 <InfoHint> 都显式传了可访问名（label 或主字典翻译器）', () => {
  const files = readClientSources();
  const calls = files.reduce((n, f) => n + [...f.code.matchAll(HINT_CALL_RE)].length, 0);
  assert.ok(calls >= 40, '客户端 <InfoHint> 调用点应 >= 40（实际 ' + String(calls) + '）—— 扫不到即假绿');
  // 形态自检：非自闭合写法会被本守卫漏掉
  const undersupported: string[] = [];
  for (const f of files) {
    const open = [...f.code.matchAll(/<InfoHint\b/g)].length;
    const selfClosing = [...f.code.matchAll(HINT_CALL_RE)].length;
    if (open !== selfClosing) undersupported.push(f.rel + ': <InfoHint 出现 ' + String(open) + ' 次，自闭合块 ' + String(selfClosing) + ' 个');
  }
  assert.deepEqual(undersupported, [], '<InfoHint> 必须是自闭合写法（</InfoHint> 形态守卫无法解析）：\n' + undersupported.join('\n'));
  // DiskUsageCard 走 prop：提供方必须显式给主字典键
  const provider = files.find((f) => f.rel === LABEL_PROP_PROVIDER);
  assert.ok(provider !== undefined, LABEL_PROP_PROVIDER + ' 必须存在');
  for (const [rel, prop] of Object.entries(LABEL_PROP_PINS)) {
    assert.ok(
      provider!.code.includes(prop + "={t('common.infoHint')}"),
      LABEL_PROP_PROVIDER + " 必须为 " + rel + ' 显式传入 ' + prop + "={t('common.infoHint')}",
    );
  }
  const violations = findAccessibleNameViolations(files);
  assert.deepEqual(violations, [], '每一处 <InfoHint> 都必须显式传可访问名：\n' + violations.join('\n'));
});

test('t6-4 common.infoHint 口径一致：主字典 + market / sync / recovery 四本字典 zh/en 逐字相同', () => {
  const canon = parseInfoHintEntry(INFO_HINT_DICTS[0]!);
  assert.equal(canon.count, 2, INFO_HINT_DICTS[0] + ' 必须恰好有两处 common.infoHint（zh + en），实际 ' + String(canon.count));
  assert.equal(canon.zh, CANON_ZH, INFO_HINT_DICTS[0] + ' 的 zh 应为 ' + CANON_ZH);
  assert.equal(canon.en, CANON_EN, INFO_HINT_DICTS[0] + ' 的 en 应为 ' + CANON_EN);
  const violations: string[] = [];
  for (const rel of INFO_HINT_DICTS.slice(1)) {
    const got = parseInfoHintEntry(rel);
    if (got.count !== 2) { violations.push(rel + ': 应有 2 处 common.infoHint（zh + en），实际 ' + String(got.count)); continue }
    if (got.zh !== canon.zh) violations.push(rel + ': zh 期望 ' + JSON.stringify(canon.zh) + '，实际 ' + JSON.stringify(got.zh));
    if (got.en !== canon.en) violations.push(rel + ': en 期望 ' + JSON.stringify(canon.en) + '，实际 ' + JSON.stringify(got.en));
  }
  // 任何其它自带该键的 *-locales.ts 也必须同口径（将来某命名空间新增 ⓘ 时自动纳入）
  const dirs = fs.readdirSync(path.join(ROOT, 'src/client'), { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const d of dirs) {
    const rel = 'src/client/' + d.name + '/' + d.name + '-locales.ts';
    if (!fs.existsSync(path.join(ROOT, rel))) continue;
    if (INFO_HINT_DICTS.includes(rel)) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (!src.includes("'common.infoHint'")) continue;
    const got = parseInfoHintEntry(rel);
    if (got.zh !== canon.zh) violations.push(rel + ': zh 与主字典不一致（' + JSON.stringify(got.zh) + ' vs ' + JSON.stringify(canon.zh) + '）');
    if (got.en !== canon.en) violations.push(rel + ': en 与主字典不一致（' + JSON.stringify(got.en) + ' vs ' + JSON.stringify(canon.en) + '）');
  }
  assert.deepEqual(violations, [], 'common.infoHint 必须口径一致：\n' + violations.join('\n'));
});

test('t6-5 负向自检：守卫对合成片段真的会红（避免扫不到即假绿）', () => {
  const syntheticMove: SourceFile[] = [{
    rel: 'src/client/fake/Fake.tsx',
    code: "export const A = () => <div className={css.hint}>{t('export.hint')}</div>;\n",
  }];
  const movePin: MovePin[] = [{ key: 'export.hint', file: 'src/client/fake/Fake.tsx', kind: '机制' }];
  const moveBad = findMoveViolations(syntheticMove, movePin);
  assert.equal(moveBad.length, 2, '合成片段应同时命中「没有 ⓘ」与「仍有可见说明行」两条（实际 ' + String(moveBad.length) + '：' + moveBad.join(' | ') + '）');
  const syntheticOk: SourceFile[] = [{
    rel: 'src/client/fake/Fake.tsx',
    code: "<InfoHint text={t('export.hint')} label={t('common.infoHint')} />\n",
  }];
  assert.deepEqual(findMoveViolations(syntheticOk, movePin), [], '合法形态不得报红');

  const keepBad = findKeepViolations(syntheticOk, [{ key: 'export.hint', file: 'src/client/fake/Fake.tsx', kind: '错误' }]);
  assert.equal(keepBad.length, 1, 'KEEP 键只剩 InfoHint（可见行被搬走）时必须报红');

  const a11yBad = findAccessibleNameViolations([{ rel: 'src/client/fake/Fake.tsx', code: "<InfoHint text={t('x.y')} />\n" }]);
  assert.equal(a11yBad.length, 1, '缺少可访问名时必须报红，实际 ' + String(a11yBad.length));
  const a11yOk = findAccessibleNameViolations([{
    rel: 'src/client/fake/Fake.tsx',
    code: "const A = (t: TranslateNS<'config-manager'>) => <InfoHint text={t('x.y')} t={t} />;\n",
  }]);
  assert.deepEqual(a11yOk, [], '主字典翻译器形态必须放行');
});

/* ================================================================
 * t9 增补（t7 评审 F1 / F2）：气泡的渲染位置与夹紧基准
 *
 * 为什么必须钉住：
 *   `.dialogContentCenter` 带着**常驻** `transform: translate(-50%, -50%)`（config-manager.module.css
 *   §6 Overlays）—— 按 CSS Transforms L1，带 transform 的祖先会成为后代 `position: fixed` 的
 *   **包含块**。气泡若裸渲在按钮旁边的 DOM 子树里，Modal 内的调用点就会整体偏移「卡片在视口中的
 *   位移」，并被 `.dialogBody{overflow-y:auto}` 裁剪（t7 评审：11/41 个调用点在 Modal 内）。
 *   修法 = `createPortal` 渲到 transform 祖先之外，**容器只能指回 `#dsh-config-manager-root`**。
 * ================================================================ */

/** 气泡宿主 + 夹紧基准的共享实现（t9 只读这几个文件的源码）。 */
const INFO_HINT_FILE = 'src/client/common/InfoHint.tsx';
const MODAL_FILE = 'src/client/common/Modal.tsx';
/**
 * 夹紧基准的**实现**所在（2026-10-03 从 InfoHint.tsx 抽到这里）：Select 菜单需要同一份基准，
 * 两处各写一份必然分叉（Select 那次跑偏正是因为直接用了视口坐标）。
 * 守卫因此改为扫**两处**：气泡侧仍要调用 canvasBounds()，实现侧要满足容器 ∩ 窗口与唯一兜底。
 */
const FLOATING_BOUNDS_FILE = 'src/client/common/floating-bounds.ts';

/** 括号配对：`open` 指向 `(`，返回 [start, end) 实参区间；找不到配对返回 null。 */
function matchParen(src: string, open: number): { start: number; end: number } | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return { start: open, end: i + 1 };
    }
  }
  return null;
}

/** 所有 `createPortal(` 调用的实参区间。 */
function createPortalSpans(code: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const m of code.matchAll(/createPortal\s*\(/g)) {
    const span = matchParen(code, (m.index ?? 0) + (m[0] ?? '').length - 1);
    if (span !== null) spans.push(span);
  }
  return spans;
}

/**
 * F1 违规扫描：`css.infoHintBubble` 的每一处出现都必须落在某个 `createPortal(...)` 实参区间内
 * （否则 = 裸渲在 Modal children 的 DOM 子树里，被 transform 包含块 + overflow 裁剪），
 * 且第二实参必须是解析出的插件根容器、**不得**回退 `document.body`。
 * 0 处引用同样算违规 —— 否则「把气泡删掉」会被读成绿灯。
 */
function findBubblePortalViolations(code: string): string[] {
  const violations: string[] = [];
  const spans = createPortalSpans(code);
  if (spans.length === 0) {
    violations.push('没有 createPortal 调用：气泡无法脱离 transform 祖先（.dialogContentCenter）');
  }
  let sites = 0;
  for (const m of code.matchAll(/css\.infoHintBubble/g)) {
    sites++;
    const at = m.index ?? 0;
    if (!spans.some((s) => at > s.start && at < s.end)) {
      violations.push('css.infoHintBubble 出现在 createPortal 实参之外（裸 position:fixed 会落进 Modal children 子树，被 transform 包含块与 .dialogBody 的 overflow 裁剪）');
    }
  }
  if (sites === 0) violations.push('找不到 css.infoHintBubble（气泡渲染点消失？删掉 ≠ 合规）');
  if (/document\.body/.test(code)) {
    violations.push('气泡容器不得回退 document.body（会被宿主 overlay z-index:1000 盖住，并连带 body pointer-events 失效）');
  }
  if (spans.length > 0 && !spans.some((s) => /,\s*container\s*,?\s*\)$/.test(code.slice(s.start, s.end)))) {
    violations.push('createPortal 的第二实参必须是解析出的插件根容器（container）');
  }
  return violations;
}

/**
 * F2 违规扫描：夹紧基准必须是**插件根容器的可见矩形**（恒与窗口取交集），
 * 窗口矩形只允许出现在兜底分支；「下方不够且上方更宽裕 → 向上翻转」必须保留。
 */
/**
 * F2-a：**气泡侧**怎么用基准 —— 必须以 canvasBounds() 为基准、左右/上下都夹紧、保留向上翻转。
 * 基准本身怎么算在 findBoundsImplementationViolations（2026-10-03 抽到 floating-bounds.ts 之后，
 * 这两类检查必须分开：混在一起会让「气泡文件里没有容器 rect」被误报成不合规）。
 */
function findClampViolations(code: string): string[] {
  const violations: string[] = [];
  if (!/const bounds = canvasBounds\(\)/.test(code)) violations.push('reposition 必须以 canvasBounds()（容器 ∩ 窗口）为夹紧基准');

  if (!/clamp\(left, minLeft, maxLeft\)/.test(code) || !/clamp\(rawTop, minTop, maxTop\)/.test(code)) {
    violations.push('左右 / 上下都必须夹进基准矩形（clamp(left/rawTop, …)）');
  }
  if (!/box\.height > below && above > below \? 'top' : 'bottom'/.test(code)) {
    violations.push('「下方空间不足且上方更宽裕 → 向上翻转」的既有行为不得丢失');
  }
  return violations;
}

/**
 * 共享夹紧实现（floating-bounds.ts）的合规扫描：容器矩形 ∩ 窗口、窗口只作兜底且只出现一次、
 * 退化时回落窗口。与 findClampViolations 分开 —— 前者管「气泡怎么用基准」，这里管「基准本身怎么算」。
 */
function findBoundsImplementationViolations(code: string): string[] {
  const violations: string[] = [];
  if (!/const root = resolveModalRoot\(\)/.test(code)) violations.push('夹紧基准必须取插件根容器（resolveModalRoot()）');
  if (!/const rect = root\.getBoundingClientRect\(\)/.test(code)) violations.push('必须量测插件根容器的 rect 作为夹紧基准');
  if (!/rect\.left, win\.left/.test(code) || !/rect\.right, win\.right/.test(code)) {
    violations.push('画布矩形必须与窗口矩形取交集（恒不出浏览器视口）');
  }
  const vw = [...code.matchAll(/window\.innerWidth/g)].length;
  const vh = [...code.matchAll(/window\.innerHeight/g)].length;
  if (vw !== 1 || vh !== 1) {
    violations.push('window.innerWidth/innerHeight 只允许各出现一次（窗口矩形仅作兜底），实际 ' + String(vw) + '/' + String(vh));
  }
  if (!/const win: Bounds = \{ left: 0, top: 0, right: window\.innerWidth, bottom: window\.innerHeight \}/.test(code)) {
    violations.push('窗口兜底矩形的形态变了（守卫需同步更新）');
  }
  if (!/rect\.width <= 0 \|\| rect\.height <= 0/.test(code)) {
    violations.push('拿不到容器尺寸时必须回落窗口（不得用 0 矩形去夹紧）');
  }
  return violations;
}

test('t9-1 F1：气泡只能经 createPortal 渲进插件根容器（裸 fixed / document.body 一律红灯）', () => {
  const files = readClientSources();
  const hint = files.find((f) => f.rel === INFO_HINT_FILE);
  assert.ok(hint !== undefined, INFO_HINT_FILE + ' 必须存在');
  const violations = findBubblePortalViolations(hint.code);
  assert.deepEqual(violations, [], '气泡必须经 createPortal 渲进插件根容器：\n' + violations.join('\n'));
  // 容器解析必须复用 Modal.tsx 的导出（唯一实现），且 Modal 侧确实按 MODAL_ROOT_ID 查询
  assert.ok(
    hint.code.includes("import { resolveModalRoot } from './Modal.tsx'"),
    '容器解析必须复用 Modal.tsx 的导出（不得各写一份 getElementById）',
  );
  assert.match(hint.code, /useState<HTMLElement \| null>\(resolveModalRoot\)/, '渲染期必须同步解析容器（惰性 useState）');
  assert.match(hint.code, /setContainer\(resolveModalRoot\(\)\)/, 'layout effect 必须兜底重解析容器');
  const modal = files.find((f) => f.rel === MODAL_FILE);
  assert.ok(modal !== undefined, MODAL_FILE + ' 必须存在');
  assert.match(modal.code, /export function resolveModalRoot\(\)/, 'Modal.tsx 必须导出 resolveModalRoot');
  assert.match(modal.code, /getElementById\(MODAL_ROOT_ID\)/, '插件根节点必须按 MODAL_ROOT_ID 查询');
  assert.match(modal.code, /export const MODAL_ROOT_ID = 'dsh-config-manager-root'/, 'MODAL_ROOT_ID 必须是 #dsh-config-manager-root');
});

test('t9-2 F2：夹紧基准 = 插件根容器可见矩形 ∩ 窗口（不是窗口），翻转行为保留', () => {
  const files = readClientSources();
  const hint = files.find((f) => f.rel === INFO_HINT_FILE);
  const bounds = files.find((f) => f.rel === FLOATING_BOUNDS_FILE);
  assert.ok(hint !== undefined, INFO_HINT_FILE + ' 必须存在');
  assert.ok(bounds !== undefined, FLOATING_BOUNDS_FILE + ' 必须存在（夹紧基准的唯一实现）');
  // ① 气泡侧：reposition 必须以 canvasBounds() 为基准并保留翻转行为
  const violations = findClampViolations(hint.code);
  assert.deepEqual(violations, [], '夹紧基准必须是插件根容器：\n' + violations.join('\n'));
  // ② 实现侧：容器 ∩ 窗口、唯一一次 window 兜底，都必须在共享文件里成立
  const impl = findBoundsImplementationViolations(bounds.code);
  assert.deepEqual(impl, [], '夹紧基准实现必须合规：\n' + impl.join('\n'));
});

test('t9-3 负向自检：合成片段在「拆掉 portal / 挂 body / 删掉气泡 / 丢掉容器 rect / 去掉夹紧」时必须变红', () => {
  const hint = readClientSources().find((f) => f.rel === INFO_HINT_FILE);
  assert.ok(hint !== undefined, INFO_HINT_FILE + ' 必须存在');
  assert.deepEqual(findBubblePortalViolations(hint.code), [], '真实实现必须合规（否则 t9-1 的绿灯不可信）');
  assert.deepEqual(findClampViolations(hint.code), [], '真实实现的夹紧基准必须合规（否则 t9-2 的绿灯不可信）');
  const boundsFile = readClientSources().find((f) => f.rel === FLOATING_BOUNDS_FILE);
  assert.ok(boundsFile !== undefined, FLOATING_BOUNDS_FILE + ' 必须存在');
  assert.deepEqual(findBoundsImplementationViolations(boundsFile.code), [], '共享夹紧实现同样必须在真实源码上合规');

  const bare = 'const A = () => <span className={css.infoHintBubble} id={id} />;\n';
  assert.ok(findBubblePortalViolations(bare).length >= 1, '裸 fixed（无 createPortal）必须报红');

  const bodyPortal = 'const A = () => createPortal(<span className={css.infoHintBubble} />, document.body);\n';
  const bodyViolations = findBubblePortalViolations(bodyPortal);
  assert.ok(
    bodyViolations.length >= 2,
    '挂 document.body 必须同时命中「body 容器」与「第二实参不是 container」（实际 ' + String(bodyViolations.length) + '：' + bodyViolations.join(' | ') + '）',
  );

  const emptied = 'const A = 1;\n';
  assert.ok(findBubblePortalViolations(emptied).length >= 2, '删掉气泡（无 createPortal / 无引用）必须报红，防「删掉即绿灯」');

  const goodPortal = 'const A = () => createPortal(<span className={css.infoHintBubble} />, container);\n';
  assert.deepEqual(findBubblePortalViolations(goodPortal), [], 'portal 到 container 的合法形态必须放行');

  // 基准实现侧的负向自检（2026-10-03 拆出 floating-bounds.ts 后指向该文件的扫描器）
  const boundsSrc = readClientSources().find((f) => f.rel === FLOATING_BOUNDS_FILE);
  assert.ok(boundsSrc !== undefined, FLOATING_BOUNDS_FILE + ' 必须存在');
  const noContainer = boundsSrc.code.replace('const root = resolveModalRoot()', 'const root = null');
  assert.ok(findBoundsImplementationViolations(noContainer).length >= 1, '夹紧基准退回窗口时必须报红（画布不再是基准）');
  const noIntersect = boundsSrc.code.replace('Math.max(rect.left, win.left)', 'rect.left');
  assert.ok(findBoundsImplementationViolations(noIntersect).length >= 1, '容器矩形不与窗口取交集时必须报红');
  const noSizeGuard = boundsSrc.code.replace('rect.width <= 0 || rect.height <= 0', 'false');
  assert.ok(findBoundsImplementationViolations(noSizeGuard).length >= 1, '拿不到容器尺寸不回落窗口时必须报红');

  // 气泡侧的负向自检
  const noClamp = hint.code.replace('clamp(left, minLeft, maxLeft)', 'left');
  assert.ok(findClampViolations(noClamp).length >= 1, '去掉左右夹紧时必须报红');
  const noFlip = hint.code.replace(/box\.height > below && above > below \? 'top' : 'bottom'/, "'bottom'");
  assert.ok(findClampViolations(noFlip).length >= 1, '丢掉向上翻转时必须报红');
});

/* ================================================================
 * t10 增补（2026-10-04 用户反馈）：固定态下「点击任意位置」必须能取消固定
 *
 * 现场：点开 ⓘ 后进入固定态（data-pinned 的主色 tint），只有**再次点击同一颗 ⓘ** 才能退出。
 * 用户必须知道「同一颗图标既是开也是关」，与「点别处收起」的通用浮层预期不符 ——
 * 期望是：固定态下按下任意位置即取消固定并关闭。
 *
 * 为什么钉在源码层：本仓库没有 React 组件测试框架（同 t6 / t9 的理由），
 * 「监听挂没挂、门禁是不是只作用于固定态、按钮自身放没放行」是结构问题，
 * 用合成片段做负向自检即可防住「删掉监听即绿灯」。
 * ================================================================ */

/**
 * t10 违规扫描（只读 InfoHint.tsx）。四条缺一不可：
 *  ① 捕获阶段监听 `mousedown`（比 click 早、覆盖右键与拖拽结束，与 Select 同源）；
 *  ② 只作用于固定态（`if (!pinned) return`）—— 悬停 / 聚焦两条通道各有自己的关闭路径，不得被改写；
 *  ③ 触发按钮自身的按下必须放行（否则第 ③ 条通道「再次点击取消固定」会被抢先关闭又重开）；
 *  ④ 卸载时移除监听，且依赖数组带 `pinned`（少了它监听永远挂不上 / 挂上不摘）。
 */
function findPinnedDismissViolations(code: string): string[] {
  code = normalizeEol(code);
  const violations: string[] = [];
  const start = code.indexOf('if (!pinned) return');
  if (start < 0) {
    violations.push('找不到「仅固定态生效」的外部按下关闭效应（if (!pinned) return）');
    return violations;
  }
  const depsStart = code.indexOf('\n  }, [', start);
  if (depsStart < 0) {
    violations.push('找不到该效应的依赖数组（守卫需同步更新）');
    return violations;
  }
  const depsEnd = code.indexOf('\n', depsStart + 1);
  const block = code.slice(start, depsEnd < 0 ? code.length : depsEnd);
  if (!/document\.addEventListener\('mousedown',\s*\w+,\s*true\)/.test(block)) {
    violations.push("必须捕获阶段监听 document 的 'mousedown'（冒泡阶段会被弹窗/面板内的局部 handler 抢先）");
  }
  if (!/document\.removeEventListener\('mousedown',\s*\w+,\s*true\)/.test(block)) {
    violations.push('卸载时必须移除 mousedown 监听（依赖变化后残留 = 监听泄漏）');
  }
  if (!/btn\.contains\(event\.target\)/.test(block)) {
    violations.push('触发按钮自身的按下必须放行（const btn = btnRef.current + btn.contains(event.target)）');
  }
  if (!/event\.target instanceof Node/.test(block)) {
    violations.push('contains 之前必须先确认 event.target 是 Node（target 可能是文本节点 / 跨文档节点）');
  }
  if (!/(^|\s)close\(\)/.test(block)) {
    violations.push('外部按下必须调用 close()（同时清掉 pinned 与 open 两个状态）');
  }
  if (!/\}, \[pinned, close\]\)/.test(block)) {
    violations.push('依赖数组必须是 [pinned, close]（少了 pinned 就永远不挂监听）');
  }
  return violations;
}

/** 负向自检的改写：锚点必须命中（否则守卫已与源码脱节，必须同步更新而不是静默绿灯）。 */
function mutate(code: string, from: string, to: string): string {
  assert.ok(code.includes(from), '负向自检锚点未命中（源码改写后需同步守卫）：' + from);
  return code.replace(from, to);
}

test('t10 固定态下点击任意位置取消固定（用户反馈 2026-10-04）', () => {
  const hint = readClientSources().find((f) => f.rel === INFO_HINT_FILE);
  assert.ok(hint !== undefined, INFO_HINT_FILE + ' 必须存在');
  const violations = findPinnedDismissViolations(hint.code);
  assert.deepEqual(violations, [], '固定态必须支持点击任意位置取消固定：\n' + violations.join('\n'));

  // 负向自检：逐条拆掉都必须变红
  const brokenGate = mutate(hint.code, 'if (!pinned) return', 'if (false) return');
  assert.ok(findPinnedDismissViolations(brokenGate).length >= 1, '去掉固定态门禁必须报红');
  const brokenCapture = mutate(hint.code, "document.addEventListener('mousedown', onMouseDown, true)", "document.addEventListener('mousedown', onMouseDown)");
  assert.ok(findPinnedDismissViolations(brokenCapture).length >= 1, '退化成冒泡阶段必须报红');
  const noCleanup = mutate(hint.code, "    return () => { document.removeEventListener('mousedown', onMouseDown, true) }\n", '');
  assert.ok(findPinnedDismissViolations(noCleanup).length >= 1, '缺卸载清理必须报红');
  const noButtonPass = mutate(
    hint.code,
    '      if (btn !== null && event.target instanceof Node && btn.contains(event.target)) return\n      close()',
    '      if (btn !== null && event.target instanceof Node && btn.contains(event.target)) return',
  );
  assert.ok(findPinnedDismissViolations(noButtonPass).length >= 1, '不调用 close() 必须报红');
  const noContains = mutate(hint.code, 'event.target instanceof Node && btn.contains(event.target)', 'false');
  assert.ok(findPinnedDismissViolations(noContains).length >= 1, '按钮自身不放行必须报红');
});

/* ================================================================
 * t11 增补（2026-10-04 用户反馈②）：弹窗里 ⓘ 的「自动选中」与气泡偏移
 *
 * 两个现场（同一张真机截图）：
 *   ① 进入「选择同步分区」弹窗时，标题行 trailing 的 ⓘ 自动亮起蓝框并弹出气泡 —— 用户什么都没点；
 *   ② 那个气泡的位置与 ⓘ 脱开，整体向右偏。
 * 根因（DSH/Radix 源码 + 截图逐条对上）：
 *   ① Radix 的 FocusScope 在弹窗挂载时 focusFirst(...)，初始焦点落到容器内第一个可聚焦元素 ——
 *      标题行 trailing 的 ⓘ 正是它；Chrome 对这种程序化聚焦同样命中 :focus-visible。
 *   ② 弹窗卡片是 position:fixed（相对浏览器窗口居中），而夹紧基准「宿主画布」= 插件根容器
 *      （宿主设置弹窗里靠右的一块）→ 弹窗左半边的 ⓘ 落在画布左缘之外，气泡被夹进画布而与锚点脱开。
 * 三条不可缺：① 聚焦只认用户发起（relatedTarget 在同一 [role=dialog] 内）；② 焦点环只在气泡打开时绘；
 * ③ 夹紧矩形并进锚点（只放宽、不收紧）。同样带负向自检。
 * ================================================================ */

/** 样式表路径：焦点环是全局样式契约，t11-3 直接读 CSS 而不是组件源码。 */
const STYLE_FILE = 'src/client/config-manager.module.css';

/** t11-1 违规扫描：聚焦通道只认「用户自己把焦点移过来」。 */
function findFocusGateViolations(code: string): string[] {
  code = normalizeEol(code);
  const violations: string[] = [];
  const start = code.indexOf('const onFocus = (event: ReactFocusEvent<HTMLButtonElement>): void => {');
  if (start < 0) {
    violations.push('onFocus 必须接住聚焦事件（ReactFocusEvent<HTMLButtonElement>）');
    return violations;
  }
  const end = code.indexOf('\n  }\n', start);
  const body = code.slice(start, end < 0 ? code.length : end);
  if (!/closest\('\[role="dialog"\]'\)/.test(body)) {
    violations.push("必须用 closest('[role=\"dialog\"]') 找到最近的弹窗（判断这次聚焦是不是弹窗初始焦点）");
  }
  if (!/dialog !== null/.test(body) || !/const from = event\.relatedTarget/.test(body)) {
    violations.push('必须取聚焦前的 relatedTarget（from）作为「从哪儿来」的判据');
  }
  if (!/!\(from instanceof Node\) \|\| !dialog\.contains\(from\)/.test(body) || !/\breturn\b/.test(body)) {
    violations.push('弹窗初始焦点（relatedTarget 在弹窗外 / 为空）必须 early return，不得打开气泡');
  }
  if (!/setOpen\(true\)/.test(body)) violations.push('用户发起的聚焦仍必须打开气泡（不得把聚焦通道整体删掉）');
  if (!/focusRef\.current = true/.test(body)) {
    violations.push('焦点记账（focusRef）必须保留 —— 外部点击 / Esc 的关闭判据要用它');
  }
  return violations;
}

/** t11-2 违规扫描：气泡夹紧矩形必须并进锚点（只放宽、不收紧），画布仍是原基准。 */
function findAnchorClampViolations(code: string): string[] {
  code = normalizeEol(code);
  const violations: string[] = [];
  const start = code.indexOf('const anchor = btn.getBoundingClientRect()');
  const end = code.indexOf('setPlacement', start);
  if (start < 0 || end <= start) {
    violations.push('找不到 reposition 的量测段（守卫需同步更新）');
    return violations;
  }
  const body = code.slice(start, end);
  if (!/const bounds = canvasBounds\(\)/.test(body)) violations.push('夹紧基准必须仍是 canvasBounds()（画布 ∩ 窗口）');
  if (!/Math\.min\(bounds\.left, anchor\.left\)/.test(body)) violations.push('夹紧矩形左界必须并进锚点（Math.min(bounds.left, anchor.left)）');
  if (!/Math\.max\(bounds\.right, anchor\.right\)/.test(body)) violations.push('夹紧矩形右界必须并进锚点（Math.max(bounds.right, anchor.right)）');
  if (!/Math\.min\(bounds\.top, anchor\.top\)/.test(body)) violations.push('夹紧矩形上界必须并进锚点（Math.min(bounds.top, anchor.top)）');
  if (!/Math\.max\(bounds\.bottom, anchor\.bottom\)/.test(body)) violations.push('夹紧矩形下界必须并进锚点（Math.max(bounds.bottom, anchor.bottom)）');
  return violations;
}

/** t11-3 违规扫描：ⓘ 的 :focus-visible 焦点环必须限定在气泡打开时（[data-open]）。 */
function findFocusRingViolations(css: string): string[] {
  css = normalizeEol(css);
  const violations: string[] = [];
  const rules = [...css.matchAll(/^\.infoHintBtn([^{]*):focus-visible\s*\{/gm)];
  if (rules.length === 0) {
    violations.push('找不到 .infoHintBtn 的 :focus-visible 规则（可访问性焦点环被删掉 ≠ 合规）');
    return violations;
  }
  for (const rule of rules) {
    if (!(rule[1] ?? '').includes('[data-open]')) {
      violations.push('焦点环必须限定在 [data-open]（否则弹窗挂载的程序化初始焦点会画出「选中」蓝框）：' + rule[0]);
    }
  }
  return violations;
}

test('t11-1 弹窗初始焦点不得打开 ⓘ 气泡（只认用户发起的聚焦）', () => {
  const hint = readClientSources().find((f) => f.rel === INFO_HINT_FILE);
  assert.ok(hint !== undefined, INFO_HINT_FILE + ' 必须存在');
  const violations = findFocusGateViolations(hint.code);
  assert.deepEqual(violations, [], '聚焦通道必须只认用户发起的聚焦：\n' + violations.join('\n'));
  const noDialog = mutate(hint.code, "event.currentTarget.closest('[role=\"dialog\"]')", 'null');
  assert.ok(findFocusGateViolations(noDialog).length >= 1, '丢掉弹窗判据（程序化初始焦点照开）必须报红');
  const noRelated = mutate(hint.code, '!dialog.contains(from)', 'false');
  assert.ok(findFocusGateViolations(noRelated).length >= 1, '不比对 relatedTarget 必须报红');
  const noGate = mutate(hint.code, '      if (!(from instanceof Node) || !dialog.contains(from)) return\n', '');
  assert.ok(findFocusGateViolations(noGate).length >= 1, '删掉 early return 必须报红');
});

test('t11-2 气泡夹紧矩形 = 画布 ∪ 锚点（弹窗卡片伸出画布时气泡不脱开 ⓘ）', () => {
  const hint = readClientSources().find((f) => f.rel === INFO_HINT_FILE);
  assert.ok(hint !== undefined, INFO_HINT_FILE + ' 必须存在');
  const violations = findAnchorClampViolations(hint.code);
  assert.deepEqual(violations, [], '夹紧矩形必须并进锚点：\n' + violations.join('\n'));
  const noLeft = mutate(hint.code, 'Math.min(bounds.left, anchor.left)', 'bounds.left');
  assert.ok(findAnchorClampViolations(noLeft).length >= 1, '左界不并锚点（用户报告的偏移就是这个）必须报红');
  const noBottom = mutate(hint.code, 'Math.max(bounds.bottom, anchor.bottom)', 'bounds.bottom');
  assert.ok(findAnchorClampViolations(noBottom).length >= 1, '下界不并锚点必须报红');
});

test('t11-3 ⓘ 焦点环只在气泡打开时绘制（程序化初始焦点不得画出「选中」蓝框）', () => {
  const css = readStyleSource();
  const violations = findFocusRingViolations(css);
  assert.deepEqual(violations, [], '焦点环必须限定在 [data-open]：\n' + violations.join('\n'));
  const unscoped = mutate(css, '.infoHintBtn[data-open]:focus-visible', '.infoHintBtn:focus-visible');
  assert.ok(findFocusRingViolations(unscoped).length >= 1, '去掉 [data-open] 限定必须报红');
  // 必须连选择器一起改：同款 outline 在别的组件上也有 :focus-visible 规则，
  // 只改 `:focus-visible {` 会命中别处、留下本规则 → 假绿。
  const removed = mutate(
    css,
    '.infoHintBtn[data-open]:focus-visible {\n  outline:',
    '.infoHintBtn[data-open]:hover {\n  outline:',
  );
  assert.ok(findFocusRingViolations(removed).length >= 1, '删掉焦点环必须报红（不得「删掉即绿灯」）');
});

test('t11-4（issue #70，CRLF 检出）：扫描器与锚点必须与换行风格解耦', () => {
  const hint = readClientSources().find((f) => f.rel === INFO_HINT_FILE);
  assert.ok(hint !== undefined, INFO_HINT_FILE + ' 必须存在');
  // 读取即归一：源码与样式表里不得残留 \r（否则 "\n" 锚点在 Windows 检出 / CI 下全灭）
  assert.ok(!hint.code.includes('\r'), 'readClientSources 必须归一 LF');
  assert.ok(!readStyleSource().includes('\r'), '样式读取必须归一 LF');
  const crlf = hint.code.replace(/\n/g, '\r\n');
  const cssCrlf = readStyleSource().replace(/\n/g, '\r\n');
  assert.deepEqual(findPinnedDismissViolations(crlf), [], 'CRLF 下固定态扫描不得失真');
  assert.deepEqual(findFocusGateViolations(crlf), [], 'CRLF 下聚焦门禁扫描不得失真');
  assert.deepEqual(findAnchorClampViolations(crlf), [], 'CRLF 下夹紧扫描不得失真');
  assert.deepEqual(findFocusRingViolations(cssCrlf), [], 'CRLF 下焦点环扫描不得失真');
  // 负向自检：CRLF 输入下同样必须报红 —— 原实现 code.indexOf('\n  }\n') 在 CRLF 下返回 -1，
  // 扫描器会把整段文件当函数体（静默变弱）或直接 assert 失败（硬红），两者都不是守法。
  const lfBroken = hint.code.replace("    return () => { document.removeEventListener('mousedown', onMouseDown, true) }\n", '');
  assert.ok(findPinnedDismissViolations(lfBroken).length >= 1, 'LF 下负向自检必须报红');
  const crlfBroken = crlf.replace("    return () => { document.removeEventListener('mousedown', onMouseDown, true) }\r\n", '');
  assert.ok(findPinnedDismissViolations(crlfBroken).length >= 1, 'CRLF 下负向自检必须报红（issue #70 的静默变弱）');
  const crlfNoGate = crlf.replace('      if (!(from instanceof Node) || !dialog.contains(from)) return\r\n', '');
  assert.ok(findFocusGateViolations(crlfNoGate).length >= 1, 'CRLF 下删掉 early return 必须报红');
});
