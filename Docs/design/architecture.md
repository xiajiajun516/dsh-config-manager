# DSH Config Manager 架构设计文档（m2-design）

> 版本：v1.0（对应 Export Schema v1）
> 依据：`Docs/DSH Config Manager.txt`（产品规范）+ `Docs/research/dsh-architecture.md`（m1 研究报告，全部真实能力核查）
> 原则：**宁缺毋滥，不编造 API，不破坏用户现有配置**。本文所有数据源、API、限制均来自研究报告 §2/§3/§4 的真实结论。
> 读者：m3（核心引擎）、m5（适配器）、m6（UI）等下游模块；实现时以本文 §12 类型清单为契约。

---

## 0. 设计基线（来自 m1 研究，硬约束）

| 事实 | 设计影响 |
|---|---|
| 配置主存储 = `~/.dsh/settings.yaml`（namespace 分区、热重载、乐观锁 revision、comment-preserving diff 写入） | 导出走 `ctx.settings.describe({redactSecrets:true})`；导入走 `update/replace` + `expectedRevision` |
| Secrets = `~/.dsh/.credentials.yaml`（明文，CredentialRef→string；`ctx.credentials` 永不回读值） | 默认不导出值，只导出状态；加密备份才导出，且只能解密后经 `credentials.set()` 写回 |
| MCP 无 settings 面、无管理 API，配置在组合 patch 的 `dsh-mcp-client` config 里 | MCP 作为「组合 config 条目」导入：写 profile `cordis.patch.yml`，`needsRestart` |
| 插件树 = profile `package.json`（dependencies+bundles）+ 多层 `cordis.patch.yml`；`pluginMarketplace.installPlugin` 返回 `needsRestart` | 插件迁移 = 清单 + 安装调用 + 重启提示；**绝不打包插件二进制** |
| Workspaces = `~/.dsh/storages/workspace.json`，path 为**绝对路径** | 跨设备必须路径映射（重点） |
| Keybindings / Workflows 配置文件 / Commands 存储 / Rules 文件：**DSH 中不存在** | 对应分区不实现，文档明确标注，禁止发明 |
| UI 偏好一半在 settings namespace、一半在浏览器 localStorage（Host 无通道） | ui 分区只迁可迁移部分，localStorage 明确声明不迁移 |
| `~/.dsh/.anonymous-user-id` 设备 ID、sessions（zstd jsonl）、logs/cache | 默认不导出 |
| DSH Plugin API 无 backup/import/export/migration/transaction | 全部由本插件自建（Export Schema / ImportPlan / 快照 / 应用层事务） |

---

## 1. Export Schema（ZIP 内部结构，v1）

### 1.1 设计原则

1. **不整包复制 `~/.dsh`**（规范 §34.20）；按「真实配置类别」分区收集。
2. **不重复存储**：每份数据只落一个文件；settings 与 ui 按 namespace 互斥切分（见 §4）。
3. 结构与研究报告 §2.2 真实存储一一对应，删掉 DSH 不存在的概念（keybindings/workflows/commands/rules 文件），合并天然一体的数据（providers 与 models 同在一个 settings section）。
4. 所有文件相对 ZIP 根存放；解压必须限制在受控临时目录（§9 安全）。

### 1.2 目录结构（v1）

```text
dsh-config-2026-08-14.zip
├── manifest.json                  # §2：元信息（schemaVersion/source/sections/security）
├── config/
│   ├── settings.json              # 非 UI 类 settings namespace（redacted + revision + applies 元数据）
│   └── ui.json                    # UI 类 namespace（pet/dsh-better-sidebar/remote-web-ui/ui-onboarding/skin…）
│                                  #   + uiMigrationNotes[]（localStorage 不可迁移项说明，纯说明不含值）
├── ai/
│   └── providers.json             # llm-deepseek / llm-pi-ai section（providers/models/默认模型/别名/参数/baseURL）
│                                  #   —— providers 与 models 不拆两文件（真实存储同 section）
├── plugins/
│   ├── plugins.json               # 插件清单：name/version/isBundle/inBundles/enabled/fiberPhase
│   └── patch.json                 # 用户 patch 层（profile cordis.patch.yml + ~/.dsh/cordis.patch.yml 合并表示）
├── mcp/
│   └── servers.json               # 从组合 patch 提取的 dsh-mcp-client 条目（serverName/command/args/env/cwd 或 url/headers）
├── custom/
│   ├── prompts.json               # 从 patch config 提取的 systemPrompt persona / plan-mode section（带来源行 id）
│   └── skills/                    # ~/.dsh/skills/ 用户技能（flat .md + 目录 bundle，文件级复制）
├── agents/
│   └── presets/                   # ~/.dsh/.agent-presets/ 用户预设（agent.cordis.yml + preset.yml）
├── workspaces/
│   └── workspaces.json            # storages/workspace.json 的 tables.workspaces（含绝对 path → 路径映射）
├── plugin-files/                  # 可选分区：插件自有配置文件（dsh-ssh.json、pet.json 等，文件级）
│   └── <plugin-id>/…
├── security/
│   ├── credentials.json           # 凭据/敏感环境变量状态：{ref, required, configured, source, hasValue}，永不含值
│   └── secrets.enc                # 仅加密备份模式存在：加密后的 .credentials.yaml 副本（AES-256-GCM）
└── integrity/
    └── checksums.json             # 每个导出文件的 SHA-256（相对 ZIP 根路径 → hash）
```

### 1.3 与规范示例的差异及理由

| 规范建议 | v1 决定 | 理由（研究报告） |
|---|---|---|
| `config/keybindings.json` | 无 | DSH 无 keybinding 概念（§2.2），禁止发明 |
| `ai/providers.json` + `ai/models.json` | 合并为 `ai/providers.json` | models 是 llm section 内字段，拆开即重复存储 |
| `custom/rules/` `custom/commands/` | 无 | 无独立文件；AGENTS.md 属项目文件不迁移；commands 由插件运行时注册 |
| `workflows/workflows.json` | 无 | dsh-workflow 是运行时 JS 工具，无 workflow 配置文件可迁移 |
| `custom/agents/` | 独立为 `agents/presets/` | 对应 `~/.dsh/.agent-presets/`（agentPresets 真实存在） |
| 无 credentials 状态文件 | 新增 `security/credentials.json` | 「3 credentials need attention」的信息来源（§5 秘密模型） |
| `security/secrets.enc` | 保留 | 仅加密备份模式生成（§7） |
| 无插件自有文件 | 新增 `plugin-files/`（可选） | dsh-ssh.json 等插件自有配置真实存在（§2.2） |
| 无 ui 说明 | `ui.json` 内嵌 `uiMigrationNotes` | localStorage 部分 Host 不可读，需显式告知用户 |

