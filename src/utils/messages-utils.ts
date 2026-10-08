/**
 * src/utils/** 的领域消息目录（zh 源语言 / en 镜像）——「英文界面零中文」迁移（t5）。
 *
 * 口径（与 src/core/messages.ts 一致，见 docs/design/2026-10-08-i18n-en-hardcoding.md）：
 *  - zh 值 = 迁移前的既有中文文案**逐字不变**（既有测试断言依赖它，只允许新增 en）；
 *  - en 值类型为 Record<keyof typeof zh, string> —— 缺键/多键即编译错误；
 *  - 动态明细一律走 {param} 插值传参，不得丢信息；
 *  - 本目录经 registerMessageCatalog 注册（模块加载即注册），查找顺序在既有基础目录之后；
 *  - zh 对象字面量必须叫 `zh`（守卫 E3 目录 zh 区豁免；改名会让本文件自身变成 300+ 命中）。
 *
 * 使用者：`utilsMsg`（本域唯一出口）——它 import 了 engineMsg，因此 import 本函数即完成注册，
 * 不会出现「用了键但目录没注册」的裸键名输出。
 */
import { engineMsg, registerMessageCatalog } from '../core/engine-locale.ts';
import type { MsgParams } from '../core/msg-types.ts';

export const zh = {
  // ---------- utils/json.ts：深度/体积保护 ----------
  'utils.json.depthDefault': 'JSON 嵌套深度超过上限 {max}',
  'utils.json.bytesExceeded': 'JSON 体积超过上限 {max} 字节',
  'utils.json.parseFailedDeep': 'JSON 解析失败（可能是嵌套过深）: {reason}',
  'utils.json.depthExceeded': 'JSON 嵌套深度 {depth} 超过上限 {max}',

  // ---------- utils/atomic-write.ts：tmp 名清洗 / symlink 策略 ----------
  'utils.atomicWrite.invalidBaseName': '原子写：非法目标文件名「{base}」',
  'utils.atomicWrite.illegalChars': '原子写：目标文件名含非法字符「{base}」',
  'utils.atomicWrite.controlChars': '原子写：目标文件名含控制字符「{base}」',
  'utils.atomicWrite.symlinkRejected': '原子写：目标为符号链接且策略为 reject，拒绝写入「{target}」',
  'utils.atomicWrite.symlinkRejectedSync': '原子写（同步）：目标为符号链接且策略为 reject，拒绝写入「{target}」',

  // ---------- utils/zip.ts：条目数 / 条目名 / 解压校验 ----------
  'utils.zip.entryCountWriteExceeded': 'ZIP 条目数 {count} 超过上限 {max}（导出上限与读取上限一致；请缩小导出分区范围后重试）',
  'utils.zip.unsafeEntryNameWrite': '拒绝写入不安全的条目名: {name}',
  'utils.zip.entryInflateFailed': '条目 "{name}" 解压失败: {reason}',
  'utils.zip.unknownCompression': '条目 "{name}" 使用未知压缩方法 {method}',
  'utils.zip.entryMissing': 'ZIP 中不存在条目: {name}',
  'utils.zip.localHeaderCorrupt': '条目 "{name}" 的本地文件头损坏',
  'utils.zip.dataOutOfRange': '条目 "{name}" 数据越界',
  'utils.zip.sizeMismatch': '条目 "{name}" 解压尺寸不符（{actual} ≠ {expected}）',
  'utils.zip.crcMismatch': '条目 "{name}" CRC32 校验失败（ZIP 已损坏）',
  'utils.zip.totalUncompressedExceeded': 'ZIP 解压总字节数超过上限',
  'utils.zip.ratioExceeded': '条目 "{name}" 压缩比 {ratio} 超过上限（疑似 zip bomb）',
  'utils.zip.tooSmall': '不是合法的 ZIP 文件（体积过小）',
  'utils.zip.missingEocd': '不是合法的 ZIP 文件（缺少中央目录结束记录）',
  'utils.zip.centralDirOutOfRange': '中央目录越界（ZIP 损坏）',
  'utils.zip.entryCountReadExceeded': 'ZIP 条目数 {count} 超过上限 {max}',
  'utils.zip.centralEntryOutOfRange': '中央目录条目越界（ZIP 损坏）',
  'utils.zip.centralSignatureCorrupt': '中央目录签名损坏',
  'utils.zip.unsafeEntryName': 'ZIP 条目名不安全: {name}',
  'utils.zip.duplicateEntryName': 'ZIP 条目名重复: {name}',
  'utils.zip.symlinkEntryRejected': 'ZIP 含符号链接条目，已拒绝: {name}',
  'utils.zip.localHeaderOutOfRange': '条目 "{name}" 本地文件头越界',
  'utils.zip.compressedTotalExceeded': 'ZIP 压缩数据总量超过上限',
  'utils.zip.extractTargetOutOfRange': '解压目标越界: {name}',

  // ---------- utils/env-lock.ts：环境锁诊断 detail（内部诊断文案，供 CLI/日志/事故恢复展示） ----------
  'utils.envLock.probeFailed': '进程探测失败 pid={pid}: {reason}',
  'utils.envLock.probeUndetermined': '进程探测未确定 pid={pid}',
  'utils.envLock.probeFailedShort': '进程探测失败 pid={pid}',
  'utils.envLock.mkdirLocksDir': '创建锁目录 {dir}',
  'utils.envLock.openWxPermissionNoExisting': "open('wx') {path}: 权限/ACL 错误 ({code})，且未发现既有锁文件",
  'utils.envLock.writeOwner': '写入 owner {path}',
  'utils.envLock.releaseForeignToken': 'release: token 不匹配当前持有（foreign/已被接管），拒绝 unlink',
  'utils.envLock.releaseOwnershipUnreadable': 'release: 磁盘 ownership 无法读取/损坏（可能被异常恢复或人工修改），拒绝 unlink（ownership-lost）',
  'utils.envLock.releaseOwnershipMismatch': 'release: 磁盘 ownership.instanceId={diskId} !== 本 token {tokenId}（ownership-lost）',
  'utils.envLock.releaseUnlinkFailed': 'release: unlink {path} 失败: {reason}',
  'utils.envLock.ownershipMissing': 'ownership file 不存在（可能正被创建中）',
  'utils.envLock.ownershipCorrupt': 'ownership 存在但无有效 owner（可能崩溃残留空/损坏文件），不删除、不执行；可用 --recover-stale-lock 回收',
  'utils.envLock.heartbeatPermissionDenied': '无法读取 heartbeat（权限/ACL），保守拒绝',
  'utils.envLock.heartbeatReadFailed': 'heartbeat 读取失败，保守拒绝',
  'utils.envLock.ownerConfirmedDead': 'owner pid={pid} 确证不存在 (heartbeat expired)',
  'utils.envLock.ownerAliveUnverifiable': 'owner pid={pid} 存活但无法验证进程身份（可能是 PID 复用），且 heartbeat {longExpired} → 判定为残留锁，可显式回收',
  'utils.envLock.heartbeatExpiredNoIdentity': 'heartbeat 过期且 pid={pid} 存活，但无法可靠取得 OS process identity，保守拒绝删除',
  'utils.envLock.pidReuse': 'pid reuse：pid={pid} identity 与 recorded 不同',
  'utils.envLock.ownerAliveDegraded': 'owner 进程存活（heartbeat 可能 degraded），非 stale',
  'utils.envLock.notStaleRefuseRecovery': '非 stale，拒绝 recovery',
  'utils.envLock.ownershipGone': 'ownership 已消失（被他人接管/清除），停止 recovery',
  'utils.envLock.captureRenameFailed': '捕获 rename 失败（可能被他人接管），停止',
  'utils.envLock.captureReadFailed': '捕获文件读取失败，保留 recovering 供诊断',
  'utils.envLock.corruptReclaimAnomaly': 'corrupt 回收二次验证异常：captured 具有效 owner，保留 {name} quarantine；不覆盖当前 environment.lock',
  'utils.envLock.reverifyFailed': '二次验证失败：保留 {name} quarantine；不覆盖当前 environment.lock（若有 successor）',
  'utils.envLock.removeCapturedFailed': '删除 captured 失败',
  'utils.envLock.removedStaleOwnership': '已移除 stale ownership (op={op}, pid={pid})',
  'utils.envLock.removedCorruptOwnership': '已移除 corrupt/崩溃残留所有权文件',
  'utils.envLock.longExpired': '已过期 {age}（阈值 {threshold}）',
  'utils.envLock.durationDays': '{value} 天',
  'utils.envLock.durationHours': '{value} 小时',
  'utils.envLock.durationMinutes': '{value} 分钟',
  'utils.envLock.durationSeconds': '{value} 秒',
  'utils.envLock.ioPermissionNotLock': '{what}: 权限/ACL 错误 ({code})，非锁占用',

  // ---------- utils/env-lock.ts：锁被挡时给用户的分类文案（长 / 短两套，同源同分类） ----------
  'utils.envLock.block.locked': '另一个任务正在运行，请稍后重试。',
  'utils.envLock.block.blocked': '配置修改已被保护，请先处理恢复事项后再继续。',
  'utils.envLock.block.unavailable': '操作暂时无法执行，请稍后重试；若持续失败请查看日志。',
  'utils.envLock.block.stale': '检测到上次异常退出残留的配置锁（其持有进程已不存在），操作已被阻止。'
    + '该锁不会自动清除，重试或重启 DSH 均无效：请在「事故恢复」中点击「回收残留锁」，'
    + '或运行 dsh-config-manager recover-stale-lock 回收后再重试。',
  'utils.envLock.brief.locked': '环境锁被另一项任务占用',
  'utils.envLock.brief.blocked': '配置修改已被保护，需先处理恢复事项',
  'utils.envLock.brief.unavailable': '环境锁暂时不可用',
  'utils.envLock.brief.stale': '残留配置锁（持有进程已不存在），需先回收',

  // ---------- utils/proxy.ts：代理隧道（保留原文的双语形态，zh 逐字不变） ----------
  'utils.proxy.connectTimeout': '代理连接超时 / proxy connect timed out ({ms}ms)',
  'utils.proxy.malformedConnectResponse': '代理 CONNECT 响应异常（头部过长）/ malformed CONNECT response',
  'utils.proxy.refusedConnect': '代理拒绝 CONNECT（HTTP {status}）/ proxy refused CONNECT',
  'utils.proxy.closedDuringConnect': '代理连接在 CONNECT 完成前关闭 / proxy closed during CONNECT',

  // ---------- utils/session-log-repair.ts：会话日志修复计划/告警 ----------
  'utils.sessionRepair.closerReferenced': '收尾块区间的 seq 被保留行引用 → 本次不丢弃该收尾块（避免把引用静默改指）',
  'utils.sessionRepair.truncateBreaksRefs': '截断会让保留行的引用失去目标或被改指（seq {seqs}）→ 拒绝本次修复',
  'utils.sessionRepair.keptRefersDropped': '保留行引用到本次将被丢弃的行（seq {seqs}）→ 拒绝本次修复',
  'utils.sessionRepair.danglingRef': '先前就存在的悬空引用：seq {seq}（本次修复未丢弃它）',
  'utils.sessionRepair.dropDuplicateRows': '丢弃 {rows} 行重放重复事件（字节相同 + seq 相同）',
  'utils.sessionRepair.dropSyntheticCloser': '丢弃 {rows} 行崩溃恢复补写的收尾块（turn {turn} 之后仍在续写，真实内容保留）',
  'utils.sessionRepair.truncateTail': '在首个异常处截断：丢弃其后 {rows} 行（**有损**，备份可回滚）',
};

