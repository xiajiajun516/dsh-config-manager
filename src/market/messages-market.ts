/**
 * src/market/** 的领域消息目录（zh 源语言 / en 镜像）——「英文界面零中文」迁移（t5）。
 *
 * 口径（与 src/core/messages.ts 一致，见 docs/design/2026-10-08-i18n-en-hardcoding.md）：
 *  - zh 值 = 迁移前的既有中文文案**逐字不变**（既有测试断言依赖它，只允许新增 en）；
 *  - en 值类型为 Record<keyof typeof zh, string> —— 缺键/多键即编译错误；
 *  - 动态明细一律走 {param} 插值传参，不得丢信息；
 *  - 本目录经 registerMessageCatalog 注册（模块加载即注册），查找顺序在既有基础目录之后；
 *  - zh 对象字面量必须叫 \`zh\`（守卫 E3 目录 zh 区豁免；改名会让本文件自身变成数百条命中）。
 *
 * 使用者：\`marketMsg\`（本域唯一出口）——它 import 了 engineMsg，因此 import 本函数即完成注册，
 * 不会出现「用了键但目录没注册」的裸键名输出。
 *
 * 注意：本模块被市场层（src/market/**）import，而市场层只在宿主/CLI 半加载；
 * 浏览器半对 src/market/types.ts、my-repo.ts 只有 \`import type\`（编译期擦除），故不进 client bundle。
 */
import { engineMsg, registerMessageCatalog } from '../core/engine-locale.ts';
import type { MsgParams } from '../core/msg-types.ts';