### 1.4 文件名与节选策略

- 文件名：`dsh-config-<yyyy-MM-dd>.zip`（可选追加时间戳/序号防覆盖）。
- sections 开关（manifest 里全量声明，false 的分区不写入 ZIP）。
- 可选分区（pluginFiles/sessions）默认 false；用户勾选后写入。

---

## 2. Manifest Schema（v1）

### 2.1 结构定义

```jsonc
{
  "schemaVersion": 1,                    // Export Schema 版本，独立于 DSH 版本（§8）
  "exporter": {
    "name": "DSH Config Manager",
    "version": "0.1.0"                    // 插件自身版本
  },
  "source": {
    "dshVersion": "0.1.0-rc.6",           // 来源 DSH 版本（host.describe / package.json）
    "platform": "win32",                  // process.platform
    "arch": "x64"                         // process.arch
  },
  "exportedAt": "2026-08-14T12:00:00.000Z", // ISO-8601 UTC
  "sections": {                           // 与 ZIP 分区一一对应；false 的分区不写入
    "settings": true,
    "ui": true,
    "providers": true,
    "plugins": true,
    "mcp": true,
    "prompts": true,
    "skills": true,
    "agentPresets": true,
    "workspaces": true,
    "pluginFiles": false,
    "credentialsStatus": true,            // security/credentials.json
    "secrets": false,                     // security/secrets.enc 是否含真实秘密
    "sessions": false
  },
  "security": {
    "containsSecrets": false,             // 任何真实秘密值是否被包含（含 secrets.enc）
    "encrypted": false,                   // secrets.enc 是否存在且加密
    "encryption": null                    // 加密时见 §2.2；密码绝不入 manifest
  }
}
```

### 2.2 加密时的 security 段

```jsonc
"security": {
  "containsSecrets": true,
  "encrypted": true,
  "encryption": {
    "algorithm": "aes-256-gcm",
    "kdf": "scrypt",
    "kdfParams": { "N": 16384, "r": 8, "p": 1, "keyLength": 32 },
    "salt": "<base64>",                   // 每次导出随机
    "iv": "<base64>",                     // GCM 每次随机
    "authTag": "<base64>",
    "version": 1
  }
}
```

> **密码不进 manifest**：加密密码只存在于用户记忆/导出时输入框；manifest 只记算法参数（salt/iv/authTag 非秘密，用于解密与完整性）。

### 2.3 manifest 的用途

- 判断：谁导出（exporter）、Schema 版本、来源 DSH 版本/平台、时间、包含哪些分区、是否含/加密秘密。
- 导入第一道闸：`schemaVersion` 超出版本链 → 拒绝或提示；`platform` 差异 → 触发跨平台路径分析。

---

## 3. Adapter 架构（统一 ConfigAdapter 接口）

### 3.1 接口设计

所有配置类别实现同一个接口；引擎只依赖接口，不感知具体配置。

```ts
interface ConfigAdapter<TSection = unknown> {
  /** 唯一 id，与 manifest.sections 键对齐（如 'settings' | 'mcp' …） */
  readonly id: SectionId;
  /** 用户可读名称 */
  readonly displayName: string;
  /** Quick Export 默认是否包含 */
  readonly defaultIncluded: boolean;
  /** 迁移类别标记：portable | deviceSpecific | platformSpecific（§11） */
  readonly portability: Portability;

  /** 读取当前 DSH 该类别配置 → 导出数据（无秘密值；返回元数据供 manifest/报告用） */
  export(ctx: HostContext, options: ExportOptions): Promise<ExportSection<TSection>>;

  /** 分析导入数据与目标 DSH 的差异 → 生成该 adapter 的 ImportPlan 项（纯计算，不改数据） */
  analyzeImport(data: TSection, ctx: ImportContext): Promise<PlanItem[]>;

  /** 执行单个计划项（由 Importer 引擎按阶段调度调用） */
  applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult>;

  /** 对导出/导入前的数据做结构校验（schema 完整性、字段类型） */
  validate(data: TSection): Promise<ValidationResult>;

  /** 可选：导入前快照（保存将被改动的目标状态）；缺省用引擎通用快照 */
  snapshot?(targets: SnapshotTarget[]): Promise<SnapshotEntry[]>;

  /** 可选：针对本 adapter 的补偿动作（rollback 时恢复） */
  rollback?(snapshot: SnapshotEntry[], ctx: ImportContext): Promise<void>;
}
```

### 3.2 设计说明

- **analyzeImport 只读**：与 `executeImportPlan` 共享同一份 plan，保证 Dry Run 与真实导入逻辑一致（规范 §10）。
- **引擎驱动**：Importer 引擎负责 校验 → 迁移 → 汇总 plan → 快照 → 按阶段 apply → validate → commit/rollback 的编排；adapter 只提供「自己的数据怎么读/怎么比/怎么写」。
- **冲突与路径映射不落在 adapter 内**：由引擎的 `ConflictResolver` / `PathMapper` 在分析后统一处理（§5/§11），adapter 只报告「差异与写入意图」，不自行决策。

### 3.3 Adapter 清单（v1，以研究报告确认真实分类为准）

