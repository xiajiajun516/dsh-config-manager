# Phase 1 交接文档（灾备基线）

> 📦 **历史归档**（阶段交接记录，非当前状态）：本文写于 `v0.1.59`，其中的版本号、测试基线（1890 项）与工作区状态均已过时。
> 当前状态以 `CHANGELOG.md` + `git log` 为准；架构与约定一律以 `AGENTS.md` / `DEVELOPERS.md` / `DESIGN.md` 为准。

> 上一轮对话完成了「与竞品 dsh-undo-savepoint 对齐的灾备能力基线」。
> 本文档写给下一个对话：**先读这份，再动手**。所有数字均为 2026-09-13 实测。
>
> 相关背景文档：`DEVELOPERS.md`（架构/限制）、`DESIGN.md`（UI 唯一权威）、
> `AGENTS.md`（改动前必读的隐性约定）、`docs/spec/`（对外契约）。

---

## 0. 一句话状态

**Phase 1 五项 P0 已全部实施、接线落盘、在真实 DSH 实例上端到端验证通过。**
代码**尚未提交**（工作区未 commit），版本仍是 `0.1.59`。

| 项 | 实测值 |
|---|---|
| HEAD | `0325a07 chore: release v0.1.59` |
| `package.json` version | `0.1.59`（**未 bump**） |
| `npm run typecheck` | **exit 0，0 错** |
| `npm test` | **1890 通过 / 0 失败** |
| 我的新增测试 | 7 个文件，约 130 项断言 |
| 架构边界测试 | PASS |
| 客户端 bundle 守卫 | PASS（无真实 `node:` 依赖） |

---

## 1. 立刻要做的第一件事

```bash
cd D:\Projects\personal\dsh-config-manager
npx tsc --noEmit          # 期望 exit 0
npm test                  # 期望 1890 pass / 0 fail
git status --porcelain    # 确认我的文件仍在（见 §6 并行线警告）
```

若 `npm test` 出现 **1~2 项偶发失败**，先看是不是并行线正在改的文件
（`src/core/recovery-orchestrator.test.ts`、`src/sync/*`）。上一轮实测过一次
「首次运行红、重跑全绿」，归因是并行线在两次运行之间改写了文件。

---

## 2. Phase 1 交付清单

### 2.1 新增 core 模块（全部 `src/core/`，均带同目录 `.test.ts`）

| 文件 | 行数 | 职责 |
|---|---|---|
| `config-state.ts` | 144 | 配置状态采集：分区指纹（稳定序列化 + sha256）、`statesEqual`、`diffStates` |
| `config-snapshot.ts` | 449 | 配置状态快照：持久化（`__u8` base64 可逆编码）、保留清理、**adapter 管线回放** |
| `config-lifecycle.ts` | 394 | 编排层：自动快照、撤销/重做、回声登记、`watchDirsFor` |
| `undo.ts` | 87 | 撤销/重做**纯规划**：按内容差异选目标、pre-restore 记账、重做护栏 |
| `watcher.ts` | 207 | 防抖监听 + **双层回声抑制**（`suppressDepth` + `EchoRegistry`） |
| `boot-rescue.ts` | 537 | 启动救援模式：备份并改写 patch/bundles，可完全还原 |
| `crash-report.ts` | 284 | 崩溃检测、日志签名归因、last-good 快照选择 |
| `phase1-wiring.test.ts` | — | **接线守卫**：断言路由/闸门/dispose 确实在盘上 |

### 2.2 新增客户端文件（`src/client/lifecycle/`）

| 文件 | 行数 | 职责 |
|---|---|---|
| `lifecycle-api.ts` | 211 | 9 个端点的类型化 fetch 封装（`LifecycleApi`） |
| `LifecyclePanel.tsx` | 463 | 灾备页：崩溃横幅 + 撤销/重做 + 救援模式 + 快照列表 + 交叉指引 |

