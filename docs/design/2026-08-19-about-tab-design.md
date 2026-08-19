# 「关于（About）」Tab 设计文档

> 日期：2026-08-19 · 状态：待实施 · 上游约束：[AGENTS.md](../../AGENTS.md)（UI/Design 规则）、[DESIGN.md](../../DESIGN.md)（Design System 唯一权威）、[CLIENT_DEPENDENCIES.md](../../src/client/CLIENT_DEPENDENCIES.md)（client 与 host API 契约）

## 1. 背景与目标

dsh-config-manager 当前设置页共有 5 个 tab（Export / Import / Snapshots / Sync / Market）。用户希望新增第 6 个 **「关于（About）」tab**，集中展示插件自身的公共信息：

- GitHub 官方仓库地址（外链）
- 作者名字（GitHub 用户名）
- 一个面向 GitHub 的「去点 Star」入口（新窗口打开仓库页面，由用户在 GitHub 上点赞 —— 插件内不做 OAuth 写操作）
- 顺带展示插件版本 / DSH 版本 / 平台等运行时信息（复用已有 `GET /status`）

目标：**纯静态展示视图 + 外链**，无表单、无写操作、无新增依赖、无新增 host 路由。

## 2. 范围

### 2.1 包含

1. `ConfigManagerSection.tsx` 新增第 6 个「关于」tab。
2. 新增 `src/client/about/AboutPanel.tsx` 组件（React 壳，只做装配）。
3. 新增 `src/client/about/about-view.ts` 纯函数渲染模型（node 可单测）。
4. 新增 `src/client/about/about-view.test.ts` 单测。
5. locale 字典（`src/client/locales.ts`）新增 `about.*` 键（zh 源 / en 镜像）。
6. `config-manager.module.css` 新增少量样式（沿用 Design System token）。
7. 出口类型在 `src/client/index.ts` 汇总（`AboutPanelProps`）。
8. `DESIGN.md` 同步记录新增的「关于页」Common UI Pattern 与任何新样式。

### 2.2 明确不包含

- ❌ 不做 OAuth / GitHub API 写操作（star 只能由用户在 GitHub 网页上完成）
- ❌ 不新增 host 路由 / API（版本信息已有 `GET /status`）
- ❌ 不引入 icon 库 / UI 库 / 新依赖
- ❌ 不改 SQL、同步、安全逻辑
- ❌ 不重新设计既有 5 个 tab 的外观

## 3. 信息与数据来源

| 信息 | 值 | 来源 |
|---|---|---|
| 插件名称 | `DSH Config Manager` | 静态常量（`about-view.ts`） |
| 插件版本 | 动态 | `GET /api/dsh-config-manager/status` → `ServiceStatus.pluginVersion` |
| DSH 版本 | 动态 | `ServiceStatus.dshVersion` |
| 平台 / 架构 | 动态 | `ServiceStatus.platform` / `ServiceStatus.arch` |
| GitHub 仓库 | `https://github.com/xiajiajun516/dsh-config-manager` | 静态常量（`about-view.ts`，与 `package.json repository` 一致） |
| 作者（GitHub 用户名） | `xiajiajun516` | 静态常量（仓库 owner） |
| Star 入口 | 仓库 URL（新窗口打开） | 由 GitHub 链接派生 |
| 文档 / Issues | `#readme` / `/issues` 派生 URL | 由仓库 URL 派生 |

**设计决策**：GitHub / 作者等**公开元数据用静态常量**（放进 `about-view.ts`），运行时版本信息走 `api.status()`。原因：
- 公开元数据不变化，硬编码可读、可测、可维护；不引发布局闪烁。
- `status()` 已有现成契约（`src/ui/types.ts` 的 `status` port），零新增 host 代码。
- 版本号**绝不能**重复维护在 client（AGENTS.md §版本号三处同步教训）：版本展示读 `status()`，天然与 host 的 `PLUGIN_VERSION` 一致。

## 4. UI 布局设计

遵循 [DESIGN.md](../../DESIGN.md) §7 页面骨架与 §8 组件目录：

```
<div className={css.viewBody}>                        ← 视图根（所有视图共用）
  <SectionTitle title=about.title subtitle=about.subtitle />
  <Card>                                              ← 项目信息卡
    <span className={css.groupLabel}>　项目名称 + 官方 Badge</span>
    <div className={css.statRow}> 版本 / DSH / 平台 Badge（动态）</div>
  </Card>
  <Card>                                              ← 链接卡
    <span className={css.groupLabel}>　相关链接</span>
    <div className={css.actionRow}>
      ⭐ Star·GitHub 主按钮（ghost + 外链）
      GitHub 仓库 / 文档 / Issues 链接行
    </div>
    作者行：👤 xiajiajun516（外链 GitHub 主页）
  </Card>
</div>
```

### 4.1 组件选择（复用以替代新建）

- `SectionTitle`：视图标题（§8.7）
- `Card`：信息分组（§8.4）
- `Badge`：版本号 / 平台徽章（§8.2，kind 语义：官方→`ok`，版本→`info`）
- `Spinner`：`status()` 加载中（§8.5）
- `Button variant="primary"`：Star 主操作（§8.1，外链形式见下）—— 仅一个 primary，符合「不要给所有按钮加 primary」
- 链接统一用 `<a>`（`target="_blank"` + `rel="noreferrer"`），复用已有外链模式（`SyncSettingsView.tsx` L725-733 的 `css.ghostButton` + `<a>` 用法）

### 4.2 外链 Button 的处理