| id | 数据源（真实） | 导出 → 文件 | 导入写入通道 | 冲突判定 | 备注 |
|---|---|---|---|---|---|
| `settings` | `ctx.settings.describe({redactSecrets:true})` 非 UI namespace | `config/settings.json` | `ctx.settings.update/replace` + `expectedRevision` | revision 乐观锁（SETTINGS_CONFLICT） | 主配置通道 |
| `ui` | 同上，UI 类 namespace（pet/better-sidebar/remote-web-ui/ui-onboarding/skin…） | `config/ui.json` | 同上 | 同上 | localStorage 项只写说明不迁移（§4.3） |
| `providers` | settings `llm-deepseek`/`llm-pi-ai` section + `ctx.llm.listProviders()` | `ai/providers.json` | settings 写通道（`llm-*` namespace） | revision + section 存在性 | apiKey 经 credentials 状态占位 |
| `plugins` | `ctx.pluginInventory.list()` + `ctx.pluginMarketplace.installed()` + patch 文件 | `plugins/plugins.json` + `plugins/patch.json` | 已装→跳过/更新；未装→`installPlugin(pkg)`；patch 行→写 `cordis.patch.yml` | 包名+版本比对 | 全部 `needsRestart` 提示；不打包二进制 |
| `mcp` | 组合 patch 中 `dsh-mcp-client` 行 config | `mcp/servers.json` | 写 profile `cordis.patch.yml` 插行 | serverName 唯一键 | `needsRestart`；依赖检测（§10.4） |
| `prompts` | patch config 中 systemPrompt persona / plan-mode section | `custom/prompts.json` | 写 patch 或 `ctx.systemPrompt.section` 注册 | 名称+内容 hash | rules/commands 无存储，不实现 |
| `skills` | `~/.dsh/skills/` 文件（flat .md + bundle） | `custom/skills/` | 文件复制到 `~/.dsh/skills/` | 相对路径+内容 hash | `~/.agents/skills`、项目级技能默认不迁 |
| `agentPresets` | `~/.dsh/.agent-presets/`（用户可写目录） | `agents/presets/` | 文件复制 + `ctx.agentPresets` 刷新 | 预设名+组合 hash | system 预设（安装目录）只记引用不复制 |
| `workspaces` | `~/.dsh/storages/workspace.json` 的 `tables.workspaces` | `workspaces/workspaces.json` | `ctx.workspace` / storage 写回 | workspace id 唯一键 | **绝对路径→PathMapping 重点** |
| `credentials` | `ctx.credentials.describe(ref)` 状态 + env 变量名 | `security/credentials.json` | 不写值；生成 MissingSecret 清单，用户经 `credentials.set()` 补录；加密备份时解密后自动 set | ref 名唯一 | 永不导出值（§7） |
| `pluginFiles`（可选） | 插件自有文件（dsh-ssh.json、pet.json…） | `plugin-files/<id>/…` | 文件复制 | 相对路径 | 白名单插件列表 |
| `sessions`（默认关） | `~/.dsh/sessions/<projectKey>/<sessionId>/` | `sessions/<projectKey>/<sessionId>/…` | 文件复制 | 会话 id | zstd jsonl；v1 可仅实现清单，默认 false |

> **明确不实现的 adapter**（研究报告确认 DSH 无对应概念）：`keybindings`、`workflows`、`commands`、`rules`（无独立文件）。manifest 中不出现这些 section；产品 UI 中说明「DSH 当前无此配置」而非静默缺失。

---

## 4. Export / 分区细节

### 4.1 settings 与 ui 的互斥切分（避免重复存储）

- 引擎维护一份 **UI namespace 名单**（`src/adapters/ui/known-ui-namespaces.ts`，按插件 id 前缀匹配：`pet`、`dsh-better-sidebar`、`remote-web-ui`、`ui-onboarding`、`dsh-client-ui-*`、`*skin*` 等，随新插件可扩展）。
- `settings` adapter 导出名单**以外**的 namespace；`ui` adapter 导出名单**以内**的 namespace。
- 两文件互斥并集 = 全部设置；导入时各自写回，无重复。
- 名单变更只影响「某一 namespace 归哪一边」，不影响数据完整性。

### 4.2 每个 namespace 的导出记录（settings.json 内）

```jsonc
{
  "version": 1,
  "namespaces": {
    "llm-deepseek": {
      "value": { …redacted… },        // describe({redactSecrets:true}) 后的 user 值
      "base": { … },                   // 基线值（用于导入时判断「是否用户自定义」）
      "revision": 12,                  // 乐观锁版本 → 导入冲突检测
      "applies": ["default"],          // 生效作用域
      "secrets": [ { "path": ["apiKeyEnv"], "set": true } ]  // 秘密位置标记（值剥离）
    }
  }
}
```

### 4.3 ui.json 内嵌说明（localStorage 不迁移声明）

```jsonc
{
  "namespaces": { "pet": { … }, "dsh-better-sidebar": { … } },
  "uiMigrationNotes": [
    {
      "plugin": "dsh-task-board",
      "storage": "localStorage",
      "key": "dsh.taskBoard.v1",
      "migratable": false,
      "reason": "Host 侧无通道访问浏览器 localStorage，需在目标机器重新配置"
    }
  ]
}
```

### 4.4 导出流程（核心引擎）

```text
SettingsService.describe(redact) ─┐
  → 按 UI 名单切分 settings/ui     │
plugins: inventory+installed+patch ├→ 各 adapter.export() → ExportSection[]
mcp: 组合 patch 提取                │   （每段过 SecretScanner，§6）
skills/agentPresets/workspaces: 文件├→ ZIP writer（deflate，路径白名单）
credentials: describe 状态          │→ integrity/checksums.json（SHA-256）
sessions/pluginFiles: 可选          ┘→ manifest.json → 校验 → 落盘
```

---

## 5. ImportPlan 模型（三段式）

### 5.1 三段式

```text
analyzeImport()          → ImportAnalysis（校验、迁移、逐 adapter 差异分析、路径/依赖/秘密检测）
createImportPlan()       → ImportPlan（合并所有 adapter 的 PlanItem + 冲突决策 + 路径映射结果）
executeImportPlan()      → ImportResult（快照 → 分阶段 apply → validate → commit/rollback）
```

- `analyzeImport` 与 `createImportPlan` **纯计算，零写入**（Dry Run 直接复用）。
- `createImportPlan` 接受用户在 UI 的冲突决策与路径映射作为输入，输出**最终可执行计划**。

### 5.2 计划项分类（十类，规范 §26）

```ts
type PlanItemKind =
  | 'Create'            // 目标不存在，新建（prompt/skill/preset/workspace/mcp…）
  | 'Update'            // 目标存在且不同，按策略更新
  | 'Skip'              // 目标已存在且一致（幂等），或用户选择跳过
  | 'Conflict'          // 目标存在且不同，待用户决策（Keep Current / Use Imported / Review）
  | 'Install'           // 插件安装（未安装的 bundle/包）
  | 'MissingSecret'     // 导入后需补录的凭据（占位，不阻塞其他项）
  | 'MissingDependency' // 依赖缺失（npx/python…）→ 该项标记 Requires Attention
  | 'PathMapping'       // 路径需映射（workspace 绝对路径 / MCP cwd / 插件配置路径）
  | 'Warning'           // 不阻塞告警（版本差异、localStorage 不可迁移…）
  | 'Error'             // 该项不可导入（格式错误/安全拒绝/不可兼容）→ 单项失败不拖垮整体
```

### 5.3 PlanItem 结构

