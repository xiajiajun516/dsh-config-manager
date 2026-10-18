/**
 * 同步域（src/sync/**）的追加消息目录（zh 源 / en 镜像），归 t6 作用域。
 *
 * 为什么不写进 \`src/core/messages.ts\`：该文件不在本作用域的 inScope 内，且既有 372 键有冻结指纹
 * （改既有键即红灯）。本模块经 \`registerMessageCatalog\` 注册一本**追加目录**：engineMsg / makeMsg 的查找
 * 顺序是「既有目录 → en 下回退既有 zh → 注册目录 → 键名」，因此本域新键**只在既有目录未命中时生效**，
 * 不可能遮蔽 core 的既有键（含 sync.git.* / sync.webdav.* 的既有键）。
 *
 * 纪律：
 *  - zh 值 = 改动前的既有中文文案**逐字原样**（只把字面量搬进目录，拼接顺序/空格/全角标点不变）；
 *  - en 为 \`Record<keyof typeof zh, string>\` —— 缺键/多键即编译错误；
 *  - 本域消费面是注入的 \`MsgFunc\`（ctx.msg / sync-engine 的 this.msg）与 \`engineMsg\`，两者都查注册目录；
 *  - **导入本模块即完成注册**：凡引用本域键的模块都要 import 本模块（或 import 它导出的 engineMsg）。
 *  - 例外（不得改动）：\`src/sync/s3/messages.ts\` 与 \`src/sync/gist/messages.ts\` 是通道**本地**目录，
 *    它们的键经 \`composeMsg(host, local)\` 解析（t79/t90 的既有护栏断言 core 直查必然回退键名 ⇒
 *    那两本目录**不得**注册进这里，否则既有回归护栏的前提被打破）。s3/gist 的新键一律落进各自本地目录。
 */
import { engineMsg as engineMsgOf, registerMessageCatalog } from '../core/engine-locale.ts';
import type { MsgFunc } from '../core/msg-types.ts';

