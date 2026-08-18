/**
 * 配置市场区块（config-manager-market）表面文案：zh 为源语言，en 镜像每个键。
 * 独立命名空间、独立文件：与 config-manager / config-manager-sync 平行，不触碰共享字典。
 *
 * 双层文案分工（与 SyncSettingsView 同款）：
 *  - 本命名空间（TranslateNS<'config-manager-market'>）= React 壳文案（标题 / 表单 / 按钮 / 列表控件）；
 *  - 纯渲染模型文案（market-view.ts 产出，如供应链警示、状态行、条目徽章文本）走共享
 *    `src/ui/i18n.ts` 的 `market.*` 键（UiT），由 MarketApi.t 提供 —— 与 sync-view.ts 用 `sync.*` 同构。
 *
 * 键集合经 `MarketKey` 类型在 client/index.ts 注册处做编译期校验。
 */

export const zh = {
  // 入口
  'section.label': '配置市场',
  'section.description': '浏览并下载社区共享的配置（公开 Git 仓库；下载内容一律视为不可信，导入前必经校验与确认）',
  // 市场仓库表单
  'config.title': '市场仓库',
  'config.builtinHint': '内置官方市场，只读、不可编辑（由创建者维护的公开 Git 仓库）。',
  'config.official': '内置官方市场',
  'config.custom': '自定义市场地址',
  'config.repoUrlHint': '内置公开 Git 仓库地址。市场只读拉取（绝不推送）。',
  'config.refresh': '拉取最新',
  'config.refreshing': '拉取中…',
  'config.addedAt': '更新于：{time}',
  'config.itemCount': '{count} 个条目',
  // 列表
  'list.empty': '内置市场尚未加载。请先「拉取最新」。',
  'list.browse': '浏览',
  'list.loading': '正在读取市场…',
  'list.noItems': '该市场暂无条目。',
  'list.searchPlaceholder': '搜索名称 / 作者 / 描述…',
  'list.categoriesAll': '全部类别',
  'list.count': '共 {count} 个条目',
  'list.filtered': '（筛选后 {count} 个）',
  'list.cacheCached': '已缓存',
  'list.cacheFresh': '刚刚拉取',
  'list.cacheNone': '未缓存',
  'list.download': '查看详情',
  // 条目详情（dry-run 预览壳）
  'detail.title': '条目详情',
  'detail.downloadedAt': '下载时间：{time}',
  'detail.version': '版本 {version}',
  'detail.errors': '校验错误：',
  'detail.emptySections': '该条目未包含任何可导入分区',
  'detail.needReview': '需要人工确认',
  'detail.previewHint': '以下为只读 dry-run 预览（零写入）。确认导入将复用现有安全管道（快照 + 校验 + 失败回滚）。',
  'detail.import': '确认导入',
  'detail.back': '返回列表',
  // 逐分区批准（安全不变式 (c)：高风险分区默认不导入、须逐项显式批准）
  'detail.approval.title': '逐分区批准导入',
  'detail.approval.highRiskHint': '以下分区涉及安装插件 / 写入文件 / 注入全局指令 / 注册 MCP / 恢复会话，属高风险变更，默认不导入；如需导入请逐项勾选。',
  'detail.approval.requiresApproval': '需逐项批准',
  'detail.approval.safe': '可导入',
  'detail.approval.count': '已批准 {selected}/{total} 分区',
  'detail.noApproval': '未批准任何分区，无法导入',
  // 公共
  'common.cancel': '取消',
  'common.close': '关闭',
  'common.retry': '重试',
  'common.loading': '加载中…',
  'common.unknownError': '未知错误',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'section.label': 'Config Marketplace',
  'section.description': 'Browse and download community-shared configs (public Git repos; downloaded content is always untrusted — validated and confirmed before import)',
  'config.title': 'Market Repository',
  'config.builtinHint': 'Built-in official market — read-only and not editable (a public Git repo maintained by the creator).',
  'config.official': 'Built-in official market',
  'config.custom': 'Custom market URL',
  'config.repoUrlHint': 'Built-in public Git repository URL. Markets are read-only (never pushed).',
  'config.refresh': 'Refresh',
  'config.refreshing': 'Refreshing…',
  'config.addedAt': 'Updated: {time}',
  'config.itemCount': '{count} item(s)',
  'list.empty': 'The built-in market has not loaded yet. Click "Refresh" first.',
  'list.browse': 'Browse',
  'list.loading': 'Reading market…',
  'list.noItems': 'This market has no items.',
  'list.searchPlaceholder': 'Search name / author / description…',
  'list.categoriesAll': 'All categories',
  'list.count': '{count} item(s)',
  'list.filtered': '({count} after filter)',
  'list.cacheCached': 'cached',
  'list.cacheFresh': 'just fetched',
  'list.cacheNone': 'not cached',
  'list.download': 'View details',
  'detail.title': 'Item Details',
  'detail.downloadedAt': 'Downloaded: {time}',
  'detail.version': 'version {version}',
  'detail.errors': 'Verification errors:',
  'detail.emptySections': 'This item contains no importable sections',
  'detail.needReview': 'Needs human confirmation',
  'detail.previewHint': 'Read-only dry-run preview below (zero writes). Confirming the import reuses the existing safe pipeline (snapshot + validation + rollback on failure).',
  'detail.import': 'Confirm import',
  'detail.back': 'Back to list',
  'detail.approval.title': 'Approve sections to import',
  'detail.approval.highRiskHint': 'These sections install plugins / write files / inject global instructions / register MCP / restore sessions — high-risk changes, not imported by default. Check each one to import it.',
  'detail.approval.requiresApproval': 'Requires approval',
  'detail.approval.safe': 'Importable',
  'detail.approval.count': '{selected}/{total} section(s) approved',
  'detail.noApproval': 'No sections approved — cannot import',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.retry': 'Retry',
  'common.loading': 'Loading…',
  'common.unknownError': 'Unknown error',
};

/** 字典键联合（注册处 compile-time 校验） */
export type MarketKey = keyof typeof zh;