```ts
interface PlanItem {
  id: string;                 // 稳定项 id（如 plugin:pkg-name / prompt:Coding Assistant / workspace:<id>）
  kind: PlanItemKind;
  adapter: SectionId;         // 归属 adapter
  description: string;        // 用户可读描述
  detail?: string;            // 补充（当前值 vs 导入值摘要）
  severity: 'info' | 'warning' | 'error';
  conflict?: ConflictDecision;    // kind=Conflict 时的用户决策（§6）
  pathMapping?: PathMapping;      // kind=PathMapping 时的新路径（§11）
  missingDependency?: string;     // kind=MissingDependency 时的依赖名
  target?: SnapshotTarget;        // 该项将修改的目标（用于快照登记）
}
```

### 5.4 执行阶段（executeImportPlan 内部，规范 §27 事务思想）

```text
Phase 0  Preflight    — 完整性校验（checksums）、schema 迁移、兼容性计算、ZIP 安全扫描（§9）
Phase 1  Snapshot     — 收集所有将被修改目标的原值（settings ns/credentials refs/patch 行/文件）
Phase 2  Apply        — 按依赖顺序执行各项：
                         settings → ui → providers → prompts → skills → agentPresets
                         → workspaces → pluginFiles → mcp(patch) → plugins(install) → credentials(补录/解密)
Phase 3  Validate     — 逐项校验 + 整体校验（settings 可 describe 回读、文件存在性）
Phase 4  Commit       — 写导入记录（成功标记、plan 副本、备份 zip 引用）
任何 Phase 2/3 错误    → 回滚（§8）
```

- **插件安装 / MCP patch 写入在最后**（副作用最大、需重启，且失败不影响已落盘的配置）。
- 每个 adapter 的 applyItem 失败 → 该项标记 `Error`，其余项继续；**非关键项失败不得导致可恢复内容永久丢失**（规范 §34.17）。
- 幂等性：重复导入同一 ZIP 时，`Create` 变 `Skip`/`Update`（按 id 匹配，§5.5）。

### 5.5 幂等匹配策略（规范 §31）

| 类别 | 唯一键 | 说明 |
|---|---|---|
| 插件 | `name`（包名） | `inBundles`/版本比对 |
| MCP | `serverName` | 组合 config 行 |
| Prompt | `name` | 内容 hash 辅助判断 |
| Skill / Preset | 相对路径 / 预设名 | 内容 hash 辅助 |
| Workspace | `id`（或 path 映射后） | id 优先，path 兜底 |
| Credential | `ref` 名 | describe 状态比对 |

---

## 6. Conflict 模型

### 6.1 全局策略（规范 §11）

```ts
type GlobalConflictStrategy = 'merge' | 'replace' | 'skipExisting';
```

- `merge`（默认）：目标原配置保留，导入项合并/追加；逐项冲突走单项决策。
- `replace`：导入覆盖目标对应项（仅限导入数据存在项；**不删除 ZIP 没有的东西**，除非 Mirror 模式，规范 §32）。
- `skipExisting`：已存在的项一律不动（`Conflict` 项自动变 `Skip`）。

### 6.2 单项决策

```ts
type ItemResolution = 'keepCurrent' | 'useImported' | 'review';
```

- 冲突项展示「当前值 vs 导入值」对比（含各自更新时间/来源），由用户选。
- `review` = 保留为待定，导入前必须解决，否则该项按 `skipExisting` 兜底并在报告中列明。

### 6.3 冲突检测机制（结合研究报告）

| 数据 | 检测机制 |
|---|---|
| settings namespace | **`expectedRevision` 乐观锁**：导出记录里的 revision vs 导入时当前 revision；不一致 → `SETTINGS_CONFLICT` → 该项进入 `Conflict`，UI 展示差异（describe 两次取值 diff） |
| 文件类（skills/presets/pluginFiles/sessions） | 目标文件存在性 + mtime/hash 比对；hash 一致 → `Skip`（幂等） |
| 插件 | 包名 + 已装版本比对：同版本 `Skip`，不同版本 `Conflict`（建议 keep/update），未装 `Install` |
| MCP / Prompt / Workspace | 唯一键存在性 + 内容 hash：存在且同 → `Skip`；存在且不同 → `Conflict`；不存在 → `Create` |

> **核心决策**：`settings` 冲突判定以**导出时记录 revision** 为基准，写入时用 `expectedRevision` 提交；若导入期间目标被并发修改，DSH 返回 `SETTINGS_CONFLICT`，该 namespace 标记 `Error` 并在报告中提示重试/查看，**绝不覆盖用户并发修改**。

---

## 7. Secret 模型

### 7.1 默认行为：只导状态，不导值（规范 §5）

`security/credentials.json` 每项：

```jsonc
{
  "ref": "DEEPSEEK_API_KEY",
  "required": true,          // 从使用方 settings 的 secrets[].set / llm section apiKeyEnv 推断
  "configured": true,        // 导出时是否有值（credentials.describe().configured）
  "source": "env | file | projectEnv",  // describe 返回，不泄值
  "hasValue": false          // 占位：值未导出
}
```

- 导入后生成 `MissingSecret` 清单：「3 credentials need attention: …」，UI 提供输入框 → `ctx.credentials.set(ref, value)`（写入 `.credentials.yaml` 明文——**这是 DSH 现有存储机制**，本插件不改变它，只在 UI/日志中避免展示值）。

### 7.2 敏感字段扫描（Sensitive Data Scanner，规范 §6）

- 对导出前的**所有数据段**递归扫描，字段名（大小写不敏感）命中黑名单：`password/passwd/token/accessToken/refreshToken/apiKey/apikey/secret/credential/authorization/cookie/privateKey/clientSecret` → 值剥离、标记、计入导出报告。
- 命中即按秘密处理（不导出值）；日志中一律 `***REDACTED***`（§10.5）。
- `ctx.settings.describe({redactSecrets:true})` 已剥离 DSH 已知秘密，扫描器作为第二道防线兜底插件自定义字段。

### 7.3 加密完整备份（可选，规范 §7）

- 用户显式勾选「Include secrets」→ 必须设置 Backup Password（强度校验），并显示警告。
- 方案：**`node:crypto` scrypt + AES-256-GCM，零新增依赖**：
  1. 随机 salt（16B）→ `crypto.scryptSync(password, salt, 32, {N:16384,r:8,p:1})` 派生 key；
  2. 随机 iv（12B）→ `crypto.createCipheriv('aes-256-gcm', key, iv)` 加密 `.credentials.yaml` 原文（含全部 CredentialRef→value）；
  3. 密文 + authTag 写入 `security/secrets.enc`（二进制格式：`magic(4B) + version(1B) + salt + iv + authTag + ciphertext`）；
  4. manifest.security 记算法参数（§2.2），**密码不入 manifest、不入任何 DSH 配置**。
