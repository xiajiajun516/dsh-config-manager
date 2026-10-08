/**
 * 引擎语言运行时单测（src/core/engine-locale.ts + src/core/messages.ts 的目录合并语义）。
 *
 * 覆盖（对应契约 t2 的验收）：
 *  - 未设定语言时行为等于 zh；setEngineLocale('en') 后取英文；同一实例跟随切换（活函数，不是快照）；
 *  - 未知键回退键名，绝不抛错；{param} 插值缺参原样保留；
 *  - makeMsg / engineMsg 合并 registerMessageCatalog 注册的目录，**且只在既有目录未命中时生效**；
 *  - LANGUAGE_TTL_MS：函数源不调 invalidate 时最迟 TTL 后即为新语言；调了则当次即为新语言；
 *  - **既有 372 键的 zh/en 取值逐字不变**（硬约束①：目录只许追加）—— t2 冻结指纹，见文末常量。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  LANGUAGE_TTL_MS,
  engineMsg,
  getEngineLocale,
  invalidateEngineLocale,
  registerMessageCatalog,
  resetMessageCatalogs,
  setEngineLanguageSource,
  setEngineLocale,
} from './engine-locale.ts';
import { en, makeMsg, zh, zhMsg } from './messages.ts';

/** 只读字典取值（键不存在 → undefined）。 */
function dictValue(dict: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined;
}

/** 冻结指纹：key → sha256(zh + U+0000 + en) 前 8 位十六进制。 */
function fingerprint(zhValue: string, enValue: string): string {
  return createHash('sha256').update(zhValue + '\u0000' + enValue, 'utf8').digest('hex').slice(0, 8);
}

/* --------------------------------------------------------------- 语言切换 */

test('缺省语言 = zh：未设定时 engineMsg 与 zhMsg 对全部既有键逐字相等', () => {
  setEngineLocale('zh');
  assert.equal(getEngineLocale(), 'zh');
  assert.equal(engineMsg('restore.pluginRemoveFailed'), '卸载失败');
  for (const key of Object.keys(zh)) {
    assert.equal(engineMsg(key), zhMsg(key), '既有键的 zh 缺省行为必须逐字不变: ' + key);
  }
});

test('setEngineLocale("en") 后取英文（en 目录与 makeMsg("en") 逐字一致）', () => {
  setEngineLocale('en');
  assert.equal(getEngineLocale(), 'en');
  assert.equal(engineMsg('restore.pluginRemoveFailed'), 'Uninstall failed');
  assert.equal(
    engineMsg('host.syncTokenWriteFailed', { reason: 'boom', ref: 'REF' }),
    'Failed to write the token into DSH credentials: boom (configure REF in DSH credential management, then retry)',
  );
  const t = makeMsg('en');
  for (const key of Object.keys(zh)) {
    assert.equal(engineMsg(key), t(key), 'engineMsg(en) 必须与 makeMsg(en) 同口径: ' + key);
  }
  setEngineLocale('zh');
});

test('同一实例跟随语言切换（活函数，不是加载期快照 —— 钉死根因）', () => {
  const live = engineMsg;
  setEngineLocale('zh');
  assert.equal(live('restore.pluginRemoveFailed'), '卸载失败');
  setEngineLocale('en');
  assert.equal(live('restore.pluginRemoveFailed'), 'Uninstall failed', '同一个函数引用必须跟着切到英文');
  setEngineLocale('zh');
  assert.equal(live('restore.pluginRemoveFailed'), '卸载失败', '切回中文同样必须跟随');
});

test('未知键回退键名，绝不抛错（zh / en 两种语言）', () => {
  setEngineLocale('zh');
  assert.equal(engineMsg('no.such.key'), 'no.such.key');
  assert.equal(engineMsg('no.such.key', { a: 'b' }), 'no.such.key');
  setEngineLocale('en');
  assert.equal(engineMsg('no.such.key'), 'no.such.key');
  setEngineLocale('zh');
});

test('插值：{param} 命中 / 缺参原样保留（与 makeMsg 同口径）', () => {
  setEngineLocale('zh');
  assert.equal(engineMsg('export.sectionFailed', { adapter: 'settings', reason: 'boom' }), '分区 settings 导出失败: boom');
  assert.equal(engineMsg('export.sectionFailed', { adapter: 'settings' }), '分区 settings 导出失败: {reason}');
  setEngineLocale('en');
  assert.equal(engineMsg('export.sectionFailed', { adapter: 'settings', reason: 'boom' }), 'Section settings export failed: boom');
  setEngineLocale('zh');
});

