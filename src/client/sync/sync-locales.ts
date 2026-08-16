/**
 * 远程同步设置区块（config-manager-sync）表面文案：zh 为源语言，en 镜像每个键。
 * 独立命名空间、独立文件：不触碰共享的 locales.ts（并行会话已改），零冲突。
 * 键集合经 `SyncKey` 类型在 client/index.ts 注册处做编译期校验。
 */

export const zh = {
  // 入口
  'section.label': '远程同步',
  'section.description': '通过 Git 私有仓库在设备间同步可移植配置（secret 永不参与同步）',
  // 私有仓库强制提示（常驻警示横幅）
  'privateRepoHint': '安全要求：同步仓库必须为私有仓库（public 仓库会公开你的配置内容）。认证 token 仅用于仓库访问，绝不写入同步文件、提交内容或日志。',
  // 仓库配置表单
  'config.title': '仓库配置',
  'config.repoUrl': '仓库地址',
  'config.repoUrlHint': 'Git 私有仓库地址（https / ssh / 本地路径）。认证 token 请使用下方凭据字段，不要拼入地址。',
  'config.token': '认证 token',
  'config.tokenHint': '将安全写入 DSH credentials（引用名 {ref}），不会写入同步文件或日志。留空表示沿用已保存的凭据。',
  'config.tokenSaved': '凭据已配置',
  'config.gitBin': 'git 可执行文件（可选）',
  'config.gitBinHint': '缺省使用 PATH 中的 git。',
  // 状态
  'status.title': '同步状态',
  'status.never': '从未同步',
  // 操作
  'action.push': '推送到远端',
  'action.pull': '拉取差异预览',
  'action.pushing': '正在推送…',
  'action.pulling': '正在拉取…',
  // 报告
  'push.title': '推送结果',
  'pull.title': '拉取差异预览',
  'pull.previewHint': '以上为只读差异预览，不会执行导入。v1 暂不提供一键导入接线；如需应用远端配置，请使用「导入恢复」向导手动导入导出的备份。',
  'pull.needsReview': '包含需要人工决策的项（冲突 / 密钥 / 依赖 / 安装）',
  'pull.empty': '远端快照与本地一致（无变更）',
  'change.total': '共 {total} 项变更',
  'sections.title': '同步分区',
  'warnings.title': '分区告警',
  // 公共
  'common.close': '关闭',
  'common.retry': '重试',
  'common.loading': '加载中…',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'section.label': 'Remote Sync',
  'section.description': 'Sync portable configuration across devices via a private Git repository (secrets never sync)',
  'privateRepoHint': 'Security requirement: the sync repository MUST be private (a public repo would expose your configuration). The auth token is only used for repository access and is never written into sync files, commit content, or logs.',
  'config.title': 'Repository',
  'config.repoUrl': 'Repository URL',
  'config.repoUrlHint': 'Private Git repository URL (https / ssh / local path). Use the credential field below for the auth token; never embed it in the URL.',
  'config.token': 'Auth token',
  'config.tokenHint': 'Securely written into DSH credentials (ref {ref}); never written into sync files or logs. Leave blank to reuse the saved credential.',
  'config.tokenSaved': 'Credential configured',
  'config.gitBin': 'git executable (optional)',
  'config.gitBinHint': 'Defaults to git on PATH.',
  'status.title': 'Sync Status',
  'status.never': 'Never synced',
  'action.push': 'Push to remote',
  'action.pull': 'Pull diff preview',
  'action.pushing': 'Pushing…',
  'action.pulling': 'Pulling…',
  'push.title': 'Push Result',
  'pull.title': 'Pull Diff Preview',
  'pull.previewHint': 'Read-only diff preview above; nothing is imported. v1 does not wire one-click import yet — use the Import wizard to apply a downloaded backup if needed.',
  'pull.needsReview': 'Contains items that need human decisions (conflicts / secrets / dependencies / installs)',
  'pull.empty': 'Remote snapshot matches local (no changes)',
  'change.total': '{total} change(s)',
  'sections.title': 'Synced Sections',
  'warnings.title': 'Section Warnings',
  'common.close': 'Close',
  'common.retry': 'Retry',
  'common.loading': 'Loading…',
};

/** 字典键联合（注册处 compile-time 校验） */
export type SyncKey = keyof typeof zh;