- 导入含 secrets.enc 时：用户输入密码 → 解密 → 校验 authTag → 逐 ref `ctx.credentials.set()`；密码错误 = `Error` 且**不写任何凭据**。
- 第一版若时间紧，可先只支持「不导值 + 状态补录」（安全兜底），加密备份作为 P1 增强——**宁可不支持也不明文泄密**。

### 7.4 导入秘密的策略矩阵

| 备份类型 | 导入行为 |
|---|---|
| 普通备份（无 secrets.enc） | 全部 `MissingSecret` → 用户补录 |
| 加密备份 + 用户输入正确密码 | 自动 `set` 恢复（用户可在预览时勾选「逐条确认」） |
| 加密备份 + 用户选择不输密码 | 同普通备份：状态补录 |

---

## 8. Snapshot / Rollback（应用层事务）

### 8.1 Snapshot 模型

导入执行前（Phase 1）生成，**只保存将被本次操作修改的目标**（规范 §16）：

```ts
interface Snapshot {
  id: string;                    // 快照 id（随机），随导入记录落盘
  createdAt: string;
  sourceZip: string;             // 来源备份文件（复制到快照目录，可整体回退）
  entries: SnapshotEntry[];      // 见下
}

type SnapshotEntry =
  | { kind: 'settingsNamespace'; adapter: 'settings'|'ui'|'providers'; namespace: string;
      before: unknown; revision: number }
  | { kind: 'credential'; ref: string; action: 'set'|'unset'; existed: boolean }
  | { kind: 'patchLine'; file: string; lineId: string; before: unknown }   // cordis.patch.yml 行原值
  | { kind: 'file'; path: string; contentHash: string; copiedTo: string }  // skills/presets/pluginFiles/sessions 原文件副本
  | { kind: 'workspaceRecord'; id: string; before: unknown };
```

存储位置：`~/.dsh/dsh-config-manager/snapshots/<snapshotId>/`（插件自有数据目录，参照 dsh-ssh.json 先例）。

### 8.2 回滚流程

```text
Importer.fail(reason)
  → 逆序执行 entries 的补偿动作：
     settingsNamespace → settings.replace(namespace, before, expectedRevision=当前)
     credential        → existed ? set(before) : unset(ref)
     patchLine         → 写回原行（或删除插入行）
     file              → 从 copiedTo 复制回原路径
     workspaceRecord   → storage 写回 before
  → 生成 RollbackReport：
      { full: true } 或
      { full: false, restored: […], failed: [{item, reason, manualHint}] }
```

- **尽力回滚**：单项补偿失败不停止其余补偿；最终必须诚实报告 `Rollback partially completed` 与需人工恢复清单（规范 §17）。
- settings 回滚同样走 `expectedRevision`，避免覆盖导入之后用户的新修改（若冲突，标记该 namespace 需人工处理）。

### 8.3 与 DSH 无事务能力的对齐

研究报告 §4.8：DSH 无跨配置事务 → 本设计即规范 §27 预判的「应用层 transaction / compensating actions」，全部基于可逆操作（记录 before + 逆序补偿）。

---

## 9. 安全（ZIP 为不可信输入，规范 §19）

导入路径全流程防线（`src/security/`）：

1. **Zip Slip / 绝对路径**：每个条目 `path.resolve(unzipDir, entryName)` 后必须 `startsWith(unzipDir + sep)`；拒绝 `..`/绝对路径/盘符。
2. **Symlink / Junction**：拒绝符号链接条目（不跟随，不创建）。
3. **Zip Bomb / 超大**：解压前检查压缩比（累计解压体积上限，如 500MB）与条目数上限（如 10k）；流式解压边解边计。
4. **Malformed ZIP**：解压库解析失败即整体拒绝，不部分导入。
5. **JSON 深度攻击**：解析器限制嵌套深度（如 ≤64）。
6. **非预期 executable**：ZIP 内发现可执行文件 → 警告并列入黑名单（本插件不执行 ZIP 内任何脚本；只解析数据文件）。
7. **完整性**：`integrity/checksums.json` 逐一 SHA-256 校验，不匹配 → `Backup integrity check failed`，禁止继续（除非高级恢复模式，默认关闭）。
8. **Redaction**：所有日志经 `redact()`（字段名黑名单 → `***REDACTED***`），见 §10.5。

---

## 10. Migration（Schema 版本独立演进）

### 10.1 原则（规范 §4）

- `schemaVersion` 独立于 DSH 版本：只描述**本插件 Export Schema** 的版本。
- 迁移逻辑集中在 `src/migrations/`，UI/业务代码**零版本判断**（通过 `migrateToCurrent()` 统一入口）。
- 迁移是纯函数式转换（输入旧结构 → 输出新结构），不触碰目标 DSH。

### 10.2 迁移链

```text
src/migrations/
├── index.ts            # registry: { from: number, to: number, migrate: (doc) => doc }[]，按序应用
├── v1-to-v2/
│   ├── index.ts
│   └── v1-to-v2.test.ts
└── v2-to-v3/           # 未来占位
```

- 导入时：`schemaVersion === CURRENT` → 直接用；`< CURRENT` → 沿迁移链逐级升级；`> CURRENT` → `Error`（需升级插件，规范「Newer unsupported schema」）。
- 迁移输出做 `validate` 后进入正常导入流程。

### 10.3 版本判定集中

- `src/schema/versions.ts`：`CURRENT_SCHEMA_VERSION`、`SUPPORTED_RANGE`、`isSupported()`、`needsMigration()`。
- 任何模块不得自行 `if (v === 1)` 散落判断。

---

## 11. 跨平台与路径映射

### 11.1 平台差异处理（规范 §13）

- 路径处理一律 `node:path`（不硬编码分隔符）；导出时记录 `source.platform/arch`，导入时比对目标。
- 平台相关项标记：

```ts
type Portability = 'portable' | 'deviceSpecific' | 'platformSpecific';
```

| 类别 | 标记 |
|---|---|
| settings / providers / prompts / skills / agentPresets | `portable` |
| workspaces（绝对 path）/ MCP cwd / env 引用 | `platformSpecific`（需映射） |
| 设备 ID / sessions / 插件自有缓存类文件 | `deviceSpecific`（默认不迁） |

- Quick Export 默认只迁 `portable`；`platformSpecific` 走路径映射；`deviceSpecific` 默认关。

### 11.2 路径映射模型（重点：workspace.json 绝对路径）

