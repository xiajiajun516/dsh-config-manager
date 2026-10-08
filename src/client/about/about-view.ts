/**
 * 「关于（About）」Tab 的客户端纯函数渲染模型（node 可测，无 React / 无 DOM）。
 *
 * 设计依据（docs/design/2026-08-19-about-tab-design.md §5）：
 *  - 公开元数据（插件名 / 仓库 / 作者）为**静态常量**，不随运行时变化，可读、可测、可维护；
 *  - 版本 / DSH / 平台等运行时信息由面板经 `api.status()` 获取，本层只负责格式化，
 *    版本号**绝不**在 client 重复维护（AGENTS.md §版本号三处同步教训）；
 *  - 链接恒等派生自仓库 URL（deriveAboutLinks），杜绝拼接错误；
 *  - AboutStatusInput 为内联最小输入接口（不依赖 api.ts 的 ServiceStatus），
 *    保持纯函数零依赖，node 可直接单测（对齐 market-view.ts 的输入类型处理）。
 *
 * 安全：无任何输入表单、无写操作；纯展示数据，不含敏感信息。
 *
 * 2026-09 追加：**插件版本更新检查**的展示模型（`aboutUpdateView` / `aboutUpgradeCommand`）——
 * 判定（是否真的有新版本、给不给终端命令）全在这里，面板只映射 kind → 文案与 Badge。
 */
import type { PluginUpdateCheckResult } from '../../ui/types.ts';
import type { ConfigManagerKey } from '../locales.ts';
import type { TranslateNS } from '../client-types.ts';

/** 插件的公开元数据（静态常量，来源见设计文档 §3 信息表） */
export interface AboutMeta {
  /** 插件名 */
  name: string;
  /** GitHub 官方仓库 URL */
  repoUrl: string;
  /** 作者（GitHub 用户名） */
  author: string;
  /** 作者 GitHub 主页 URL */
  authorUrl: string;
}

/** 由仓库 URL 派生的外链集合 */
export interface AboutLinks {
  /** 去 Star 入口（仓库页，新窗口打开） */
  starUrl: string;
  /** 仓库页 URL（已归一化，无尾斜杠） */
  repoUrl: string;
  /** 文档链接（仓库页 + '#readme'） */
  docsUrl: string;
  /** Issues 反馈链接（仓库页 + '/issues'） */
  issuesUrl: string;
  /** Releases 更新日志链接（仓库页 + '/releases'） */
  releasesUrl: string;
}

/**
 * 最小状态输入接口。
 *
 * 刻意内联而**不**从 ../api.ts 导入 ServiceStatus：本文件是纯函数渲染模型，
 * 不应依赖浏览器侧 api 类；仅取面板需要的 4 个字段（ready 与展示无关，不在此列）。
 */
export interface AboutStatusInput {
  pluginVersion: string;
  dshVersion: string;
  platform: string;
  arch: string;
  /** issue #28 诊断位（best-effort，可缺省） */
  homeDir?: string;
  profile?: string;
  profileManifestReadable?: boolean;
  installedPluginCount?: number;
  installedPluginNames?: string[];
  bundles?: string[];
}

/** 状态展示行（版本 / DSH / 平台），供 Badge 装配 */
export interface AboutStatusRows {
  /** 插件版本 */
  version: string;
  /** DSH 版本 */
  dsh: string;
  /** 平台 · 架构（合并 platform + arch，对齐 locale about.platform 模板） */
  platform: string;
  /** issue #28 诊断行（无诊断数据时为 null，面板据此隐藏该行） */
  diagnostics: AboutDiagnosticsRow | null;
}

/**
 * issue #28 诊断行：把「插件读的是哪个目录 / 哪个 profile / 看到几个插件」显式展示。
 * 用户据此即可自查「装了插件却没被识别」是不是 profile 或 DSH_HOME 不匹配。
 */
export interface AboutDiagnosticsRow {
  /** 插件清单来源目录（=<homeDir>/profiles/<profile>） */
  profileDir: string;
  /** 解析到的 profile 名 */
  profile: string;
  /** 读到的插件数量 */
  pluginCount: number;
  /** profile 的 package.json 不可读 → 清单必然为空（关键诊断信号） */
  manifestUnreadable: boolean;
}