test('语言源抛错绝不冒泡（回落 zh）', () => {
  setEngineLanguageSource(() => {
    throw new Error('boom');
  });
  invalidateEngineLocale();
  assert.equal(getEngineLocale(), 'zh');
  setEngineLocale('zh');
});

/* --------------------------------------------------------------- TTL 上界 */

test('LANGUAGE_TTL_MS：TTL 内允许缓存，到期必须重新解析；invalidate 当次即生效', () => {
  let lang: 'zh' | 'en' = 'zh';
  const base = 1_000_000;
  setEngineLanguageSource(() => lang);
  assert.equal(getEngineLocale(base), 'zh');
  lang = 'en';
  assert.equal(getEngineLocale(base + LANGUAGE_TTL_MS - 1), 'zh', 'TTL 内允许缓存');
  assert.equal(getEngineLocale(base + LANGUAGE_TTL_MS), 'en', '到 TTL 必须重新解析（非请求路径的兜底上界）');

  let lang2: 'zh' | 'en' = 'zh';
  setEngineLanguageSource(() => lang2);
  assert.equal(getEngineLocale(base), 'zh');
  lang2 = 'en';
  invalidateEngineLocale();
  assert.equal(getEngineLocale(base), 'en', 'invalidate 后当次调用即为新语言（请求入口用）');
  setEngineLocale('zh');
});

/* ------------------------------------------------------------- 目录注册 */

test('registerMessageCatalog：只在既有目录未命中时生效（既有键不可被覆盖）', () => {
  resetMessageCatalogs();
  try {
    registerMessageCatalog({
      id: 'unit-test',
      zh: { 'unit.extra': '注册目录中文', 'export.sectionFailed': '注册目录不该赢' },
      en: { 'unit.extra': 'registered english', 'export.sectionFailed': 'registered should not win' },
    });
    // 既有目录命中 → 注册目录不得覆盖
    assert.equal(makeMsg('zh')('export.sectionFailed', { adapter: 'a', reason: 'b' }), '分区 a 导出失败: b');
    assert.equal(makeMsg('en')('export.sectionFailed', { adapter: 'a', reason: 'b' }), 'Section a export failed: b');
    setEngineLocale('zh');
    assert.equal(engineMsg('export.sectionFailed', { adapter: 'a', reason: 'b' }), '分区 a 导出失败: b');
    // 既有目录未命中 → 注册目录生效（各语言取自己那本）
    assert.equal(makeMsg('zh')('unit.extra'), '注册目录中文');
    assert.equal(makeMsg('en')('unit.extra'), 'registered english');
    setEngineLocale('en');
    assert.equal(engineMsg('unit.extra'), 'registered english');
    setEngineLocale('zh');
    assert.equal(engineMsg('unit.extra'), '注册目录中文');

    // en 语言下注册目录只有 zh 时回退其 zh（与既有 en → zh 同口径）
    resetMessageCatalogs();
    registerMessageCatalog({ id: 'zh-only', zh: { 'unit.zhOnly': '只有中文' } });
    setEngineLocale('en');
    assert.equal(engineMsg('unit.zhOnly'), '只有中文');
    assert.equal(makeMsg('en')('unit.zhOnly'), '只有中文');
    assert.equal(makeMsg('zh')('unit.zhOnly'), '只有中文');
  } finally {
    resetMessageCatalogs();
    setEngineLocale('zh');
  }
});

test('resetMessageCatalogs 后回到既有目录（注册目录不残留）', () => {
  registerMessageCatalog({ id: 'temp', zh: { 'unit.temp': '临时' }, en: { 'unit.temp': 'temp' } });
  setEngineLocale('en');
  assert.equal(engineMsg('unit.temp'), 'temp');
  resetMessageCatalogs();
  assert.equal(engineMsg('unit.temp'), 'unit.temp', '注册目录清空后必须回退键名');
  setEngineLocale('zh');
});

/* ------------------------------------------------- t2 新增键的 zh 逐字保真 */