```ts
interface PathMapping {
  oldPrefix: string;      // 导出端根前缀，如 C:\Users\alice\projects
  newPrefix: string;      // 导入端映射前缀，用户经 api.host.pickDirectory() 选择
  appliesTo: ('workspaces'|'mcp'|'pluginConfig'|'skills')[];  // 应用范围
}

interface PathIssue {
  kind: 'missing' | 'platformMismatch' | 'homeMismatch';
  value: string;          // 原绝对路径
  mappedTo?: string;      // 映射后路径（UI 确认后填充）
}
```

- 检测：所有导出数据中的绝对路径（workspace `path`、MCP `cwd`/`command`、插件配置中的目录引用）→ 不存在或 OS 形态不符 → `PathMapping` 计划项。
- 支持**批量前缀映射**（规范 §12）：`C:\Users\alice\` → `/Users/bob/` 一次替换全部相关路径；映射在 `createImportPlan` 阶段应用到所有数据，`applyItem` 拿到的已是映射后数据（PathMapper 先行）。
- 映射结果持久化到插件配置（`~/.dsh/dsh-config-manager/path-mappings.json`），下次导入可复用。

---

## 12. 模块结构与数据流

### 12.1 目录结构（对齐规范 §25 + 研究报告 §5.1）

```text
packages/dsh-config-manager/
├── src/
│   ├── index.ts                  # Host 半入口：settings.section 声明、/api/dsh-config-manager 路由、
│   │                             #   ctx.commands（/export）、依赖注入、配置注册
│   ├── core/
│   │   ├── exporter.ts           # 导出编排：adapter 收集 → secret 扫描 → checksums → manifest → ZIP
│   │   ├── importer.ts           # 导入编排：ZIP 读入 → 安全校验 → 迁移 → analyze → plan → snapshot → execute → rollback
│   │   ├── analyzer.ts           # analyzeImport：差异/路径/依赖/秘密检测（纯函数）
│   │   ├── planner.ts            # createImportPlan：汇总 PlanItem + 冲突决策 + 路径映射
│   │   ├── executor.ts           # executeImportPlan：Phase0-4 调度
│   │   ├── validator.ts          # 整体校验（schema、完整性、兼容性评分）
│   │   ├── backup.ts             # Pre-import snapshot 生成/落盘
│   │   ├── rollback.ts           # 补偿动作执行 + 回滚报告
│   │   └── compatibility.ts      # 兼容性评分（Excellent/Good/Partial/Unsupported，规则驱动）
│   ├── schema/
│   │   ├── manifest.ts           # Manifest 类型 + zod/schemastery schema + 解析
│   │   ├── config.ts             # 各分区数据结构类型（settings/providers/mcp/…）
│   │   ├── versions.ts           # CURRENT_SCHEMA_VERSION / isSupported / needsMigration
│   │   └── types.ts              # 共享类型（§13 中与 DSH 无关的纯类型）
│   ├── migrations/               # §10
│   │   ├── index.ts
│   │   └── v1-to-v2/
│   ├── security/
│   │   ├── secret-scanner.ts     # 敏感字段扫描（递归、黑名单、值剥离）
│   │   ├── encryption.ts         # scrypt + AES-256-GCM（§7.3）
│   │   ├── integrity.ts          # SHA-256 checksums 生成/校验
│   │   ├── zip-security.ts       # §9 解压安全（slip/bomb/symlink/深度/条目数）
│   │   └── redaction.ts          # 日志 redact
│   ├── adapters/
│   │   ├── types.ts              # ConfigAdapter 接口 + HostContext/ImportContext 类型
│   │   ├── settings.ts
│   │   ├── ui.ts                 # 含 known-ui-namespaces 名单
│   │   ├── providers.ts
│   │   ├── plugins.ts
│   │   ├── mcp.ts
│   │   ├── prompts.ts
│   │   ├── skills.ts
│   │   ├── agent-presets.ts
│   │   ├── workspaces.ts
│   │   ├── credentials.ts
│   │   ├── plugin-files.ts       # 可选
│   │   ├── sessions.ts           # 默认关
│   │   └── index.ts              # registry：adapter 列表（导出顺序即导入阶段顺序的参考）
│   ├── profiles/                 # 配置 Profile（规范 §20，Phase 6；v1 只留目录与类型占位）
│   ├── zip/                      # ZIP 读写封装（node:zlib 或 fflate，见研究报告 §5.2 由 m3 定）
│   ├── utils/
│   │   ├── paths.ts              # 路径规范化/前缀映射/平台判定（node:path 唯一出口）
│   │   ├── hashing.ts            # SHA-256/内容 hash
│   │   ├── yaml.ts               # js-yaml 封装
│   │   └── ids.ts                # 稳定 id 生成
│   └── client/                   # React UI（dsh-ssh 双半范式）：settings.section 页 + 进度/预览/冲突/结果视图
├── cordis.patch.yml              # 挂载行
├── package.json / tsconfig / tsdown.config.ts
└── tests/                        # vitest（规范 §33 场景全覆盖，见 §14）
```

### 12.2 数据流总览

```text
EXPORT:
  adapters.export(ctx) → ExportSection[] → SecretScanner 剥离/标记 → ZipWriter（分区分文件）
  → checksums.json → manifest.json → 校验 → dsh-config-*.zip
        ▲
        └── 报告：Included/Excluded/Security/File（规范 §21）

IMPORT:
  ZIP → zip-security 解压到临时目录 → integrity 校验 → manifest 解析
  → versions.isSupported? → migrations.migrateToCurrent()
  → 逐 adapter analyzeImport → ImportAnalysis
  → （用户：冲突决策 + 路径映射 + 秘密补录意向）
  → planner.createImportPlan → ImportPlan（预览，规范 §10/§22）
  → 用户确认 → backup.createSnapshot → executor.executeImportPlan（Phase0-4）
  → validate → commit（成功）｜rollback（失败）→ ImportResult 报告
```

---

## 13. TypeScript 契约清单（m3/m5 直接照做的接口）

> 所有类型放 `src/schema/types.ts` 与 `src/adapters/types.ts`；DSH Service 类型（settings/credentials 等）以 `@deepseek-ai/dsh-*` 包真实导出为准，m3 实现时按研究报告 §3 核对签名，**禁止编造**。

### 13.1 核心领域类型（schema/types.ts）

```ts
// —— Export Schema / manifest ——
export type SectionId =
  | 'settings' | 'ui' | 'providers' | 'plugins' | 'mcp' | 'prompts'
  | 'skills' | 'agentPresets' | 'workspaces' | 'pluginFiles'
  | 'credentialsStatus' | 'secrets' | 'sessions';