/**
 * 由仓库 URL 派生各链接；恒等推导，杜绝拼接错误。
 *
 * - starUrl = repoUrl（去尾斜杠归一化后原样）；
 * - docsUrl = repoUrl + '#readme'；
 * - issuesUrl = repoUrl + '/issues/new/choose'（直达 GitHub 的「选模板」页：
 *   直接落到 issue 列表要多点一次、还要自己判断该用哪个模板，反馈摩擦就是这么来的）；
 * - releasesUrl = repoUrl + '/releases'；
 * - 输入尾斜杠（含多个）会被归一化去除，如 'https://…/repo/' → 'https://…/repo'。
 */
export function deriveAboutLinks(repoUrl: string): AboutLinks {
  const base = repoUrl.trim().replace(/\/+$/, '');
  return {
    starUrl: base,
    repoUrl: base,
    docsUrl: `${base}#readme`,
    issuesUrl: `${base}/issues/new/choose`,
    releasesUrl: `${base}/releases`,
  };
}

/**
 * 动态状态 → 展示行（版本 / DSH / 平台）。
 *
 * - version = pluginVersion（原样透传，避免 client 侧重复维护版本号）；
 * - dsh = dshVersion（原样透传）；
 * - platform = `${platform} · ${arch}`（合并平台与架构，供 Badge 单行展示）。
 */
export function aboutStatusRows(status: AboutStatusInput): AboutStatusRows {
  return {
    version: status.pluginVersion,
    dsh: status.dshVersion,
    platform: `${status.platform} · ${status.arch}`,
    diagnostics: diagnosticsRow(status),
  };
}

/**
 * 诊断行（issue #28）：仅当宿主回了 homeDir 与 profile 时展示（老版本宿主 → null，面板自动隐藏）。
 * 路径分隔符归一化为 '/'，避免 Windows 反斜杠在 UI 上显示混乱。
 */
function diagnosticsRow(status: AboutStatusInput): AboutDiagnosticsRow | null {
  const homeDir = status.homeDir;
  const profile = status.profile;
  if (typeof homeDir !== 'string' || homeDir === '' || typeof profile !== 'string' || profile === '') return null;
  return {
    profileDir: `${homeDir.replace(/\\/g, '/')}/profiles/${profile}`,
    profile,
    pluginCount: status.installedPluginCount ?? 0,
    manifestUnreadable: status.profileManifestReadable === false,
  };
}

/**
 * 运行时信息 → 可直接粘贴到 issue 的 Markdown 片段。
 *
 * 为什么放在这里：用户提界面问题时最不愿意做的就是手抄版本号，而「关于」页已经握着全部
 * 需要的信息。拼接规则是纯函数（node 可测），组件只负责把它交给 CopyButton。
 *
 * 不含任何敏感信息：只有版本号、平台标识、profile 名与插件清单目录（目录用于排查
 * profile / DSH_HOME 不匹配，不是凭据）。诊断位缺失（老宿主）时只输出前三行。
 *
 * 文案一律走 config-manager 字典（英文界面零中文）：此前这里是双语硬编码字面量
 * （'### 环境 / Environment' …），英文界面下会原样透出中文。
 */
export function buildFeedbackSnippet(rows: AboutStatusRows, t: TranslateNS<'config-manager'>): string {
  const lines = [
    t('about.snippet.environment'),
    t('about.snippet.plugin', { version: rows.version || 'unknown' }),
    t('about.snippet.dsh', { version: rows.dsh || 'unknown' }),
    t('about.snippet.platform', { platform: rows.platform || 'unknown' }),
  ];
  if (rows.diagnostics !== null) {
    lines.push(`- profile: ${rows.diagnostics.profile}`);
    lines.push(t('about.snippet.pluginDir', { dir: rows.diagnostics.profileDir }));
  }
  return lines.join('\n');
}

/** 插件公开元数据常量（见设计文档 §3；repoUrl 与 package.json repository 一致） */
export const ABOUT_META: AboutMeta = {
  name: 'DSH Config Manager',
  repoUrl: 'https://github.com/xiajiajun516/dsh-config-manager',
  author: 'xiajiajun516',
  authorUrl: 'https://github.com/xiajiajun516',
};

