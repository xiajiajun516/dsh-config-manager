# 🛠️ DSH Config Manager — 开发者 / 维护者文档

> 面向开发者与维护者。**用户请直接看 [README.md](README.md)（英文）或 [README.zh-CN.md](README.zh-CN.md)。**

---

## 📦 开发命令

```bash
npm install --legacy-peer-deps   # 安装依赖（部分 DSH 核心包未发布公共 registry，需跳过 peer 解析）
npm run typecheck                # 类型检查（tsc --noEmit）
npm run build                    # 构建：Host 半 lib/（tsc）+ client bundle lib/client.js（tsdown）
npm run bundle                   # 仅重建 client bundle（tsdown）
npm test                         # 运行全部测试（node --test，192 个）
npm run smoke                    # 仅核心引擎冒烟测试
```

## 🏗️ 架构

```
src/
├── core/       核心引擎（与 DSH 运行时解耦，ConfigAdapter/HostContext 接口 + 内存 mock 可测）
│               exporter / analyzer(三段式) / importer(14步) / backup(快照) / rollback(逆序补偿)
│               cache-cleaner（缓存自动清理：tmp 暂存 / exports 导出副本 / market cache+work，保留期可配）
├── schema/     领域类型 / Manifest / 版本判定（集中，CURRENT_SCHEMA_VERSION=1）
├── security/   secret-scanner / redaction / zip-security / integrity / encryption(scrypt+AES-256-GCM)
├── adapters/   13 个真实配置适配器（settings/ui/providers/plugins/mcp/prompts/skills/
│               agentPresets/workspaces/credentials/pluginFiles/sessions/self）
├── migrations/ schema 迁移链（registry + v1→v2 占位）
├── ui/         框架无关 UI 逻辑层（九步导入向导 / 冲突 / 路径映射 / 进度 / 报告）
├── client/     React 界面（settings.section 挂载，/api/dsh-config-manager/* 调 Host）
├── profiles/   档案 = DSH 自带 profile（$DSH_HOME/profiles/<name>）：
│               shared（零依赖类型/常量/纯函数）→ dsh-profile-manager（node fs 引擎）→ src/ui/dsh-profiles-view.ts
└── index.ts    Host 半 Cordis 插件入口（name='config-manager'，7 端点路由）
```

**安全不变量**：Secret 默认不导出 / 导入前强制快照 / Dry Run 零写入 / 冲突不默认覆盖 / ZIP 视为不可信输入 / 日志全程脱敏。

## 🚀 自动发布（npm + GitHub Release）

打 tag 即全自动（`.github/workflows/publish.yml`）：

```bash
npm version patch          # 0.1.x → 0.1.x+1（改版本 + 打 tag）
git push origin main --tags
```

CI 流水线：`typecheck → 192 测试 → build → npm pack → npm publish（OIDC）→ 创建 GitHub Release（tgz 附件 + CHANGELOG 双语亮点 + 自动变更记录）`

- **npm 发布走 Trusted Publishing（OIDC）**：无任何长期令牌；workflow 需 `id-token: write` + npm ≥ 11.5.1（workflow 会先升级 npm）
- **Release 描述**：CI 从 `CHANGELOG.md` 抽取当前版本段（中英双语亮点，漏写会 **fail fast**）拼上自动变更记录；发版前务必在 `CHANGELOG.md` 顶部更新对应版本段
- 一次性配置（首次）：
  ```bash
  npm login
  npm trust github dsh-config-manager --file publish.yml --repo xiajiajun516/dsh-config-manager --allow-publish
  ```
- `dist/` 目录需先创建（`mkdir -p dist && npm pack --pack-destination ./dist`），否则 npm pack 报 ENOENT

## 🔒 CI 门禁（PR / 主干）

`.github/workflows/ci.yml` 与发布流水线**分离**，对 `pull_request`（目标 `main`）、`push`（`main`）与 `workflow_dispatch` 触发：

```
install → typecheck → npm test（全量套件，不按目录裁剪）→ build（tsc + tsdown）→ npm pack（打包与 files 白名单校验）
```

