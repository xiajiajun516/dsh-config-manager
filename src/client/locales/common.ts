/**
 * Config Manager 字典分域 · 入口与公共（分区显示名、关于片段、公共标点、Toast）。
 *
 * tech-debt #22（2026-11 拆分）：本文件只承载该域键值；聚合与键顺序由 ../locales.ts 编排。
 * 约束：zh 文案逐字保留、en 一键一镜像（`Record<keyof typeof zh, string>` 编译期校验），
 * 键集合由 src/core/engine-locale.test.ts 的既有键冻结指纹兜底。本文件零依赖、零 import。
 */
export const zh = {
  // 入口
  'section.label': '备份与迁移',
  'section.description': '导出 / 导入 / 迁移 DSH 配置（备份不含密钥，加密备份可选）',
  // 分区显示名（SectionId → 文案；唯一映射见 common/section-labels.ts。UI-08）
  'section.settings': '设置',
  'section.ui': 'UI 偏好',
  'section.providers': 'Provider 与模型',
  'section.plugins': '插件清单',
  'section.mcp': 'MCP 服务器',
  'section.prompts': '提示词',
  'section.skills': '技能',
  'section.agentPresets': 'Agent 预设',
  'section.agentInstructions': '全局指令',
  'section.workspaces': '工作区',
  'section.pluginFiles': '插件散落配置',
  'section.credentialsStatus': '凭据状态',
  'section.secrets': '密钥',
  'section.sessions': '历史会话',
  'section.self': '配置管理器设置',
  'section.pluginData': '插件数据目录',
  'section.pluginAssets': '插件大文件',
  // 视图切换
  'view.about': '关于',
  // 关于页「一键复制环境信息」片段（提 issue 用）：zh 保留双语标题（维护者可读），en 纯英文
  'about.snippet.environment': '### 环境 / Environment',
  // 更新内容拉取失败（GitHub API）：错误对象里也必须是当前语言
  'about.releaseNotes.rateLimited': 'GitHub API 速率限制（Rate limit exceeded），请稍后再试或直接在 GitHub 上查看。',
  'about.releaseNotes.fetchFailed': 'GitHub API 请求失败 ({status} {statusText})',
  'about.snippet.plugin': '- 插件版本 / Plugin: {version}',
  'about.snippet.dsh': '- DSH 版本 / DSH: {version}',
  'about.snippet.platform': '- 平台 / Platform: {platform}',
  'about.snippet.pluginDir': '- 插件清单目录 / Plugin dir: {dir}',
  // 公共
  'common.close': '关闭',
  'common.cancel': '取消',
  // 标点也属界面文案：英文界面不得出现全角冒号（label：value 形态的分隔符走这个词条）
  'common.labelSeparator': '：',
  'common.back': '上一步',
  'common.next': '下一步',
  'common.retry': '重试',
  // 落盘失败（sessionStorage 配额满/不可用）：状态还在内存里，但刷新即丢 —— 必须说清
  'common.saveFailed': '浏览器存储写入失败：当前进度仍在本页内存中，刷新会丢失',
  'common.loading': '加载中…',
  'common.unknownError': '未知错误',
  // client-F6：拼接类标点走字典（英文界面不得出现全角括号 / 顿号）
  'common.parens': '（{text}）',
  // client-F5：关于页 CLI 命令说明（此前硬编码中文）
  'about.cli.help': '列出全部 CLI 命令与用法（离线可用）',
  'about.cli.snapshots': '列出本机回滚快照（无需 DSH 运行）',
  'about.cli.restore': '恢复到导入前状态（离线）',
  'about.cli.reinstall': '一键重装 DSH（救援）',
  'common.listSeparator': '、',
  // 全局通知（右下角 Toast）的通用文案
  'toast.copied': '已复制到剪贴板',
  'toast.copyFailed': '复制失败，请手动选择文本复制',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'section.label': 'Backup & Migration',
  'section.description': 'Export / import / migrate DSH configuration (backups exclude secrets; encrypted backups optional)',
  // Section display names (SectionId → text; the single mapping lives in common/section-labels.ts, UI-08)
  'section.settings': 'Settings',
  'section.ui': 'UI Preferences',
  'section.providers': 'Providers & Models',
  'section.plugins': 'Plugin list',
  'section.mcp': 'MCP Servers',
  'section.prompts': 'Prompts',
  'section.skills': 'Skills',
  'section.agentPresets': 'Agent Presets',
  'section.agentInstructions': 'Agent Instructions',
  'section.workspaces': 'Workspaces',
  'section.pluginFiles': 'Plugin config files',
  'section.credentialsStatus': 'Credentials Status',
  'section.secrets': 'Secrets',
  'section.sessions': 'Sessions',
  'section.self': 'Config Manager settings',
  'section.pluginData': 'Plugin data dirs',
  'section.pluginAssets': 'Plugin large files',
  'view.about': 'About',
  'about.snippet.environment': '### Environment',
  'about.releaseNotes.rateLimited': 'GitHub API rate limit exceeded — please try again later, or view the release notes directly on GitHub.',
  'about.releaseNotes.fetchFailed': 'GitHub API request failed ({status} {statusText})',
  'about.snippet.plugin': '- Plugin version: {version}',
  'about.snippet.dsh': '- DSH version: {version}',
  'about.snippet.platform': '- Platform: {platform}',
  'about.snippet.pluginDir': '- Plugin directory: {dir}',
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.labelSeparator': ': ',
  'common.back': 'Back',
  'common.next': 'Next',
  'common.retry': 'Retry',
  // Persist failure (sessionStorage quota / unavailable): state is in memory but a refresh loses it
  'common.saveFailed': 'Could not write browser storage: the current progress stays in this page only and is lost on refresh',
  'common.loading': 'Loading…',
  'common.unknownError': 'Unknown error',
  'common.parens': '({text})',
  'about.cli.help': 'List every CLI command and its usage (works offline)',
  'about.cli.snapshots': 'List local rollback snapshots (no running DSH needed)',
  'about.cli.restore': 'Restore to the pre-import state (offline)',
  'about.cli.reinstall': 'One-shot DSH reinstall (rescue)',
  'common.listSeparator': ', ',
  'toast.copied': 'Copied to clipboard',
  'toast.copyFailed': 'Copy failed — select the text and copy manually',
};