`Button` 原语渲染 `<button>`，无法直接承担 `href`。方案：**给 `ui.tsx` 的 `Button` 增加可选 `href` + `newTab` props**（Extend 而非 Create，符合 AGENTS.md §Reuse Before Creating）——有 `href` 时渲染 `<a className={同款按钮类}>`，否则渲染 `<button>`。这样 Star 链接与普通按钮外观统一，且不破坏既有调用。

### 4.3 新样式（最小集合，进 `config-manager.module.css`）

预计仅需 1–2 个类：

| 类 | 用途 | 依据 |
|---|---|---|
| `.aboutLinkRow` | 链接行（flex wrap，gap 沿用 10px/12px 规范） | 贴近 `.actionRow` 的间距表 §4.2 |
| `.aboutAuthor` | 作者行（13px，label-primary，可点 hover 转 `interactive-bg-hover`） | 贴近 `.categoryItem` 交互行 |

不新增：颜色 / 字号 / 圆角 / 阴影（全部沿用 Design System token 与既有 scale）。

> ⚠️ 若实现时发现需要任何视觉上「新」的样式值或结构，必须先回写 `DESIGN.md`（§17 强制流程）再实现。

## 5. 渲染模型（`about-view.ts`，node 可测）

纯函数、无 React、无 DOM：

```ts
export interface AboutMeta {
  name: string              // 插件名 'DSH Config Manager'
  repoUrl: string           // https://github.com/xiajiajun516/dsh-config-manager
  author: string            // xiajiajun516（GitHub 用户名）
  authorUrl: string         // https://github.com/xiajiajun516
}

export interface AboutLinks {
  starUrl: string           // repoUrl
  repoUrl: string
  docsUrl: string           // repoUrl + '#readme'
  issuesUrl: string         // repoUrl + '/issues'
}

/** 由仓库 URL 派生各链接；恒等推导，杜绝拼接错误 */
export function deriveAboutLinks(repoUrl: string): AboutLinks
/** 动态状态 → 展示行（版本 / DSH / 平台），供 Badge 装配 */
export function aboutStatusRows(status: ServiceStatus): { version: string; dsh: string; platform: string }
```

单测覆盖（`about-view.test.ts`）：
- 链接派生：repoUrl → star/docs/issues 的正确后缀；无尾斜杠处理
- 状态行：`pluginVersion/dshVersion/platform/arch` 的格式化
- 常量完整性：`repoUrl` 与 `package.json repository` 一致（测试中硬编码断言）

## 6. Tab 集成（`ConfigManagerSection.tsx`）

按现有「低频面板」模式（与 `marketOpen/syncOpen/snapshotsOpen` 完全一致）：

- 新增 `const [aboutOpen, setAboutOpen] = useState(false)`
- `openAbout()` 打开并关闭其余
- `setView()` / `openSnapshots()` / `openSync()` / `openMarket()` 各重置 `aboutOpen`
- 新增第 6 个 tab 按钮（`aria-selected={activeTab === 'about'}`），位置：**放在 Market 之后（最右）**
- `activeTab` 联合类型扩展为 `| 'about'`
- `sectionBody` 渲染分支：`aboutOpen ? <AboutPanel api={api} t={t} /> : ...`

关于 tab 不进入 `runStore`（低频静态视图，无跨 tab 状态需保留，与 Snapshots/Sync/Market 同策略）。`MainView` 类型**不变**（仍是 `'export' | 'import'`）。

## 7. locale 键（`src/client/locales.ts`）

新增键（zh 源 / en 镜像，`ConfigManagerKey` 编译期校验）：

| 键 | zh | en |
|---|---|---|
| `view.about` | 关于 | About |
| `about.title` | 关于 DSH Config Manager | About DSH Config Manager |
| `about.subtitle` | 插件信息、作者与反馈入口 | Plugin info, author and feedback links |
| `about.official` | 官方 | Official |
| `about.version` | 版本 {version} | Version {version} |
| `about.dshVersion` | DSH {version} | DSH {version} |
| — | 平台 · 架构（如 `win32 · x64`）由 `aboutStatusRows` 纯函数合并展示，无独立字典键 | — |
| `about.links` | 相关链接 | Links |
| `about.star` | ⭐ 在 GitHub 上点赞 | ⭐ Star on GitHub |
| `about.repo` | GitHub 仓库 | GitHub Repository |
| `about.docs` | 使用文档 | Documentation |
| `about.issues` | 反馈问题 | Issues |
| `about.authorLabel` | 作者 | Author |
| `about.loading` | 正在获取版本信息… | Loading version info… |
| `about.retryStatus` | 重新获取 | Retry |

> 链接文字（GitHub 仓库 / 文档 / Issues）走字典，链接 URL 走 `about-view.ts` 常量。

## 8. 安全

- 外链一律 `target="_blank"` + `rel="noreferrer"`（防 tabnabbing，遵循 GUI 安全基线）
- **无任何表单输入** → 无 secret 泄漏面
- 不将 password/token 带入 About 场景；`status()` 返回不含敏感信息
- 版本信息仅展示，不写日志不持久化
- 不新增可执行入口（用户不能从 About 页触发备份/还原/写入）

## 9. 验收标准

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 通过（新增 `about-view.test.ts` 用例全绿）
- [ ] `npm run build` 通过（client bundle 可出，CSS Modules 正常）
- [ ] GUI 中「关于」tab 出现在最右，其余 5 tab 行为不变
- [ ] 版本 / DSH / 平台来自 `status()`，加载中有 Spinner，失败可重试
- [ ] Star / 仓库 / 文档 / Issues / 作者 外链均 `target="_blank"` + `rel="noreferrer"`，点击新窗口打开
- [ ] 暗色 / 亮色主题均正常（全部 token 驱动）
- [ ] 新文案 zh / en 镜像齐全
- [ ] `DESIGN.md` 已同步新增的 About 页面 Pattern / 任何新样式