test('t2 新增的 host.* 键：zh 逐字保留既有文案、en 非空且无 CJK', () => {
  const pairs: Array<[string, string]> = [
    ['host.syncWebdavPasswordWriteFailed', 'WebDAV 口令写入 DSH credentials 失败：{reason}（请在 DSH 凭据管理里配置 {ref} 后重试）'],
    ['host.syncCredentialWriteFailed', '{kind} 写入 DSH credentials 失败：{reason}（请在 DSH 凭据管理里配置 {ref} 后重试）'],
    ['host.syncKindS3Secret', 'S3 密钥'],
    ['host.sessionFormatPathSeparator', '、'],
    ['host.sessionFormatPathsTruncated', '{paths} 等'],
    ['host.snapshotPruneSummary', '自动保留清理删除 {count} 个旧快照'],
    ['host.autosyncSummary', '自动同步 {direction}{transportSuffix}'],
    ['host.autosyncTransportSuffix', '（{transport}）'],
  ];
  const zhDict = zh as Readonly<Record<string, string>>;
  const enDict = en as Readonly<Record<string, string>>;
  for (const [key, zhText] of pairs) {
    assert.equal(dictValue(zhDict, key), zhText, 'zh 必须逐字保留: ' + key);
    const enText = dictValue(enDict, key);
    assert.ok(enText !== undefined && enText.trim() !== '', 'en 值不得为空: ' + key);
    assert.equal(/[\u2E80-\u2EFF\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6]/u.test(enText), false, 'en 值不得含 CJK: ' + key);
  }
  // 迁移后 index.ts 用的既有键必须仍在（zh 逐字不变）
  assert.equal(dictValue(zhDict, 'restore.missingTargetBlob'), '恢复动作缺少 target/blobPath');
  assert.equal(dictValue(zhDict, 'restore.unknownAction'), '未知动作 {kind}: {description}');
  assert.equal(dictValue(zhDict, 'host.syncTokenWriteFailed'), 'token 写入 DSH credentials 失败：{reason}（请在 DSH 凭据管理里配置 {ref} 后重试）');
});

/* ------------------------------------------------ 既有 372 键的冻结指纹 */

test('既有 372 键的 zh/en 取值逐字不变（硬约束①：目录只许追加）', () => {
  const lines = BASELINE.trim().split('\n');
  assert.equal(lines.length, BASELINE_KEY_COUNT, '冻结基线条目数不得变');
  const missing: string[] = [];
  const changed: string[] = [];
  const zhDict = zh as Readonly<Record<string, string>>;
  const enDict = en as Readonly<Record<string, string>>;
  for (const line of lines) {
    const at = line.lastIndexOf('=');
    const key = line.slice(0, at);
    const digest = line.slice(at + 1);
    const zhValue = dictValue(zhDict, key);
    const enValue = dictValue(enDict, key);
    if (zhValue === undefined || enValue === undefined) {
      missing.push(key);
      continue;
    }
    if (fingerprint(zhValue, enValue) !== digest) changed.push(key);
  }
  assert.deepEqual(missing, [], '既有键被删除/改名（只许追加）: ' + missing.slice(0, 10).join(', '));
  assert.deepEqual(changed, [], '既有键的 zh/en 取值被改动（zh 逐字不变、只新增 en 值）: ' + changed.slice(0, 10).join(', '));
  assert.ok(Object.keys(zh).length >= BASELINE_KEY_COUNT, '目录不得净减');
  assert.equal(Object.keys(en).length, Object.keys(zh).length, 'zh/en 键集必须相等');
});