export const zh = {
  // ---------- market/types.ts：itemId 校验 ----------
  'market.types.itemIdInvalid': '非法市场条目 id: {id}（仅允许字母数字开头，字符限 . _ -）',

  // ---------- market/url.ts：仓库地址 scheme ----------
  'market.url.schemeUnsupported': '市场仓库地址仅支持 http(s)（拒绝 git@/ssh 等形态）',

  // ---------- market/git-file-writer.ts：git 写入器 ----------
  'market.gitWriter.repoUrlEmpty': '仓库地址不能为空',
  'market.gitWriter.repoUrlInvalid': '仓库地址非法: {reason}',
  'market.gitWriter.repoUrlScheme': '仅支持 http(s) 仓库地址（token 经 credential helper 注入，不拼入 URL）',
  'market.gitWriter.credentialsRequired': 'credentials provider 必填',
  'market.gitWriter.workDirEmpty': 'workDir 不能为空',
  'market.gitWriter.entriesEmpty': 'entries 不能为空',
  'market.gitWriter.checkoutFailed': '切换分支失败（{stderr}）',
  'market.gitWriter.addFailed': 'git add 失败（{stderr}）',
  'market.gitWriter.commitFailed': 'git commit 失败（{stderr}）',
  'market.gitWriter.pushFailed': 'git push 失败（{stderr}）',
  'market.gitWriter.commandFailed': 'git {args} 失败: {stderr}',
  'market.gitWriter.workDirNotEmpty': '工作副本目录非空且不是 git 仓库: {workDir}',
  'market.gitWriter.cloneFailed': '克隆仓库失败（{stderr}）',
  'market.gitWriter.identityFailed': '配置提交身份失败（{stderr}）',
  'market.gitWriter.pullFailed': '拉取远端失败（{stderr}）',
  'market.gitWriter.upstreamAddFailed': '添加 upstream 远端失败（{stderr}）',
  'market.gitWriter.upstreamFetchFailed': '拉取官方仓库失败（{stderr}）',
  'market.gitWriter.defaultBranchUnknown': '无法确定远端默认分支（origin/main 或 origin/master）',

  // ---------- market/github-repos.ts：GitHub REST 封装 ----------
  'market.github.invalidResponseShape': 'GitHub API 返回了无法识别的数据结构',
  'market.github.missingField': 'GitHub API 响应缺少必要字段 {key}',
  'market.github.reposNotArray': 'GitHub repos 响应不是数组',
  'market.github.notAFile': 'GitHub contents 路径不是文件（目录 / 子模块不可作为文本读取）',
  'market.github.missingFileContent': 'GitHub contents 响应缺少文件内容',
  'market.github.unsupportedEncoding': '不支持的 contents 编码：{encoding}',
  'market.github.pullsNotArray': 'GitHub pulls 响应不是数组',
  'market.github.forkNameConflict': '你的同名仓库已存在但不是本市场的 fork，无法自动收录，请改名或删除后重试',
  'market.github.forkTimeout': 'fork 创建超时（GitHub 异步创建，请稍后重试）',
  'market.github.noToken': 'GitHub token 未配置（请先登录）',
  'market.github.requestFailed': 'GitHub API 请求失败：{reason}',
  'market.github.invalidStars': 'GitHub API 响应缺少有效的 stargazers_count',
  'market.github.apiError': 'GitHub API 错误（HTTP {status}）',
  'market.github.apiErrorWithMessage': 'GitHub API 错误（HTTP {status}）：{message}',
  'market.github.unparsableResponse': 'GitHub API 返回了无法解析的响应，请稍后重试',

  // ---------- market/index-parser.ts：index.json（L1）字段 ----------
  'market.index.fieldMustBeString': '{path} 必须是字符串',
  'market.index.fieldMustBeStringArray': '{path} 必须是字符串数组',
  'market.index.mustBeObject': '{path} 必须是对象',
  'market.index.unknownFields': '{path} 含未知字段: {fields}',
  'market.index.idInvalid': '{path}.id 非法: {id}（仅允许字母数字开头，字符限 . _ -）',
  'market.index.nameEmpty': '{path}.name 必须是非空字符串',
  'market.index.contentEmpty': 'index.json 内容为空',
  'market.index.parseFailed': 'index.json 解析失败: {reason}',
  'market.index.rootNotObject': 'index.json 必须是对象',
  'market.index.rootUnknownFields': 'index.json 含未知字段: {fields}',
  'market.index.schemaVersion': 'index.json schemaVersion 必须是 {expected}（收到 {actual}）',
  'market.index.itemsMissing': 'index.json 缺少 items 数组',

  // ---------- market/index-parser.ts：items/<id>/manifest.json（L2）字段 ----------
  'market.manifest.contentEmpty': 'manifest.json 内容为空',
  'market.manifest.parseFailed': 'manifest.json 解析失败: {reason}',
  'market.manifest.rootNotObject': 'manifest.json 必须是对象',
  'market.manifest.unknownFields': 'manifest.json 含未知字段: {fields}',
  'market.manifest.schemaVersion': 'manifest.json schemaVersion 必须是 {expected}（收到 {actual}）',
  'market.manifest.idInvalid': 'manifest.json.id 非法: {id}',
  'market.manifest.nameEmpty': 'manifest.json.name 必须是非空字符串',
  'market.manifest.versionEmpty': 'manifest.json.version 必须是非空字符串',
  'market.manifest.sectionsNotArray': 'manifest.json.sections 必须是字符串数组',
  'market.manifest.unknownSection': 'manifest.json.sections 含未知分区: {section}',
  'market.manifest.modeInvalid': 'manifest.json.mode 非法: {mode}（仅接受 migrate | share）',
  'market.manifest.checksumsNotObject': 'manifest.json.checksums 必须是对象',
  'market.manifest.checksumsUnknownFields': 'manifest.json.checksums 含未知字段: {fields}',
  'market.manifest.checksumsZipEmpty': 'manifest.json.checksums.zip 必须是非空字符串',
  'market.manifest.provenanceNotObject': 'manifest.json.provenance 必须是对象',
  'market.manifest.provenanceUnknownFields': 'manifest.json.provenance 含未知字段: {fields}',
  'market.manifest.provenanceSourceNotString': 'manifest.json.provenance.source 必须是字符串',
  'market.manifest.provenanceNoteNotString': 'manifest.json.provenance.note 必须是字符串',

  // ---------- market/prepare.ts：发布包生成 ----------
  'market.prepare.nameRequired': 'name 必填',
  'market.prepare.repoUrlInvalid': 'repoUrl 非法: {reason}',
  'market.prepare.zipTooLarge': 'config.zip 体积 {size} 超过上限 {max} 字节',
  'market.prepare.zipParseFailed': 'config.zip 安全解析失败: {reason}',
  'market.prepare.zipMissingManifest': 'config.zip 缺少内部 manifest.json（须为导出/备份格式）',
  'market.prepare.zipManifestInvalid': 'config.zip 内部 manifest 无效: {reason}',
  'market.prepare.zipContainsSecrets': 'zip 声明 containsSecrets=true，市场通道永不携带秘密，拒绝发布',
  'market.prepare.zipNoSections': 'zip 无启用分区，无可发布内容',
  'market.prepare.bannedSections': 'zip 包含禁止分区 {sections}（sessions=历史会话 / pluginFiles=任意文件 / self=本地环境），市场条目禁止携带',
  'market.prepare.shareNonPortableSections': '分享模式禁止携带设备/平台相关分区 {sections}（含凭据状态 / 会话 / MCP / 工作区等），请仅导出通用可移植分区',
  'market.prepare.localTarballsRejected': 'zip 的 plugins 分区携带 {count} 个本地插件 tarball（localTarballs），禁止发布到市场（内嵌插件代码不可经公开仓库审阅；本地插件迁移请用自己的备份）',
  'market.prepare.patchFilesRejected': 'zip 的 plugins 分区携带 {count} 个 pnpm patch 文件（patchFiles），禁止发布到市场（会在安装时改写依赖代码；请用自己的备份迁移）',
  'market.prepare.sensitiveContent': '检测到疑似敏感内容（{hits}），市场条目禁止携带凭据，请脱敏后重试',
  // 命中清单的连接符也是本地化呈现的一部分（英文用半角分号 + 空格）
  'market.prepare.scanHitSeparator': '；',
  'market.prepare.warningPublicMarket': '条目将发布至公共网络市场，未经官方审核（供应链警示）',
  'market.prepare.warningUntrustedInput': '发布内容为不可信输入，下载方导入前会逐项核对',

  // ---------- market/security.ts：下载侧安全校验 ----------
  'market.security.manifestIdMismatch': '清单 id 与请求条目不一致: {manifestId} ≠ {itemId}',
  'market.security.zipTooLarge': 'config.zip 体积 {size} 超过上限 {max} 字节',
  'market.security.zipShaMismatch': '清单声明的 config.zip SHA-256 与实际不符',
  'market.security.zipParseFailed': 'config.zip 安全解析失败: {reason}',
  'market.security.zipMissingManifest': 'config.zip 缺少内部 manifest.json',
  'market.security.zipManifestInvalid': 'config.zip 内部 manifest 无效: {reason}',
  'market.security.zipContainsSecrets': 'config.zip 声明 containsSecrets=true，市场通道永不携带秘密，拒绝',
  'market.security.checksumMismatch': 'config.zip 内部完整性校验失败: {entries}',
  'market.security.checksumsParseFailed': 'config.zip 内部 checksums 解析失败: {reason}',
  'market.security.bannedSection': 'config.zip 包含禁止分区 {section}（sessions=历史会话 / pluginFiles=任意文件 / self=本地环境），市场条目禁止携带',
  'market.security.emptyFileSection': 'config.zip 中分区 {section} 为空（无文件），导入后不产生任何效果',
  'market.security.missingSectionFile': 'config.zip 缺少分区文件 {path}（{section}）',
  'market.security.sectionParseFailed': '分区 {section} 数据解析失败: {reason}',
  'market.security.sectionInvalid': '分区 {section} 数据无效: {errors}',
  'market.security.localTarballsRejected': 'config.zip 的 plugins 分区携带 {count} 个本地插件 tarball（localTarballs），市场条目禁止携带内嵌插件代码（供应链防线；本地插件迁移请用自己的备份，不要经公共市场分发）',
  'market.security.patchFilesRejected': 'config.zip 的 plugins 分区携带 {count} 个 pnpm patch 文件（patchFiles），市场条目禁止携带会在安装时改写依赖代码的内容（供应链防线；请用自己的备份迁移）',
  'market.security.sectionsNoIntersection': '清单 sections 与 config.zip 内部 sections 无交集',
  'market.security.warningFromPublicMarket': '条目 {itemId} 来自公共网络市场，未经官方审核（供应链警示）',
  'market.security.warningUntrustedContent': '下载内容为不可信输入，导入前请逐项核对',

  // ---------- market/my-repo.ts：我的配置仓库（一键上传/更新/删除/收录） ----------
  'market.myRepo.indexName': '我的配置仓库',
  'market.myRepo.repoDescription': '我的配置仓库（dsh-config-manager 自动发布）',
  'market.myRepo.prepareRequired': 'prepare 必填',
  'market.myRepo.restRequired': 'rest 必填',
  'market.myRepo.userIndexUnparsable': '用户仓库 index.json 无法解析（可能被外部修改）',
  'market.myRepo.itemNotFound': '未找到条目 {itemId}（可能已被删除），请刷新列表后重试',
  'market.myRepo.listingTimeout': '等待市场任务超时（{itemId}）',
  'market.myRepo.itemToDeleteNotFound': '未找到要删除的条目 {itemId}（可能已被删除），请刷新列表后重试',
  'market.myRepo.delistPrSubmitted': '该条目已收录官方市场，已自动提交下架 PR；合并前官方市场可能仍显示该条目',
  'market.myRepo.pendingPrClosed': '已关闭该条目的待审核收录 PR',
  'market.myRepo.itemToUpdateNotFound': '未找到要更新的条目 {itemId}（可能已被移除），请刷新列表后重试',
  'market.myRepo.nameChangedNewItem': '未找到同名已上传条目，名称变化将作为新条目发布',
  'market.myRepo.userIndexUnparsableAborted': '用户仓库 index.json 无法解析（可能被外部修改），已中止，请检查后重试',
  'market.myRepo.officialIndexMissing': '官方市场 index.json 不存在',
  'market.myRepo.officialIndexUnparsable': '官方市场 index.json 无法解析',
  'market.myRepo.preparedManifestInvalid': 'prepare 生成的 manifest 无效',
  'market.myRepo.itemGoneFromUserRepo': '条目 {itemId} 已不在用户仓库（可能已删除），任务终止',
  'market.myRepo.delistPrTitle': '市场下架：{itemId}',
  'market.myRepo.delistPrIntro': '由 dsh-config-manager「删除条目」自动提交。',
  'market.myRepo.delistPrItemLine': '- 条目：{itemId}',
  'market.myRepo.delistPrAction': '- 操作：从官方市场 index.json 移除该条目（下架）',
  'market.myRepo.delistPrContent': '- 内容：原条目内容位于用户公开仓库，已随删除移除',
  'market.myRepo.listPrTitle': '市场收录：{itemId} v{version}',
  'market.myRepo.listPrIntro': '由 dsh-config-manager「一键上传」自动提交。',
  'market.myRepo.listPrItemLine': '- 条目：{itemId} v{version}',
  'market.myRepo.listPrHosting': '- 内容托管：用户公开仓库（见 index.json 条目 repo 字段）',
  'market.myRepo.listPrValidation': '- 校验：dsh-config-market CI（validate.yml）将自动执行 8 道校验与秘密扫描',
};