### 2.3 改动的既有文件（**只列我改的部分**）

| 文件 | 我的改动 |
|---|---|
| `src/index.ts` | +288 行：`ConfigLifecycle` 实例化、三条路由（`/lifecycle` `/crash` `/rescue`）、boot-state 写入方、`lifecycle.dispose()` |
| `src/client/ConfigManagerSection.tsx` | 导航项 `{ id:'lifecycle', label:'nav.recovery' }`、`case 'lifecycle'` 渲染、`openRecoveryWizard` 注入 |
| `src/client/index.ts` | 导入/实例化/注入 `lifecycleApi` |
| `src/client/client-types.ts` | `ConfigManagerSectionInjected` 加 `lifecycleApi` |
| `src/client/run-store.ts` | `PanelId` 加 `'lifecycle'`（**不是 `'recovery'`**，见 §5.1） |
| `src/client/locales.ts` | +102 行：47 个 `lifecycle.*` + `nav.recovery` + 3 个 `lifecycle.guided.*` |
| `src/ui/i18n.ts` | +2 行：`error.lifecycleTimeout`（zh/en） |
| `CHANGELOG.md` | 顶部加 `## [Unreleased] — Phase 1：灾备基线（P0）` 段 |

---

## 3. 五个关键设计决策（**不要推翻**，都有理由）

### 3.1 配置状态快照与既有 `Snapshot` **分目录**

- 既有 `core/backup.ts` 的 `Snapshot` 是**导入计划驱动**的：只登记「本次导入将写入的目标」，
  无法回答「配置整体有没有变」。
- 新增的配置状态快照在 `<dataDir>/config-snapshots`，既有在 `<dataDir>/snapshots`。
- **混用会产生错误语义**（保留策略、回放方式都不同）。

### 3.2 回放走 adapter 管线，不写第二套写入逻辑

`restoreConfigSnapshot` = `adapter.validate` → `analyzeImport` → `applyItem`，
与导入 / Profile 切换**同一条路径**。因此天然覆盖 settings 命名空间、patch 行、
文件类分区与插件安装。

> **重要**：`core/restore.ts` 的 `restore()` **不能**用于此目的——它只处理
> `hostFileBackups` / `pluginRemove` / `file` 条目，`settingsNamespace` 只记为 skip。

### 3.3 回声抑制必须是两层

恢复动作自己会写文件。若只做一层，会立刻产生一个「等于刚写回内容」的自动快照，
**把重做通道堵死**（竞品 CHANGELOG 记录了这起真实事故）。

1. **写操作窗口**：`watcher.beginSuppress/endSuppress` 直接丢弃事件；
2. **窗口之后**：`EchoRegistry` 按内容指纹识别**延迟投递**的事件。

两条防线都有专门测试。`endSuppress` 归零时**顺带清空待发事件**——这是关键细节。

### 3.4 救援路由**刻意不进入 mutation gate**

`POST /rescue` 既不被 `withMutationGate` 包裹，也没有并入 `host.safeModeIsBlocked`。

**理由**：救援模式是「解决 SAFE MODE」的手段。若被它要解决的那个状态挡住，
用户会被**永久锁在救援态**（死锁）。这一点已写成带注释的守卫测试
（`phase1-wiring.test.ts` 的「救援路由绝不进入 mutation gate」）。

### 3.5 撤销后产生新变更 → 重做**被拒**，而不是覆盖

状态机层面拒绝（`planRedo` 返回 `superseded-by-newer-change`），
保证用户的新改动不会被旧状态覆盖。全部相同时返回 `already-at-state`，不做空操作。

---

## 4. 已验证的事实（真实 DSH 实例，非 mock）

隔离实例：`DSH_HOME=.qa/home`，`dsh web --port 3177`，插件以 link 挂载。

