/**
 * security 层的领域消息目录（zh 源 / en 镜像）—— 经 engineMsg 取「调用期」语言文案。
 *
 * 为什么是本域独立目录：src/security/** 的写作用域不含 src/core/messages.ts（既有键有冻结指纹），
 * 所以本域的键用 registerMessageCatalog 在**模块加载时**注册进引擎目录，查找顺序见
 * src/core/engine-locale.ts（基础目录 → 注册目录 → 键名）。
 *
 * 纪律（与 src/core/messages.ts 同口径）：
 *  - zh 值 = 迁移前的既有中文文案**逐字不变**（既有测试断言依赖）；
 *  - en 类型为 Record<keyof typeof zh, string> —— 缺键/多键即编译错误；
 *  - {param} 插值与缺参保留由 engineMsg 负责；
 *  - **凭据 / 密码值永不进消息**：这里只换文案，脱敏口径与拼接顺序逐字不变（转写前长什么样，
 *    转写后还是什么样），绝不新增任何值参数。
 */
import { engineMsg, registerMessageCatalog } from '../core/engine-locale.ts';
import type { MsgParams } from '../core/msg-types.ts';

export const zh = {
  // ---------- 加密容器（encryption.ts） ----------
  'security.encryptionPasswordEmpty': '加密密码不能为空',
  'security.secretsBlobTooSmall': 'secrets.enc 体积过小（截断或损坏）',
  'security.unknownFileMagic': '未知文件格式 magic "{magic}"，不是本插件产物',
  'security.unsupportedSecretsVersion': '不支持的 secrets.enc 版本 {version}',
  'security.invalidEncryptionParams': 'manifest 加密参数非法或不受支持',
  'security.encryptionParamsMismatch': 'secrets.enc 与 manifest 加密参数不一致（可能被篡改）',
  'security.keyDerivationFailed': '密钥派生失败: {reason}',
  'security.decryptAuthFailed': '解密认证失败：密码错误或密文被篡改',
  'security.archiveBlobTooSmall': '加密备份容器体积过小（截断或损坏）',
  'security.unsupportedArchiveVersion': '不支持的加密备份版本 {version}',
  'security.archiveParamsMismatch': '加密备份参数不一致（可能被篡改）',

  // ---------- 完整性校验表（integrity.ts） ----------
  'security.checksumsMustBeJsonObject': 'checksums.json 必须是 JSON 对象',
  'security.checksumsTooManyEntries': 'checksums.json 条目数 {count} 超过上限 {max}',
  'security.checksumsDangerousKey': 'checksums.json 含危险键 "{path}"，已拒绝',
  'security.checksumsIllegalPath': 'checksums.json 含非法相对路径 "{path}"',
  'security.checksumsNotSha256': 'checksums.json["{path}"] 不是合法的 SHA-256 hex',
  'security.checksumMismatch': '"{path}" (hash 不符)',
  'security.checksumMissing': '"{path}" (缺失)',

  // ---------- 秘密扫描（secret-scanner.ts） ----------
  'security.scanDepthExceeded': '扫描深度 {depth} 超过上限 {max}',
  'security.circularReference': '检测到循环引用，无法扫描（路径 {path}）',

  // ---------- vault / ZIP 安全（vault.ts / zip-security.ts） ----------
  'security.vaultUnsafePath': 'vault: 非法敏感文件路径 "{path}"',
  'security.zipTargetOutOfBounds': '解压目标越界: {name}',
  'security.zipExecutableEntry': '条目 "{name}" 是潜在可执行文件，本插件不会执行它',
  'security.zipEntryNotRegularFile': '解压产物不是普通文件: {rel}',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'security.encryptionPasswordEmpty': 'Encryption password must not be empty',
  'security.secretsBlobTooSmall': 'secrets.enc is too small (truncated or corrupted)',
  'security.unknownFileMagic': 'Unknown file format magic "{magic}"; not a product of this plugin',
  'security.unsupportedSecretsVersion': 'Unsupported secrets.enc version {version}',
  'security.invalidEncryptionParams': 'Invalid or unsupported manifest encryption parameters',
  'security.encryptionParamsMismatch': 'secrets.enc encryption parameters do not match the manifest (possibly tampered with)',
  'security.keyDerivationFailed': 'Key derivation failed: {reason}',
  'security.decryptAuthFailed': 'Decryption authentication failed: wrong password or tampered ciphertext',
  'security.archiveBlobTooSmall': 'Encrypted backup container is too small (truncated or corrupted)',
  'security.unsupportedArchiveVersion': 'Unsupported encrypted backup version {version}',
  'security.archiveParamsMismatch': 'Encrypted backup parameters do not match (possibly tampered with)',

  'security.checksumsMustBeJsonObject': 'checksums.json must be a JSON object',
  'security.checksumsTooManyEntries': 'checksums.json has {count} entries, exceeding the limit of {max}',
  'security.checksumsDangerousKey': 'checksums.json contains a dangerous key "{path}", rejected',
  'security.checksumsIllegalPath': 'checksums.json contains an illegal relative path "{path}"',
  'security.checksumsNotSha256': 'checksums.json["{path}"] is not a valid SHA-256 hex string',
  'security.checksumMismatch': '"{path}" (hash mismatch)',
  'security.checksumMissing': '"{path}" (missing)',

  'security.scanDepthExceeded': 'Scan depth {depth} exceeds the limit of {max}',
  'security.circularReference': 'Circular reference detected, cannot scan (path {path})',

  'security.vaultUnsafePath': 'vault: illegal sensitive file path "{path}"',
  'security.zipTargetOutOfBounds': 'Extraction target escapes the destination: {name}',
  'security.zipExecutableEntry': 'Entry "{name}" is a potential executable; this plugin will not execute it',
  'security.zipEntryNotRegularFile': 'Extracted entry is not a regular file: {rel}',
};

registerMessageCatalog({ id: 'security', zh, en });

/** 本域翻译器：key 受目录约束（拼错键 = 编译错误），语言按 engineMsg 的活语言解析。 */
export function securityMsg(key: keyof typeof zh, params?: MsgParams): string {
  return engineMsg(key, params);
}
