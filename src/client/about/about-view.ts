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
 */

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
}

/** 状态展示行（版本 / DSH / 平台），供 Badge 装配 */
export interface AboutStatusRows {
  /** 插件版本 */
  version: string;
  /** DSH 版本 */
  dsh: string;
  /** 平台 · 架构（合并 platform + arch，对齐 locale about.platform 模板） */
  platform: string;
}

/**
 * 由仓库 URL 派生各链接；恒等推导，杜绝拼接错误。
 *
 * - starUrl = repoUrl（去尾斜杠归一化后原样）；
 * - docsUrl = repoUrl + '#readme'；
 * - issuesUrl = repoUrl + '/issues'；
 * - 输入尾斜杠（含多个）会被归一化去除，如 'https://…/repo/' → 'https://…/repo'。
 */
export function deriveAboutLinks(repoUrl: string): AboutLinks {
  const base = repoUrl.trim().replace(/\/+$/, '');
  return {
    starUrl: base,
    repoUrl: base,
    docsUrl: `${base}#readme`,
    issuesUrl: `${base}/issues`,
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
  };
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