- **零发布副作用**：不含向 registry 推送的步骤，不申请 OIDC 发布凭据，权限仅 `permissions: contents: read`
- **单 job 跑完整阶梯**：install → typecheck → test → build → pack，一步失败即整体红；**禁用「允许失败」、不加自动重试**（全量测试实测 1558 项约 88 秒，无需拆 job；耗时由 concurrency + timeout 控制）
- **安装契约与发布一致**：Node 24 + `npm ci --legacy-peer-deps`（部分 DSH 核心包只声明在 peerDependencies，普通 `npm ci` 必红）
- **并发**：`concurrency.group: ci-${{ github.ref }}` + `cancel-in-progress`，同一分支的新提交自动取消旧运行
- **PR 要求**：合并进 `main` 前需 ci.yml 全绿；**发布仍是打 tag → `publish.yml`**（见上一节），两条流水线互不触发
- **已知间歇性失败（非必然红灯）**：`src/utils/env-lock.test.ts` 与 `src/client/run-store.test.ts` 存在**负载相关的间歇性**失败（多数运行 0 fail 全绿，单独跑必过）。若 CI 首次红灯，可先 `gh run rerun <id> --failed` 确认是否为该间歇，**而非直接认定为缺陷**——但也不要因为「可能是间歇」而放松警觉。

## 🧪 测试矩阵

**192 个测试全部通过**（node:test，零额外依赖），覆盖规范 §33 + 验收场景 A–G：

| 类别 | 覆盖 |
|---|---|
| 导出 | 正常 / 空 / 大配置(1MB+) / Unicode / 特殊字符 / Secret 过滤 |
| 导入 | 正常 / Merge / Replace / Skip(不删目标独有) / Conflict / 缺失插件 / 缺失依赖 / 缺失密钥 / 未确认拒绝 |
| 回滚（场景 E） | 多适配器混合中途失败 → 整体恢复；rollbackOnError=false 对照；部分回滚诚实报告 |
| 迁移（场景 G） | migrateToCurrent 机制级边界（当前 v1 即最新，无真实 v2 可端到端验证） |
| 安全（场景 F） | 恶意 ZIP / 超大条目 / checksum 不匹配 / Zip Slip / 绝对路径 |
| 跨平台（场景 B） | win32↔darwin↔linux 批量前缀映射 |
| 冲突导航（回归） | 只前进的阶段导航（path-mapping 后不回跳 conflicts） |

## 📋 完整技术限制

1. Workspace 只能创建/改标题（DSH 无整体覆盖写通道；路径与会话列表由 DSH 维护）
2. MCP 无管理 API——以组合 patch 行导入，需重启生效
3. 插件安装需重启（installPlugin 返回 needsRestart）
4. 浏览器 localStorage UI 状态不迁移（Host 无通道）
5. keybindings / workflows 配置 / commands / rules——DSH 无此概念，不实现假分区
6. 凭据值无法回滚（DSH 不回读值，回滚需人工补录）
7. 新建项无法回滚删除（settings 无删除语义）
8. Schema 迁移 v1→v2 为占位（CURRENT=1）
9. 历史会话默认不迁移（v1 仅文件级复制）
10. 加密备份密码丢失无法解密（设计使然）
11. **DSH 无法在运行中切换 profile**：profile 由启动参数 `--profile <name>` 决定，bundle 层在启动时解析，运行中的进程无法更换自身 profile。故「档案」页的切换 = 写 `<dataDir>/next-profile` 标记 + 提示手动重启（`dsh --profile <name>`）；DSH 也没有 profile 管理 HTTP 路由（已核对 0.1.5-rc.1 / 0.1.5-rc.2 / 0.1.6-alpha.2 全无 profile-admin/ui-profile-admin/profileManagement）
12. DSH 不提供 `DSH_PROFILE` 环境变量：当前 profile 只能从 argv（`--profile`）或插件 config 推断（`resolveProfileNameFromArgv`）