export const en: Record<keyof typeof zh, string> = {
  // ---------- market/types.ts ----------
  'market.types.itemIdInvalid': 'Invalid market item id: {id} (must start with a letter or digit; allowed characters are . _ -)',

  // ---------- market/url.ts ----------
  'market.url.schemeUnsupported': 'Market repository URLs support http(s) only (git@/ssh forms are rejected)',

  // ---------- market/git-file-writer.ts ----------
  'market.gitWriter.repoUrlEmpty': 'Repository URL must not be empty',
  'market.gitWriter.repoUrlInvalid': 'Invalid repository URL: {reason}',
  'market.gitWriter.repoUrlScheme': 'Only http(s) repository URLs are supported (the token is injected through the credential helper, never embedded in the URL)',
  'market.gitWriter.credentialsRequired': 'credentials provider is required',
  'market.gitWriter.workDirEmpty': 'workDir must not be empty',
  'market.gitWriter.entriesEmpty': 'entries must not be empty',
  'market.gitWriter.checkoutFailed': 'Failed to switch branch ({stderr})',
  'market.gitWriter.addFailed': 'git add failed ({stderr})',
  'market.gitWriter.commitFailed': 'git commit failed ({stderr})',
  'market.gitWriter.pushFailed': 'git push failed ({stderr})',
  'market.gitWriter.commandFailed': 'git {args} failed: {stderr}',
  'market.gitWriter.workDirNotEmpty': 'The working copy directory is not empty and is not a git repository: {workDir}',
  'market.gitWriter.cloneFailed': 'Failed to clone the repository ({stderr})',
  'market.gitWriter.identityFailed': 'Failed to configure the commit identity ({stderr})',
  'market.gitWriter.pullFailed': 'Failed to pull from the remote ({stderr})',
  'market.gitWriter.upstreamAddFailed': 'Failed to add the upstream remote ({stderr})',
  'market.gitWriter.upstreamFetchFailed': 'Failed to fetch the official repository ({stderr})',
  'market.gitWriter.defaultBranchUnknown': 'Cannot determine the remote default branch (origin/main or origin/master)',

  // ---------- market/github-repos.ts ----------
  'market.github.invalidResponseShape': 'The GitHub API returned an unrecognized data structure',
  'market.github.missingField': 'GitHub API response is missing the required field {key}',
  'market.github.reposNotArray': 'GitHub repos response is not an array',
  'market.github.notAFile': 'GitHub contents path is not a file (directories / submodules cannot be read as text)',
  'market.github.missingFileContent': 'GitHub contents response is missing the file content',
  'market.github.unsupportedEncoding': 'Unsupported contents encoding: {encoding}',
  'market.github.pullsNotArray': 'GitHub pulls response is not an array',
  'market.github.forkNameConflict': 'A repository with the same name already exists but is not a fork of this market, so it cannot be listed automatically; rename or delete it and retry',
  'market.github.forkTimeout': 'Fork creation timed out (GitHub creates it asynchronously, please retry later)',
  'market.github.noToken': 'GitHub token is not configured (please sign in first)',
  'market.github.requestFailed': 'GitHub API request failed: {reason}',
  'market.github.invalidStars': 'GitHub API response is missing a valid stargazers_count',
  'market.github.apiError': 'GitHub API error (HTTP {status})',
  'market.github.apiErrorWithMessage': 'GitHub API error (HTTP {status}): {message}',
  'market.github.unparsableResponse': 'The GitHub API returned a response that could not be parsed, please retry later',

  // ---------- market/index-parser.ts (L1) ----------
  'market.index.fieldMustBeString': '{path} must be a string',
  'market.index.fieldMustBeStringArray': '{path} must be an array of strings',
  'market.index.mustBeObject': '{path} must be an object',
  'market.index.unknownFields': '{path} contains unknown fields: {fields}',
  'market.index.idInvalid': '{path}.id is invalid: {id} (must start with a letter or digit; allowed characters are . _ -)',
  'market.index.nameEmpty': '{path}.name must be a non-empty string',
  'market.index.contentEmpty': 'index.json content is empty',
  'market.index.parseFailed': 'index.json parsing failed: {reason}',
  'market.index.rootNotObject': 'index.json must be an object',
  'market.index.rootUnknownFields': 'index.json contains unknown fields: {fields}',
  'market.index.schemaVersion': 'index.json schemaVersion must be {expected} (received {actual})',
  'market.index.itemsMissing': 'index.json is missing the items array',

  // ---------- market/index-parser.ts (L2) ----------
  'market.manifest.contentEmpty': 'manifest.json content is empty',
  'market.manifest.parseFailed': 'manifest.json parsing failed: {reason}',
  'market.manifest.rootNotObject': 'manifest.json must be an object',
  'market.manifest.unknownFields': 'manifest.json contains unknown fields: {fields}',
  'market.manifest.schemaVersion': 'manifest.json schemaVersion must be {expected} (received {actual})',
  'market.manifest.idInvalid': 'manifest.json.id is invalid: {id}',
  'market.manifest.nameEmpty': 'manifest.json.name must be a non-empty string',
  'market.manifest.versionEmpty': 'manifest.json.version must be a non-empty string',
  'market.manifest.sectionsNotArray': 'manifest.json.sections must be an array of strings',
  'market.manifest.unknownSection': 'manifest.json.sections contains an unknown section: {section}',
  'market.manifest.modeInvalid': 'manifest.json.mode is invalid: {mode} (only migrate | share are accepted)',
  'market.manifest.checksumsNotObject': 'manifest.json.checksums must be an object',
  'market.manifest.checksumsUnknownFields': 'manifest.json.checksums contains unknown fields: {fields}',
  'market.manifest.checksumsZipEmpty': 'manifest.json.checksums.zip must be a non-empty string',
  'market.manifest.provenanceNotObject': 'manifest.json.provenance must be an object',
  'market.manifest.provenanceUnknownFields': 'manifest.json.provenance contains unknown fields: {fields}',
  'market.manifest.provenanceSourceNotString': 'manifest.json.provenance.source must be a string',
  'market.manifest.provenanceNoteNotString': 'manifest.json.provenance.note must be a string',

  // ---------- market/prepare.ts ----------
  'market.prepare.nameRequired': 'name is required',
  'market.prepare.repoUrlInvalid': 'Invalid repoUrl: {reason}',
  'market.prepare.zipTooLarge': 'config.zip size {size} exceeds the limit of {max} bytes',
  'market.prepare.zipParseFailed': 'config.zip failed hardened parsing: {reason}',
  'market.prepare.zipMissingManifest': 'config.zip is missing the internal manifest.json (it must be in export/backup format)',
  'market.prepare.zipManifestInvalid': 'config.zip internal manifest is invalid: {reason}',
  'market.prepare.zipContainsSecrets': 'The zip declares containsSecrets=true; the market channel never carries secrets — refusing to publish',
  'market.prepare.zipNoSections': 'The zip has no enabled sections, so there is nothing to publish',
  'market.prepare.bannedSections': 'The zip contains banned sections {sections} (sessions=conversation history / pluginFiles=arbitrary files / self=local environment); market items must not carry them',
  'market.prepare.shareNonPortableSections': 'Share mode forbids device/platform-specific sections {sections} (credential status / sessions / MCP / workspaces and the like); export portable sections only',
  'market.prepare.localTarballsRejected': 'The plugins section of the zip carries {count} local plugin tarball(s) (localTarballs), which must not be published to the market (embedded plugin code cannot be reviewed through a public repository; migrate local plugins with your own backup)',
  'market.prepare.patchFilesRejected': 'The plugins section of the zip carries {count} pnpm patch file(s) (patchFiles), which must not be published to the market (they rewrite dependency code at install time; migrate with your own backup)',
  'market.prepare.sensitiveContent': 'Suspected sensitive content detected ({hits}); market items must not carry credentials — redact and retry',
  'market.prepare.scanHitSeparator': '; ',
  'market.prepare.warningPublicMarket': 'The item will be published to a public network market without official review (supply-chain warning)',
  'market.prepare.warningUntrustedInput': 'Published content is untrusted input; downloaders verify every item before importing',

  // ---------- market/security.ts ----------
  'market.security.manifestIdMismatch': 'Manifest id does not match the requested item: {manifestId} ≠ {itemId}',
  'market.security.zipTooLarge': 'config.zip size {size} exceeds the limit of {max} bytes',
  'market.security.zipShaMismatch': 'The config.zip SHA-256 declared in the manifest does not match the actual file',
  'market.security.zipParseFailed': 'config.zip failed hardened parsing: {reason}',
  'market.security.zipMissingManifest': 'config.zip is missing the internal manifest.json',
  'market.security.zipManifestInvalid': 'config.zip internal manifest is invalid: {reason}',
  'market.security.zipContainsSecrets': 'config.zip declares containsSecrets=true; the market channel never carries secrets — rejected',
  'market.security.checksumMismatch': 'config.zip internal integrity check failed: {entries}',
  'market.security.checksumsParseFailed': 'config.zip internal checksums parsing failed: {reason}',
  'market.security.bannedSection': 'config.zip contains a banned section {section} (sessions=conversation history / pluginFiles=arbitrary files / self=local environment); market items must not carry it',
  'market.security.emptyFileSection': 'Section {section} in config.zip is empty (no files); importing it produces no effect',
  'market.security.missingSectionFile': 'config.zip is missing the section file {path} ({section})',
  'market.security.sectionParseFailed': 'Section {section} data parsing failed: {reason}',
  'market.security.sectionInvalid': 'Section {section} data is invalid: {errors}',
  'market.security.localTarballsRejected': 'The plugins section of config.zip carries {count} local plugin tarball(s) (localTarballs); market items must not carry embedded plugin code (supply-chain defense; migrate local plugins with your own backup instead of distributing them through a public market)',
  'market.security.patchFilesRejected': 'The plugins section of config.zip carries {count} pnpm patch file(s) (patchFiles); market items must not carry content that rewrites dependency code at install time (supply-chain defense; migrate with your own backup)',
  'market.security.sectionsNoIntersection': 'The manifest sections and the sections inside config.zip have no intersection',
  'market.security.warningFromPublicMarket': 'Item {itemId} comes from a public network market without official review (supply-chain warning)',
  'market.security.warningUntrustedContent': 'Downloaded content is untrusted input; verify every item before importing',

  // ---------- market/my-repo.ts ----------
  'market.myRepo.indexName': 'My configs repository',
  'market.myRepo.repoDescription': 'My configs repository (published automatically by dsh-config-manager)',
  'market.myRepo.prepareRequired': 'prepare is required',
  'market.myRepo.restRequired': 'rest is required',
  'market.myRepo.userIndexUnparsable': 'The user repository index.json could not be parsed (it may have been modified externally)',
  'market.myRepo.itemNotFound': 'Item {itemId} was not found (it may have been deleted); refresh the list and retry',
  'market.myRepo.listingTimeout': 'Timed out waiting for the market task ({itemId})',
  'market.myRepo.itemToDeleteNotFound': 'The item to delete, {itemId}, was not found (it may have been deleted); refresh the list and retry',
  'market.myRepo.delistPrSubmitted': 'This item is listed in the official market, so a delist PR was submitted automatically; the official market may still show the item until the PR is merged',
  'market.myRepo.pendingPrClosed': 'The pending listing PR for this item was closed',
  'market.myRepo.itemToUpdateNotFound': 'The item to update, {itemId}, was not found (it may have been removed); refresh the list and retry',
  'market.myRepo.nameChangedNewItem': 'No uploaded item with the same name was found; the name change will be published as a new item',
  'market.myRepo.userIndexUnparsableAborted': 'The user repository index.json could not be parsed (it may have been modified externally); aborted — please check and retry',
  'market.myRepo.officialIndexMissing': 'The official market index.json does not exist',
  'market.myRepo.officialIndexUnparsable': 'The official market index.json could not be parsed',
  'market.myRepo.preparedManifestInvalid': 'The manifest generated by prepare is invalid',
  'market.myRepo.itemGoneFromUserRepo': 'Item {itemId} is no longer in the user repository (it may have been deleted); the task stopped',
  'market.myRepo.delistPrTitle': 'Market delist: {itemId}',
  'market.myRepo.delistPrIntro': 'Submitted automatically by dsh-config-manager "Delete item".',
  'market.myRepo.delistPrItemLine': '- Item: {itemId}',
  'market.myRepo.delistPrAction': '- Action: remove the item from the official market index.json (delist)',
  'market.myRepo.delistPrContent': '- Content: the original item content lives in the user public repository and was removed together with the deletion',
  'market.myRepo.listPrTitle': 'Market listing: {itemId} v{version}',
  'market.myRepo.listPrIntro': 'Submitted automatically by dsh-config-manager "One-click upload".',
  'market.myRepo.listPrItemLine': '- Item: {itemId} v{version}',
  'market.myRepo.listPrHosting': '- Content hosting: user public repository (see the repo field of the index.json entry)',
  'market.myRepo.listPrValidation': '- Validation: the dsh-config-market CI (validate.yml) runs 8 checks plus a secret scan automatically',
};

registerMessageCatalog({ id: 'market', zh, en });

/**
 * 本域唯一出口：取一条 src/market/** 的文案（键名受类型约束，拼错即编译错误）。
 *
 * 为什么不让调用方直接 import engineMsg：import 本函数即保证目录已注册（模块加载期注册一次），
 * 否则会出现「用了键但注册表里没有 → 输出裸键名」的静默失败。
 */
export function marketMsg(key: keyof typeof zh, params?: MsgParams): string {
  return engineMsg(key, params);
}