| 验证项 | 证据 | 结果 |
|---|---|---|
| 自动快照 | 改文件 → 防抖 1500ms → `trigger:'watcher'` 快照，覆盖 14 分区 | PASS |
| **撤销真的改文件** | `skills/qa.md` V2 → undo → 磁盘内容 = V1 | PASS |
| **重做真的改文件** | redo → 磁盘内容 = V2 | PASS |
| 手动快照 + 删除 | 创建 200 → 删除后目录真的消失 | PASS |
| 崩溃归因 | `GET /crash` 返回 `crashed/lastGoodAt/advice` | PASS |
| 救援状态 | `GET /rescue` 可读 | PASS |
| CSRF 防护 | `sec-fetch-site: cross-site` / 外部 Origin → **403** | PASS |
| 交叉指引导航 | 目标 `snapshots` + `subTab='recovery'` 真实存在 | PASS |

### QA 环境（可复用）

```
.qa/home                          # 隔离 DSH_HOME
.qa/home/profiles/web/node_modules/dsh-config-manager   # link 挂载
```

启动：`$env:DSH_HOME="$PWD\.qa\home"; dsh web --port 3177 --no-open`

**注意**：启动前先查 3177 是否被占用（上一轮踩过：遗留 node 实例会静默应答旧构建）。

---

## 5. 六个坑（**血泪，务必避免重蹈**）

### 5.1 `run-store` 的 `'recovery'` 是**遗留值**，不能复用

`PanelId` 里 `'recovery'` 的契约是「**旧**聚合 tab → 迁移为 `snapshots` + `subTab='recovery'`」
（`run-store.test.ts:957` 有专门测试）。我最初把新页签 id 定为 `'recovery'`，
直接打破了那条迁移契约。**新页面 id 必须用 `'lifecycle'`。**

> 附带澄清：Phase-5 的 `RecoveryPanel` **不是孤儿**，它由
> `SnapshotsPanel.tsx:414` 的 recovery 子 tab 渲染。

### 5.2 `edit` 工具会因零宽字符匹配失败

文件写入通道会注入 `U+200B` 等零宽字符，导致 `edit` 的 `old_string` 匹配不上
（表现为 "file changed since it was read" 或直接 not found）。

**对策**：改用 node 脚本按**行号**或**锚点**操作，且锚点断言「命中一次」否则中止。
写完必须清理：

```bash
node -e "const fs=require('fs');for(const f of ['<file>']){const s=fs.readFileSync(f,'utf8');const c=s.replace(/[\u200b\u200c\u200d\u2060\ufeff]/g,'');if(c!==s){fs.writeFileSync(f,c,'utf8');console.log('CLEANED',f);}}"
```

### 5.3 锚点必须按**实际行尾**构造

本仓库无 `.gitattributes` + `core.autocrlf=true` → 工作区 CRLF、CI(Linux) LF。
node 补丁脚本里的锚点若写死 `'\n'`，在 CRLF 工作区**命中 0 次**。

**对策**：`const EOL = src.includes('\r\n') ? '\r\n' : '\n'`，插入内容也用 `EOL` 拼接。
**并且**用 LF/CRLF 双形态跑一遍守卫（上一轮 `v0.1.59` tag 就因此 CI 红灯）。

### 5.4 客户端 bundle 铁律

`src/client/**` 任何**运行时**（非 `import type`）跨端 import 都会把整条依赖链
打进 `lib/client.js`；一旦出现 `require("node:...")`，DSH loader 报
「missed the module table」，**整个插件不加载**。

排查时必须**先剥注释**——注释里的同名字符串是已知误报
（`lib/client.js` 里就有两处描述 issue #30 的注释含该字样）。

### 5.5 监听不存在的目录会刷告警

`watchDirsFor` 返回的 `skills` / `.agent-presets` 在首次启动时常常不存在，
直接 `fs.watch` 会为每个缺失目录刷一条告警（QA 实测 2 条）。
已修为「只监听存在的目录」，并有 3 项测试覆盖。

### 5.6 「探针错了」≠「引擎错了」