## 📌 常见坑

- **pnpm 裸名 add 不升级**：`dsh plugin add dsh-config-manager`（无版本）会保留已记录版本；用 `@latest` 或精确版本
- **`@latest` 装到旧版 = pnpm 11 发布年龄策略（不是缓存）**：`minimumReleaseAge` 默认把发布不足 30 天的新版本排除出版本解析，只有 `minimumReleaseAgeExclude` 白名单里的版本可用。`pnpm cache delete` 无效。解决：
  1. **精确版本装一次即自动白名单**（推荐）：
     ```bash
     dsh plugin --profile web add dsh-config-manager@0.1.5
     # pnpm 自动把 0.1.5 追加进 pnpm-workspace.yaml 的 minimumReleaseAgeExclude，之后 @latest 即可解析到它
     ```
  2. 或彻底关闭年龄门槛：在 profile 的 `pnpm-workspace.yaml` 加 `minimumReleaseAge: 0`
- **MemFs 测试路径**：内存 fs 的 key 必须与宿主 path 解耦（POSIX 上 path.resolve 对 win32 home 会注入 cwd）
- **插件控制台日志默认静音**：宿主入口（`src/index.ts` 的 `ConfigManagerHostContext`）用 `parseLogLevel(process.env.DSH_CONFIG_MANAGER_LOG_LEVEL)` 解析级别，**缺省 warn**——启动 `dsh web` 后只留 warn/error，常规 info（挂载横幅、调度器跳过、导出/备份完成、保留策略清理）不再刷屏；排查时设 `DSH_CONFIG_MANAGER_LOG_LEVEL=info`（或 `debug`）。级别只在入口解析一次，勿在调用点加 `if (debug)` 分支。

## 📥 从 AGENTS.md 下移的细则（2026-09）

> 背景：`AGENTS.md` **每轮对话都会进入模型上下文**，而这里是「实现细节级」的权威依据。
> 下移不改变任何约定，只是把按需查阅的内容从常驻文档挪到这里；`AGENTS.md` 中保留了硬性规则与指针。

#### 页面落位（src/client/）
- 七 tab 容器：`index.ts` + `ConfigManagerSection.tsx`（Overview/Export/Import/Snapshots/Sync/Market/Profiles/More；tablist 支持方向键导航）；总览为默认首 tab（`panel:'overview'`，旧 panel 缺省值经 parsePersistedState 迁移）
- 总览 `overview/OverviewPanel.tsx`（纯函数模型 `src/ui/overview-view.ts`：指标/健康判定/建议/最近活动/相对时间）
- 导出 `export/ExportView.tsx`；导入九步 `import/ImportWizardView.tsx`（外层包装 Stepper 步骤条 + `ImportWizardBody` 本体；纯函数 `src/ui/import-stepper.ts`；+`ConflictList/PathMappingForm/import-file-select`）；快照 `snapshots/SnapshotsPanel.tsx`
- 历史 `history/HistoryPanel.tsx`；同步 `sync/SyncSettingsView.tsx`(+`SyncConfirmView/SyncHistoryView/sync-view`)；市场 `market/MarketPanel.tsx`(+`MyConfigsView/my-configs-view/my-configs-api`)；咨询 `consult/ConsultCard.tsx`
- 共享原语 **`common/ui.tsx`**（Button/Badge/Banner/Card/Spinner/Field/SectionTitle/Empty/Checkbox/Stepper）+`common/ErrorBanner.tsx`/`ProgressBar.tsx`/`ReportView.tsx`/`ConfirmDialog.tsx`（含 focus trap）
- 状态中枢 `run-store.ts`（模块级单例+sessionStorage 白名单）；数据访问 `api.ts`/`sync/sync-api.ts`/`market/market-api.ts`；文案字典 `locales.ts`/`sync-locales.ts`/`market-locales.ts`（zh 源/en 镜像）
- 样式全在 `src/client/config-manager.module.css`