/** 由 ABOUT_META.repoUrl 派生的外链常量（单一来源，恒与元数据一致） */
export const ABOUT_LINKS: AboutLinks = deriveAboutLinks(ABOUT_META.repoUrl);

/* ---------------------------------------------------------------- P1-⑩ CLI 救援工具卡 */

/** CLI 引导卡的展示数据（P1-⑩：GUI 里发现不了 CLI → About 面板给安装/常用命令/文档入口）。
 *  CLI 是独立 npm 工具（与插件分开安装：`--omit=peer` 让离线救援端零 DSH 运行时依赖），
 *  DSH 挂了也能用；文案与命令见 README.md「CLI — the first line of defense」。 */
export const ABOUT_CLI: {
  installCommand: string;
  /** client-F5：说明文案走字典键（此前硬编码中文，英文界面恒为中文） */
  commands: { command: string; descriptionKey: ConfigManagerKey }[];
  docsUrl: string;
} = {
  installCommand: 'npm install -g dsh-config-manager@latest --omit=peer',
  commands: [
    { command: 'dsh-config-manager help', descriptionKey: 'about.cli.help' },
    { command: 'dsh-config-manager snapshots', descriptionKey: 'about.cli.snapshots' },
    { command: 'dsh-config-manager restore [--id <id>] [--dry-run]', descriptionKey: 'about.cli.restore' },
    { command: 'dsh-config-manager reinstall [--yes] [--wipe-config]', descriptionKey: 'about.cli.reinstall' },
  ],
  docsUrl: 'https://github.com/xiajiajun516/dsh-config-manager#-cli--the-first-line-of-defense-when-dsh-is-broken',
};
/* ---------------------------------------------------------------- 插件版本更新检查（关于 tab） */

/** 升级命令的上下文：当前档案名（'desktop' 由桌面端独占，不给终端命令）。 */
export interface AboutUpdateContext {
  /** 当前档案（status/diagnostics 提供；未知 → 命令里不带 --profile） */
  profile?: string;
}

/**
 * 组装升级命令。
 *
 * 为什么用**精确版本**而不是 `@latest`：pnpm 的 `minimumReleaseAge` 会让 `@latest` 解析到
 * 「发布满阈值」的旧版（README「安装」段实测记录），而我们刚刚从 registry 拿到了确切的 latest ——
 * 直接钉住它既不会装回旧版，也不会跟用户报告里看到的版本号对不上。
 *
 * `desktop` 档案由 Electron 独占管理（普通 CLI 对它无条件拒绝），未知档案也不猜 —— 两种情况
 * 返回 null，界面改为提示「请在 DSH 插件页更新」，不给一条注定失败的命令。
 */
export function aboutUpgradeCommand(latest: string, ctx: AboutUpdateContext = {}): string | null {
  const profile = (ctx.profile ?? '').trim();
  if (profile === '' || profile === 'desktop') return null;
  return `dsh plugin --profile ${profile} add dsh-config-manager@${latest}`;
}

/**
 * 检查结果 → 展示模型（判定在纯函数里，面板只做「kind → 文案/Badge」映射）。
 *
 * - `upToDate`：latest ≤ current（**含本地跑预发布版的情况** —— 不提示降级）；
 * - `available`：latest > current；`command` 为 null 时界面改给「插件页更新」提示；
 * - `failed`：网络/超时/响应畸形 —— 如实展示原因并允许重试，**绝不当作「已是最新」**。
 */
export type AboutUpdateView =
  | { kind: 'upToDate'; current: string; latest: string }
  | { kind: 'available'; current: string; latest: string; command: string | null }
  | { kind: 'failed'; current: string; error: string };

/** 检查结果 → 展示模型（见 AboutUpdateView 的三档语义） */
export function aboutUpdateView(
  result: PluginUpdateCheckResult,
  ctx: AboutUpdateContext = {},
): AboutUpdateView {
  if (!result.ok) return { kind: 'failed', current: result.current, error: result.error };
  if (!result.updateAvailable) {
    return { kind: 'upToDate', current: result.current, latest: result.latest };
  }
  return {
    kind: 'available',
    current: result.current,
    latest: result.latest,
    command: aboutUpgradeCommand(result.latest, ctx),
  };
}