export const en: Record<keyof typeof zh, string> = {
  // ---------- utils/json.ts ----------
  'utils.json.depthDefault': 'JSON nesting depth exceeds the limit of {max}',
  'utils.json.bytesExceeded': 'JSON payload exceeds the limit of {max} bytes',
  'utils.json.parseFailedDeep': 'JSON parsing failed (possibly nested too deeply): {reason}',
  'utils.json.depthExceeded': 'JSON nesting depth {depth} exceeds the limit of {max}',

  // ---------- utils/atomic-write.ts ----------
  'utils.atomicWrite.invalidBaseName': 'Atomic write: invalid target file name "{base}"',
  'utils.atomicWrite.illegalChars': 'Atomic write: target file name contains illegal characters "{base}"',
  'utils.atomicWrite.controlChars': 'Atomic write: target file name contains control characters "{base}"',
  'utils.atomicWrite.symlinkRejected': 'Atomic write: target is a symbolic link and the policy is reject — refusing to write "{target}"',
  'utils.atomicWrite.symlinkRejectedSync': 'Atomic write (sync): target is a symbolic link and the policy is reject — refusing to write "{target}"',

  // ---------- utils/zip.ts ----------
  'utils.zip.entryCountWriteExceeded': 'ZIP entry count {count} exceeds the limit of {max} (write and read limits are the same; narrow the exported section range and retry)',
  'utils.zip.unsafeEntryNameWrite': 'Refusing to write an unsafe entry name: {name}',
  'utils.zip.entryInflateFailed': 'Entry "{name}" failed to decompress: {reason}',
  'utils.zip.unknownCompression': 'Entry "{name}" uses an unknown compression method {method}',
  'utils.zip.entryMissing': 'No such entry in the ZIP: {name}',
  'utils.zip.localHeaderCorrupt': 'Entry "{name}" has a corrupt local file header',
  'utils.zip.dataOutOfRange': 'Entry "{name}" data is out of range',
  'utils.zip.sizeMismatch': 'Entry "{name}" decompressed size mismatch ({actual} ≠ {expected})',
  'utils.zip.crcMismatch': 'Entry "{name}" CRC32 check failed (the ZIP is corrupt)',
  'utils.zip.totalUncompressedExceeded': 'Total uncompressed ZIP bytes exceed the limit',
  'utils.zip.ratioExceeded': 'Entry "{name}" compression ratio {ratio} exceeds the limit (possible zip bomb)',
  'utils.zip.tooSmall': 'Not a valid ZIP file (too small)',
  'utils.zip.missingEocd': 'Not a valid ZIP file (missing end of central directory record)',
  'utils.zip.centralDirOutOfRange': 'Central directory is out of range (corrupt ZIP)',
  'utils.zip.entryCountReadExceeded': 'ZIP entry count {count} exceeds the limit of {max}',
  'utils.zip.centralEntryOutOfRange': 'Central directory entry is out of range (corrupt ZIP)',
  'utils.zip.centralSignatureCorrupt': 'Central directory signature is corrupt',
  'utils.zip.unsafeEntryName': 'Unsafe ZIP entry name: {name}',
  'utils.zip.duplicateEntryName': 'Duplicate ZIP entry name: {name}',
  'utils.zip.symlinkEntryRejected': 'ZIP contains a symbolic link entry — rejected: {name}',
  'utils.zip.localHeaderOutOfRange': 'Entry "{name}" local file header is out of range',
  'utils.zip.compressedTotalExceeded': 'Total compressed ZIP bytes exceed the limit',
  'utils.zip.extractTargetOutOfRange': 'Extraction target is out of range: {name}',

  // ---------- utils/env-lock.ts ----------
  'utils.envLock.probeFailed': 'Process probe failed for pid={pid}: {reason}',
  'utils.envLock.probeUndetermined': 'Process probe for pid={pid} was inconclusive',
  'utils.envLock.probeFailedShort': 'Process probe failed for pid={pid}',
  'utils.envLock.mkdirLocksDir': 'create lock directory {dir}',
  'utils.envLock.openWxPermissionNoExisting': "open('wx') {path}: permission/ACL error ({code}), and no existing lock file was found",
  'utils.envLock.writeOwner': 'write owner {path}',
  'utils.envLock.releaseForeignToken': 'release: token does not match the current holder (foreign/taken over) — refusing to unlink',
  'utils.envLock.releaseOwnershipUnreadable': 'release: on-disk ownership is unreadable/corrupt (possibly recovered abnormally or edited by hand) — refusing to unlink (ownership-lost)',
  'utils.envLock.releaseOwnershipMismatch': 'release: on-disk ownership.instanceId={diskId} !== this token {tokenId} (ownership-lost)',
  'utils.envLock.releaseUnlinkFailed': 'release: unlink {path} failed: {reason}',
  'utils.envLock.ownershipMissing': 'ownership file does not exist (possibly being created right now)',
  'utils.envLock.ownershipCorrupt': 'ownership exists but has no valid owner (possibly an empty/corrupt file left by a crash); not deleted, not executed; reclaim with --recover-stale-lock',
  'utils.envLock.heartbeatPermissionDenied': 'Cannot read heartbeat (permission/ACL) — conservatively refusing',
  'utils.envLock.heartbeatReadFailed': 'Heartbeat read failed — conservatively refusing',
  'utils.envLock.ownerConfirmedDead': 'owner pid={pid} is confirmed gone (heartbeat expired)',
  'utils.envLock.ownerAliveUnverifiable': 'owner pid={pid} is alive but its process identity cannot be verified (possible PID reuse), and heartbeat {longExpired} → judged a stale lock, explicit reclaim allowed',
  'utils.envLock.heartbeatExpiredNoIdentity': 'heartbeat expired and pid={pid} is alive, but the OS process identity cannot be obtained reliably — conservatively refusing to delete',
  'utils.envLock.pidReuse': 'pid reuse: pid={pid} identity differs from the recorded one',
  'utils.envLock.ownerAliveDegraded': 'owner process is alive (heartbeat may be degraded), not stale',
  'utils.envLock.notStaleRefuseRecovery': 'not stale — refusing recovery',
  'utils.envLock.ownershipGone': 'ownership has disappeared (taken over/cleared by someone else) — stopping recovery',
  'utils.envLock.captureRenameFailed': 'capture rename failed (possibly taken over by someone else) — stopping',
  'utils.envLock.captureReadFailed': 'reading the captured file failed; keeping the recovering file for diagnosis',
  'utils.envLock.corruptReclaimAnomaly': 'corrupt reclaim second verification anomaly: the captured file has a valid owner; keeping {name} quarantined and not overwriting the current environment.lock',
  'utils.envLock.reverifyFailed': 'second verification failed: keeping {name} quarantined and not overwriting the current environment.lock (if any successor exists)',
  'utils.envLock.removeCapturedFailed': 'failed to delete the captured file',
  'utils.envLock.removedStaleOwnership': 'removed stale ownership (op={op}, pid={pid})',
  'utils.envLock.removedCorruptOwnership': 'removed the corrupt/crash-left ownership file',
  'utils.envLock.longExpired': 'expired {age} ago (threshold {threshold})',
  'utils.envLock.durationDays': '{value} days',
  'utils.envLock.durationHours': '{value} hours',
  'utils.envLock.durationMinutes': '{value} minutes',
  'utils.envLock.durationSeconds': '{value} seconds',
  'utils.envLock.ioPermissionNotLock': '{what}: permission/ACL error ({code}), not lock contention',

  'utils.envLock.block.locked': 'Another task is running, please retry later.',
  'utils.envLock.block.blocked': 'Configuration changes are protected — resolve the recovery items before continuing.',
  'utils.envLock.block.unavailable': 'The operation cannot run right now, please retry later; if it keeps failing, check the logs.',
  'utils.envLock.block.stale': 'A configuration lock left behind by a previous abnormal exit was detected (its owning process no longer exists), so the operation was blocked.'
    + 'This lock will not clear itself — retrying or restarting DSH will not help: click "Reclaim stale lock" under "Incident recovery",'
    + 'or run dsh-config-manager recover-stale-lock and then retry.',
  'utils.envLock.brief.locked': 'Environment lock held by another task',
  'utils.envLock.brief.blocked': 'Configuration changes are protected; resolve recovery items first',
  'utils.envLock.brief.unavailable': 'Environment lock temporarily unavailable',
  'utils.envLock.brief.stale': 'Stale configuration lock (owning process is gone); reclaim it first',

  // ---------- utils/proxy.ts ----------
  'utils.proxy.connectTimeout': 'Proxy connection timed out ({ms}ms)',
  'utils.proxy.malformedConnectResponse': 'Malformed proxy CONNECT response (headers too long)',
  'utils.proxy.refusedConnect': 'Proxy refused CONNECT (HTTP {status})',
  'utils.proxy.closedDuringConnect': 'Proxy connection closed before CONNECT completed',

  // ---------- utils/session-log-repair.ts ----------
  'utils.sessionRepair.closerReferenced': 'The seq range of the closer block is referenced by kept rows → this run will not drop that closer block (avoid silently redirecting references)',
  'utils.sessionRepair.truncateBreaksRefs': 'Truncation would leave references from kept rows without a target, or redirect them (seq {seqs}) → refusing this repair',
  'utils.sessionRepair.keptRefersDropped': 'Kept rows reference rows that would be dropped by this repair (seq {seqs}) → refusing this repair',
  'utils.sessionRepair.danglingRef': 'Pre-existing dangling reference: seq {seq} (this repair does not drop it)',
  'utils.sessionRepair.dropDuplicateRows': 'Drop {rows} row(s) that replay duplicate events (identical bytes + identical seq)',
  'utils.sessionRepair.dropSyntheticCloser': 'Drop {rows} row(s) of the crash-recovery closer block (writing continued after turn {turn}; real content is preserved)',
  'utils.sessionRepair.truncateTail': 'Truncate at the first anomaly: drop the following {rows} row(s) (**lossy**, a backup can roll it back)',
};

registerMessageCatalog({ id: 'utils', zh, en });

/**
 * 本域唯一出口：取一条 src/utils/** 的文案（键名受类型约束，拼错即编译错误）。
 *
 * 为什么不让调用方直接 import engineMsg：import 本函数即保证目录已注册（模块加载期注册一次），
 * 否则会出现「用了键但注册表里没有 → 输出裸键名」的静默失败。
 */
export function utilsMsg(key: keyof typeof zh, params?: MsgParams): string {
  return engineMsg(key, params);
}