- **Hook**：本仓库无自定义 hooks 目录，组件内联 state + `useSyncExternalStore` 消费 runStore，复用逻辑下沉 `src/ui/`。不要新造 hooks 层。
- **Type**：领域类型 `src/core/types.ts`/`src/schema/types.ts`/`src/sync/*`/`src/market/types.ts`；UI 类型 `src/ui/types.ts`；client 专属 `src/client/client-types.ts`。
- **Utility**：`src/utils/` 或模块私有；带业务语义的纯函数优先 `src/ui/`。

### 🚀 发布（打 tag 全自动）
CI `.github/workflows/publish.yml`：tag `v*` push → typecheck → test → build → pack → npm publish(OIDC) → GitHub Release。
步骤：①bump 三处版本；②`CHANGELOG.md` 顶部加当前版本双语亮点段（漏写 CI fail-fast，release 由 `.github/scripts/extract-release-notes.py` 抽取）；③push main；④`git tag -a vX.Y.Z && push`。
注意：手动 `workflow_dispatch` 不建 Release；npm 用 OIDC 无长令牌；版本 `0.1.x`；commit 惯例 `chore: bump to X.Y.Z`；不配 `.github/release.yml`（无 PR+label，GitHub 默认 conventional 分组更好）。
CI 门禁：`.github/workflows/ci.yml` 对 `pull_request`→main 与 `push`→main 跑 typecheck/test/build/pack（最小权限、零发布副作用）；**发版仍只走 tag → `publish.yml`**，两条流水线互不重叠。

#### 状态管理
- 高频可恢复流程(Export/Import)状态在 `run-store.ts`；新视图需「切 tab 不丢/刷新恢复」就入 runStore。
- 低频面板(Snapshots/Sync/Market)组件自持(state+ref) + 非敏感切片镜像 runStore（`toSyncStoreSlice/toMarketStoreSlice/toSnapshotsStoreSlice`）；状态变更统一走 `commit(next)`（更新 stateRef→setState→**总是** `runStore.patch`），不依赖 effect flush；凭据仅内存、瞬态为内存切片，均被 `toPersistedState` 白名单剔除。
- 面板开关存 runStore `panel` 字段。
- 控制器(`ExportFlow/ImportWizard`)由 runStore 缓存复用，**禁止每次渲染 new**；刷新恢复经 `writeWizardSnapshot()` 受控 rehydrate。

#### i18n
- 文案进字典：React 壳 `t('key')`(zh 源/en 镜像，`ConfigManagerKey` 编译校验)；`src/ui/` 走 `src/ui/i18n.ts` `UiT`(`makeUiT`)。
- **禁止硬编码用户可见字符串**。

##### 字典共 7 套；「查不到 key」不等于是缺陷（排查前必读）
写文案时要放进**正确的那一套**；反过来，**判断「某 key 是否存在」时必须先确认 `t` 的来源**，否则会系统性误报：

| 字典 | zh/en | `t` 的来源 | 缺 key 行为 |
|---|---|---|---|
| `src/client/locales.ts` | 506 / 506 | 组件 props `t`（`ConfigManagerKey`） | **编译期报错** |
| `src/ui/i18n.ts` | 278 / 278 | `UiT`（`api.t` / `zhUiT` / props） | **静默返回 key 本身** |
| `src/core/messages.ts` | 291 / 291 | host/adapter `msg()` | 编译期（`keyof typeof zh`） |
| `history-locales.ts` | 51 / 51 | `historyT` → ns `config-manager-history` | 静默 |
| `market-locales.ts` | 138 / 138 | `marketT` → ns `config-manager-market` | 静默 |
| `recovery-locales.ts` | 104 / 104 | `recoveryT` → ns `config-manager-recovery` | 静默 |
| `sync-locales.ts` | 198 / 198 | `syncT` → ns `config-manager-sync` | 静默 |