export interface Manifest {
  schemaVersion: number;
  exporter: { name: string; version: string };
  source: { dshVersion: string; platform: NodeJS.Platform; arch: string };
  exportedAt: string;                       // ISO-8601
  sections: Record<SectionId, boolean>;
  security: {
    containsSecrets: boolean;
    encrypted: boolean;
    encryption: EncryptionInfo | null;
  };
}

export interface EncryptionInfo {
  algorithm: 'aes-256-gcm';
  kdf: 'scrypt';
  kdfParams: { N: number; r: number; p: number; keyLength: number };
  salt: string;                             // base64
  iv: string;                               // base64
  authTag: string;                          // base64
  version: number;
}

// —— 导出分区数据 ——
export interface NamespaceRecord {
  value: unknown;                           // redacted user 值
  base?: unknown;
  revision: number;
  applies?: string[];
  secrets: { path: string[]; set: boolean }[];
}

export interface SettingsSection { version: 1; namespaces: Record<string, NamespaceRecord>; }

export interface UiSection {
  version: 1;
  namespaces: Record<string, NamespaceRecord>;
  uiMigrationNotes: { plugin: string; storage: string; key: string; migratable: false; reason: string }[];
}

export interface ProviderEntry {
  route: string;
  apiKeyEnv?: string;                       // 只记名字，值在 credentials
  displayName?: string;
  baseURL?: string;
  models?: unknown[];
  modelOverrides?: unknown;
  reasoning?: unknown;
  transport?: unknown;
  retryPolicy?: unknown;
}
export interface ProvidersSection { version: 1; providers: Record<string, ProviderEntry>; }

export interface PluginEntry {
  name: string;                             // 包名
  version: string;
  isBundle: boolean;
  inBundles: string[];                      // 所属 bundle 列表
  enabled: boolean;
  fiberPhase?: string;
}
export interface PluginsSection {
  version: 1;
  plugins: PluginEntry[];
  patch: { file: string; lineId: string; raw: unknown }[];  // 用户 patch 行
}

export interface McpServerEntry {
  serverName: string;
  type: 'stdio' | 'streamable-http';
  command?: string; args?: string[]; env?: Record<string, string>; cwd?: string;
  url?: string; headers?: Record<string, string>;
}
export interface McpSection { version: 1; servers: McpServerEntry[]; }

export interface PromptEntry { id: string; name: string; kind: 'systemPrompt' | 'planMode'; text: string; sourceLineId?: string; }
export interface PromptsSection { version: 1; prompts: PromptEntry[]; }

export interface WorkspaceRecord { id: string; path: string; title?: string; sessionIds: string[]; createdAt?: string; updatedAt?: string; }
export interface WorkspacesSection { version: 1; workspaces: WorkspaceRecord[]; }

export interface CredentialStatus {
  ref: string;
  required: boolean;
  configured: boolean;
  source?: 'env' | 'file' | 'projectEnv' | 'other';
  hasValue: boolean;                        // 恒 false（未导出值）
}
export interface CredentialsSection { version: 1; credentials: CredentialStatus[]; }
```

### 13.2 Adapter 契约（adapters/types.ts）

```ts
import type { Manifest, SectionId } from '../schema/types';

export type Portability = 'portable' | 'deviceSpecific' | 'platformSpecific';

export interface ExportOptions { includeSecrets: boolean; only?: SectionId[]; }
export interface HostContext {
  // 由 m3 注入的真实 DSH Service 门面（只暴露本插件用到的叶子方法，见研究报告 §3.2）
  settings: SettingsFacade;
  credentials: CredentialsFacade;
  llm: LlmFacade;
  pluginInventory: PluginInventoryFacade;
  pluginMarketplace: PluginMarketplaceFacade;
  skills: SkillsFacade;
  agentPresets: AgentPresetsFacade;
  workspace: WorkspaceFacade;
  // …
}
export interface ImportContext {
  manifest: Manifest;
  targetPlatform: NodeJS.Platform;
  pathMappings: PathMapping[];              // 已由 PathMapper 应用到 data
  resolutions: Record<string, ItemResolution>;   // conflict 决策
  secretInputs: Record<string, string>;           // 用户补录（仅内存）
  decryptedCredentials?: Map<string, string>;    // 加密备份解密结果（仅内存）
  log: (level: LogLevel, msg: string) => void;
}

export interface ExportSection<T> {
  sectionId: SectionId;
  data: T;
  counts: Record<string, number>;           // 报告用（如 prompts: 21, mcp: 4）
  warnings: string[];
}

export interface ValidationResult { valid: boolean; issues: { path: string; message: string; severity: 'error'|'warning' }[]; }

export interface PlanItem { id: string; kind: PlanItemKind; adapter: SectionId; description: string; detail?: string; severity: 'info'|'warning'|'error'; conflict?: ConflictDecision; pathMapping?: PathMapping; missingDependency?: string; target?: SnapshotTarget; }
export interface ApplyResult { ok: boolean; message?: string; needsRestart?: boolean; }

export interface ConfigAdapter<TSection = unknown> {
  readonly id: SectionId;
  readonly displayName: string;
  readonly defaultIncluded: boolean;
  readonly portability: Portability;
  export(ctx: HostContext, options: ExportOptions): Promise<ExportSection<TSection>>;
  analyzeImport(data: TSection, ctx: ImportContext): Promise<PlanItem[]>;
  applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult>;
  validate(data: TSection): Promise<ValidationResult>;
  snapshot?(targets: SnapshotTarget[]): Promise<SnapshotEntry[]>;
  rollback?(snapshot: SnapshotEntry[], ctx: ImportContext): Promise<void>;
}
```

### 13.3 导入计划 / 冲突 / 快照（core 类型）

```ts
export type PlanItemKind =
  | 'Create' | 'Update' | 'Skip' | 'Conflict' | 'Install'
  | 'MissingSecret' | 'MissingDependency' | 'PathMapping' | 'Warning' | 'Error';

export type ItemResolution = 'keepCurrent' | 'useImported' | 'review';
export type GlobalConflictStrategy = 'merge' | 'replace' | 'skipExisting';

export interface ConflictDecision { itemId: string; resolution: ItemResolution; }

export interface PathMapping { oldPrefix: string; newPrefix: string; appliesTo: ('workspaces'|'mcp'|'pluginConfig'|'skills')[]; }