首次 QA 里 undo 报 `ok:true` 但文件没变。**不是 bug**：探针改的是 `settings.yaml`
的注释行，而 settings 分区走宿主 facade 读**命名空间值**，看不到纯注释差异。

**教训**：验证配置类功能时，用**文件类分区**（`skills` / `agentInstructions`）做探针，
它们走 `FileSystemFacade` 整文件读写，能真正被撤销。

同类误判还有两例：`mutation-locked`（上一操作的锁未释放，重试即 200）、
无 token 访问 200（该路由的守卫是 **CSRF/loopback** 语义，与既有 `/status` 一致）。

---

## 6. ⚠️ 并行开发线警告（**最重要**）

**仓库有另一条活跃开发线**，工作区里同时存在它的改动。当前未提交改动中：

| 属于我 | 属于并行线 |
|---|---|
| `src/core/{config-state,config-snapshot,config-lifecycle,undo,watcher,boot-rescue,crash-report,phase1-wiring}.*` | `src/core/recovery-orchestrator.ts`（+62） |
| `src/client/lifecycle/` | `src/client/recovery/*` |
| `src/client/{ConfigManagerSection.tsx,client-types.ts,index.ts,run-store.ts,locales.ts}` | `src/sync/{autosync-scheduler,backup-scheduler}.ts` + tests |
| `src/index.ts`（我的 288 行） | `src/ui/types.ts`、`src/utils/env-lock.ts`、`src/client/snapshots/SnapshotsPanel.tsx` |
| `CHANGELOG.md`、`src/ui/i18n.ts` | `.tmp-verify/`（含 `issue31-e2e.ts` → 它在做 issue #31） |

**纪律**：
- 改任何文件**前先重读**；`edit`/`write` 后立刻 `git diff` 确认；
- 全仓绿灯**不代表**我的接线落盘——要用 `git diff --stat` + 锚点 grep 抽查；
- **不要**动并行线的文件（`recovery-*` / `sync-*` / `ui/types.ts` / `env-lock.ts`）；
- untracked 新文件可能被 `git clean` 删掉。

---

## 6.5 灾备子系统当前**整体下线**（2026-09-14 / 09-17 追加）

为「先修 bug、再发版」，灾备子系统整体停摆。**两个开关必须同开同关**：

| 开关 | 位置 | 关闭后 |
|---|---|---|
| `LIFECYCLE_ENABLED: boolean = false` | `src/index.ts` | 不启动变更监听（无自动快照）、不写 `boot-state`、三条路由一律 `503 feature-disabled` |
| `SHOW_LIFECYCLE_NAV = false` | `src/client/ConfigManagerSection.tsx` | 导航条无「灾备」入口 |

### 为什么整体下线，而不是只停自动快照

自动快照的采集走**全部 adapter**，其中 `sessions` 分区（历史会话）本机实测
**340 MB**，远超快照 64 MiB 上限（`config-snapshot.ts` 的 `maxBytes`），必然持续失败并刷：

```
[lifecycle] 自动快照失败: 配置快照超出上限（479313046 > 67108864 字节）
```

在该缺陷修好前，撤销/重做/救援也拿不到可信的快照基线，故一并下线。

### 下线**不删除任何代码**

core 模块、客户端组件、路由实现、`PanelId` 与迁移契约全部保留。开关只挂在
**启动路径与路由入口**上。守卫测试锁定这一点（`src/core/phase1-wiring.test.ts`
末尾「灾备总开关」三条），防止退化成「只改注释不改行为」。

### 客户端归一化（恢复入口时要一并删）

入口隐藏期间，若 sessionStorage 里持久化的 `panel` 是 `'lifecycle'`（此前切到过灾备页
的会话），渲染期回落到 `'snapshots'` 并把 store 归一化；否则刷新后会停在一个没有导航
入口的页面上。

### 验收证据（真实实例：`DSH_HOME=.qa/home` + `dsh web --port 3177`）