> 上表数量为 2026-09-20 **最终态**实测（node 直读字典对象逐个计数）：7 套字典的 zh / en **键集合完全相等**、无重复键。
> 数量历史（不同时点，勿混用）：`locales.ts` HEAD 517（本机脚本按 `'key':` 字面量统计；t1 审计报告写 533 属其统计口径）
> → t3 复核 558（批次一新增文案后）→ t12 收口前 522 → **最终 506**（t12 删除 16 个 `overview.*` 死键，zh/en 同步；t15 只删代码不删键）。
> 改动文案后如要引用数量，请重新实测，不要沿用旧数字。

**第四个坑：`t` 可经 props 注入 → 静态归属不可判。**
`ConsultCard` 声明 `t: UiT`（不是本地字典），由调用方传 `t={api.t}`。因此「按文件在哪个目录就查哪套字典」**永远判不对**；实测这种静态归属扫描会产生 **600+ 处假阳性**（`error.*`/`history.*`/`myconfigs.*`/`report.*` 等全是注入式 `t`）。

**正确排查姿势**：①先判 `t` 来自 import（编译校验）还是 `api.t` / props 注入（宽松）；②宽松字典里「查不到」**必须**先把 7 套字典取并集再下结论；③真正可靠的护栏是 `ConfigManagerKey` 的编译校验 + `UiT` 的运行时回退，而不是旁路扫字典。

#### Missing Design Rule（DESIGN.md 未覆盖）
①搜库确认无类似 ②能扩展先扩展(加 variant/props) ③尝试 token+color-mix+现有比例组合 ④确实不存在才按既有语言设计新规范(复用既有 Color/Typography/Spacing/Radius/Pattern) ⑤**写入 DESIGN.md** ⑥再使用。
> Never introduce a new visual pattern without documenting it in DESIGN.md.

#### 第三方 UI 库准入（按需追加）
默认不引入第二套视觉体系；当现有原语(`common/ui.tsx`)和 DESIGN.md token 无法满足需求时，按以下流程评估后落地：

1. **必要性**：确认 `common/*` → `src/ui/*` → `src/core/*` 无等价方案；能扩展先扩展(加 variant/props)。
2. **Token 对齐**：库必须能消费 `--dsw-*` token（颜色/字体/阴影），不允许 hardcode；tint 仍走 `color-mix`。亮暗主题与皮肤切换下表现一致。
3. **CSS 隔离**：优先 CSS Modules / CSS Variables / Shadow DOM；避免全局注入污染宿主样式。若库自带全局 css，必须在入口做 scope 包裹或 prefix。
4. **体积评估**：tree-shakable 优先；bundle 增量需在 PR 描述中注明（`npm run bundle` 前后对比）。
5. **依赖同步**：新增后同步更新 `package.json` + `package-lock.json`（两处+根对象版本）；peer/dev 区分清楚。
6. **文档落位**：在 `DESIGN.md` 写入新 pattern / 组件用法 / token 映射表；在 `AGENTS.md` 本段记录库名与用途，避免重复引入。
7. **验证**：`npm run typecheck && npm run build && npm test`；UI 自查覆盖 Hover/Focus/Disabled/Loading/Empty/Error + Dark Mode。

> 图标库同理：默认文本符号/emoji；确需图标库时按上述流程评估，优先支持 SVG sprite / icon font 的按需加载形态。

**已落地（2026-09 Visual Polish，按上述 7 步评估通过）**：
- `lucide-react`（图标）+ `@radix-ui/react-dialog`（弹窗 a11y）——均为**无样式/行为级**原语，视觉仍走 `--dsw-*` token，不引入第二套视觉体系。**devDependencies**（经 `tsdown.config.ts` 的 `deps.alwaysBundle` 打进单文件 cjs，已被内联故非运行时依赖；放 dependencies 会迫使 headless 消费者安装整套 React UI 栈）。bundle +136KB raw / +30KB gzip。封装层 `common/Icon.tsx`、`common/Modal.tsx`；细节与未迁移弹窗清单见 `DESIGN.md §6`。护栏：`src/client/bundle-selfcontained.test.ts`（build 后跑）；消费方式见 `docs/spec/headless-consumption.md`。