export interface ImportAnalysis {
  valid: boolean;
  errors: string[];
  warnings: string[];
  compatibility: 'excellent' | 'good' | 'partial' | 'unsupported';
  sectionsInZip: SectionId[];
  pluginSummary: { installed: number; toInstall: number };
  pathIssues: PathIssue[];
  secretCount: number;
  dependencyIssues: { item: string; dependency: string }[];
}

export interface ImportPlan {
  items: PlanItem[];
  globalStrategy: GlobalConflictStrategy;
  pathMappings: PathMapping[];
  missingSecrets: { ref: string; required: boolean }[];
  needsRestart: boolean;                    // 导入后需重启 dsh 生效
  estimatedActions: Record<SectionId, number>;
}

export interface ImportResult {
  ok: boolean;
  executed: { itemId: string; status: 'ok' | 'skipped' | 'failed'; message?: string }[];
  needsRestart: boolean;
  missingSecrets: string[];
  warnings: string[];
  rollback: RollbackReport | null;
  snapshotId: string | null;
}

export interface SnapshotTarget { adapter: SectionId; ref: string; }   // ref 如 namespace 名/文件路径/ref 名
export interface SnapshotEntry {
  kind: 'settingsNamespace' | 'credential' | 'patchLine' | 'file' | 'workspaceRecord';
  adapter: SectionId;
  ref: string;
  before: unknown;
  revision?: number;
  copiedTo?: string;
  existed?: boolean;
}
export interface Snapshot { id: string; createdAt: string; sourceZip: string; entries: SnapshotEntry[]; }

export interface RollbackReport { full: boolean; restored: string[]; failed: { item: string; reason: string; manualHint?: string }[]; }

export interface CompatibilityInput { sourceDsh: string; targetDsh: string; sourcePlatform: string; targetPlatform: string; schemaVersion: number; missingSections: SectionId[]; }
// 规则引擎：missingSections 空 + 同平台 + schema 支持 → excellent；向下兼容 → good；跨平台/缺配置 → partial；schema 超范围 → unsupported
```

### 13.4 安全模块

```ts
// security/secret-scanner.ts
export interface SensitiveHit { path: string; field: string; }
export function scanAndRedact(data: unknown, blacklist?: string[]): { sanitized: unknown; hits: SensitiveHit[] };

// security/encryption.ts
export function encryptCredentials(plaintext: string, password: string): Promise<{ blob: Buffer; info: EncryptionInfo }>;
export function decryptCredentials(blob: Buffer, info: EncryptionInfo, password: string): Promise<string>; // authTag 校验失败抛错

// security/integrity.ts
export function hashFile(path: string): Promise<string>;
export function buildChecksums(files: string[]): Promise<Record<string, string>>;
export function verifyChecksums(zipRoot: string, checksums: Record<string, string>): Promise<{ ok: boolean; mismatches: string[] }>;

// security/zip-security.ts
export interface ZipSafetyLimits { maxEntries?: number; maxTotalBytes?: number; maxRatio?: number; maxJsonDepth?: number; }
export function safeExtract(zipPath: string, destDir: string, limits?: ZipSafetyLimits): Promise<string[]>; // 返回条目相对路径
export function isPathSafe(entryName: string, destDir: string): boolean;

// security/redaction.ts
export function redact(text: string, blacklist?: string[]): string; // ***REDACTED***
```

### 13.5 核心引擎

```ts
// core/exporter.ts
export class Exporter {
  constructor(ctx: HostContext, adapters: ConfigAdapter[], zip: ZipWriter, scanner: SecretScanner);
  export(options: ExportOptions): Promise<{ zipPath: string; manifest: Manifest; report: ExportReport }>;
}

// core/importer.ts
export class Importer {
  constructor(ctx: HostContext, adapters: ConfigAdapter[], security: ImportSecurity);
  analyzeImport(zipPath: string): Promise<ImportAnalysis>;           // 纯读
  createImportPlan(zipPath: string, decisions: { strategy: GlobalConflictStrategy; resolutions: Record<string, ItemResolution>; pathMappings: PathMapping[] }): Promise<ImportPlan>;
  executeImportPlan(zipPath: string, plan: ImportPlan): Promise<ImportResult>;
}

// core/backup.ts / core/rollback.ts
export function createSnapshot(ctx: HostContext, plan: ImportPlan): Promise<Snapshot>;
export function rollback(ctx: HostContext, snapshot: Snapshot): Promise<RollbackReport>;

// core/compatibility.ts
export function computeCompatibility(input: CompatibilityInput): 'excellent' | 'good' | 'partial' | 'unsupported';
```

---

## 14. 测试矩阵（对齐规范 §33，m3/m7 执行）

| 组 | 场景 |
|---|---|
| Export | 正常 / 空配置 / 大配置 / Unicode 特殊字符 / Secret 过滤（黑名单命中即剥离） |
| Import | 正常 / merge / replace / skip / conflict / missing plugin / missing dependency / missing secret / 重复导入幂等 |
| Version | 同版本 / 旧 schema 迁移 / 更新 schema 拒绝 / 迁移链正确性 |
| Security | Zip Slip / 绝对路径 / malformed ZIP / 超大归档 / 可疑字段 / checksum 不匹配 / JSON 深度 |
| Rollback | 模拟 Phase2 中途失败 → 验证原配置恢复；部分回滚报告完整性 |
| Cross-platform | win→mac / mac→win / linux→win 路径映射（重点 workspace 绝对路径） |
| Encryption | 加密→解密往返 / 错误密码 / authTag 篡改检测 / 密码不入 manifest |

---

## 15. 明确不迁移 / v1 限制（如实声明，规范 §40.6）

1. **Keybindings / Workflows 配置文件 / Commands / Rules 文件**：DSH 当前无这些概念（研究报告 §2.2/§4.10），不实现分区。
2. **浏览器 localStorage UI 状态**（任务看板数据、面板宽度等）：Host 无通道，只导出 `uiMigrationNotes` 说明。
3. **设备 ID**（`.anonymous-user-id`）、**sessions**（默认关，v1 可仅清单）、**logs/cache/临时文件**：不迁移。
4. **插件二进制**：绝不打包，只迁移清单并走 `installPlugin`（需重启）。
5. **MCP**：以 patch 行导入，`needsRestart` 生效；DSH 无 MCP 管理 API（研究报告 §4.3）。
6. **配置 Profile**（规范 §20）：Phase 6，v1 只留 `profiles/` 类型占位。
7. **历史会话批量迁移**：默认关闭（研究报告 §4.9）。

> 产品 UI 与 README 必须如实列出以上限制（规范 §38），禁止假装支持。