| 项 | 关闭时 | 对照：临时改回 `true` |
|---|---|---|
| `GET /lifecycle/status` | **503** `feature-disabled` | 200 |
| `GET /crash`、`GET /rescue` | **503** `feature-disabled` | 200 |
| `boot-state.json` mtime | **不变**（未写） | 被重写 |
| 改 `skills/` 下探针文件后快照目录数 | **2 → 2**（无新快照） | 2 → 3（自动快照触发） |
| 导航条 | 无「灾备」 | — |
| `GET /status`（正常功能） | 200，不受影响 | 200 |

对照实验很关键：它证明探针本身能观测到变化，**不是**「测了个寂寞」。

---

## 7. 下一步选项（三选一，建议 A）

### A. 发版（建议）
Phase 1 功能完整、测试全绿、真实 QA 通过，具备发版条件。
按 `AGENTS.md` 的发版流程：
1. bump **四处**版本：`package.json` ≡ `src/index.ts` 的 `PLUGIN_VERSION` ≡
   `package-lock.json` 根对象 `version` ≡ `packages[""].version`；
2. `CHANGELOG.md` 顶部把 `[Unreleased]` 改成实际版本号（CI fail-fast 依赖它）；
3. 确认 `ci.yml` 在 main 上绿，再 push + `git tag -a vX.Y.Z`。

**注意**：并行线也在改同一仓库，发版前先确认它的改动是否要一起走。

### B. P0-4 离线 WebUI
Phase 1 唯一未做的 P0。DSH 完全起不来时的浏览器兜底。
- 可复用 `src/core/`（已与 DSH 解耦，`src/cli/index.ts` 已证明零 `@deepseek-ai/*` 可行）；
- **不要**重复竞品的错误：它的离线 CLI/GUI 是 Windows-only（WinForms + P/Invoke），
  建议**先做全平台 WebUI**；
- 路由命名要与 host 侧 `/api/dsh-config-manager/*` 区分。

### C. UI 细节打磨
- 灾备页目前未做浏览器截图验收（上一轮环境无 browser provider）；
- 建议用 `browser_screenshot(savePath)` + `read_image` 走原生视觉链
  （**不要**用 `vision_*` 系列）。

---

## 8. 不要做的事

1. **不要**复制竞品的 `apply-dsh-patches.ps1`（改写 DSH 安装包源码）——
   那是它最脆弱的承重墙，任何 DSH 升级都会失效。
2. **不要**把救援路由放进 mutation gate（§3.4 的死锁）。
3. **不要**复用 `PanelId` 的 `'recovery'`（§5.1）。
4. **不要**在 `src/client/` 里加运行时 `node:` 依赖（§5.4）。
5. **不要**动并行线的文件（§6）。
6. **不要**在没跑过 `npm test` + `npm run build` 的情况下声称完成——
   `lib/` 未纳入 git，客户端缺陷**只在真实构建后暴露**。

---

## 9. 竞品对照（结论摘要）

竞品 `dsh-undo-savepoint`（GitHub `lire1131/dsh-undo-savepoint`，master v0.4.7）：

- **它强在**：单点体验（自动存档 / 一键撤销 / SAFE MODE / 离线 GUI），
  以及「DSH 挂了也能自救」的情感定位；
- **它弱在**：PS/Node 引擎**双实现漂移**（实测 7 处分歧，2 处是数据安全问题）、
  离线栈实为 **Windows-only**、**monkey-patch DSH 安装包**、
  PowerShell 全栈**零测试覆盖**、ZIP 导入导出零覆盖、无并发锁；
- **你的护城河**：配置模型（14 适配器）、同步引擎、市场三层信任、journal 状态机 ——
  这些是**架构级资产**，对方追赶成本是重写而非打补丁。

Phase 1 补齐的是**入场券**（Layer 1），不是差异化。差异化在 Layer 2/3（迁移/同步/市场/Profile）。