/** t2 冻结的既有目录基线：key → sha256(zh + U+0000 + en) 前 8 位十六进制（372 键）。 */
const BASELINE_KEY_COUNT = 372;
const BASELINE = `
export.encryptionRequired=6f5d0604
export.sectionFailed=2e6900c6
export.credentialsReadFailed=5c4746fa
export.vaultRefreshed=bc97d18e
export.vaultRefreshSkipped=d2731560
export.vaultRefreshFailed=518fc015
export.sessionsLimited=a80b218a
export.sessionsNone=15d6aadd
export.sessionsWorkspacesCoupled=f1e32d07
export.sessionsDeclaredInWorkspaces=fd33cb78
export.sessionsWorkspacesCarriedAll=c7d20911
export.sessionsWithoutWorkspaces=462072dc
export.sessionsWorkspacesUnreadable=7e8b82db
export.sessionsLimitNoMtime=ba56bb07
export.fileSectionSecrets=b67c4400
import.readFailed=f70e240a
import.noManifest=6c904a49
import.manifestParseFailed=46d9b50a
import.integrityFailed=7445aa62
import.schemaUnsupported=ce2e357d
import.executableWarning=7987d95e
import.sectionParseFailed=4120b7c3
import.sectionInvalid=5f8161c7
import.adapterAnalyzeFailed=bf841492
import.adapterValidationIssue=087d6bff
import.versionUnsupported=f6ac0640
import.missingSections=1fb2502a
import.unsupportedSections=a116f3d3
import.sessionsWithoutWorkspaces=ad735b76
import.subagentSessionsWithoutParents=13099f30
import.sessionsFormatUnsupported=4ab94f7a
import.sessionsFormatSampled=7aef2152
import.sessionsFormatAborted=4e1119ad
import.sessionsNeedRestart=2654c174
export.sessionParentsCoupled=3633b079
export.sessionParentsUncoupled=a67ea15e
export.sessionChildrenCoupled=e347e418
export.sessionRelationNotFound=0fa7aa11
export.sessionParentTooLarge=add5f66d
import.unsupportedSectionVersion=aefc30cb
import.checksumsMissing=9078606d
import.extraEntries=0167f799
import.undeclaredSectionContent=15039a5b
import.secretsPayloadEmpty=e6fff431
import.migrated=2613d9d1
import.migrateInvalidManifest=dc7c8958
import.postValidationIssue=b6aad3cc
import.postValidationFailed=e3e8af95
import.conflictKeepCurrent=c46b667e
import.conflictSkipExisting=7676e111
import.conflictReplace=dff65c88
import.secretMissingDesc=69bea9f7
import.secretAlreadyConfigured=5582af19
import.secretFromArchive=371091df
import.secretNotProvided=313843dd
import.notConfirmed=b0a9d227
import.encryptedPasswordRequired=d857e8a0
import.encryptedPasswordWrong=2d28831a
import.notEncryptedContainer=162d2934
import.encryptedContainerNeedsUnlock=270bb476
import.userSkipped=03132f7c
import.userSkippedDetail=df02b540
import.vaultRestored=3df83728
import.vaultMissing=9928d845
import.sessionRelocated=d904f413
import.sessionRelocateFailed=59ec2557
import.sessionRewritten=effa56d8
import.sessionRewriteFailed=00395039
import.sessionRewriteRolledBack=1e67fe5c
import.sessionRewriteRollbackFailed=84da6de8
import.vaultBackfillFailed=13c3fd2f
import.vaultCredentialsFromArchive=e2636fbd
runs.cancelUnsupported=0d6fa0da
runs.cancelWaitingSafePoint=9b2431b5
import.cancelRequested=a6746bc7
import.cancelAwaitingDecision=d3bfe0d3
import.cancelDecisionTimeout=a040c9d1
import.cancelRollingBack=286375ca
import.cancelKept=3bc3023d
import.cancelKeptSnapshotKept=80bf66d2
import.cancelKeptSkippedItem=2f6f095d
import.cancelKeptJournalFailed=6668364b
import.cancelKeptUnchecked=a7d73ea8
import.cancelKeptNoAudit=0ce7ff0a
bootSafety.bundlesPruned=1286143b
bootSafety.bundlesPrunedFailed=b30ef254
bootSafety.bundleListUnreadable=efc9e9ff
bootSafety.criticalFileUnreadable=e94a9037
bootSafety.criticalFileUnparsable=9984c74a
bootSafety.patchFileMissing=a403e6f8
bootSafety.extraCheckFailed=58de3fad
rollback.ns.createdNoDelete=9d67ab26
rollback.ns.manualHint=5ae2c950
rollback.ns.conflictHint=0f6972fd
rollback.cred.noReadback=0f6a6835
rollback.cred.manualHint=67c4a26e
rollback.patch.manualHint=fab359d2
rollback.file.manualHint=5b977f79
rollback.workspace.manualHint=d7393095
rollback.unknownEntry=40bf9ee4
restore.snapshotInvalid=128774df
restore.invalidSnapshotId=990394ab
restore.pathEscape=b774bf0a
restore.snapshotUntrusted=cb44d84e
restore.blobPathEscape=e1cde5de
restore.hostSkipEscape=14198338
restore.hostSkipEscapeDetail=859adf51
restore.hostNoBlobInfo=6759b284
restore.hostUnreadable=04a4eadb
restore.hostBlobMissing=13969f2b
restore.hostRestore=ede02fa7
restore.backupBeforeWrite=b30d3550
restore.writeDirect=fc5eb12b
restore.hostRemove=ae43cae0
restore.backupBeforeRemove=8c946f03
restore.hostSkipAbsent=663f124a
restore.settingsNotBacked=18490617
restore.settingsNotBackedDetail=a29f5138
restore.noBaseline=b96bb4af
restore.noBaselineDetail=8be7744b
restore.pluginRemove=28975e5a
restore.pluginRemoveEmptyBaseline=3cb373c9
restore.noAddedPlugins=fa54726d
restore.fileSkipEscape=51aaeb5d
restore.fileBlobMissing=c940fd90
restore.fileRestore=db49ecd5
restore.fileRemove=42159482
restore.fileSkipAbsent=149af72b
restore.fileNoBlobInfo=7c440569
restore.credentialHint=677f526d
restore.credentialManualHint=87b9f20f
restore.nsAggregate=0f3b1f15
restore.nsAggregateDetail=0aae1c3c
restore.patchAggregate=c469ca62
restore.patchAggregateDetail=b75527f6
restore.workspaceAggregate=0d78661c
restore.workspaceAggregateDetail=9b2d5de6
restore.credentialAbsentAggregate=19d8b6df
restore.uninstallFailedCode=0366eb46
restore.uninstallFailedExit=ee365c9d
restore.noOutput=c1610bee
restore.pluginRemoveFailed=9238f57d
restore.unknownAction=9c4f46b8
restore.missingTargetBlob=65f23050
restore.missingTarget=de247064
restore.missingPluginName=300b82d6
restore.ghostSweepSummary=027e9d89
restore.versionMismatch=0152cf52
restore.versionMismatchDetail=05f1573a
run.conflict.export=c181e08f
run.conflict.import=ffb79768
run.notFound=9e2fa6ee
host.exportTimeout=59bf7d33
host.syncPushTimeout=cb856ffe
host.syncPullTimeout=d68522d6
host.workspaceUnavailable=bb5978df
host.workspaceMissingTarget=e1e32977
host.sessionStoreShapeUnknown=5f536b4e
host.sessionStorePurposeReindex=d8390c9f
host.sessionStorePurposeParentRelations=1f87e205
host.sessionStoreListFailed=6de50590
host.sessionStoreListNotArray=879d8be6
host.sessionStorePartialUnresolved=93c25644
host.parentRelationsUnavailable=9c507e80
host.fsPathNotAbsolute=63921261
host.fsPathDotDot=570cd46b
host.fsPathNotDirectory=de0f5bc1
host.patchUnsupported=528742ab
host.patchUnreadable=cbbe8621
host.patchRefuseClobber=b7120f1a
host.fsPathEscape=b774bf0a
host.activationRowFailed=0dce5ab1
host.syncTokenWriteFailed=d50f3dc1
host.githubMissingClientId=58778d2b
host.githubFlowGone=5afe13e0
host.restoreBlobEscape=bc69f93c
host.restoreUninstallFailed=ee365c9d
host.restoreNoOutput=c1610bee
adapter.pluginListReadFailed=d9c4cbb4
adapter.patchReadFailed=25a00431
adapter.patchReadFailedPrompts=9f4c3045
adapter.patchReadFailedMCP=5a5db819
adapter.pnpmReadFailed=17b37b9a
adapter.localPackFailed=58c833ad
adapter.pluginLocalTarballHint=247729c9
adapter.providerNsReadFailed=aab8027d
adapter.credStatusReadFailed=d31c590a
adapter.settingsNsReadFailed=a8efebe4
adapter.dirEmpty=c4afe993
adapter.linksFollowed=4023bbc7
adapter.linksSkipped=b9872901
adapter.dirsUnreadable=14b18853
adapter.depsDirsSkipped=43b54fc6
adapter.depsDirFiles=31278d84
adapter.depsDirFilesUnknown=56ed56d4
adapter.fileSectionByteLimit=688de04a
adapter.linkReason.loop=4e783716
adapter.linkReason.outsideHome=64c3b9c2
adapter.linkReason.broken=23ffb55e
adapter.linkReason.unreadable=a3e2122b
adapter.linkReason.tooDeep=f011cf3b
adapter.noSettingsNamespaces=fadca649
adapter.fileCreate=8bc99f2f
adapter.fileSame=4a19ccce
adapter.fileDiff=a2f85dd6
adapter.pluginFileCreate=04a3f084
adapter.pluginFileReserved=d263f753
adapter.fileReserved=d263f753
adapter.mcpCreate=ab0cac88
adapter.mcpSame=a677aa75
adapter.mcpDiff=145629e1
adapter.pwCreate=65fb3545
adapter.pwUpdate=7e23c7e5
adapter.pluginInstall=a422c035
adapter.pluginSame=b540e3ac
adapter.pluginDiff=5c8f623f
adapter.pluginVersionDetail=8bcc20c3
adapter.pluginBundleMember=cb259799
adapter.pluginInstallOk=2f197583
adapter.pluginUpdateTriggered=b4a9d3cd
adapter.pluginRestartSuffix=8b777dc3
adapter.pwMissing=b128378b
adapter.pluginInstallFailed=ae58536f
adapter.pluginUpdateFailed=8208d02f
adapter.patchLineCreate=fb975c58
adapter.patchLineSame=425fa025
adapter.patchLineDiff=dc165320
adapter.promptSame=39140338
adapter.promptDiff=c38e4221
adapter.promptDiffWithLine=dd31a856
adapter.promptCreate=99e04ceb
adapter.promptManual=f52a0f29
adapter.providerUnregistered=10ca00e8
adapter.providerCreate=859b6951
adapter.providerSame=bce72c5f
adapter.providerDiff=3fda0f92
adapter.settingsUnregistered=a26cf0cb
adapter.settingsCreate=f5cd8bd1
adapter.settingsSame=1f998e25
adapter.settingsDiff=5607918f
adapter.workspaceCreate=602c43de
adapter.workspaceSame=3fab4f6e
adapter.workspaceDiff=8e4fde14
adapter.workspacePathMapping=089f5b3f
adapter.workspaceMissing=711f116f
adapter.credentialDescription=3ee102d2
adapter.missingTargetRef=b3db7b49
adapter.dataMissingFile=37fda3f4
adapter.patchMissing=081968e3
adapter.pwWritten=3b81fb89
adapter.pwWriteFailed=a1ed0359
adapter.patchFileCreate=9d64dc02
adapter.patchFileWriteFailed=1e736591
adapter.patchFileMissing=ae3f7a77
adapter.patchFileUnsafe=9a5eab2f
adapter.patchFileReadFailed=35ea1463
adapter.patchFileTooLarge=a85c5edb
adapter.pwPatchesDropped=60db1659
adapter.pwPatchesDroppedDetail=229a409e
adapter.pwPatchesUnsupported=6ee9a080
adapter.pwWrittenPatchesDropped=788b1b24
adapter.patchWritten=ef005ab0
adapter.credentialValueMissing=77856b96
adapter.promptWarningNoWrite=ddffc7c3
adapter.promptMissing=96d59424
adapter.promptCreated=edfa6a8f
adapter.patchLineMissing=722a9efe
adapter.promptWritten=7ecfa259
adapter.mcpMissing=a69e2ccc
adapter.mcpWritten=3361d17f
adapter.workspaceWriteFailed=c05d4d68
adapter.workspaceDirCreated=b815201b
adapter.workspaceDirFailed=23c2b6ce
adapter.workspaceDirUnsafe=af957f28
adapter.workspaceSessionsAttached=b1637e5a
adapter.workspaceSessionsPending=e8e562f6
adapter.workspaceSessionsOutsideBundle=cd677cd6
adapter.workspaceSessionsManual=4835e86a
adapter.workspaceSessionsOwnerMissing=b37a5f40
adapter.providerMissing=46eefe92
adapter.namespaceMissing=544111f5
adapter.validate.object=f684b129
adapter.validate.fileSection=59afe08f
adapter.validate.version=88de06b9
adapter.validate.array=e7738574
adapter.validate.string=b598e7e2
adapter.validate.localTarballPath=eb521c44
adapter.validate.missingObject=ae0ec53a
adapter.validate.recordObject=020cd708
adapter.validate.requiredField=919004e2
adapter.validate.sourceNamespace=faca8869
adapter.validate.number=4d5de0cf
adapter.validate.nonEmptyRef=7189e682
adapter.validate.credentialRef=2049999b
adapter.validate.fileRelativePath=032ee98a
adapter.validate.promptIdentity=655d15a8
adapter.validate.hasValueFalse=52a8e3ea
adapter.validate.serverName=7b336f41
adapter.validate.workspaceIdentity=c99a90fc
adapter.validate.missingValue=0bf5e371
sync.denySensitiveSection=4c50a519
sync.sectionFailed=2e6900c6
sync.skipNonPortable=da38bf76
sync.encryptRequiresPassword=5bb93652
sync.includeSecretsRequiresEncryption=951e1d1c
sync.credentialsReadFailed=b2569ea9
sync.credentialsEmpty=521714b1
sync.credentialsItemDesc=cf087014
sync.credentialsNeedPassword=0e82e95b
sync.encryptedNeedsPassword=4bf48a91
sync.noPortableSections=8f111b6a
sync.remoteEmpty=690b4168
sync.sessionDeletionsRecorded=adff6325
sync.sessionsTombstoned=bd728e04
sync.missingImporter=b72eedb6
sync.missingCtx=410d0a1f
sync.missingTransport=6dc45be2
sync.missingStateDir=fed3551a
sync.remoteContainsSecrets=e9c50b3d
sync.unchanged=6f653d9f
sync.changesSummary=5c515700
sync.configWhitespace=65394f94
sync.configUnparseable=1569b688
sync.configUserinfo=7e7af4e7
sync.state.notObject=6e207956
sync.state.schemaUnsupported=ee5f5f86
sync.state.lastSyncAt=a4ceeeb8
sync.state.sections=2f4ea8d1
sync.state.sectionRecord=e47084b4
sync.state.sectionFields=2b5677d2
sync.state.transport=8777af55
sync.git.repoUrlRequired=aa5876a5
sync.git.workDirRequired=b51cad7f
sync.git.credentialsRequired=d4e5bcfc
sync.git.snapshotMissing=480cf6b3
sync.git.snapshotCorrupt=af1824d9
sync.git.repoUnreachable=85f9daaa
sync.git.workDirNotRepo=d7ecc7d8
sync.git.pullFailed=6766926f
sync.git.cmdFailed=1bc06220
sync.git.pushTokenRequired=5aabd2a0
sync.git.pushAuthFailed=3e3de724
sync.git.repoUrlInvalid=362a2b36
sync.git.invalidSnapshotId=49c10fb1
sync.webdav.baseUrlRequired=e3067d58
sync.webdav.baseUrlInvalid=62b4779e
sync.webdav.baseUrlUserinfo=34c9692a
sync.webdav.usernameRequired=347a9b47
sync.webdav.credentialsRequired=81fcc041
sync.webdav.invalidSnapshotId=49c10fb1
sync.webdav.snapshotMissing=75dd1e8c
sync.webdav.requestFailed=3dc71e9f
sync.webdav.requestError=0014c75c
sync.webdav.timeout=edf1c80c
sync.webdav.tooManyRedirects=ecaaa26b
sync.webdav.indexInvalid=3fedc570
sync.webdav.snapshotInvalid=3924e9cd
sync.pruneListFailed=7801bb72
sync.pruneDeleteFailed=554a397e
market.invalidItemId=074d1618
market.urlWhitespace=becd1d87
market.urlUnparseable=3f5ed1b5
market.urlUserinfo=4ce929db
market.repoUnreachable=11728a2d
market.cloneFailed=c3437a6f
market.pullFailed=1cfeb577
market.workDirNotRepo=9c98bd70
market.missingIndex=123dd882
market.missingManifest=1b6d8abb
market.missingZip=e5af4f3e
market.zipTooLarge=e7e622e9
market.invalid=7b4145b6
`