export const zh = {
  // ---------- 快照 / 祖先 ----------
  'sync.ancestorSnapshotIdRequired': 'loadAncestor: snapshotId 不能为空',
  'sync.snapshotSectionsNotObject': '快照 sections 必须是对象',
  'sync.snapshotJsonInvalid': '快照 JSON 形状非法（缺少 id/createdAt/manifest/sections）',
  'sync.snapshotStillEncrypted': '快照仍为加密载荷，无法转 ZIP（需先解密）',
  'sync.encryptPasswordRequired': '加密密码不能为空',
  'sync.decryptPasswordRequired': '解密密码不能为空',
  'sync.encryptedContentInvalid': '加密快照内容损坏：解密后不是有效的分区对象',
  // ---------- 散文件布局 ----------
  'sync.layoutEncryptedDirUnsupported': '加密快照不写散文件目录（本地不落盘；请直接使用密文传输）',
  'sync.layoutCredentialsNeedEncryptedLayout': '凭据载荷只能随加密快照的密文单文件布局传输（散文件目录不落任何凭据）',
  'sync.layoutSectionUnsupported': '分区 {section} 不在散文件布局支持范围（SECTION_JSON_PATHS / SECTION_FILE_PREFIXES）',
  'sync.layoutFileRelPathInvalid': '非法文件相对路径: {path}（分区 {section}）',
  'sync.layoutManifestMissing': '快照目录缺少 {file}: {dir}',
  'sync.layoutManifestNotObject': 'manifest.json 损坏：必须是对象',
  'sync.layoutManifestMissingFields': 'manifest.json 损坏：缺少 id/createdAt/manifest/sectionHashes',
  'sync.layoutManifestSectionUnsupported': 'manifest 声明了布局不支持的分区 {section}',
  'sync.layoutJsonSectionMissing': '快照缺少 JSON 分区文件 {path}（{section}）',
  'sync.layoutBlobRefsInvalid': '外置引用文件形状非法: {file}',
  'sync.layoutBlobRefsNoSink': '快照的 {section} 分区是内容寻址外置形态，但当前通道未提供 blob 仓',
  'sync.layoutFileSectionDirMissing': '快照缺少文件分区目录 {prefix}（{section}）',
  // ---------- 内容寻址 blob 仓 ----------
  'sync.blobMissing': '内容的 blob 缺失（{hash}，{path}）：远端仓不完整，拒绝降级为空分区',
  'sync.webdav.blobHashInvalid': '内容哈希形状非法，拒绝写入 blob 仓: {hash}',
  // ---------- 审查队列 ----------
  'sync.reviewQueueNotObject': 'sync-review-queue.json 损坏：必须是对象',
  'sync.reviewQueueItemsNotArray': 'sync-review-queue.json 损坏：items 必须是数组',
  'sync.reviewQueueItemNotObject': 'sync-review-queue.json 损坏：每个 item 必须是对象',
  'sync.reviewQueueItemFieldsMissing': 'sync-review-queue.json 损坏：item 必须含字符串 id/sectionId/kind/description',
  'sync.reviewQueueItemNotFound': 'resolveItem: 未找到 itemId {id}',
  // ---------- 同步历史 ----------
  'sync.historyJsonParseFailed': '{file} 损坏：JSON 解析失败',
  'sync.historyNotObject': '{file} 损坏：必须是对象',
  'sync.historySchemaVersionMismatch': '{file} 损坏：schemaVersion 必须是 {version}',
  'sync.historyEntriesNotArray': '{file} 损坏：autosyncEntries 必须是数组',
  'sync.historyEntryNotObject': '{file} 损坏：每个 entry 必须是对象',
  'sync.historyEntryFieldsMissing': '{file} 损坏：entry 必须含字符串 direction/status/createdAt',
  // ---------- GitHub 设备码登录 ----------
  'sync.githubEmptyResponse': '{context}: GitHub 返回空响应（HTTP {status}）',
  'sync.githubInvalidJson': '{context}: GitHub 返回了无法解析的响应（HTTP {status}），请稍后重试',
  'sync.githubClientIdRequired': 'client_id 必须是非空字符串',
  'sync.githubDeviceCodeRequestFailed': '请求 GitHub 设备码失败：{err}',
  'sync.githubDeviceCodeDenied': 'GitHub 拒绝了设备码请求：{detail}',
  'sync.githubDeviceCodeFieldsMissing': 'GitHub 设备码响应缺少必要字段（device_code/user_code/verification_uri）',
  'sync.githubTokenExchangeFailed': '交换 GitHub token 失败：{err}',
  'sync.githubContextDeviceCode': '请求设备码',
  'sync.githubContextTokenExchange': '交换 token',
  // ---------- 回滚 / 应用 ----------
  'sync.rollbackProofFailed': '回滚失败（未能证明已恢复）：{err}',
  'sync.rollbackManualHintParen': '（{hint}）',
  'sync.rollbackIncomplete': '回滚未完成：{item} —— {reason}{hint}',
  'sync.applyMergePlanNoImporter': 'applyMergePlan: SyncEngine 缺少 importer（需在 options 中注入）',
  'sync.applyItemsNoImporter': 'applyItems: SyncEngine 缺少 importer（需在 options 中注入）',
  'sync.preApplySnapshotFailed': '应用前快照失败：{err}',
  // ---------- 自动同步 ----------
  'sync.autosyncApplyMergeFailed': 'applyMergePlan 执行失败',
  'sync.autosyncPushFailed': 'push 失败',
  'sync.autosyncConsecutiveFailureNotified': '连续失败 {count} 次，已通知',
  // ---------- 备份产物 / 调度 ----------
  'sync.backupExportsDirUnreadable': '导出目录读不出来（{code}）：{dir}',
  'sync.backupFileNameInvalid': '非法备份文件名: {name}',
  'sync.backupTriggerManual': '手动备份',
  'sync.backupTriggerScheduled': '定时备份',
  'sync.backupHistoryDone': '{trigger}完成：{zip}',
  'sync.backupHistorySkipped': '{trigger}跳过：{reason}',
  'sync.backupHistoryFailed': '{trigger}失败',
  // ---------- 推送前只读预览（issue #91） ----------
  'sync.pushPreviewUnpackedLocalSources': '本地源插件（link:/file:）需打包才能精确比对变更，分区 {sections} 本次按「有变化」展示',
  // ---------- cloud-sync 借鉴项 ①②③：条件写 / 探针 / 首连自建目录 ----------
  'sync.probeUnsupported': '当前同步通道不支持连通性自检',
  'sync.webdav.concurrentWrite': '远端索引已被其它设备更新（HTTP 412）：本次写入已中止，请重新同步后再试',
  'sync.webdav.probeOk': '连接正常（远端 {count} 份快照）',
  'sync.webdav.probeUnreachable': 'WebDAV 目录不可访问（HTTP {status}）：{url}',
  'sync.webdav.collectionCreated': '已自动创建远端目录：{path}',
  'sync.webdav.collectionCreateFailed': '创建远端目录失败（HTTP {status}）：{path}',
  // ---------- cloud-sync 借鉴项 ⑥：设备身份 ----------
  'sync.deviceNameFallback': '未命名设备',
  // ---------- git 通道连通性探针（cloud-sync 借鉴项 ②，补齐四通道） ----------
  'sync.git.probeOk': '连接正常（远端可达、凭据可用）',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'sync.ancestorSnapshotIdRequired': 'loadAncestor: snapshotId must not be empty',
  'sync.snapshotSectionsNotObject': 'Snapshot sections must be an object',
  'sync.snapshotJsonInvalid': 'Malformed snapshot JSON (missing id/createdAt/manifest/sections)',
  'sync.snapshotStillEncrypted': 'The snapshot is still an encrypted payload and cannot be converted to ZIP (decrypt it first)',
  'sync.encryptPasswordRequired': 'The encryption password must not be empty',
  'sync.decryptPasswordRequired': 'The decryption password must not be empty',
  'sync.encryptedContentInvalid': 'The encrypted snapshot is corrupt: after decryption it is not a valid sections object',
  'sync.layoutEncryptedDirUnsupported': 'Encrypted snapshots are not written as a loose-file directory (nothing is stored locally; transfer the ciphertext instead)',
  'sync.layoutCredentialsNeedEncryptedLayout': 'Credential payloads can only travel inside the single ciphertext file of an encrypted snapshot (the loose-file layout stores no credentials)',
  'sync.layoutSectionUnsupported': 'Section {section} is outside the loose-file layout support range (SECTION_JSON_PATHS / SECTION_FILE_PREFIXES)',
  'sync.layoutFileRelPathInvalid': 'Invalid relative file path: {path} (section {section})',
  'sync.layoutManifestMissing': 'Snapshot directory is missing {file}: {dir}',
  'sync.layoutManifestNotObject': 'manifest.json is corrupt: must be an object',
  'sync.layoutManifestMissingFields': 'manifest.json is corrupt: missing id/createdAt/manifest/sectionHashes',
  'sync.layoutManifestSectionUnsupported': 'The manifest declares section {section}, which the layout does not support',
  'sync.layoutJsonSectionMissing': 'Snapshot is missing the JSON section file {path} ({section})',
  'sync.layoutBlobRefsInvalid': 'Malformed external reference file: {file}',
  'sync.layoutBlobRefsNoSink': 'Section {section} of the snapshot uses content-addressed external form, but the current channel provides no blob store',
  'sync.layoutFileSectionDirMissing': 'Snapshot is missing the file section directory {prefix} ({section})',
  'sync.blobMissing': 'The blob for {path} is missing ({hash}): the remote store is incomplete, refusing to degrade to an empty section',
  'sync.webdav.blobHashInvalid': 'Malformed content hash; refusing to write to the blob store: {hash}',
  'sync.reviewQueueNotObject': 'sync-review-queue.json is corrupt: must be an object',
  'sync.reviewQueueItemsNotArray': 'sync-review-queue.json is corrupt: items must be an array',
  'sync.reviewQueueItemNotObject': 'sync-review-queue.json is corrupt: every item must be an object',
  'sync.reviewQueueItemFieldsMissing': 'sync-review-queue.json is corrupt: an item must contain the strings id/sectionId/kind/description',
  'sync.reviewQueueItemNotFound': 'resolveItem: no item found for itemId {id}',
  'sync.historyJsonParseFailed': '{file} is corrupt: JSON parsing failed',
  'sync.historyNotObject': '{file} is corrupt: must be an object',
  'sync.historySchemaVersionMismatch': '{file} is corrupt: schemaVersion must be {version}',
  'sync.historyEntriesNotArray': '{file} is corrupt: autosyncEntries must be an array',
  'sync.historyEntryNotObject': '{file} is corrupt: every entry must be an object',
  'sync.historyEntryFieldsMissing': '{file} is corrupt: an entry must contain the strings direction/status/createdAt',
  'sync.githubEmptyResponse': '{context}: GitHub returned an empty response (HTTP {status})',
  'sync.githubInvalidJson': '{context}: GitHub returned an unparsable response (HTTP {status}), please retry later',
  'sync.githubClientIdRequired': 'client_id must be a non-empty string',
  'sync.githubDeviceCodeRequestFailed': 'Failed to request the GitHub device code: {err}',
  'sync.githubDeviceCodeDenied': 'GitHub rejected the device code request: {detail}',
  'sync.githubDeviceCodeFieldsMissing': 'The GitHub device code response is missing required fields (device_code/user_code/verification_uri)',
  'sync.githubTokenExchangeFailed': 'Failed to exchange the GitHub token: {err}',
  'sync.githubContextDeviceCode': 'device code request',
  'sync.githubContextTokenExchange': 'token exchange',
  'sync.rollbackProofFailed': 'Rollback failed (could not prove anything was restored): {err}',
  'sync.rollbackManualHintParen': ' ({hint})',
  'sync.rollbackIncomplete': 'Rollback incomplete: {item} — {reason}{hint}',
  'sync.applyMergePlanNoImporter': 'applyMergePlan: SyncEngine is missing the importer (must be injected via options)',
  'sync.applyItemsNoImporter': 'applyItems: SyncEngine is missing the importer (must be injected via options)',
  'sync.preApplySnapshotFailed': 'Pre-apply snapshot failed: {err}',
  'sync.autosyncApplyMergeFailed': 'applyMergePlan failed',
  'sync.autosyncPushFailed': 'push failed',
  'sync.autosyncConsecutiveFailureNotified': 'Failed {count} times in a row; notification sent',
  'sync.backupExportsDirUnreadable': 'Cannot read the export directory ({code}): {dir}',
  'sync.backupFileNameInvalid': 'Invalid backup file name: {name}',
  'sync.backupTriggerManual': 'Manual backup',
  'sync.backupTriggerScheduled': 'Scheduled backup',
  'sync.backupHistoryDone': '{trigger} finished: {zip}',
  'sync.backupHistorySkipped': '{trigger} skipped: {reason}',
  'sync.backupHistoryFailed': '{trigger} failed',
  'sync.pushPreviewUnpackedLocalSources': 'Local-source plugins (link:/file:) must be packed to compare changes exactly; section(s) {sections} are shown as changed',
  'sync.probeUnsupported': 'This sync channel does not support a connectivity self-check',
  'sync.webdav.concurrentWrite': 'The remote index was updated by another device (HTTP 412): this write was aborted, please sync again',
  'sync.webdav.probeOk': 'Connection OK ({count} remote snapshots)',
  'sync.webdav.probeUnreachable': 'The WebDAV directory is unreachable (HTTP {status}): {url}',
  'sync.webdav.collectionCreated': 'Created the remote directory automatically: {path}',
  'sync.webdav.collectionCreateFailed': 'Failed to create the remote directory (HTTP {status}): {path}',
  'sync.deviceNameFallback': 'Unnamed device',
  'sync.git.probeOk': 'Connection OK (remote reachable, credentials accepted)',
};

registerMessageCatalog({ id: 'sync-domain', zh, en });

/** 本域活翻译器（与 core 的 engineMsg 同一实现；导入本模块即完成目录注册）。 */
export const engineMsg: MsgFunc = engineMsgOf;
