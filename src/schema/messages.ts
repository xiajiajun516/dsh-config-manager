/**
 * schema 层的领域消息目录（zh 源 / en 镜像）—— 经 engineMsg 取「调用期」语言文案。
 *
 * 为什么是本域独立目录：src/schema/** 的写作用域不含 src/core/messages.ts（既有键有冻结指纹），
 * 所以本域的键用 registerMessageCatalog 在**模块加载时**注册进引擎目录，查找顺序见
 * src/core/engine-locale.ts（基础目录 → 注册目录 → 键名）。
 *
 * 纪律（与 src/core/messages.ts 同口径）：
 *  - zh 值 = 迁移前的既有中文文案**逐字不变**（既有测试断言依赖）；
 *  - en 类型为 Record<keyof typeof zh, string> —— 缺键/多键即编译错误；
 *  - {param} 插值与缺参保留由 engineMsg 负责；
 *  - 只追加键，不改既有键。
 */
import { engineMsg, registerMessageCatalog } from '../core/engine-locale.ts';
import type { MsgParams } from '../core/msg-types.ts';

export const zh = {
  // ---------- 分区 JSON 结构校验（config.ts） ----------
  'schema.sectionDataInvalid': '分区 {section} 数据无效: {issues}',
  'schema.sectionDataMustBeObject': '分区 {section} 数据必须是对象',
  'schema.sectionUnregistered': '未注册分区 {section}：拒绝校验（新增分区须在 schema/section-registry.ts 注册）',
  'schema.namespacesMissing': '分区 {section} 缺少 namespaces 对象',
  'schema.namespaceRecordMustBeObject': 'namespace 记录必须是对象',
  'schema.revisionMustBeNumber': 'revision 必须是数字',
  'schema.valueMissing': '缺少 value',
  'schema.secretsMustBeArray': 'secrets 必须是数组',
  'schema.objectMissing': '缺少 {key} 对象',
  'schema.keyMustBeArray': '{key} 必须是数组',
  'schema.patchFileEntryMustBeObject': 'patch 文件条目必须是对象',
  'schema.patchFilePathUnsafe': 'patch 文件路径必须是安全的相对路径（不得为绝对路径或含 ..）',
  'schema.patchFileContentMustBeBase64': 'patch 文件内容必须是 base64 字符串',
  'schema.fileEntryMustBeObject': '文件条目必须是对象',
  'schema.filePathUnsafe': '文件路径必须是安全的相对路径（不得为绝对路径或含 ..）',
  'schema.sectionNoJsonPayload': '分区 {section} 无 JSON 载荷（凭据值走独立加密容器，不参与分区 JSON 校验）',
  'schema.unhandledPayloadKind': '未处理的分区载荷形态 {payload}',

  // ---------- manifest 结构校验（manifest.ts） ----------
  'schema.manifestInvalid': 'manifest.json 无效: {issues}',
  'schema.manifestMustBeObject': 'manifest 必须是对象',
  'schema.schemaVersionMustBeNumber': 'schemaVersion 必须是数字',
  'schema.exporterMissing': 'exporter 缺失',
  'schema.exporterNameMustBeString': 'exporter.name 必须是字符串',
  'schema.exporterVersionMustBeString': 'exporter.version 必须是字符串',
  'schema.sourceMissing': 'source 缺失',
  'schema.sourceDshVersionMustBeString': 'source.dshVersion 必须是字符串',
  'schema.sourcePlatformMustBeString': 'source.platform 必须是字符串',
  'schema.sourceArchMustBeString': 'source.arch 必须是字符串',
  'schema.exportedAtInvalid': 'exportedAt 必须是合法 ISO-8601 时间',
  'schema.sectionsMissing': 'sections 缺失',
  'schema.unknownSection': '未知分区 "{section}"',
  'schema.sectionFlagMustBeBoolean': 'sections.{section} 必须是布尔',
  'schema.securityMissing': 'security 缺失',
  'schema.containsSecretsMustBeBoolean': 'containsSecrets 必须是布尔',
  'schema.encryptedMustBeBoolean': 'encrypted 必须是布尔',
  'schema.encryptionMustBeObjectOrNull': 'encryption 必须是对象或 null',

  // ---------- 版本描述（versions.ts） ----------
  'schema.versionTooNew': 'schema v{version}（高于当前 {current}，需升级插件）',
  'schema.versionNeedsMigration': 'schema v{version}（旧版，将迁移到 v{current}）',
  'schema.versionCurrent': 'schema v{version}（当前版本）',
  'schema.versionBelowMinimum': 'schema v{version}（低于最低支持 {minimum}，不受支持）',
  'schema.sectionDataVersionMismatch': '分区 {section} 的 version 必须为 {expected}（收到 {actual}）',

  // ---------- 分区注册表（section-registry.ts） ----------
  'schema.sectionNotRegistered': '未注册分区「{section}」：拒绝按其它分区语义处理；新增分区必须在 src/schema/section-registry.ts 注册',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'schema.sectionDataInvalid': 'Section {section} has invalid data: {issues}',
  'schema.sectionDataMustBeObject': 'Section {section} data must be an object',
  'schema.sectionUnregistered': 'Unregistered section {section}: refusing validation (register new sections in schema/section-registry.ts)',
  'schema.namespacesMissing': 'Section {section} is missing the namespaces object',
  'schema.namespaceRecordMustBeObject': 'Namespace record must be an object',
  'schema.revisionMustBeNumber': 'revision must be a number',
  'schema.valueMissing': 'missing value',
  'schema.secretsMustBeArray': 'secrets must be an array',
  'schema.objectMissing': 'missing {key} object',
  'schema.keyMustBeArray': '{key} must be an array',
  'schema.patchFileEntryMustBeObject': 'patch file entry must be an object',
  'schema.patchFilePathUnsafe': 'patch file path must be a safe relative path (no absolute paths, no ..)',
  'schema.patchFileContentMustBeBase64': 'patch file content must be a base64 string',
  'schema.fileEntryMustBeObject': 'file entry must be an object',
  'schema.filePathUnsafe': 'file path must be a safe relative path (no absolute paths, no ..)',
  'schema.sectionNoJsonPayload': 'Section {section} has no JSON payload (credential values use a separate encrypted container and are not part of section JSON validation)',
  'schema.unhandledPayloadKind': 'Unhandled section payload kind {payload}',

  'schema.manifestInvalid': 'manifest.json is invalid: {issues}',
  'schema.manifestMustBeObject': 'manifest must be an object',
  'schema.schemaVersionMustBeNumber': 'schemaVersion must be a number',
  'schema.exporterMissing': 'exporter is missing',
  'schema.exporterNameMustBeString': 'exporter.name must be a string',
  'schema.exporterVersionMustBeString': 'exporter.version must be a string',
  'schema.sourceMissing': 'source is missing',
  'schema.sourceDshVersionMustBeString': 'source.dshVersion must be a string',
  'schema.sourcePlatformMustBeString': 'source.platform must be a string',
  'schema.sourceArchMustBeString': 'source.arch must be a string',
  'schema.exportedAtInvalid': 'exportedAt must be a valid ISO-8601 time',
  'schema.sectionsMissing': 'sections is missing',
  'schema.unknownSection': 'Unknown section "{section}"',
  'schema.sectionFlagMustBeBoolean': 'sections.{section} must be a boolean',
  'schema.securityMissing': 'security is missing',
  'schema.containsSecretsMustBeBoolean': 'containsSecrets must be a boolean',
  'schema.encryptedMustBeBoolean': 'encrypted must be a boolean',
  'schema.encryptionMustBeObjectOrNull': 'encryption must be an object or null',

  'schema.versionTooNew': 'schema v{version} (newer than the current {current}; update the plugin)',
  'schema.versionNeedsMigration': 'schema v{version} (old version, will be migrated to v{current})',
  'schema.versionCurrent': 'schema v{version} (current version)',
  'schema.versionBelowMinimum': 'schema v{version} (below the minimum supported {minimum}; unsupported)',
  'schema.sectionDataVersionMismatch': 'Section {section} version must be {expected} (got {actual})',

  'schema.sectionNotRegistered': 'Unregistered section "{section}": refusing to treat it as another section; new sections must be registered in src/schema/section-registry.ts',
};

registerMessageCatalog({ id: 'schema', zh, en });

/** 本域翻译器：key 受目录约束（拼错键 = 编译错误），语言按 engineMsg 的活语言解析。 */
export function schemaMsg(key: keyof typeof zh, params?: MsgParams): string {
  return engineMsg(key, params);
}
