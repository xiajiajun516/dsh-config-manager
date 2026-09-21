# Changelog

本文档记录 dsh-config-manager 的发布亮点（中英双语）。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
This file records release highlights of dsh-config-manager (bilingual: 中文 + English). Format: [Keep a Changelog](https://keepachangelog.com/).

> **发布流程**：打 tag 发布时 CI（`.github/workflows/publish.yml`）自动抽取**当前版本段**作为 GitHub Release 描述亮点；
> 如果忘记写当前版本段，CI 会 **fail fast** 拒绝发版，避免漏写。
>
> **Release workflow**: on tag push, CI extracts the current version's section as the release notes highlights;
> the build fails fast if the section is missing, so you cannot forget to update it.

## [0.1.62] - 2026-09-21

> 本版主题是**内容级选择 + 可读性 + 安全收口**：「只能按分区整块勾选」的时代结束——导出、导入、
> 市场三条通道现在共用同一套「分区 → 最小可拆单元」选择内核；恢复计划有了 git 风格的逐行对照；
> 档案页从「插件自建的配置快照」换成**直接管理 DSH 自带 profile**（**行为替换，含破坏性**，见下）；
> 并修复 issue **#39**（凭据 `refs:` 口径 / 会话限额 / 凭据可恢复性 Feature 1–3）与 **#43**（「立即备份」空转却假报成功）。
> 未做项与有损点照旧登记在 `docs/spec/known-gaps.md`（本轮新增 **G-18**）。

### ⚠️ 破坏性 / 不兼容（升级前必读）

- **档案页语义整体替换（用户数据 + API 双重破坏）**：旧的「保存当前配置为档案 / 切换预览 / 执行切换 /
  导入 profile.json」四处交互与 `/profiles/save|analyze-switch|execute-switch|import` 四条端点一起删除，
  `ProfileManager` / `SwitchPreview` / `src/ui/profiles-view.ts` 全部移除，改为**直接管理 DSH 自带 profile**
  （`$DSH_HOME/profiles/<name>`）。此前保存在 `$DSH_HOME/dsh-config-manager/profiles/<name>/profile.json` 的
  插件自有档案**不再被列出或切换，也没有自动迁移代码**（文件仍在磁盘，需人工处理）。
- **「切换档案」不再即时生效**：DSH 无法在运行中更换 profile（bundle 层启动时解析，且 0.1.5-rc.1 /
  0.1.5-rc.2 / 0.1.6-alpha.2 均无 profile 管理路由），因此现在只写「下次启动用哪个」标记并给出
  `dsh --profile <name>` 重启命令；该标记是机器本地状态，不参与备份。
- **迁移前咨询不再接受 `type=profile`**：可迁移源只剩 export-zip / local-snapshot / remote-snapshot，
  宿主对 `type=profile` 返回 400；`buildProfileSource` / `ProfileSourceInput` 已删除（调用方需自行更新）。
- **市场通道取消「高风险分区默认不勾 + 逐分区批准」的严格分层信任默认**：改为与导入页同一套级联树
  （默认全选，含 plugins / mcp / agentPresets / agentInstructions / sessions / pluginFiles），风险改由
  「就地高风险警示 + 免责确认 + 导入前快照 + 导入后一键回滚」承担。相关免责文案与两份 README 已同步改写。
- **导出页 / 同步页的「快速导出 vs 自定义」二选一模式被移除**：勾选集合成为唯一事实（`ExportMode` 类型删除，
  `export.mode.*` 文案删除）；同步页改为「选择同步分区」弹窗，落盘 mode 恒为 advanced。
- **同步加解密密码从「仅内存」改为持久化到本机 DSH 凭据库**（安全策略变更，见 `SECURITY.md` 登记为唯一
  持久化例外）：值仍不写同步文件 / 响应 / 日志 / 备份，浏览器只拿得到 configured 布尔。

### 🐞 issue #39 —— 凭据 `refs:` 口径 / 会话限额 / 凭据可恢复性（Feature 1–3）

- **问题（报告人实测）**：`.credentials.yaml` 的 DSH v1 布局把凭据值放在顶层 `refs:` 之下，而插件两处解析
  （宿主 `tryDecryptCredentials` 与同步 `credentialsMapFromYaml`）只认「顶层字符串项」的预发布扁平布局，
  `refs` 是对象 → **整段被过滤成空 Map** → 备份包里明明带着凭据原文，导入却把全部 ref 送进「待人工重填」。
- **修复（唯一解析口径）**：新增 `src/security/credentials-yaml.ts` 的 `collectCredentialRefs()`——v1 `refs:` 块
  与预发布扁平布局**都认**、同名以 `refs` 为准，`records` / `payload` 等嵌套结构一律忽略（会话秘密不是凭据 ref，
  混进来只会污染补录清单）；零依赖，宿主与同步引擎共用同一份实现，杜绝「同一文件格式两处口径漂移」。
- **修复（误导提示收窄）**：`includeSecrets=true` 的导出按设计**不**镜像明文 vault，跨机 vault 必然为空，
  于是「凭据文件不在本机 vault（需人工重填）」必然出现——现在值已随包内密文回填时改用新消息
  `import.vaultCredentialsFromArchive` 如实说明，**只有确实还缺 ref 时才**保留「需人工重填」。
- **Feature 1：会话按数量筛选** `ExportOptions.sessions: { limit }` —— `0` = 不带该分区 / 负数 = 全带 /
  正数 = 最新 N 个 / 键缺省 = 现有行为。单位是**会话目录**（同一会话的 `session.jsonl.zstd` 与
  `session.v3.jsonl.zstd` 必须一起走），文件名判据不写死（`session.lock` 不算会话、新格式不能整批漏掉），
  排序用**会话日志文件的最新 mtime**；宿主 `FileSystemFacade` 未实现 `mtimeMs()` 或时间全读不到时
  **退回全量 + 告警**，绝不把「时间未知」当成最旧。实测收益：全量会话约 370 MB → 最新 10 个约 7.5 MB。
- **Feature 2：`/analyze` 返回 `credentials: { inArchive, refs, satisfied }`** —— 宿主不必自己解
  `security/secrets.enc` 再解析 YAML（否则上面那个坑每个宿主都要重踩一遍）；**只回传 ref 名，永不回传值**。
- **Feature 3：`/execute` 结果带 `credentialsRestored`**（从加密归档内解出并回填本机的条数；字段只增不改，
  为 0 时省略以保持旧响应逐字节不变）。

### 🐞 issue #43 —— 「立即备份」不再空转、更不再假报成功

- **问题（报告人实测）**：概览页蓝色主按钮「立即备份」在**定时备份未启用**时（`enabled: false` 是缺省值，
  也是「从未配置过定时备份」用户的必然状态）宿主直接返回 `{status:'skipped', skipReason:'disabled'}`、
  一个文件都不产出，而客户端**不看 `run.status`**、无条件 `toast.ok('备份完成')`。
- **修复（手动不再空转）**：`runOnce(opts?: { manual?: boolean })` —— 手动路径（`/backup-schedule/run` 改为
  `runOnce({ manual: true })`）**绕过 `enabled` 开关**：用户点这个按钮的语义就是「现在就给我做一份」，
  与自动调度开没开无关。其余守卫（RunRegistry 防重、环境锁、SAFE MODE、保留策略）一条未放宽；写回配置时
  仍用原 `enabled` 值 —— **绝不偷偷替用户打开自动调度**（已用测试钉住）。
- **修复（不再假报成功）**：新增纯函数 `backupRunOutcome()`，提示通道一律由 `run.status` 决定：
  `success` → 成功；`skipped` → 按原因分档提示「已跳过：定时备份未启用（没有生成任何备份文件）/ 上一次备份
  仍在进行中 / 另一项任务正在执行（防重）/ 环境锁被占用」；`failed` → 「备份失败：{原因}」（过 `redact()`）。
  未知 status 一律落 `error`（fail-safe，绝不宣称成功）。
- **来源词不冒充**：手动触发的日志与迁移历史用「手动备份完成/跳过/失败」，自动路径仍是「定时备份…」；
  迁移史新增 kind `backup-manual`，于是历史面板与概览「最近活动」能把两者分开（旧条目无法追溯，见「已知限制」）。
- **顺带修正文案**：`overview.quick.backupTitle` 由「全量快照，随时可回滚」改为「立即生成一份完整备份文件
  （不受定时备份开关影响；在快照页查看 / 还原）」（原文案说的是快照，实际产物是 `exports/*.zip` 备份文件）。

### 🐞 issue #35 收尾 —— 补丁声明与补丁文件成为**原子单元**

- 条目级选择引入后，`pnpm-workspace.yaml` 的 `patchedDependencies` 声明与 `patches/**` 补丁文件被声明为
  **互相 `lockedWith` 的原子组**，导出侧再用「全或无」兜底：取消其中任一个整组一起取消，**绝不产出
  「有声明、没文件」的半套**（目标机 pnpm 会因此拒绝一切 `add`）。
- 顺带把 `pnpm-workspace` ↔ patch 文件的配对知识下沉到 `src/adapters/units.ts`，供后续新增依赖组复用。

### 🧩 条目级内容选择（Phase 1：导出 / 导入 / 市场共用一套内核）

- 导出可对**分区内的最小可拆单元**逐个勾选，不再只能整块勾选分区：新增可选 `ConfigAdapter.listUnits()`
  （纯函数、输入即 `export()` 产物，预览端点因此**零额外读盘**）。
- 单元粒度按「拆开就失效」的知识定义（`src/adapters/units.ts`）：文件类分区默认 = 首个路径段
  （一个技能目录 bundle / 一次会话 = 一个可勾选整体）；`pluginFiles` / `self` 覆写为逐文件；
  `sessions` = `<projectKey>/<sessionId>` 会话目录；`plugins` = `plugin:<包名>` / `patch:<行id>` /
  `plugins:pnpm-workspace` / `plugins:patch:<rel>`；`workspaces` = `workspace:<记录id>`。
- 白名单三分语义（`ExportOptions.includeItems`）：键缺省 = 该分区全量（向后兼容）；键存在且**空数组**
  = 该分区整体剔除（在选定阶段剔除，不产出空载荷分区，`manifest.sections` 如实为 false）；非空 = 只带
  白名单单元。未实现 `listUnits` 的分区（settings / ui / providers / mcp / prompts / credentialsStatus）
  不可细分，传入白名单一律忽略 = 保持全量。
- 过滤发生在 `readFile` **之前**：未勾选的文件不读盘，取消勾选大分区（会话）后导出耗时明显下降。
- 唯一的选择内核：`src/ui/selection-model.ts` 的 `Selection { sections, excluded }` 稀疏表示 + 三态 /
  原子组 / 请求换算；导出页、导入向导、市场通道**共用**同一套语义（消灭「同样的勾选框不一样的行为」）。
- 唯一的内容勾选组件：`src/client/common/ContentPicker.tsx`（两级树 + 搜索 + 全选/全不选 + 部分选中徽章 +
  分组级联 + 捆绑联动 + 渐进披露 + `unitBadge`）；与只读的 `SectionComposition` 明确分工，禁止合并。
- 新端点 / 字段（只增不改）：`/export-preview` 响应新增可选 `sections[].items`（`ExportUnit[]`）与
  `failedSections`；`/export` 请求新增条目白名单 `includeItems`；`/restore` 响应新增可选 `changeSummary`。

### 📤 导出页

- 工具栏重排：删除「快速导出 / 自定义导出」分段与「预览将导出内容」按钮，改为「开始导出」（primary）+
  「选择要导出的内容」；模式提示改为一行说明。
- 内容选择器：「显示全部（共 N 条）」渐进披露上限由 100 提到 1000（真实 631 项会话库展开即全量）；
  单元名中段省略 + 悬停全文；按工作区分组且默认全折叠，展开一个分组只展开那一棵子树。
- 「设备相关 / 敏感」徽章 + 勾选到这类分区时页面与弹窗内**就地警示**（非阻断，列出分区名）；
  一键「全选」不再静默勾上 sessions / pluginFiles / credentialsStatus；「全不选」时明确提示并禁用导出。
- 页尾新增「本次将导出」构成卡（恒常渲染、内部滚动，合计与选择器 footer 同源）。
- 修复：分区清单读取失败不再显示误导性的「已选 0/0」——逐分区标「读取中…」/「读取失败 · 将整体导出」，
  存在未读分区时合计改口径为「已读取 …（含未读取分区，实际不少于该值）」，并把宿主精确清单与
  「请求了但没回来」的推断取并集。
- 修复：恢复「安全选项」「文件名与备注」两个分组标题；文件名规则与备注说明常驻显示（先规则后报错）；
  弹窗几何稳定（内容区固定高度 + 公告位恒定高度 + 底部动作移入固定底栏，不再随内容跳动 / 关闭按钮滚走）；
  双列字段间距由 5 处内联 style 改为 CSS 类。
- 修复：导出结果报告改为结构化清单（中文分区名 + 中文计数单位「18 个命名空间」），长行折行不再被裁、
  置于限高内滚，徽章全部走 i18n。

### 📥 导入向导

- 预览步拆成两页：第 1 页「迁移前咨询」（只读结论 + 「下一步：选择要导入的内容」，无法生成报告时给
  中性提示且不阻断），第 2 页是内容选择面板；换一份备份自动回到咨询页。
- 条目级内容勾选（与导出一套内核）：不勾选的条目**不导入、也不进快照**；确认页显示「将导入 N 个分区 ·
  M 个条目」与「本次有 N 项被你取消勾选」。
- 修复（UI-05）：**空选择守卫** —— 预览步勾选被清空时提示并禁用「下一步」，确认页「确认导入」同样禁用
  （此前「什么都没勾」会被执行成一次成功导入）。
- 修复（UI-06）：密钥补录页改为受控表单 —— 返回该页仍显示上次输入的值，编辑一个字段不再丢其它 ref 的值；
  且只为仍会导入的凭据索要密钥（被取消的插件不再索要）。
- 修复：确认页提示语跟随「失败时整体回滚」勾选状态（取消勾选后不再承诺回滚）；冲突列表文案走 i18n
  （「当前 / 备份」「错误」「无冲突项」）且 `description` / `detail` 渲染前过 `redact()`；预览统计补上
  此前漏渲染的「提示词」维度；兼容性页分区清单显示中文名；路径映射横幅由 warn 改 info（留空跳过是合法的）；
  结果页显式传 `t`（英文界面不再恒中文）、底部按钮由原始动作 id「done」改为「完成 / 查看失败项 / 查看详情」。
- `PlanItem` 新增可选 `unitId` / `label` / `group`（纯展示与对齐字段，`id`/`kind`/`target` 不变）：
  文件类 adapter 在 `analyzeImport` 用与导出 `listUnits` **同一套** `unitIdOf` 声明单元，导入侧于是也能按
  「一个技能 bundle / 一次会话」勾选，而不是逐个文件。

### 📸 快照恢复 —— git 风格的恢复计划预览

- 恢复计划预览改为三级视图：① 摘要条（将被还原 / 新增 / **将被删除** / 卸载插件 / 需人工处理 / 无动作 +
  行数合计 `+X −Y`）② 固定顺序分组（变更 → 删除 → 插件 → 人工 → 无动作，「无动作」默认折叠）
  ③ 点文件行展开**左右双栏逐行对照**（左 = 当前磁盘、右 = 快照内容，成对修改左红右绿，
  块头 `@@ -a,b +c,d @@`）。
- 新内核：零依赖行级 diff `src/utils/line-diff.ts`（CRLF 归一 + 公共前后缀裁剪 + 超预算降级，保证耗时确定）
  + `src/core/snapshot-diff.ts`（两级读取上限：列表阶段单侧 ≤256 KB / 总预算 8 MB / 最多 80 文件，
  详情阶段单侧 ≤1 MB / 6000 行 / 上下文 3 行；超限如实标 budget / truncated，而不是拖慢预览）。
- 边界态都有说明：二进制 / 文件过大 / 不可读 / 快照内缺该文件 / 路径越界；两侧一致时显示
  「两侧内容一致，无逐行差异」；行号列宽按最宽行号分四档；hunks 由 `POST /snapshots/file-diff`
  **点开才懒加载**。
- 安全：路径一律经恢复引擎的越界护栏（`isWithinHome` / `homeAbs` / `blobAbs` 本轮改为导出以复用**同一份**
  判据），越界拒绝；返回值不含凭据值且 UI 渲染前再过 `redact()`；单项失败只标 unreadable / skip，
  绝不因一个文件读不到就让整个预览失败。
- 修复：恢复报告新增显式「完成」按钮关闭回执（此前执行完恢复就停在报告上找不到返回，且报告随
  sessionStorage 落盘会「复活」）；迁移前咨询卡移到计划预览**之前**并加分割线。
- 澄清：删除动作本身在 0.1.61 就有（`hostFileRemove` / `fileRemove` 未改动），本版增强的是
  「预览里能看到它并逐行对比」；恢复计划的生成逻辑未变。

### 🔄 同步

- **历史会话成为显式可选同步分区**（`OPT_IN_SYNC_SECTIONS`）：推送必须**既勾选 sessions 又在请求体带**
  `sessions.{limit}`，缺一即按非 portable 跳过并**显式告警**；拉取只在用户驱动的 pull / 一键同步上放行
  （引擎 `includeOptInSections`），自动同步与 Agent 工具恒不带 —— **会话绝不悄悄下行**。
- 会话同步上限：缺省 5、`0` = 勾了但不带、非整数回退 5、>10000 钳制（`sync-selection.json` schema v2
  只增字段，旧文件缺省读回 5）。
- **密码持久化**：加密 / 解密密码保存到本机 DSH 凭据库独立槽位
  （`DSH_CONFIG_MANAGER_SYNC_{ENCRYPT,DECRYPT}_PASSWORD_<GIT|WEBDAV>`）；输入框失焦即写（两框一致才写）、
  留空即沿用、取消勾选「加密备份」即删除已存密码、解密密码另有 danger 语义的「删除已保存密码」；
  请求体密码优先于已存密码、`clear*` 优先于写入；`GET /sync/status` 只回 configured 布尔。
- 行为变更：删除「同步模式」分段，改为「选择同步分区」弹窗 —— 勾选集合就是同步范围、改动即时生效并
  持久化，设备相关分区带 warn 徽章，勾选为空时禁止推送。
- 修复：同步确认视图的 `description` / `detail` / `diff` 渲染前过 `redact()`，变更明细由 `<pre>` 改普通块
  （长 JSON 不再横向溢出被裁）；全部弹窗补 `closeLabel`（关闭按钮 aria-label 走字典）。
- 内部：拉取侧「哪些分区进临时 ZIP」的三处口径收敛为 `pullSectionIds()`。

### 🛒 市场

- 条目详情从「列表上的弹窗」改为**页面级分步向导**（预览 → 选择内容 →（有冲突才有）冲突 → 确认 → 结果），
  步骤条复用 Stepper，页头 = 标题 + 「返回列表」；起因是实测「3 分区 / 61 个计划项」导致三重滚动。
- 选择步改用与导入页**同一套**级联树（搜索 / 全选 / 二级分组 / 树上直接标「将改动 / 已一致 / 不导入」），
  筛选 Segmented（全部 / 将改动 / 高风险 / 未勾选，带计数，只影响渲染）。
- 已勾选的高风险分区**就地警示**（列出分区名与后果）；无勾选时禁止导入；逐项摘要降维为**分区级小结**
  （一行一分区：已选 n/m + 将改动/已一致 + 高风险徽章），不再把 61 行铺满。
- 冲突逐项决策（保留本机 / 使用导入）内联在向导里，决策变化由宿主 `createImportPlan` 重算计划
  （不在前端改 `planItem.kind`），未决策一律按「保留本机」不覆盖。
- 导入后新增**「回滚到导入前快照」**入口（danger + 二次确认 + 恢复/卸载/失败/人工计数报告）；
  没有可用快照时如实说明「无法回滚」，不给假入口。
- 「我的配置 → 装回本地」同样改为页面级向导，与「浏览条目详情」**共用同一个** `MarketImportReview`
  （消灭两套勾选语义）；上传 / 更新向导仍是弹窗。
- 勾选与冲突决策进 runStore 市场切片（绑 `zipPath`，换条目自动回落默认全选），切 tab / 刷新不丢；
  步骤与筛选是纯瞬态。
- 安全默认变更见上文「破坏性」；免责文案与两份 README 的「逐分区批准」措辞已同步改写为「逐项内容选择」。
  上传侧的 8 道校验、供应链警示恒展示（`needsReview` 恒 true）、`patchFiles` / `localTarballs` 双端拒收
  均**未改动**（后者是 0.1.60 的既有防线）。

### 🗂️ 档案（Profiles = DSH 自带 profile 管理）

- 新语义：档案 = `$DSH_HOME/profiles/<name>`（`dsh --profile <name>` 启动的那份）。列表每行显示形态徽章
  （Web / Headless / 自定义）、「当前运行」/「下次启动」徽章、损坏徽章（`package.json` 不可解析 / patch 过大）、
  计数摘要（N 个层 · patch M 条 · 依赖 K · 已装未装 node_modules · patch 热生效或仅启动应用 · 更新时间）；
  排序为当前运行 → 待切换 → 按名字。
- 详情弹窗（点整行打开）：bundle 层清单（带序号 = patch 应用顺序）、依赖清单、目录、patch 条目数与体积、
  更新时间，以及 `package.json` 与 `cordis.patch.yml` 原文（渲染前 `redact()`；patch 过大则不加载原文并说明）。
- 新建：名字 + 起步模板下拉（base / web / headless / sdk / sdk-minimal / acp，并显示模板含哪些 bundle 层），
  名称实时校验（空 / 超 64 字 / 非法字符 / DSH 保留名分别提示）；脚手架三文件与官方 `initProfile`
  **逐字节一致**。
- 重命名：目录级 rename + 同步修正 `package.json` 的 name 与「下次启动」标记；**运行中的档案拒绝改名**。
- 删除：**物理删除整个目录（含 node_modules）**，不可恢复；目录内 junction 只删链接本身；目标是当前运行
  档案时需额外勾选确认；删除会一并清掉指向它的「下次启动」标记。
- 「下次启动」卡四态：未设置（规则说明）/ 就是当前（绿 Banner「无需重启」）/ 指向的档案已不存在
  （warn + 清除）/ 待切换（等宽 `dsh --profile` 命令 + 复制 + 取消）。
- 修复：重命名成功给 Toast 回执；错误码（同名已存在 / 不存在 / 不能作用于当前档案 / 名字非法 / 保留名 /
  未知模板）本地化；加载失败横幅过 `redact()`。

### 📋 迁移历史

- 新增两类审计条目文案：「档案新建」「设置下次启动档案」；「备份」细分为**「定时备份」与「手动备份」**
  （issue #43，含 en 镜像与筛选下拉）。
- 行为变更：每条记录改**两行布局** —— 元信息行（时间 · 结果 · 分区）+ 摘要独占一行（此前摘要与元信息
  抢同一行被挤成碎片）。
- 修复：时间由原始 ISO 串（含 `T`/`Z`/毫秒）改为本地 `YYYY-MM-DD HH:mm`，悬停显示完整本地时间
  （复用同步历史的时间格式化，两个历史视图观感一致）；分区列最多显示 3 个、其余折叠为 `+N`；
  筛选下拉「最近」项改为与另两个同构的「最近: 全部」。

### 🧪 迁移前咨询（migration consult）

- 结论改为**由证据决定**而非由分数决定：新增硬阻断白名单（只有「引擎真的不会继续」才算：无 manifest /
  schema 不支持 / checksum 不符 / Zip Slip / dry-run 失败），修复用户实测的「健康评分 89 却建议阻止执行」
  自相矛盾；有硬阻断时把分数压进 critical 区间。
- 冲突降级为「需处理」：致命冲突由 error 降为 warning 并封顶扣分，文案改为「有 N 处冲突需要你决定保留
  哪一边（下一步可逐个选择；默认不覆盖本机）」；悬空凭据引用由「每个 ref 各刷一行」聚合成一条并封顶扣分，
  且永不判 critical。
- 报告新增 `blockerCount` / `attentionCount`，咨询卡在结论徽章旁恒显示「N 项硬阻断（不处理无法安全导入）」
  「N 项需处理」，触发项列表里硬阻断排最前。

### 🎨 UI 审计（26 条）与全局一致性

- 按 `docs/design/ui-audit-2026-09-20.md` 的清单（0 blocker / 9 high / 11 medium / 6 low，共 26 条）逐条修复，
  本版绝大多数 UI 改动都能回溯到 `UI-01` … `UI-26` 编号。用户可见的代表项：
  - 长文本不再被裁：报告 / 错误明细的 `<pre>` 补 `white-space: pre-wrap` + `overflow-wrap: anywhere`
    并统一置于 `.reportScroll` **限高内滚**（UI-01，此前长行横向溢出且被父容器裁掉）；同步变更明细、
    导入结果报告同源修复。
  - **分区显示名单一映射**（15 个分区的中文名，`common/section-labels.ts`）：总览构成、导出选择器、
    导入选择器、兼容性页、同步分区弹窗、导出报告从此只有一种叫法（此前同一个分区有英文 label /
    裸 id / 中文三套）；`Record<SectionId, …>` 全量覆盖 ⇒ 新增分区忘配文案会**编译失败**。
  - **页签溢出提示**（UI-19）：英文界面 7 个页签 + 2 个文字按钮在 564px 画布溢出且滚动条被刻意隐藏时，
    在真实溢出侧画渐隐遮罩；放得下时不画。
  - `ErrorBanner` 改为随 `error` 属性重新解析（此前同屏连续两次失败会一直显示第一次的标题 / 原因 / 建议），
    并把 `t` 传入错误映射 —— 英文界面的错误标题与建议动作不再恒中文。
  - 走 `Modal.Header` 的弹窗：标题不再双重内边距；`closeLabel` 改为**编译器强制必填**，关闭按钮
    aria-label 一律走字典（英文界面屏幕阅读器不再读中文「关闭」）。
  - `ProgressBar` 的阶段文案 / 分区名 / 当前项名渲染前过 `redact()`；`ConflictList` 与 `SyncConfirmView`
    的裸渲染修复（实测 MCP `env` / `headers` 明文凭据会原样回传浏览器），并新增**按渲染点**的源码级守卫
    测试（去掉任一处 `redact()` 即红灯）。
- i18n 收口：删除一批死键（`export.mode.*`、`export.preview*`、`snapshots.hint|viewPlan|kind.*|summary`、
  `error.title|hint`、`about.diag.bundles`、nav 遗留键等），zh / en 同步；7 套字典最终态键数
  506 / 278 / 291 / 51 / 138 / 104 / 198，**zh 与 en 键集合完全相等**（对照表与排查姿势见 `DEVELOPERS.md`）。

### 🔇 日志降噪

- 新增 `parseLogLevel()`：宿主入口**默认日志级别由 info 降为 warn**（大小写与空白不敏感，非法值 / 缺省 → warn）。
  启动 `dsh web` 后控制台只留 warn / error —— 挂载横幅、调度器跳过、导出与备份完成、保留策略清理等常规
  info 不再刷屏。
- 排查时设 `DSH_CONFIG_MANAGER_LOG_LEVEL=info`（或 `debug`）即恢复逐条输出；级别只在入口解析一次，
  勿在调用点再加 `if (debug)` 分支。

### 📄 文档 / 契约 / 测试

- `docs/spec/known-gaps.md`：新增 **G-18**（`.credentials.yaml` 的 `refs:` 块未被识别 → 导入后仍要求人工
  重填，✅ 已修复，写明修复位置、验证方式与**未覆盖项**：`workspaces.applyItem` 整条覆盖会丢本机独有键、
  `POST /sessions/group` 仍未做）；G-17 验证方式扩到 8 例、有损点表述改为「凭据字符串值」。
- `docs/spec/headless-consumption.md`：新增 **§4.5**，把 `sessions.{limit}` 档位语义、
  `analyzeImport(zip, { decryptedCredentials })` → `analysis.credentials`、`credentialsRestored` 写成
  对外契约（只增不改），并列出对应 HTTP 面（`/export` 的 `sessions`、`/analyze` 的 `decryptPassword`、
  `/execute` 的 `credentialsRestored`）。bundle-format / manifest schema / compat-matrix **未改**。
- `docs/design/ui-audit-2026-09-20.md`（新增）：UI-01 … UI-26 逐条审计（现象 + 行号级证据 + 期望 +
  涉及文件 + 三批修复建议 + 「本清单不需要新增第三方依赖」结论 + 复核命令）。
- `docs/design/2026-09-20-session-log-compression.md`（新增，只读实测）：会话日志是多帧 zstd 容器
  （4.4 MB 日志 2642 帧）——保留帧边界重压几乎无收益，合并单流才有；全量 379.8 MB → 210 MB（≈1.79×）、
  跨会话 solid 4.3×、单个长会话 18–20×；结论「只带最新 N 个」性价比最高且不需格式改动
  （默认改走 `sessions.limit` 属行为变更，**本版未改默认**）。
- `DESIGN.md` +338 行：把内容选择器、git 风格恢复预览、市场条目导入审阅、档案页、导出页新结构、
  报告与错误折行规则、计划文本与分区名脱敏规则、两套字典分工与死键纪律写成规范；`DEVELOPERS.md`：
  新增「从 AGENTS.md 下移的细则」（页面落位 / 状态管理 / i18n 七套字典对照表 / Missing Design Rule /
  第三方库准入 7 步）与两条技术限制（DSH 无法运行中切 profile、无 `DSH_PROFILE` 环境变量）。
- `README.md` / `README.zh-CN.md`：Profiles 小节整段重写（= DSH 自带 profile + 无法运行中切换）、
  同步密钥段改写为「密码存本机凭据库、留空即沿用、取消勾选即删除」、首屏备份内容清单移除 Profiles 并加注
  「DSH profile 不随备份迁移」、新增 FAQ「`dsh web` 控制台为什么安静了」、市场小节措辞与「逐项内容选择」对齐。
- `SECURITY.md`：「加密备份」→「加密备份 / 导出」，并新增「同步通道密码（唯一持久化例外）」条目（中英同步）。
- 测试：全量 **2152** 项通过（新增 units / sessions / session-meta / session-select / snapshot-diff /
  line-diff / logger / selection-model / restore-plan-view / diff-view / market-import / nav-overflow /
  dsh-profiles-view / section-labels / plan-text-redaction / credentials-yaml / credentials-refs-import /
  export-item-selection 等套件），`typecheck` / `build` / build 后 `bundle-selfcontained` 护栏全绿。

### ⛔ 本版已知限制（如实登记）

- **旧「配置档案」数据不会被迁移**：`$DSH_HOME/dsh-config-manager/profiles/<name>/profile.json` 仍在磁盘
  但不再被列出 / 切换，仓库内也没有迁移代码 —— 需要时请手动转换为 DSH profile。
- **旧迁移历史条目的来源无法追溯**：修复前写入的备份条目 kind 恒为 `backup`，因此仍显示「定时备份」，
  即使当时是手动点的；只有本版之后的新条目才准确。
- 「默认走最新 N 个会话」**未实现**：导出默认行为仍是「sessions 分区默认不含」（结论见设计文档）。
- `workspaces` 导入仍以备份记录**整条覆盖**、会丢本机独有键（`archivedSessionIds` 等）；导入写记录前也
  不建缺失目录。二者与 `POST /sessions/group` 一起留在 `known-gaps` G-18「未覆盖」。

### 🎯 亮点 / Highlights (zh)

- 🧩 **终于能按「内容」勾选了**：导出 / 导入 / 市场共用一套「分区 → 最小可拆单元」级联树，技能目录、
  插件补丁组、单次会话都是整体单元；未勾选的文件连读都不读。
- 🎬 **恢复计划变成 git 风格对照**：将被删除 / 还原 / 新增一目了然，逐文件左右双栏看改了哪几行
  （hunk 点开才加载）。
- 🗂️ **档案页重做**：直接列表 / 新建 / 重命名 / 物理删除 `$DSH_HOME/profiles/<name>`，并告诉你
  「下次启动用哪个」+ 重启命令（**旧插件自有档案不迁移，见破坏性小节**）。
- 🛒 **市场装回本地走完整向导**：预览 → 选择 → 冲突 → 确认 → 结果，导入后可一键回滚到导入前快照。
- 🔐 **凭据终于认得 DSH 的 `refs:` 布局**：加密备份里的凭据不再被误判为「包里没有」，误导性的
  「需人工重填」也只在真的还缺时出现。
- ⏰ **「立即备份」真的备份**：不再空转、不再假报成功，与定时备份开关解耦；手动与定时在历史里分开记。
- 🔇 **控制台安静了**：默认只留 warn / error，`DSH_CONFIG_MANAGER_LOG_LEVEL=info` 一键恢复。
- 🎨 **26 条 UI 审计逐条修完**：长报告折行 + 限高内滚、分区名统一、页签溢出提示、错误横幅不再失真、
  关闭按钮无障碍标签本地化。

### Highlights (en)

- 🧩 **Content-level selection**: export / import / market now share one section→smallest-unit cascade tree;
  skill bundles, patch groups and single sessions are atomic units, and unchecked files are never even read.
- 🎬 **git-style restore preview**: see what will be restored / added / **deleted**, then open any file for a
  side-by-side line diff (hunks are lazy-loaded).
- 🗂️ **Profiles page rewritten** to manage DSH's own `$DSH_HOME/profiles/<name>` (list / create / rename /
  physical delete, plus "which profile to launch next" with the restart command). **Old plugin-owned profiles
  are not migrated** — see the breaking-changes section.
- 🛒 **Marketplace install is now a full wizard**: preview → select → conflicts → confirm → result, with
  one-click rollback to the pre-import snapshot.
- 🔐 **Credentials finally understand DSH's `refs:` layout**: encrypted backups no longer look "empty", and the
  misleading "re-enter manually" hint appears only when a ref is genuinely missing.
- ⏰ **"Back up now" really backs up**: no more silent no-op and no more false success toast; it is decoupled
  from the schedule switch, and manual vs scheduled runs are recorded separately.
- 🔇 **Quieter console**: warn/error by default; `DSH_CONFIG_MANAGER_LOG_LEVEL=info` restores verbose output.
- 🎨 **All 26 UI-audit items fixed**: wrapping + capped scroll for long reports, one canonical section-name map,
  tab overflow hints, accurate error banners, localized close-button labels.


## [0.1.61] - 2026-09-18

> 单主题版本：修复 **issue #38** —— 同步页「导出密钥」此前**不会导出任何密钥**。
> 本版把它做成真的：凭据以**独立密文载荷**随加密快照迁移，并在目标机按用户确认写回本机凭据。
> 缺口登记见 `docs/spec/known-gaps.md` **G-17**。

### 🐞 issue #38 同步页「导出密钥」未生效

- **问题**：`includeSecrets` 在同步通道内**没有数据源**——没有任何 adapter 读它，结构化分区在源头
  就已 `redactSecrets`，凭据分区被 `FORBIDDEN_SECTIONS` 结构性排除，`.credentials.yaml` 在
  `SECTION_JSON_PATHS` / `SECTION_FILE_PREFIXES` 里没有映射。它唯一真实生效的效果是
  **跳过同步载荷的第二道 `SecretScanner` 脱敏**——方向是**降低防护**，而不是取得凭据。
  推送载荷与不勾时**逐字节相同**（唯一差异是 `manifest.containsSecrets` 由 `false` 变 `true`），
  而 UI hint 承诺「把真实凭据值写入加密快照」，两版 README 也从未提及该选项。
- **修复（push 侧接入数据源）**：`includeSecrets=true` 时经 `ctx.fs.readFile` 读
  `$DSH_HOME/.credentials.yaml` 原文，用本次调用的密码加密为**独立字段**
  `SyncSnapshot.credentials`（新类型 `EncryptedCredentials`）。**刻意不进 `sections`**——
  `credentialsStatus` / `secrets` 是结构性拒绝分区，凭据值必须走分区之外的载荷。
  读不到 / 解析不出凭据 → **显式告警且不带载荷**（不静默成功，也不阻断其余配置同步）。
- **修复（pull / apply 侧接线）**：`pull()` / `preview()` 解密出 `Map<ref, value>`，为每个 ref
  生成一条 `MissingSecret` 计划项（凭据迁移因此进**人工确认**列表、默认不采用）；
  `applyItems()` 把该 Map 作为 `executeImportPlan.decryptedCredentials`（此前**硬编码
  `undefined`**）交给 credentials adapter → `credentials.set(ref, value)` 写回本机。
  一键同步会话**仅内存**保管该 Map（存值不存密码——能力更窄），apply-items 消费 / cancel /
  TTL 30 分钟即消失，绝不落盘。
- **双保险**：未加密快照若携带凭据载荷，一律拒绝拉取（与「非加密快照声明 `containsSecrets`」
  同类，防御篡改 / 旧坏数据）；散文件布局显式拒绝承载凭据载荷，**绝不静默丢弃**。
- **可见性**：推送预览新增 `credentialsIncluded`，确认弹窗明确提示
  「本次推送包含真实凭据值（已随载荷整体加密；远端只见密文）」——勾选后不再是无声的行为变化。
- **安全不变量（均未放宽）**：`includeSecrets ⇒ encrypt` 强制；凭据载荷**只**存在于加密快照；
  自动同步恒 `includeSecrets=false`（无密码可用，遇到加密快照跳过）；密码仅内存，
  不落盘 / 不落日志 / 不进响应体；`manifest.containsSecrets=true` 语义保持。
- **已知有损点（如实登记）**：只搬运 `.credentials.yaml` 的**顶层字符串值**（与导出路径
  `security/secrets.enc` 同口径），嵌套结构 / 非字符串值不迁移；凭据写回**不可回滚**——
  DSH 不回读凭据值，属既有的技术限制。

### 📄 文档与契约同步

- `src/client/sync/sync-locales.ts`：入口描述与「导出密钥」hint 从「密钥永不参与同步」改为
  「**默认**不参与同步；勾选『导出密钥』并加密后可随加密快照迁移」——消除文案与实现不符。
- `README.md` / `README.zh-CN.md`：功能表与同步章节同步修订，写明「密文随快照上行、
  远端只见密文、凭据写回需用户确认」。
- `AGENTS.md`：安全不变量新增「同步『导出密钥』= 独立密文凭据载荷」一条（含两条不放宽的红线）。
- `docs/spec/known-gaps.md`：新增 **G-17**（含修复位置、不变量、验证方式与有损点）。

### 测试

- 新增 `src/sync/sync-credentials.test.ts`（7 例端到端，含负例）：push 密文载荷 + 明文绝不入载荷 /
  只加密不导密钥不带载荷 / 无凭据文件明确告警 / pull+preview 生成迁移项且报告不含凭据值 /
  applyItems 带 Map 写回、不带则跳过 / 未加密快照携带凭据载荷被拒 / 散文件布局拒绝。
- `src/client/sync/sync-push-preview.test.ts`：新增「含凭据推送 → 显式提示」用例。
- 全量套件 **1962** 项通过；`typecheck` / `build` / build 后 `bundle-selfcontained` 护栏全绿。

### 🎯 亮点 / Highlights (zh)

- 🔑 **「导出密钥」终于真的导出密钥**：勾选后 `.credentials.yaml` 会以 scrypt + AES-256-GCM 密文**随加密快照一起走**——换机后凭据能真正落地，而不再是「看起来勾了、其实什么都没带」。修复前该选项的唯一效果是**降低**载荷脱敏强度，用户却以为密钥已经迁移
- 🧭 **凭据迁移走人工确认，不静默写入**：拉取侧为每个 ref 生成一条「凭据迁移」项，你确认采纳才写入本机凭据；凭据值全程只在内存中流转，密码不落盘、不落日志、不进响应体
- 🛡️ **红线一条没松**：仍强制「导出密钥必须加密」，凭据载荷**只**存在于加密快照，未加密快照携带凭据载荷一律拒绝；自动同步恒不带凭据

### Highlights (en)

- 🔑 **"Export secrets" now actually exports secrets**: with it checked, `.credentials.yaml` travels as scrypt + AES-256-GCM ciphertext **inside the encrypted snapshot** — credentials genuinely land on the other machine instead of "looks checked, carries nothing". Before the fix the option's only real effect was to **weaken** payload redaction while users believed their secrets had migrated
- 🧭 **Credential migration is confirmed, never silent**: the receiving side turns each ref into a "credential migration" item that is written to the local credential store only after you accept it; values stay in memory — the password is never persisted, logged, or returned to the browser
- 🛡️ **No guardrail was relaxed**: "export secrets ⇒ encryption" still holds, the credentials payload exists **only** in encrypted snapshots, and an unencrypted snapshot carrying one is rejected outright; auto sync never carries credentials

## [0.1.60] - 2026-09-18

> 本版包含**两块互不重叠**的工作：
> 1. **issue 修复**（第一小节）——仓库中 8 条 open issue（#27–#37）的逐条修复，是本版的发布主题；
> 2. **Phase 1 灾备基线**（第二小节）——由竞品源码审计驱动的能力补齐，**代码随本版发布但默认整体关闭**
>    （两个开关均为 `false`，路由返回 503），不改变本版对外可见的行为。
>
> 本版**没有**修复的、以及只做到一半的，都在 `docs/spec/known-gaps.md` 里如实登记（G-15 明确标为「部分修复」）。

### 🐞 issue 修复（#27 / #28 / #29 / #30 / #31 / #35 / #36 / #37）

- **#37 复检发现的越界读取（本轮自查修复）**：跟随链接时，**文件**符号链接（`skills/link.md`
  → home 外文件）此前只对「目录链接」做了 home 边界检查，内容会被读进备份——CLI 既有回归
  `T2-P3` 当场抓到。现在目录链接与文件链接共用同一 realpath 判据：目标越出 `$DSH_HOME`
  一律跳过并记 `outside-home`（内容绝不读入）。同时把「目录读取失败」也纳入告警
  （此前 ACL/竞态导致的目录读失败被静默吞掉，症状与 #37 同类）。
- **#37 CLI 离线备份路径（`dsh-config-manager backup`）同样静默跳过链接**：issue 点名的
  两条路径里，Web UI 已修而 CLI 未修（`core/backup-plan.ts` 自带的遍历写死「绝不跟随链接」
  且零告警）。现在两条路径共用 `utils/recursive-walk.ts`，CLI 也会跟随 home 内链接并在
  报告 warnings 里写明「跟随了 N 个」「哪些链接/目录没进来及原因」。
- **#35 复检发现的顺序与越权缺陷（本轮自查修复）**：patch 文件项原本排在
  `plugins:pnpm-workspace` **之后**，而配置项的 applyItem 又会替它把 patch 文件写掉——
  ① 会留下「声明在、文件未到」的窗口（中途中断后目标机 pnpm 从此拒绝一切 add）；
  ② 绕过了用户在 patch 文件冲突项上的 `keepCurrent` 选择（正是 issue #35 要消除的静默覆盖）。
  现在 patch 文件项**先于**配置项执行，配置项只按**磁盘真实状态**决定是否剔除声明，不再越权写文件。
- **#35 附带（工具链变更可见可取消）**：`plugins:pnpm-workspace` 在本次同步中**移除了**
  patchedDependencies 声明时（带 detail），进入一键同步的确认列表（默认仍采用，但用户可取消）；
  普通内容变更不进列表，不制造噪音。
- **#31 收口**：autosync 的 `acquire` 抛错分支（锁目录 IO/权限故障）此前同样不写历史——
  现补写，使「自动同步不再更新」这一症状不再有任何静默出口。
- **#36 残留锁在 Windows 上无法回收**（`src/utils/env-lock.ts`）：Windows 拿不到 OS
  process identity，PID 又会被复用，于是「心跳过期 + pid 存活」永远停在 `UNKNOWN_STATE`，
  连官方 `recover-stale-lock` 都拒绝，用户只能手工删锁文件。现在引入**心跳长过期**判据
  （阈值 = `max(30 × staleAfterMs, 30 分钟)`，可注入）：越过阈值即判为残留锁，
  **显式**回收可成功。acquire 侧依旧绝不自动摘锁——放宽的只是「显式回收」这一条人工路径，
  且 `inspectLockState` 与回收二次验证 `reProveStale` 使用**同一**判据（否则首次判定可回收、
  二次验证又判非 stale → quarantine，等于没修）。
- **#37 skills 等文件类分区静默跳过 junction / 符号链接**（`src/utils/recursive-walk.ts`、
  `src/adapters/link-report.ts`）：`readdir` 对目录链接返回 `isSymbolicLink() === true`，
  旧实现只处理 `isDirectory()/isFile()`，链接目录连同其**全部真实内容**被静默排除，备份照样
  报成功（实测 8 个链接目录约 12 MB 内容丢失）。现在**跟随**目录链接收集内容，用 realpath
  去重防环（自引用/重复链接/深度上限），并把「跟随了 N 个链接（导入按普通目录还原，链接结构
  不会重建）」「跳过了 N 个链接且**其内容未进备份**（原因 + 路径）」写进备份报告——
  缺了后半句，用户依然无从察觉缺失。越出 `$DSH_HOME` 的目标仍不进备份（既有边界不变），但会留痕。
- **#35 只搬 `pnpm-workspace.yaml` 的 `patchedDependencies` 声明、不搬 patch 文件**
  （`src/adapters/pnpm-workspace.ts`、`src/adapters/plugins.ts`）：目标机拿到「声明在、
  `patches/*.patch` 不在」的组合后，pnpm 会拒绝**一切** `add`（含与补丁无关的插件），
  实测一次「一键同步 → 确认导入」13/13 插件安装全灭、而同步仍报成功。现在：
  ① 导出时把 `patches/**` 作为 `plugins.patchFiles` 随分区携带（源机缺文件 → 显式告警）；
  ② 导入时先落 patch 文件，再写入**剔除目标机无法满足的声明**后的配置（按行改写，保留注释与
  CRLF，不整文件重写；单行 flow 形态不猜着改，改为告警）；③ 剔除在计划里以 **Warning 项**
  显式可见（一键同步的确认列表现在也渲染 Warning，不再静默自动采用）；
  ④ 安装失败分类新增 `patch-file-missing`，给出可操作修复路径，而不是 13 条「插件装不上」；
  ⑤ 供应链：`patchFiles` 非空在**发布侧与导入侧**双端拒收（与 `localTarballs` 同级），
  `patchFiles[].relativePath` 进结构校验（拒绝绝对路径 / 上跳路径）；
  ⑥ 每个 patch 文件都是**计划项**（Create/Skip/Conflict）并进入**导入前快照**——否则导入覆盖了
  目标机原有 patch 文件后再回滚，原文件会永久丢失（新增 ref 前缀 `patchFile:` 与 patch **行** id
  区分开，`resolveFileTarget`/`captureTarget` 同步支持）。
- **#35 附带（可观测性）**：插件安装失败返回 `{ok:false, warning:true}`（§34.17 非致命语义），
  而 journal 把「非 ok / 非 failed」一律记成 `skipped` 且不落 message → 事后审计（人 / CLI / agent
  读 `transactions` 或 `migration-history`）会得出「用户跳过了这些插件、同步成功」的错误结论。
  现在 `warning` → `attention`（不可证明已应用），`skipped` 只留给真正的跳过，并持久化
  `message`（`src/core/analyzer.ts`、`src/core/journal.ts`）。
- **#28 「装了插件但备份没识别到」的剩余形态**（`src/core/plugin-cli.ts`）：已装清单此前只遍历
  `package.json` 的 `dependencies`，仅通过 `dsh.profile.bundles` 声明的层**完全不可见**——
  而 DSH 启动时确实会挂载它们（`reconcileBundles` 对这类条目是保留的）。现在 bundles 中
  非依赖、非 in-box 的条目也进入清单（版本取 `node_modules` 落盘版本）。
- **#27 / #29 / #30 / #31**：核对并保留已落地的修复（残锁分类文案与 `--help` / README 可见性、
  未配置 token 视为「未登录」而非 500、插件私有出站代理、定时备份与自动同步的锁跳过文案与
  历史、以及 423 文案所指向的「事故恢复 → 回收残留锁」GUI 入口），并补上 #31 遗漏的两处：
  自动同步被挡时**补写 sync-history**（此前连历史都不写，用户只能看到「自动同步不再更新」）、
  客户端 `describeSkipReason` 对 `mutation-locked` 给出可读中文。

### 📄 文档与契约同步

- `docs/spec/bundle-format-v1.md`：登记 `plugins.patchFiles` 字段、市场双端拒收、以及
  **实现者注意**「`pnpmWorkspace` 与 `patchFiles` 必须同进同出」。
- `docs/spec/known-gaps.md`：新增 **G-14**（同步只搬声明不搬 patch 文件）并标记已修复。
- `README.md`：`recover-stale-lock` 症状表补「PID 被复用」一行；插件清单来源补
  `dsh.profile.bundles` 说明。

### Phase 1：灾备基线（P0）—— 代码随本版发布，**功能默认关闭**

> 本节补齐与同类 DSH 撤销/回退插件的**能力基线差距**：自动快照、撤销/重做、
> 启动救援模式、崩溃归因。全部为新增能力，不改动既有分区模型与导入/导出契约。
> 尚无对应 issue（由竞品源码审计驱动）。
>
> **阅读提示**：下面这些能力在本版中**用户不可达**（开关为 false）。列出它们是为了让
> 发布内容可被完整审计，而不是宣称它们已可用。

### ⚠️ 默认关闭（本版不对用户开放）

- **灾备子系统整体下线**：`LIFECYCLE_ENABLED = false`（`src/index.ts`）关闭
  自动快照监听、`boot-state` 写入与 `/lifecycle` / `/crash` / `/rescue` 三条路由
  （一律 `503 feature-disabled`）；客户端导航入口同步关闭
  （`SHOW_LIFECYCLE_NAV = false`）。**两个开关必须同开同关**，否则会出现
  「入口可见但功能 503」的错位。
- **为什么下线**：自动快照的采集覆盖**全部 adapter**，其中 `sessions` 分区（历史会话）
  在本机实测 340 MB，远超快照 64 MiB 上限，必然持续失败并刷
  `[lifecycle] 自动快照失败: 配置快照超出上限（479313046 > 67108864 字节）` 告警。
  在该缺陷修好前，撤销/重做/救援也没有可信的快照基线可用，故整体下线而非只停监听。
- 引擎代码与测试**全部保留**（core 模块、客户端组件、路由实现均未删除），修好缺陷后
  把两个开关改回 `true` 即可恢复。已有守卫测试锁定开关确实挂在启动路径上
  （`src/core/phase1-wiring.test.ts` 的「灾备总开关」三条），防止只改注释不改行为。

### 新增

- **自动快照（P0-1）**：监听 DSH 配置目录与用户插件源码目录，防抖合并文件事件后
  自动落一份配置状态快照。含**两层回声抑制**——写操作窗口内直接丢弃事件，窗口外按
  内容指纹识别「恢复动作自写文件」的延迟投递事件。缺了这层，恢复动作会立刻产生一个
  等于刚写回内容的快照，把重做通道堵死。
- **撤销 / 重做（P0-2）**：撤销 = 回退到与当前状态**内容不同**的最新快照（自动快照在
  变更之后采集，所以「最新快照」通常等于当前状态，必须跳过）；撤销前先落 `pre-restore`
  快照使重做可逆；撤销后若又发生真实变更，重做**被拒**而非覆盖用户新改动。全部相同时
  明确报告「没有可撤销的变化」，不做空操作。
- **启动救援模式（P0-3）**：DSH 因插件/bundle 起不来时，备份 `cordis.patch.yml`（home 与
  profile 两层）与 `package.json`，改写为只挂载本插件自身的最小 patch，并把
  `dsh.profile.bundles` 收窄为 **DSH 核心（`@deepseek-ai/*`）+ 本插件**——其余用户插件本次
  启动不挂载（只中和 patch 层救不了「bundle 能解析但插件代码把 DSH 搞挂」这类）；退出时逐
  字节完整还原。含家目录指纹——换机/重建 home 后残留状态自动降级不激活。**救援路由刻意不
  进入 mutation gate**：否则会被它要解决的那个状态挡住，形成死锁。
- **崩溃归因（P0-5）**：`boot-state.json` 记录每次启动结果，上次未正常结束时按日志尾部
  签名分类（`session-corrupt` / `bundle-check` / `patch-tree` / `unknown`）并给出建议动作与
  「最后正常快照」id。归因在启动时一次性持久化——日志会被滚动覆盖，错过就没了。
- 三条新路由：`GET /api/dsh-config-manager/lifecycle/status`、`POST .../lifecycle/{snapshot,undo,redo,remove}`、
  `GET /api/dsh-config-manager/crash`、`GET|POST /api/dsh-config-manager/rescue`。

### 修复（自审 + 独立审计发现的缺陷）

- **退出救援对路径写法敏感（用户实测卡死）**：家目录指纹原先直接哈希 `homeDir` 原始字符串，
  同一目录换个写法（`C:/…` vs `C:\…`、尾分隔符、`.`/`..`）就判 stale 并**拒绝还原、一个文件
  都不动**。从插件 UI 进出时两次都原样传 `host.homeDir` 所以看不出来，从 CLI / 脚本手动进出
  必踩。现在指纹输入经 `normalizeHomeDir` 归一化（resolve + win32 折叠大小写），并兼容历史
  （归一化前）指纹，使**已处于救援态**的用户升级后仍能正常退出。
- **救援没有真正禁用其它插件**：原先只中和 patch 层 + 剪掉「不可解析」的 bundle，bundle 只要
  能解析就照旧挂载，治不了「插件代码自己把 DSH 搞挂」。现在进入救援会把 `dsh.profile.bundles`
  收窄为 DSH 核心 + 本插件；保留了 `@deepseek-ai/dsh-base` / `dsh-web-app`，否则 DSH 自身
  都起不来。UI 文案与代码注释同步改为如实描述。
- **自动快照会丢失中间状态**：watcher 在回调前已把事件批摘除，而 flush 进行中到来的批次被
  直接丢弃且**不再重排**——实测连写 v2、v3 只落 1 份快照，撤销于是无从回到 v2。现在改为排队
  补拍。
- **恢复通道的回声抑制只覆盖撤销/重做**：导入、备份恢复、Profile 切换、同步应用同样会写配置
  文件，却不在抑制窗口内，恢复完会立刻多出一份「等于刚恢复内容」的快照，把重做通道永久堵死。
  现在按「采集状态是否等于最新快照 / 刚回放的目标状态」兜底，覆盖全部通道。
- **撤销可能「假成功」**：某个分区采集失败时状态会少一个分区，与内容其实相同的快照判为
  「不同」→ 选中它 → 回放写不回任何东西却返回 `ok:true`，且 `canUndo` 永远为真。现在采集
  不完整即拒绝撤销（`capture-incomplete`）并让 `canUndo=false`。
- **回放失败仍消费 pre-restore**：重做通道就此消失，而配置正停在半应用的中间态。现在仅回放
  成功才消费。
- **`pre-restore` 记录的可能不是「撤销前状态」**：原先挑目标与落 pre-restore 是两次独立采集，
  之间的用户改动会溜进去，重做时把用户没见过的内容写回去。现在复用同一次采集。
- **一条损坏快照能让整个灾备面板 500**：`meta.state` 未做形状校验，`statesEqual` 会抛
  `TypeError`。现在读取侧丢弃形状不对的 meta，比较侧改为全函数（缺字段不抛）。
- 救援卡片把「自动快照未开启」当成「救援未开启」显示；启动后新出现的 `skills` /
  `.agent-presets` 目录此前在整个进程生命周期内都不会被监听（与注释承诺不符），现已自愈纳入。

### 说明

- 配置状态快照存放于 `<dataDir>/config-snapshots`，与导入前快照 `<dataDir>/snapshots`
  **分目录**：后者由导入计划驱动（只登记本次将写入的目标），无法回答「配置整体变没变」。
  两者保留策略与回放方式都不同，混用会产生错误语义。
- 快照回放复用 adapter 管线（`validate → analyzeImport → applyItem`），与导入/Profile 切换
  同一条写入路径，因此不引入第二套写入逻辑。
- 监听器与定时器全部依赖注入，自动快照时序在测试中由假定时器驱动——不 sleep、不受机器负载
  影响。

### 测试

- 新增 6 个 core 模块与 7 个测试文件；全量套件 1910+ 项通过。
- 含接线守卫（`src/core/phase1-wiring.test.ts`）：断言路由/闸门/dispose 确实在盘上，
  防止「注释承诺 > 实际防线」；守卫自身已按 LF 与 CRLF 双形态验证。
- 上述缺陷各有对应回归测试（含确定性故障注入：`exportGate` 钉死 flush 竞态、
  `failExport` / `failApply` 注入采集与回放失败）。
## [v0.1.59] - 2026-09-13

> 本版把两个**尚未发布**的版本合并为一次发布，因此只占一个版本号。它包含前后两轮工作：前半是**自驱的能力补齐轮次**，方向来自对同类工具（restic / kopia / Borg / rclone / Duplicati / Syncthing / chezmoi / yadm / mackup / VS Code / JetBrains）的能力对照与差距分析，落点选在「会真正丢东西」与「可靠性无法自证」两类问题上；后半是**格式规格化 + 全量缺陷修复**轮次，方向是把 bundle 格式从「实现细节」变成**可被第三方独立实现的对外契约**，并在此过程中把审计挖出的缺陷**真正修掉**（而非仅登记）。两轮均不针对任何新提交的 issue。

### 🎯 亮点 / Highlights (zh)

- 🧩 **本地开发中的插件不再随换机丢失（能力补齐轮次最重要）**：以 `link:` / `file:` 安装的插件，其依赖 spec 指向的是**本机绝对路径**（例如 `link:D:/Projects/my-plugin`）。导出备份时会原样记下这条路径，而目标机器上它根本不存在——导入时该插件必然安装失败，且**失败是静默的**（备份看起来完好）。现在导出阶段会对这类插件执行 `npm pack`，把打出的 tarball 一并放进备份；导入阶段先解包到 `$DSH_HOME/dsh-config-manager/local-plugins/`，再把 spec 重写为 `file:<绝对路径>` 交给官方安装通道。单个插件打包失败**不会中断导出**（记 warning 跳过，其余继续），超过 100 MB 的 tarball 会被跳过并告警。**密钥排除规则不受影响**——进入备份的是插件代码，不是凭据
- 🔍 **CLI 补上 `verify`：回答「三个月前那个备份现在还能不能用」**（此前无任何入口）。它把备份 ZIP 从磁盘重读一遍、**一个字节都不写**，给出五种互斥裁决：`OK` / `MISSING` / `CORRUPT` / `UNSUPPORTED` / `VERIFY_ERROR`。逐条目重算 SHA-256 与 `integrity/checksums.json` 比对，不符时**点名具体条目**（而不是只给个总数）；解压全程走既有强化解析器（Zip Slip / 压缩炸弹 / 符号链接 / 重复条目名一律拒绝）。**校验失败绝不降级成"大概没问题"**——`VERIFY_ERROR` 只用于自检自身失败（磁盘 IO 等），明确区别于「备份确实坏了」。退出码语义明确（全 OK → 0，任一非 OK → 1），并支持 `--json` 供 CI 与定时任务断言
- 💾 **CLI 补上 `backup`：DSH 起不来时也能备份**。此前的 CLI 是「能恢复但不能备份」——GUI 与 Agent 工具都能备份，唯独救急通道缺这一半。现在可离线把 `$DSH_HOME` 下**离线可直读**的分区打成与 GUI 同结构的 ZIP（manifest + checksums + 分区目录），并立即自检。**刻意不伪造结构化分区**：`settings` 等必须经 DSH 服务层权威脱敏、离线拿不到，这类分区**不进归档并在输出里列为"离线不可收集"**——宁可如实告知，也不产出一个「声称含设置、实际为空」的假备份（那会让恢复者误以为配置已经保住）
- 🗄️ **保留策略可配置，支持 GFS 分层**：快照与定时备份的保留策略此前是**三处硬编码常量**（快照 10 / 定时备份 10），用户完全不可调；总览页的分母还写死了字符串 `'10'`，改常量会导致 UI 与实际行为不一致。现在策略可配——「最近 N 份 + 每月留 1 份 + 每年留 1 份」（参考 restic `forget` 的分层思路，配置备份这类「体积小、变化频繁」的场景比纯 FIFO 更合用）。**默认值与旧行为逐字节等价**（`keepLast: 10` 且分层关闭时直接走原函数），既存快照的清理结果不会发生任何变化
- 🛡️ **配置市场两端拒绝内嵌插件代码**：本轮给 `plugins` 分区新增的本地插件 tarball 字段（`localTarballs`），在**发布端**（`prepareMarketItem`）与**导入端**（市场条目校验）**同时硬拒绝**。原因：tarball 是不可经公开仓库审阅的不透明二进制，安装时可能执行 `postinstall`——若允许它经市场分发，等于给「分享配置」开了一条携带任意代码、绕过既有 BANNED 分区防线的通道。本地插件迁移只应发生在**自己的备份**里。该字段也因此**不会**成为新的供应链入口

- 🚦 **CI 有了 PR 门禁**：此前 `.github/workflows/` 只有发布流水线（仅 `tag v*` 触发），dependabot 与外部贡献的 PR **全绿与否无人校验**即可合并。现在新增 `ci.yml`：`pull_request` → `main` 与 `push` → `main` 跑完整的 typecheck → test（全量 1600+ 项）→ build → pack，**零发布副作用**（不含 publish、不申请 OIDC 凭据、权限仅 `contents: read`），并带并发取消（同分支新提交自动取消旧运行）与超时兜底

- 📜 **bundle 格式 v1 有了对外规格**（`docs/spec/bundle-format-v1.md`，1312 行）：逐条 `file:line` 取证 + 显式「未验证」清单，配 manifest 的 JSON Schema（`bundle-manifest.schema.json`）与可执行一致性语料（`tests/conformance/`）。规格的核心章节是**向前兼容规则**——导入端遇到「未知分区」「未知顶层字段」「已知分区内的未知字段」时分别保留还是忽略，逐条实测写明。**同时诚实登记了尚存的空白**：各 adapter 的冲突判定规则、`PlanItem.id` 命名约定、对外返回类型契约仍未规格化，第三方据此仍**无法**完整实现兼容 importer
- ⛓️ **迁移链从「死代码」变成真实接入（缺陷修复轮次最重要）**：`migrateToCurrent` 此前**全库零 import**——有定义、有注册、有单测，却**从未被导入路径调用**。叠加 `MIN_SUPPORTED = CURRENT = 1`，整条迁移链**一次都没真正执行过**。这意味着发布 schema v2 那天，旧备份会被判定「可迁移」却**不迁移**，用户拿到静默的错误数据。现在导入路径在 `needsMigration` 为真时真实调用迁移链、用迁移结果替换 manifest，并重新校验结果合法性
- 🔍 **「不认识」与「文件缺失」不再混为一谈**：此前未知分区被**静默丢弃**，而唯一的相关告警还把原因说反了——报「备份声明了但**缺少**的分区: X」，**而文件其实就在 ZIP 里**。用户无法判断该升级插件还是备份坏了。现在未知分区走独立的 `unsupportedSections` 通道与专属告警文案；分区数据版本高于本版本时**跳过该分区并告警**，而不是让**整个 bundle** 无法导入（数据损坏类的非法版本号仍硬失败）
- 🧾 **完整性校验补上反向检查**：此前 checksums 只保证「表内条目未被篡改」，不保证「ZIP 内没有多余条目」，且**剥掉校验表即可无提示通过**。现在未登记条目会明确告警，校验表缺失或为空时也会显式告知「全部条目未被校验」——**不再有静默通过路径**
- 🔐 **加密备份不做任何密码强度校验（刻意的产品决策）**：加密备份的密码策略**完全由用户自己掌握**，插件不施加任何强度约束——`1`、`12345678`、`password` 一律可用。**唯一约束是密码非空**（空字符串会被拒），加密入口除此之外不再做任何判定。这项决策同时**删除**了此前那个强度校验函数：它在上一版（`v0.1.58`）中虽已实现且有单测，却在宿主入口**从未被调用**——一个「看起来在守、实际不跑」的死代码。本版选择**直接移除**而不是把它接通，因为留着一个永不生效的闸门比没有闸门更危险：它会让维护者和审计者误以为防线存在。**解密方向同样不校验**（且现在整个校验面都不存在）——否则历史弱密码备份会**永久打不开**
- 🕵️ **文件类分区纳入凭据扫描**：`skills` / `agentPresets` / `agentInstructions` / `pluginFiles` / `sessions` / `self` 的内容此前**完全不进扫描器**，也不计入 `redactedHits`——「默认不含秘密」这条不变量对它们**不成立**。现在导出时做文本级扫描并告警（**只报告、绝不改写**——那是用户的真实文件），且三条导出路径（HTTP 路由 / `config_backup` / 定时自动备份）注入**同一个** scanner 实例，避免档位漂移
- 📦 **引擎可被 headless 环境零成本消费**：`@radix-ui/*` 与 `lucide-react` 已被内联进 `lib/client.js`，却仍挂在 runtime `dependencies`，迫使只想复用引擎的消费者安装整套 React UI 栈。现在它们归入 `devDependencies`，且全部 16 个 peer 标记 `peerDependenciesMeta.optional`（它们由 DSH 宿主提供）。**默认安装从 74 个包 / 32.25 MB 降到 3 个包 / 8.84 MB**；同时 `files` 排除 140 个 `.map`，发布包从 2.48 MB 降到 1.88 MB。`./schema` 导出位此前指向纯类型产物（运行时 **0 导出**），现在是真实的运行时入口

### Highlights (en)

> This release merges two **as-yet-unpublished** versions into a single release, so it occupies only one version number. It spans two rounds of work. The first is a self-driven **capability-gap round**, scoped by comparing against peer tools (restic / kopia / Borg / rclone / Duplicati / Syncthing / chezmoi / yadm / mackup / VS Code / JetBrains) and targeting two classes of problem: things that **actually lose data**, and reliability that **cannot be self-proven**. The second is a **format-specification and defect-remediation round** that turns the bundle format from an implementation detail into a contract **a third party can implement independently**, and **actually fixes** — rather than merely logs — the defects the audit surfaced. Neither round addresses a newly filed issue.

- 🧩 **Locally developed plugins no longer vanish when you change machines (the capability round's headline fix)**: plugins installed via `link:` / `file:` carry a dependency spec that points at a **machine-local absolute path** (e.g. `link:D:/Projects/my-plugin`). The backup used to record that path verbatim, but it does not exist on the target machine, so the plugin inevitably failed to install — **and failed silently** (the backup looked perfectly fine). Export now runs `npm pack` for such plugins and bundles the resulting tarball; import unpacks it under `$DSH_HOME/dsh-config-manager/local-plugins/` and rewrites the spec to `file:<absolute path>` for the official install path. A single plugin failing to pack **never aborts the export** (recorded as a warning, the rest continue), and tarballs above 100 MB are skipped with a warning. **Secret-exclusion rules are unaffected** — what enters the backup is plugin code, not credentials
- 🔍 **New CLI `verify`: "is that backup from three months ago still usable?"** There was previously no way to ask. It re-reads the backup ZIP from disk and **writes not a single byte**, returning five mutually exclusive verdicts: `OK` / `MISSING` / `CORRUPT` / `UNSUPPORTED` / `VERIFY_ERROR`. It recomputes SHA-256 per entry against `integrity/checksums.json` and **names the offending entries** rather than reporting a bare count; extraction goes through the existing hardened parser (Zip Slip / zip bombs / symlinks / duplicate names all rejected). **A failed check is never downgraded to "probably fine"** — `VERIFY_ERROR` is reserved for failures of the check itself (disk I/O), which is explicitly distinct from "the backup is genuinely broken". Exit codes are unambiguous (all OK → 0, any non-OK → 1) and `--json` is available for CI and scheduled assertions
- 💾 **New CLI `backup`: back up even when DSH cannot start.** The CLI could previously restore but not back up — the GUI and the agent tools could both back up, yet the emergency path was missing exactly that half. It now builds, fully offline, a ZIP with the same structure the GUI produces (manifest + checksums + section directories) from the parts of `$DSH_HOME` that are **directly readable offline**, then self-verifies it. It **deliberately does not fabricate structured sections**: `settings` and friends must be authoritatively redacted through the DSH service layer and are unobtainable offline, so those sections **stay out of the archive and are reported as "not collectable offline"** — honest disclosure rather than a bogus backup that claims to contain your settings while being empty (which would leave a restorer believing the configuration was saved)
- 🗄️ **Configurable retention with GFS tiers**: snapshot and scheduled-backup retention used to be **three hard-coded constants** (10 snapshots, 10 scheduled backups) that users could not change at all, and the overview page hard-coded the string `'10'` as its denominator, so changing a constant would silently desync the UI from real behaviour. Retention is now configurable — "the last N + one per month + one per year" (modelled on restic `forget`'s tiered thinking; a better fit for config backups, which are small and change often, than pure FIFO). **Defaults are byte-for-byte equivalent to the old behaviour** (`keepLast: 10` with tiers disabled calls the original function directly), so pruning results for existing snapshots do not change at all
- 🛡️ **The marketplace rejects embedded plugin code at both ends**: the local-plugin tarball field (`localTarballs`) added to the `plugins` section this round is **hard-rejected on both the publish side** (`prepareMarketItem`) **and the install side** (market item validation). The reason: a tarball is an opaque binary that cannot be reviewed through a public repository and may run `postinstall` on install — allowing it through the marketplace would open a channel for shipping arbitrary code via "shared config", bypassing the existing BANNED-section defenses. Migrating locally developed plugins belongs in **your own backup**, not in a public marketplace item. The field therefore does **not** become a new supply-chain entry point

- 🚦 **CI now has a PR gate**: `.github/workflows/` previously held only the release pipeline (triggered solely by `tag v*`), so dependabot and external-contribution PRs **could be merged with nobody checking whether they passed**. The new `ci.yml` runs the full typecheck → test (1600+ tests) → build → pack on `pull_request` → `main` and `push` → `main`, with **zero release side effects** (no publish step, no OIDC credentials requested, `permissions: contents: read` only), plus concurrency cancellation (a newer push to the same branch cancels the stale run) and a timeout guard

- 📜 **Bundle Format v1 now has a public specification** (`docs/spec/bundle-format-v1.md`, 1312 lines): per-claim `file:line` evidence plus an explicit "unverified" list, alongside a JSON Schema for the manifest and an executable conformance corpus (`tests/conformance/`). Its central chapter is **forward-compatibility**: whether an importer preserves or ignores an unknown section, an unknown top-level field, and an unknown field inside a known section — each determined by measurement, not assumption. It **also honestly records what is still missing**: per-adapter conflict rules, the `PlanItem.id` convention, and the return-type contracts are not yet specified, so a third party still **cannot** fully implement a compatible importer
- ⛓️ **The migration chain went from dead code to genuinely wired in (the defect-remediation round's most important reliability fix)**: `migrateToCurrent` had **zero importers anywhere** — defined, registered, unit-tested, and **never called by the import path**. Combined with `MIN_SUPPORTED = CURRENT = 1`, the entire chain had **never once executed for real**. The consequence: on the day schema v2 ships, an old backup would be judged "migratable" and then **not migrated**, handing the user silently wrong data. The import path now genuinely invokes the chain when `needsMigration` holds, replaces the manifest with the migrated result, and re-validates it
- 🔍 **"I don't recognise this" is no longer conflated with "the file is missing"**: unknown sections used to be **silently dropped**, and the only related warning stated the cause backwards — "sections declared by the backup but **missing**: X" — **while the file was in fact inside the ZIP**. Users could not tell whether to upgrade the plugin or distrust the backup. Unknown sections now travel a dedicated `unsupportedSections` channel with their own message; a section whose data version is newer than this build is **skipped with a warning** instead of making the **whole bundle** unimportable (genuinely invalid version numbers still fail hard)
- 🧾 **Integrity checking gained its reverse direction**: checksums used to guarantee only that "entries in the table were not tampered with", never that "the ZIP contains nothing extra" — and **removing the checksum table made everything pass silently**. Unregistered entries now warn, and a missing or empty table explicitly reports that **no entry was verified**. There is **no longer a silent-pass path**
- 🔐 **Encrypted backups apply no password-strength validation at all (a deliberate product decision)**: the password policy for an encrypted backup belongs **entirely to the user** — the plugin imposes no strength requirement, so `1`, `12345678` and `password` are all accepted. **The only constraint is that the password is non-empty** (an empty string is rejected); beyond that the encryption entry point makes no judgement. This decision also **deleted** the strength-checking function: it existed in the previous release (`v0.1.58`) with unit tests, yet had **zero call sites** in the host entry — dead code that looked like a guard but never ran. This release **removes** it outright instead of wiring it up, because a gate that never fires is more dangerous than no gate: it leads maintainers and auditors to believe a defence exists. **Decryption is likewise never validated** (and no validation surface exists at all now) — doing so would make **historical weak-password backups permanently unopenable**
- 🕵️ **File-type sections are now scanned for credentials**: the contents of `skills` / `agentPresets` / `agentInstructions` / `pluginFiles` / `sessions` / `self` previously **never entered the scanner** and were excluded from `redactedHits` — so "no secrets by default" **did not hold** for them. Export now scans their text and warns (**report only, never rewrite** — these are the user's real files), and all three export paths (HTTP route / `config_backup` / scheduled auto-backup) inject **the same** scanner instance so their strictness cannot drift apart
- 📦 **The engine is now consumable from a headless environment at zero cost**: `@radix-ui/*` and `lucide-react` are already inlined into `lib/client.js` yet still sat in runtime `dependencies`, forcing anyone who wanted only the engine to install a whole React UI stack. They now live in `devDependencies`, and all 16 peers are marked `peerDependenciesMeta.optional` (they are supplied by the DSH host). **A default install drops from 74 packages / 32.25 MB to 3 packages / 8.84 MB**, while `files` now excludes 140 `.map` files, shrinking the published tarball from 2.48 MB to 1.88 MB. The `./schema` export used to point at a types-only artifact (**0 runtime exports**); it is now a real runtime entry point

## [v0.1.58] - 2026-09-12

> 本版为自驱的 UI 打磨与缺陷修复轮次，**不针对任何新提交的 issue**（#27-#30 的修复随 v0.1.57 发布）。

### 🎯 亮点 / Highlights (zh)

- 🧭 **历史页「分类筛选」首次真正生效**：此前后端查询契约（`filterToQuery`）已实现、单测全绿，但历史面板从未把筛选条件传给后端（`list()` 不带参），于是「分类 / 结果」下拉**可点却纹丝不动**——纯函数已写、组件从未接线的空接线缺陷。现改为前端收敛（`filterByKindResult`）：下拉只列出**当前数据里真实出现过**的分类与结果（全部 14 类中多数在本机永远不会出现，列出来只会让人选中"永远为空"的选项），并强制保留当前选中项，避免「选中了却在下拉里找不到」；统计徽章与分组随之反映筛选结果
- 📊 **同步历史改用设计系统数据表 + 顶部统计摘要**：该表此前用字符串 class `sync-history-table`（全仓唯一字面量，且**无任何 CSS 规则**，等同于裸表格）。现改用 `.dataTable/.tableFixed/.tableCompact`（限高内滚 + 固定列宽），并在表头新增统计摘要徽章行（总数 / 快照 / 自动同步 / 失败 / 跳过，**失败与跳过仅在存在时出现**并给语义色）；快照 UUID 中段省略、保留头尾区分信息（悬停仍给全文），时间列等宽 11px 单行显示、悬停给出**含秒**的完整本地时间；自动同步的跳过原因独立成第二行小字，状态徽章带语义色
- 🧹 **「建议依据」去重**：迁移前咨询卡的建议依据是各维度问题文案的直接拼接，同一句可能被重复 push 多次（如「存在需注意的迁移项」按迁移项逐条 push）。现按**原文**去重并保持首次出现顺序，重复项以「×N」标注，空串与纯空白条目丢弃（刻意不做 trim 合并、不做大小写折叠，避免把不同内容误并）
- 📄 **长配置明细不再横向溢出**：导入冲突的「配置更改明细」原用 `<pre>`（`white-space: pre` 不换行），长 JSON 会把卡片撑出左右滚动条。现拆成 `current` / `imported` 两段各自独占一行、中间以 1px 分割线区隔，长值任意位置折行
- 🪟 **导出预览改为弹窗 + 分区构成共用组件**：预览结果由行内横幅改为宽弹窗（加载 / 合计 / 分区构成 / 错误都在弹窗内呈现，点击立即打开不再等待），并与总览页共用新的 `SectionComposition` 分区构成网格，两处视觉与文案完全一致
- 📋 **备份计划卡信息分层**：改为「头部（标题 / 结果徽章 / 动作）→ 事实行（开关状态 / 备份间隔 / 上次运行）→ 说明 → 设置行」。事实行统一取**宿主权威值**，未保存的草稿不再改写它，避免把尚未生效的档位显示成已生效；关闭定时备份时隐藏间隔与时刻下拉，减少无关噪音
- 📐 **布局回归修复（含暗色主题下的突兀色块）**：`.input/.select` 移除全局 `width:100%`（市场筛选、同步快照下拉等**行内**控件曾被撑成各自独占一整行），满宽只在纵向字段内按需生效；`.shellNav` 不再铺底色（暗色下其底色比宿主设置面板底色更暗，会形成一条通栏色块）；弹窗尺寸放大以容纳长内容；新增 `.actionRowTop/.tabRow/.headRow/.authorRow` 行原语，把「行」的语义与间距集中到 CSS，不再各处内联 margin；市场筛选改为 2 列网格
- 🐛 **修复备份页选中行高亮丢失**：快照列表行原本带 `data-selected` 提供选中淡底，随本轮重构被误删，导致 listbox 选中态**只剩语义（`aria-selected`）没有视觉反馈**。已恢复

### Highlights (en)

> This release is a self-driven UI polish and defect-fix round and **does not address any newly filed issue** (the #27-#30 fixes shipped in v0.1.57).

- 🧭 **History category filtering works for the first time**: the backend query contract (`filterToQuery`) was implemented and fully unit-tested, but the history panel never passed the filter to the backend (`list()` took no arguments), so the kind / result dropdowns **could be changed without affecting the list at all** — a pure function written and tested, yet never wired up. Filtering is now applied on the client (`filterByKindResult`); the dropdowns list only the kinds and results that **actually occur in the current data** (most of the 14 kinds never occur on a given machine, and offering them only lets you pick an option that is always empty), the current selection is always kept in the list, and the summary badges and grouping follow the filtered set
- 📊 **Sync history now uses the design-system data table, with a header summary**: the table previously used the string class `sync-history-table` (the only such literal in the repo, and it had **no CSS rules at all** — effectively a bare table). It now uses `.dataTable/.tableFixed/.tableCompact` (height-capped inner scroll with fixed column widths), and gains a summary badge row in the header (total / snapshots / auto sync / failed / skipped, where **failed and skipped appear only when non-zero** and carry semantic colours); snapshot UUIDs are middle-ellipsized so the distinguishing tail survives (the full value stays in the tooltip), timestamps render as a single line of 11px monospace with the **second-precision** local time on hover, and the auto-sync skip reason moves to its own second line with a colour-coded status badge
- 🧹 **"Reasons" de-duplication**: the pre-migration consult card builds its reasons by concatenating dimension issue messages, so the same sentence could be pushed repeatedly (e.g. "there are migration items to review", pushed once per item). Reasons are now de-duplicated **literally**, keeping first-appearance order, with repeats labelled "×N" and empty or whitespace-only entries dropped (deliberately no trim-merging and no case folding, which would merge genuinely different content)
- 📄 **Long conflict details no longer overflow horizontally**: the import conflict "configuration change detail" used a `<pre>` (`white-space: pre`, no wrapping), so a long JSON blob forced a horizontal scrollbar. It is now split into `current` and `imported` lines separated by a 1px rule, wrapping anywhere
- 🪟 **Export preview is now a dialog, sharing the section-composition component**: the preview moved from an inline banner to a wide dialog (loading / totals / section breakdown / errors all render inside it, opening immediately instead of waiting), and it now shares the new `SectionComposition` grid with the overview page so both render identically
- 📋 **Backup schedule card re-layered**: header (title / result badge / actions) → fact rows (enabled state / interval / last run) → notes → settings. The fact rows always read the **host-authoritative** values, so unsaved drafts no longer rewrite them (previously an unsaved interval could appear to be in effect); interval and time dropdowns are hidden while scheduled backup is off
- 📐 **Layout regression fixes (including a dark-theme colour block)**: `.input/.select` no longer default to `width: 100%` (inline controls such as the market filters and the sync snapshot picker were each being stretched onto their own full-width row) — full width now applies only inside vertical field containers; `.shellNav` no longer paints a background (in dark themes its colour is *darker* than the host settings panel, producing a full-width slab); dialogs were enlarged for long content; new row primitives `.actionRowTop/.tabRow/.headRow/.authorRow` centralise row semantics and spacing in CSS instead of scattered inline margins; the market filters became a two-column grid
- 🐛 **Fixed the lost selected-row highlight on the backup page**: snapshot rows carried `data-selected` for their selected tint, which was dropped during this refactor, leaving the listbox selection with **semantics (`aria-selected`) but no visual feedback**. Restored

## [v0.1.57] - 2026-09-11

### 🎯 亮点 / Highlights (zh)

- 🌐 **出站请求现支持代理**（issue #30）：GitHub 登录与市场/同步请求不再受「必须经代理访问 GitHub」的网络限制。插件现在自行读取 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 并让**自身**出站经代理（`https` 目标走 `CONNECT` 隧道 + TLS，`http` 目标走 absolute-form），覆盖 GitHub API、device flow 登录与 WebDAV 同步三条路径 —— 此前 Node 内置 fetch 默认不读代理变量，导致 device flow 报 `fetch failed`、`/me/status` 返回 500。**未配置代理时行为完全不变**；代理凭据绝不进日志；可用 `DSH_CONFIG_MANAGER_PROXY=off` 强制直连。相比 `NODE_USE_ENV_PROXY` 的进程级开关，本实现**只影响插件自身**，不会改变宿主（含模型 API）的出站行为，也不要求 Node ≥ 24.14
- 🔓 **未配置 token 不再报「登录状态读取失败」**（issue #29）：首次使用（credentials 中尚无同步 token）时「我的配置」会误报错误横幅。现在「未配置 token」与「token 失效（401）」统一视为**未登录**，正常显示「未登录 + 使用 GitHub 登录」；而网络/限流等**真实故障仍如实报错**，不会被伪装成未登录
- 🔧 **残留环境锁可识别、可恢复**（issue #27）：进程被强制结束（任务管理器 / `kill -9`）后留下的环境锁此前与「另一任务运行中」共用同一句「请稍后重试」，但残留锁**永远不会自愈**，导致上传/同步持续失败且无从下手。现在残留锁单独提示「重试或重启 DSH 均无效」并给出恢复方式；`recover-stale-lock` 命令补进 `--help` 与 README（此前是隐藏命令）；自动同步被挡时也会写出同样的可操作指引。**恢复策略不变**：仍只在持有者被确证死亡时回收，绝不自动摘活锁
- 🩺 **插件清单来源可自查**（issue #28）：在「关于」页新增「插件清单来源」诊断位，显示清单**实际读取的目录 / profile 名 / 识别到的插件数量**；当该目录读不到 `package.json` 时会明确告警。用于定位「明明装了插件、备份里却识别不到」（profile 或 `DSH_HOME` 与实际不符）
- ✨ **界面全面翻新（Visual Polish）**：统一图标（Lucide）与弹窗（Radix Dialog，含完整 focus trap / Esc / 焦点还原）、新增 Toast 通知；顶部页签条与底部状态栏改为圆角分段条；概览页指标可**精确跳转**到对应子视图，健康段在存在待处理恢复事项时直达「事故恢复」；移除常驻冗余绿灯提示。视觉仍 100% 走 DSH `--dsw-*` token，不引入第二套视觉体系

### Highlights (en)

- 🌐 **Proxy support for outbound requests** (issue #30): GitHub sign-in and market/sync requests no longer break on networks where GitHub is reachable only through a proxy. The plugin now reads `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` for **its own** egress (`https` via `CONNECT` tunnelling + TLS, `http` via absolute-form), covering the GitHub API, the device-flow login and WebDAV sync — Node's built-in `fetch` ignores proxy variables, which previously produced `fetch failed` on device flow and HTTP 500 on `/me/status`. **No behaviour change when no proxy is configured**; proxy credentials are never logged; `DSH_CONFIG_MANAGER_PROXY=off` forces direct connections. Unlike the process-wide `NODE_USE_ENV_PROXY`, this affects **only the plugin**, leaving host egress (including model API calls) untouched, and does not require Node ≥ 24.14
- 🔓 **Missing token no longer shows "failed to read sign-in status"** (issue #29): on a fresh setup (no sync token in credentials) "My Configs" wrongly rendered an error banner. "No token" and "token rejected (401)" are now treated alike as **not signed in**, showing "Not signed in + Sign in with GitHub", while genuine failures (network / rate limit) still surface as real errors instead of being disguised as a sign-out
- 🔧 **Leftover environment locks are now identifiable and recoverable** (issue #27): after a force-killed process (Task Manager / `kill -9`) the leftover lock shared the generic "please retry later" message with a genuinely busy lock — yet a leftover lock **never clears by itself**, so uploads/syncs kept failing with no way forward. It now reports that retrying or restarting won't help and points at the fix; `recover-stale-lock` is documented in `--help` and the README (it used to be a hidden command); autosync logs the same actionable hint. **Recovery policy is unchanged**: a lock is still reclaimed only when its owner is proven dead — a live lock is never taken over
- 🩺 **Self-service diagnostics for the plugin list** (issue #28): the About page now shows which directory / profile the plugin list was actually read from and how many plugins were detected, with an explicit warning when `package.json` cannot be read — pinpointing "plugins installed but missing from the backup" (a mismatched profile or `DSH_HOME`)
- ✨ **Full UI refresh (Visual Polish)**: unified icons (Lucide) and dialogs (Radix Dialog with proper focus trap / Esc / focus restore), new toast notifications; the top tab strip and bottom status bar became rounded segmented bars; overview metrics now deep-link to the matching sub-view and the health segment jumps straight to "Incident recovery" when recovery items are pending; the redundant always-on green banner was removed. Styling still uses DSH `--dsw-*` tokens exclusively — no second visual system

## [v0.1.56] - 2026-09-03

### 🎯 亮点 / Highlights (zh)

- 🔄 **WebDAV 自动跟随重定向**：同步通道现可自动跟随 301/302/303/307/308 跳转（上限 5 跳）——修复 123pan 等网盘 WebDAV 把下载 GET 302 到带时效签名 CDN 直链导致 list/push/pull 全部失败的问题（issue #25）；跨域跳转自动剥离 Authorization（Basic 凭据不会转发给 CDN 第三方域名），303 且非 GET 时按语义降级为 GET；跳转循环给出清晰报错
- ✏️ **WebDAV 配置弹窗文案修正**：服务器地址帮助文案由过时的 `snapshots/` 子目录更新为实际的 `dsh-config-manager/` 子目录，与 v0.1.55 起的远端存储路径一致

### Highlights (en)

- 🔄 **WebDAV redirect following**: the sync channel now follows 301/302/303/307/308 redirects (up to 5 hops) — fixing syncs that fail entirely on pan-drive WebDAV servers (e.g. 123pan) which redirect download GETs to time-signed CDN direct links (issue #25); cross-origin hops strip `Authorization` so Basic credentials never leak to third-party CDN domains, 303 downgrades non-GET methods to GET per spec, and redirect loops now surface a clear error
- ✏️ **WebDAV setup copy fix**: the server-URL help text now mentions the actual `dsh-config-manager/` subdirectory instead of the stale `snapshots/`, matching the remote storage layout since v0.1.55

## [v0.1.55] - 2026-09-02

### 🎯 亮点 / Highlights (zh)

- 🔄 **WebDAV 同步存储路径变更**：远程快照目录由 `snapshots` 改为 `dsh-config-manager`。**升级注意**：如需保留坚果云（WebDAV）上之前的历史同步数据，请登录坚果云网页版，将原有的 `snapshots` 文件夹重命名为 `dsh-config-manager`，升级新版本后即可直接读取；如无需保留旧历史，新版本会自动在 `dsh-config-manager` 路径下重建索引与快照
- 🌐 **WebDAV 请求改用原生 `node:http/https`**：更可靠地支持 MKCOL/PROPFIND 等全部 WebDAV 方法，并携带准确的 `Content-Length` 与 `User-Agent`，解决部分 WebDAV 服务器对 fetch 兼容性问题导致的同步失败
- 📘 **新增「版本更新内容」弹窗**：打开插件时自动检查 GitHub Releases，检测到新版本即弹出更新说明，支持「永不提示」；也可在「关于」页手动查看全部版本记录
- 🧹 **仓库整理**：移除历史 Phase 设计文档与冗余重复文件（`dsh.bundle.patch` / `dsh.client`），源码与既有功能不变
- 🆕 **兼容 DSH Alpha 版本**：插件现可运行于 DSH 稳定版（`0.1.1`）与 Alpha 版（`0.1.2-alpha.x`）——Settings 命名空间与凭据引用 API 的转换器同时适配两种 DSH 接口，DSH 版本解析亦支持 `-rc` / `-alpha` 预发布后缀

### Highlights (en)

- 🔄 **WebDAV sync storage path changed**: the remote snapshot directory is now `dsh-config-manager` (previously `snapshots`). **Upgrade note**: to keep your existing Nutstore (WebDAV) history, sign in to the Nutstore web app and rename the old `snapshots` folder to `dsh-config-manager`; the new version reads it directly after upgrading. If you do not need the old history, the new version will rebuild the index and snapshots under `dsh-config-manager` automatically
- 🌐 **WebDAV requests now use native `node:http/https`**: full WebDAV method support (MKCOL / PROPFIND / …) with accurate `Content-Length` and `User-Agent`, fixing sync failures on servers that have fetch-compatibility issues
- 📘 **New "Release Notes" dialog**: on opening the plugin it checks GitHub Releases and shows the update notes when a new version is available, with a "Don't show again" option; all versions can still be reviewed manually on the About page
- 🧹 **Repo cleanup**: removed old phase design documents and redundant duplicate files (`dsh.bundle.patch` / `dsh.client`); source code and existing behavior are unchanged
- 🆕 **Compatible with DSH Alpha releases**: the plugin now runs on both DSH stable (`0.1.1`) and alpha (`0.1.2-alpha.x`) — the settings namespace and credential ref API converters adapt to both DSH interfaces, and DSH version parsing handles `-rc` / `-alpha` prerelease suffixes

## [v0.1.54] - 2026-08-25

### 🎯 亮点 / Highlights (zh)

- 🗂️ **导出与导入合并为单一 tab**：顶层 tab 由「导出备份 / 导入恢复」两个合并为「**导出与导入**」，内部用子 tab 切换——导航更紧凑，切 tab/刷新状态照常保留；同时「配置文件」tab 移到「关于」之前
- ✏️ **自定义文件名自动补全 `.zip`**：导出时无需手动输入 `.zip` 后缀（失焦/提交自动补全），校验只针对文件名本体；若与已有备份同名则**自动追加数字后缀**（`foo.zip` → `foo-1.zip` → `foo-2.zip`），不再覆盖之前的备份文件
- 🔍 **备份查看/对比变更明细分组 + 颜色**：冲突（红）/ 变更（蓝）/ 路径映射（黄）/ 已一致（绿）/ 其他 分组展示，组内 kindTag 同色——一眼区分「需决策 / 将写入 / 需处理 / 无需处理」；配置档案切换预览同步为同结构（差异摘要 + 分区清单 + 变更明细分组）
- 🪟 **快照恢复计划预览改为弹窗**：点击快照行 → dry-run 完成后自动弹出恢复计划（与备份文件「查看/对比」同弹窗体系），弹窗内执行恢复仍走二次确认；关闭后可随时重开
- 🖱️ **修复多处横向滚动条**：备份备注过长自动换行不再撑破行；快照列可收缩 + 单元格 ellipsis（置顶/长文件名不再撑宽）；配置档案列表列数据与表头对齐
- 📘 **关于页 CLI 卡补充 `dsh-config-manager help`** 命令（离线列出全部 CLI 用法）

### Highlights (en)

- 🗂️ **Export & Import merged into one tab**: the top-level tabs "Export" and "Import" are merged into a single **Export & Import** tab with inner sub-tabs — tighter navigation, tab/refresh state preserved as before; the Profiles tab also moves before About
- ✏️ **Custom file name auto-appends `.zip`**: no need to type `.zip` on export (auto-appended on blur/submit; validation targets the bare name); if a backup with the same name exists the export **auto-appends a numeric suffix** (`foo.zip` → `foo-1.zip` → `foo-2.zip`) instead of overwriting
- 🔍 **Backup inspect change list grouped + color-coded**: conflicts (red) / changes (blue) / path mappings (amber) / identical skipped (green) / others, with matching kindTag colors per group — see at a glance what needs a decision / will apply / needs handling / needs nothing; the profile-switch preview now mirrors the same structure (diff summary + section list + grouped changes)
- 🪟 **Snapshot restore plan preview in a dialog**: clicking a snapshot row opens the restore plan in the same dialog system as "Inspect / Compare" after dry-run; executing still goes through a second confirm; reopen anytime after closing
- 🖱️ **Various horizontal-scrollbar fixes**: long backup notes wrap instead of widening rows; snapshot columns shrink with cell ellipsis (pin/long filenames no longer widen); profile list columns align with their headers
- 📘 **About CLI card adds `dsh-config-manager help`** (offline command overview)

## [v0.1.53] - 2026-08-24

### 🎯 亮点 / Highlights (zh)

- ✨ **「我的配置」上传/更新免手动点「校验」**：选完 zip 即**自动**执行本地校验（analyzeImport dry-run，无密钥 + 内容合法才放行），通过后直接进入表单页——不再需要先点一次「校验」按钮再点「一键上传」；校验失败停留在校验步骤展示错误并可重新选择 zip（上传与更新两种模式行为一致）

### Highlights (en)

- ✨ **"My Configs" upload/update validates automatically**: after picking a zip, validation (analyzeImport dry-run; no secrets + valid content required) runs automatically and jumps straight to the form on success — no more clicking a separate "validate" button before the one-click publish; on failure it stays on the validate step showing the error with a reselect option (same behavior for both upload and update modes)

## [v0.1.52] - 2026-08-24

### 🎯 亮点 / Highlights (zh)

- 🐛 **修复 git 通道空文件分区同步失败**：当某文件类分区（skills / agentPresets / agentInstructions 等）为空时，`git` 不跟踪空目录导致上传后 `custom/skills/` 等目录在远端仓库丢失，另一台机器全新 clone 后一键同步报「快照缺少文件分区目录 custom/skills/（skills）」——现在上传方（`GitTransport.upload`）给空文件类分区目录写入 `.gitkeep` 占位文件保证远端保留目录，读回时按「文件名 + 内容」双重匹配过滤（不吞用户真实同名文件）；同时 `GitTransport.download` 对旧版插件上传的无占位快照宽容降级（目录缺失 = 空分区，git 提交原子性保证非空目录不会缺失），历史快照也能正常拉取
- 🧩 **市场校验放行空文件分区**：`validateMarketItem` 此前把「manifest 声明 skills=true 但 ZIP 无 `custom/skills/` 条目」判为 invalid（「config.zip 缺少文件分区 skills」），导致未安装 skills 的机器「一键上传」被拒——空文件分区是合法状态（导入侧 `analyzer.extractSections` 对空分区收集空 files、零操作零报错，与 sync 空分区语义一致），现改为仅追加「分区为空」warning 不拒绝；JSON 分区与禁止分区（sessions/pluginFiles/self）仍严格校验

### Highlights (en)

- 🐛 **Fix git-channel sync failure on empty file sections**: when a file section (skills / agentPresets / agentInstructions / …) is empty, git does not track empty directories, so `custom/skills/` etc. vanished from the remote repo after upload and a fresh clone on another machine failed one-click sync with "快照缺少文件分区目录 custom/skills/（skills）" — the uploader (`GitTransport.upload`) now writes a `.gitkeep` placeholder into empty file-section dirs so the remote keeps them, and reads filter it out by name + content (real same-named user files survive); `GitTransport.download` also degrades gracefully for legacy snapshots uploaded without placeholders (a missing dir means an empty section, since git commits are atomic, a non-empty dir can never be missing), so historical snapshots pull fine
- 🧩 **Market validation now accepts empty file sections**: `validateMarketItem` used to reject "manifest declares skills=true but the ZIP has no `custom/skills/` entries" as invalid ("config.zip 缺少文件分区 skills"), which blocked one-click publishing from machines without skills installed — an empty file section is a legitimate state (the importer's `analyzer.extractSections` collects empty files and does nothing, matching the sync channel's empty-section semantics), so it now only appends an "empty section" warning instead of rejecting; JSON sections and banned sections (sessions/pluginFiles/self) stay strictly validated

## [v0.1.51] - 2026-08-24

### 🎯 亮点 / Highlights (zh)

- 🗂️ **快照面板拆分为二级 tab + 一级 tab 更名「备份与快照」**：原先「快照恢复」面板把三类功能挤在一页（快照深度恢复 / 备份文件管理 / 定时备份设置），概念易混淆——现拆为两个清晰的二级 tab：**「快照恢复」**（导入前回滚点列表 → dry-run 计划 → 执行恢复 → 报告，功能原样保留）与**「备份文件」**（导出产物列表：下载 / 一键导入 / 删除 + 定时全量备份设置，联动「立即备份」自动刷新）；一级 tab 由「快照」更名「备份与快照」提示双功能域
- 🔄 **二级 tab 状态持久化**：`SnapshotsStoreSlice.subTab`（restore / files）镜像 runStore——切一级 tab / 刷新均保留上次选择，旧版载荷自动回退「快照恢复」；复用既有 `modeTabs` 模式，零新增样式、零 host 路由改动（纯 UI 重组）

### Highlights (en)

- 🗂️ **Snapshots panel split into sub-tabs, top-level tab renamed "Backup & Snapshots"**: the old "Snapshot Restore" panel crammed three feature areas onto one page (deep snapshot restore / backup-file management / scheduled-backup settings), which blurred their concepts — it is now two clear sub-tabs: **Snapshot Restore** (pre-import rollback points → dry-run plan → execute → report, unchanged) and **Backup Files** (export artifacts: download / one-click import / delete + scheduled full-backup settings, with the list auto-refreshing after "Back up now"); the top-level tab was renamed from "Snapshots" to "Backup & Snapshots" to signal both domains
- 🔄 **Sub-tab state persists**: `SnapshotsStoreSlice.subTab` (restore / files) is mirrored into runStore — the last selection survives tab switches and refresh, and legacy payloads fall back to "Snapshot Restore"; it reuses the existing `modeTabs` pattern with zero new styles and zero host-route changes (pure UI reorganization)

## [v0.1.50] - 2026-08-24

### 🎯 亮点 / Highlights (zh)

- 📁 **快照面板新增「备份文件」管理**：此前定时备份与手动导出的 ZIP 都躺在 `exports/` 目录、GUI 无任何入口可见——现在快照恢复面板统一列出全部导出产物（文件名 + 来源徽章「定时备份 / 手动导出」+ 大小 + 时间），支持**下载**（复用 `/download`）、**一键导入**（切到导入向导直接分析该备份，跳过上传）、**删除**（二次确认弹窗）；顺带修复了「手动导出的文件也无处查看」的老缺口
- 🧹 **定时备份保留最近 10 个**：定时备份产物改用独立前缀 `dsh-config-auto-`（来源标识 + 清理依据），每次成功备份后自动清理超出 10 个的旧文件；cache-cleaner 的 exports 7 天回收**豁免 auto 前缀**——定时备份生命周期由保留策略管理，不再与「按天回收」相互截断；手动导出文件不自动删（仍按 7 天回收）
- 🛡️ **新路由全过 loopback fence**：新增 `GET /backup-files`（列表）与 `POST /backup-files/delete`（删除，服务端文件名防穿越校验），与全仓一致每个方法分支都过 guard
- 🔁 **一键导入状态为一次性瞬态**：`SnapshotsStoreSlice.importBackup`（zipPath + 文件名）随 `view` 切换传给导入向导，消费后立即清空、sessionStorage 白名单剔除、刷新不重放

### Highlights (en)

- 📁 **"Backup Files" management in the snapshot panel**: scheduled backups and manual exports used to sit in `exports/` with no GUI entry — the snapshot restore panel now lists every export artifact (file name + source badge "Scheduled / Manual" + size + time) with **download** (reuses `/download`), **one-click import** (jumps into the import wizard and analyzes that backup directly, no re-upload) and **delete** (confirmed via dialog); this also closes the old gap where manually exported files had no UI to view them
- 🧹 **Scheduled backups keep the latest 10**: scheduled artifacts now use a dedicated `dsh-config-auto-` prefix (source marker + cleanup key), pruning older files past 10 after every successful run; the cache-cleaner's 7-day exports sweep **exempts the auto prefix** so scheduled-backup lifecycle is owned by the retention policy instead of fighting the day-based sweep; manual exports are never auto-deleted (still recycled after 7 days)
- 🛡️ **New routes pass the loopback fence**: `GET /backup-files` (list) and `POST /backup-files/delete` (delete with server-side filename traversal guard) both go through `guard` on every method branch, like the rest of the codebase
- 🔁 **One-click import is a one-shot transient**: `SnapshotsStoreSlice.importBackup` (zipPath + name) is passed to the import wizard along with the view switch, cleared right after consumption, stripped from the sessionStorage whitelist, and never replayed on refresh

## [v0.1.49] - 2026-08-24

### 🎯 亮点 / Highlights (zh)

- 🛟 **快照恢复进度可视化 + 宿主侧权威防重**：`/restore` 真实执行（dryRun=false）经 RunRegistry 登记 `restore` run —— 同 kind 已有 running 时返回 409 拒绝重复恢复（前端 loading 只是 UX，宿主锁才是正确性保障；不同快照并发恢复会交错写文件、同快照并发会互相覆盖 pre-restore 双保险备份，都是真实数据风险）；每执行一个恢复动作经 `onAction` 埋点更新 `/progress`，前端 `watchRunning('restore')` 轮询 + `/runs` 刷新恢复，刷新期间恢复仍在进行则自动回到 running 并回填报告；`SnapshotsStoreSlice.running` 为瞬态镜像——白名单剔除、applyPersisted 硬性归零、以宿主 `/runs` 为权威，不把浏览器陈旧状态当成恢复执行中的依据
- 📜 **导入执行日志冻结修复（500 行封顶不再冻结）**：`RunRegistry.appendLog` 改为**不可变追加**（每次换新数组引用，行数封顶后长度恒定但引用必变），`ImportLogPanel` memo 改以「数组引用 + t 引用」比较——引用未变跳过重渲染、引用已变（含封顶后）必重渲染，杜绝「优化导致日志冻结」；新增**智能自动滚动**：仅当用户贴近底部时跟随最新行，用户上滚查看历史时不强制拉回，改在 `logHeader` 显示「↓ 新输出」胶囊按钮（`logJumpButton`，ghost 语义），点击跳回底部并恢复跟随
- 🏷️ **导入 runId 即时同步**：`watchRunning` 发现活跃 import run 时立即把 runId 写入 store（此前 `/execute` 响应在整段导入完成后才带 runId，fresh run 期间「跳过当前插件」会打到上一次导入的陈旧 runId）
- 🔒 **backup-schedule 路由补全 loopback fence**：GET/PUT `/backup-schedule` 与 POST `/backup-schedule/run` 此前漏 `guard`（loopback 守卫），本次统一补齐——远程调用方不得触发宿主写盘操作，全仓 45+ 路由均过 fence
- 🧹 附带：`BackupScheduleCard` 增加挂载守卫（切 tab 卸载后异步回调只更新 store 草稿，不再 setState）；`restore` 完成/失败回填报告或错误到 `SnapshotsStoreSlice`（切 tab 回来可见结果）

### Highlights (en)

- 🛟 **Snapshot-restore progress + host-side dedup**: real `/restore` execution is now registered in the RunRegistry as a `restore` run — a second restore of the same kind while one is running is rejected with 409 (frontend `running` is just UX; the host lock is the correctness guarantee; concurrent restores of different snapshots interleave file writes and concurrent restores of the same snapshot clobber the pre-restore double-backup). Each action emits progress via `onAction` (`/progress` polling + `/runs` refresh-resume); `SnapshotsStoreSlice.running` is a transient mirror — stripped from persistence by the whitelist, never used as the authority for whether a restore is executing
- 📜 **Import log panel no longer freezes at the 500-line cap**: `RunRegistry.appendLog` now writes immutably (a fresh array reference per append), so `ImportLogPanel`'s memo compares array references — unchanged = skip, changed (incl. post-cap) = must re-render; plus smart auto-scroll: it only follows the latest line when you're near the bottom, otherwise shows a "↓ New output" jump button instead of yanking you down
- 🏷 **Import runId synced immediately**: `watchRunning` now writes the discovered runId into the store the moment an active import run is found (previously the `/execute` response only carried it after the whole import finished, so "skip current plugin" could target a stale runId)
- 📷 **loopback fence added to backup-schedule routes**: GET/PUT `/backup-schedule` and POST `/backup-schedule/run` were missing the `guard` (loopback-only) check; now added so remote callers cannot trigger host write operations
- 🧹 **Also**: `BackupScheduleCard` got a mount guard (callbacks after unmount only update the store draft, no `setState`), and restore completion/failure now writes the report/error back into the store slice

## [v0.1.48] - 2026-08-23

### 🎯 亮点 / Highlights (zh)

- ⏰ **定时全量备份 GUI（快照 tab）**：快照恢复面板新增「定时全量备份」设置卡——总开关 + 间隔档位（6h/12h/24h/7d）+ 上次运行状态（成功/跳过/失败 + 时间或 ZIP 名）+「保存设置」「立即备份」按钮；配置仍存 sync/backup-schedule.json（随 self 分区备份/同步迁移），保存即重排调度器、立即备份复用 runOnce（同一时刻防重）；新增 GET/PUT /backup-schedule 与 POST /backup-schedule/run 三个 host 路由 + src/ui/backup-schedule.ts 纯函数层（校验 / 状态映射 / 脏判定，node 单测 6 例）；草稿镜像 runStore（切 tab / 刷新保留未保存修改）

### Highlights (en)

- ⏰ **Scheduled full backups GUI (snapshots tab)**: the snapshot restore panel now has a "Scheduled Full Backups" settings card — enable toggle + interval (6h/12h/24h/7d) + last-run status (success/skipped/failed with time or zip name) + "Save settings" / "Back up now" buttons; config stays in sync/backup-schedule.json (migrates with the self section); saving re-schedules the scheduler and "back up now" reuses runOnce with a re-entrancy guard; three new host routes (GET/PUT /backup-schedule, POST /backup-schedule/run) plus a pure-function layer src/ui/backup-schedule.ts (validation / status mapping / dirty check, 6 node tests); draft mirrored into runStore (unsaved edits survive tab switches / refresh)

## [v0.1.47] - 2026-08-23

### 🎯 亮点 / Highlights (zh)

- 🛠️ **修复模型工具注册崩溃（v0.1.46 回归）**：安装后启动 DSH 报 `cannot get property "tools" without inject` 导致插件树加载失败——5 个 Agent 模型工具（config_backup 等）改为经 `ctx.get('tools')` 结果注册，不再做 `ctx.tools` 属性访问（Cordis 属性访问要求显式 inject，而 tools 是可选服务不应进 inject）；新增模拟真实 Cordis 守卫的回归测试

### Highlights (en)

- 🛠️ **Fix model-tool registration crash (v0.1.46 regression)**: DSH failed to boot with `cannot get property "tools" without inject` — the 5 agent tools (config_backup etc.) are now registered via the `ctx.get('tools')` result instead of `ctx.tools` property access (Cordis property access requires explicit inject; tools is an optional service and must not be injected); regression test simulating the real Cordis guard added

## [v0.1.46] - 2026-08-23

### 🎯 亮点 / Highlights (zh)

- ⏰ **定时备份调度器**：设置 6 小时 / 12 小时 / 24 小时 / 7 天的固定节奏，DSH 在后台静默产出完整备份——secrets 从不包含，磁盘上无需密码也安全；README 双语宣传同步
- 🔒 **Vault 文件级脱敏**：导出（不含 secrets 模式）时把 `.credentials.yaml` 等敏感文件移入 `dataDir/vault` 并在报告标注刷新动作——备份文件里不再残留凭据明文
- 🧹 **Ghost-sweep 幽灵清扫**：检测备份中「已不存在于宿主」的幽灵条目并提示清理；宿主无归档 API 时降级为本地校验
- 🗑️ **Tombstone 删除记录**：删除动作以 tombstone 记录进同步流，导入时按记录跳过已删除项，报告标注「已按删除记录跳过 N 项」
- ☁️ **WebDAV 快照级跳过**：内容未变的快照自动跳过（`sectionsEqual` 比对），不再重复传输整包；加密快照始终上传（密文不可比对）
- 🕵️ **Secret-scanner 个人化扩展**：新增 `extraValuePatterns` 与 `createConfiguredSecretScanner`，可从插件配置注入自定义敏感值模式
- 🛒 **市场共享模式**：prepare 增加保守档拦截与 deviceSpecific 分区拒绝（机型相关配置不共享），服务端 / UI 全程透传 mode
- 🧪 **架构与 schema 兼容测试**：`architecture-boundaries` 固化分层边界（KNOWN_VIOLATIONS 例外表）；`schema-compat` 固化 manifest 兼容策略（拒绝未来版本、未知字段保留）
- 🚀 **导入体验**：进度条下方实时命令日志面板（RunRegistry 轮询、刷新不丢）；导入中可跳过当前插件（彻底清理半装状态）；结果页支持重试失败 / 跳过的子集

### Highlights (en)

- ⏰ **Scheduled full backups**: pick a fixed cadence (6h / 12h / 24h / 7d) and DSH quietly keeps a fresh full backup in the background — secrets are never included, so it stays safe on disk without a password; bilingual README updated
- 🔒 **File-level vault redaction**: exporting without secrets moves sensitive files (e.g. `.credentials.yaml`) into `dataDir/vault` and flags the refresh in the report — no plaintext credentials left in backup archives
- 🧹 **Ghost-sweep**: detects and flags backup entries that no longer exist on the host (local-validation fallback when the host exposes no archive API)
- 🗑️ **Tombstone deletions**: deletes are recorded as tombstones in the sync stream; import skips deleted items and reports "skipped N items per delete records"
- ☁️ **WebDAV snapshot-level skip**: unchanged snapshots are skipped via `sectionsEqual` — no more re-uploading whole archives; encrypted snapshots always upload (ciphertext cannot be compared)
- 🕵️ **Personalized secret scanning**: `extraValuePatterns` + `createConfiguredSecretScanner` let you inject custom sensitive-value patterns from plugin config
- 🛒 **Market share mode**: prepare adds a conservative-mode gate and rejects device-specific sections (no machine-bound config sharing); mode is threaded through server & UI
- 🧪 **Architecture & schema-compat tests**: `architecture-boundaries` locks layer boundaries (KNOWN_VIOLATIONS exception table); `schema-compat` locks manifest compatibility (future versions rejected, unknown fields preserved)
- 🚀 **Import experience**: live command-log panel under the progress bar (RunRegistry polling, survives refresh); skip the current plugin mid-import (half-installed state fully cleaned); retry failed/skipped subsets from the results page

## [v0.1.45] - 2026-08-21

### 🎯 亮点 / Highlights (zh)

- 🧹 **安装命令简化**：README / DEVELOPERS 的安装命令统一为 `dsh plugin --profile web add dsh-config-manager@latest`，移除 `--config.auto-install-peers=false` 后缀——照着复制即可，无需再关心 peer 解析参数
- 🛒 **README 配置市场描述上线**：两个 README（中英镜像）新增配置市场完整描述——首屏亮点 + Use Cases + 核心亮点表格 + 功能详解小节（内置官方市场 / 搜索筛选排序 / 供应链警示恒展示 + 逐分区批准 / 安装复用安全导入管道 / 「我的配置」一键上传到自有仓库 + 自动收录 PR）；功能截图新增 `assets/screenshot-market.png`
- 🎨 **市场「我的配置」上传向导打磨**：改为三步式（选文件 → 本地校验 → 精简表单，仅 name / description / categories，其余系统自动）；更新模式支持页内换新 ZIP 并自动校验；详情视图 JSX 结构调整

### Highlights (en)

- 🧹 **Simplified install command**: README / DEVELOPERS now use `dsh plugin --profile web add dsh-config-manager@latest` — the `--config.auto-install-peers=false` suffix is gone, so users can just copy-paste
- 🛒 **Marketplace docs shipped**: both READMEs (en + zh mirror) now fully describe the config marketplace — hero bullet, Use Cases, highlights table and a dedicated feature section (built-in official market / search, filter & sort / always-on supply-chain warnings + per-section approval / install reuses the safe import pipeline / "My Configs" one-click upload to your own repo with auto listing PR); new `assets/screenshot-market.png` added to the screenshots
- 🎨 **Marketplace "My Configs" upload wizard polished**: now a three-step flow (pick file → local dry-run validation → slim form with only name / description / categories, the rest auto-filled); update mode lets you swap in a new ZIP inline with auto-validation; detail view JSX restructured

## [v0.1.44] - 2026-08-21

### 🎯 亮点 / Highlights (zh)

- 🔍 **AI 搜索曝光优化（SEO/AEO）**：README 首屏副标题改为「DeepSeek Harness Backup, Restore & Migration Plugin」，一句话价值主张覆盖 backup / restore / export / import / migrate / sync / plugins / MCP / skills 等全部高频搜索词；新增「Use Cases」小节（Backup / Restore / Migrate / Sync 四组自然语言场景，中文版同步镜像「典型使用场景」），让 AI 搜索直接命中句子即可召回
- 🧹 **npm description 修复**：清除双重编码乱码（`â€”`）与残留内部备注，重写为关键词密集的自然描述，末尾补充中文简介；keywords 由 7 个扩至 17 个（新增 dsh-plugin / restore / export / import / migrate / sync / webdav / mcp / skills / configuration）
- 📄 **新增 AI 搜索曝光审计文档**：`docs/seo/2026-08-21-ai-search-exposure-audit.md`——生态收录现状盘点（DSH Get / dshplugins.cc / DSH 插件商店 / awesome-dsh-plugins 全部收录）+ GitHub Description / Topics 建议值 + 后续优化清单

### Highlights (en)

- 🔍 **AI search exposure optimization (SEO/AEO)**: README opening now reads "DeepSeek Harness Backup, Restore & Migration Plugin" with a value proposition covering backup / restore / export / import / migrate / sync / plugins / MCP / skills and more; a new "Use Cases" section (Backup / Restore / Migrate / Sync natural-language scenarios; Chinese mirror added) lets AI search hit the exact sentences
- 🧹 **npm description fixed**: removed a double-encoded mojibake (`â€”`) and a leftover internal note; rewrote a keyword-rich, natural description with a short Chinese intro; keywords expanded from 7 to 17 (added dsh-plugin / restore / export / import / migrate / sync / webdav / mcp / skills / configuration)
- 📄 **AI search exposure audit doc added**: `docs/seo/2026-08-21-ai-search-exposure-audit.md` — ecosystem listing review (indexed by DSH Get / dshplugins.cc / DSH plugin store / awesome-dsh-plugins) + recommended GitHub Description / Topics + follow-up checklist

## [v0.1.43] - 2026-08-22

### 🎯 亮点 / Highlights (zh)

- 📐 **弹窗正文间距统一**：确认弹窗（`dialogBody`）与同步通道配置弹窗（`dialogBodyScroll`）的正文改为 flex 纵向排布 + 统一 10px 间距——message 与自定义内容、表单内的 tab/Banner/字段/操作行不再紧贴，视觉节奏与页面视图一致；纯视觉微调，无行为 / 交互 / API 变化，`DESIGN.md` 同步更新

### Highlights (en)

- 📐 **Unified dialog body spacing**: confirm dialog (`dialogBody`) and sync channel config dialog (`dialogBodyScroll`) bodies now use a flex column layout with a consistent 10px gap — messages, custom content, and form blocks (tabs/banners/fields/actions/hints) no longer collide, matching the page views' vertical rhythm; purely visual, no behavioral / API change; `DESIGN.md` updated accordingly

## [v0.1.42] - 2026-08-21

### 🎯 亮点 / Highlights (zh)

- ⭐ **市场页仓库级 Star 展示**：市场浏览列表每个条目新增「⭐ N」徽章，显示其**来源仓库**的 star 数（官方条目 = 官方市场仓库统一数字；第三方条目 = 作者自托管 `dsh-configs` 仓库），并标注「来源仓库」避免误解；「我的配置」页同步显示自己配置仓库的 star
- 🔍 **来源筛选下拉框**：市场工具栏新增「全部来源 / 官方配置 / 个人配置」筛选，selected 状态随 store 持久化（切 tab / 刷新不丢）
- 🔃 **排序下拉框**：新增「默认 / 最新更新 / ⭐ 最多 / 名称 A–Z」四种排序（升/降与 undefined 值规则确定且稳定）
- 🔒 **零凭据 star 查询**：浏览端点一律**匿名**查询 GitHub（`/repos/{owner}/{repo}`），按仓库 URL 去重 + 1 小时 TTL 内存缓存 + 单仓库失败降级显示「—」，不触碰任何 token，保持市场端点「无凭据」硬不变式
- 📜 **MIT 许可证 + Issue 模板**：仓库新增 MIT `LICENSE` 与中英双语 **Bug 报告 / 功能建议** Issue 模板；npm 包 metadata 同步补齐 `license` 字段

### Highlights (en)

- ⭐ **Repo-level stars in the market**: each market item now shows a "⭐ N" badge with its **source repo** star count (official items share the official market repo's single count; community items show the author's self-hosted `dsh-configs` repo), labeled as "source repo" to avoid confusion; "My Configs" shows your own config repo's stars too
- 🔍 **Source filter dropdown**: new market filter "All / Official / Community", persisted in the store (survives tab switches / refresh)
- 🔃 **Sort dropdown**: "Default / Recently updated / Most starred / Name A–Z" with deterministic, stable ordering (missing values sort last)
- 🔒 **Credential-free star lookup**: browsing queries GitHub **anonymously** (`/repos/{owner}/{repo}`), deduped per repo URL with a 1h in-memory TTL cache and per-repo failure fallback ("—"); no token is ever touched, keeping the market endpoints' credential-free invariant
- 📜 **MIT license + issue templates**: added the MIT `LICENSE` and bilingual **bug report / feature request** issue templates; npm metadata now carries the `license` field

## [v0.1.41] - 2026-08-21

### 🎯 亮点 / Highlights (zh)

- 🧹 **缓存自动清理**：`~/.dsh/dsh-config-manager/` 下的临时文件（`tmp/` 导入/解密/同步暂存）、导出副本（`exports/`，导出时已下载到本地）、市场缓存与 git 工作副本（`market/cache/`、`market/work/`）由插件**自动清理**——DSH 启动时清理一次、此后每 24 小时清理一次，只删除超过保留期（临时文件 24 小时、导出产物与市场缓存 7 天）的条目；导入回滚快照（`snapshots/`）与同步数据（`sync/`）属用户数据/安全网，**不自动清理**
- 🗑️ **「我的配置」删除条目**：列表新增删除入口，点删除弹**确认弹窗**（遮罩/Esc/取消三途径关闭，危险操作默认焦点落取消）——已收录条目自动提交**下架 PR**（独立分支 `dsh-market-delist/<id>`），待审核条目直接关闭收录 PR；收录/下架任务**后台执行 + 状态轮询**，进程重启后仍可一键**重试**（幂等复用已有 fork/PR）
- 📢 **市场操作免责弹窗**：上传 / 下载 / 装回本地三处操作前置免责声明，支持「不再提示」（三操作**分开记忆**，localStorage 持久化；存储不可用时静默降级为每次提示）
- 🪟 **同步设置改弹窗驱动**：远程同步页改为「同步通道」入口卡 + **通道配置弹窗**（Git/WebDAV 子 tab 与登录块移入弹窗，关闭弹窗 = 放弃本次操作含 GitHub 登录流程）；新增 **GitHub 登录态真实校验**（`/sync/github/validate`：token 有效则隐藏登录块，失效自动重新展示）
- 💾 **一键同步差异确认决策持久化**：逐项「采纳/解决」决策镜像进 store，切 tab / 刷新不丢，恢复会话可继续决策
- 🚀 **市场首次打开自动刷新**：本次 DSH 启动后首次打开市场页自动拉取一次最新条目（手动刷新成功即置位，失败可重试）
- 🔒 **秘密扫描宽松档**：市场发布扫描新增 `literalValueOnly` 档位——字段名敏感**且**值像真实字面量凭据才命中（占位符/示例形态/代码表达式/环境引用一律放行），真实密钥形状仍硬拦

### Highlights (en)

- 🧹 **Automatic cache cleanup**: transient files under `~/.dsh/dsh-config-manager/` (`tmp/` import/decrypt/sync staging), export copies (`exports/` — already downloaded to your machine on export), and marketplace cache/git worktrees (`market/cache/`, `market/work/`) are now **cleaned automatically** — once at DSH startup and then every 24 hours, removing only entries older than their retention (24 h for tmp, 7 days for exports and market cache); import rollback snapshots (`snapshots/`) and sync data (`sync/`) are user data / safety nets and are **never auto-removed**
- 🗑️ **"My Configs" item deletion**: each listed item gains a delete action guarded by a **confirm dialog** (mask / Esc / Cancel close paths; focus lands on Cancel for destructive ops) — listed items automatically open a **de-listing PR** (dedicated branch `dsh-market-delist/<id>`), pending-review items just close the listing PR; listing/de-listing jobs run **in background with status polling**, and a failed/lost job can be **retried in one click** (idempotent, reuses the existing fork/PR)
- 📢 **Market operation disclaimers**: upload / download / install-back-local now show a disclaimer first, with a per-operation **"don't ask again"** toggle (remembered independently in localStorage; silently degrades to always-ask when storage is unavailable)
- 🪟 **Sync settings moved to a dialog**: the sync page is now an entry card that opens a **channel-config dialog** (Git/WebDAV tabs and the GitHub login block live inside; closing the dialog abandons the operation, including an in-flight GitHub login); new **real GitHub sign-in validation** (`/sync/github/validate`: valid token hides the login block, an invalid one re-shows it)
- 💾 **One-click-sync confirm decisions persisted**: per-item adopt/resolve choices are mirrored into the store, surviving tab switches / refresh so a session can be resumed
- 🚀 **Market auto-refresh on first open**: the market page auto-fetches once per DSH startup (a successful manual refresh also arms it; failures can be retried)
- 🔒 **Lenient secret-scan tier**: market publishing gains a `literalValueOnly` mode — a sensitive field name only hits when the value looks like a real literal credential (placeholders / example shapes / code expressions / env references always pass); real key shapes are still hard-blocked

## [v0.1.40] - 2026-08-20

### 🎯 亮点 / Highlights (zh)

- 🧭 **「我的配置」体验修复**：移除标题上方的「返回市场」按钮（子视图切换已在顶部，无需重复返回）；update 更新改为**显式按条目 id 定位**（不再靠名称转 id 猜测，中文名/改名场景不再误建新条目，目标条目不存在时明确报错）；秘密扫描**消除技能文档误报**（`token:`/`password:` 等代码示例、类型声明、占位符、环境引用不再误判，真实密钥 sk-/ghp_/JWT/PEM/Bearer 仍强制拦截）

### Highlights (en)

- 🧭 **"My Configs" UX fixes**: removed the "back to market" button above the title (the sub-view tabs already switch back); update now targets the item by its **explicit id** (no more name→slug guessing — Chinese names / renames no longer create a duplicate item, and a missing target id errors clearly); secret scan **no longer false-positives on skill docs** (code samples like `token:`/`password:`, type declarations, placeholders, env references are allowed; real key shapes sk-/ghp_/JWT/PEM/Bearer are still hard-blocked)

## [v0.1.39] - 2026-08-20

### 🎯 亮点 / Highlights (zh)

- 🧹 **上传入口收敛**：移除「配置市场」浏览视图中的旧「发布到市场」向导（PublishView）及其入口按钮，上传配置统一收敛到「我的配置」子视图（一键上传 → 自动建仓 → 自动收录 PR）；fork 创建轮询超时 60s → 180s（GitHub 首次 fork 复制仓库内容可能超过 1 分钟）

### Highlights (en)

- 🧹 **Upload entry consolidated**: the legacy "Publish to Market" wizard (PublishView) and its entry button are removed from the browse view; uploading configs now lives solely in the "My Configs" sub-view (one-click upload → auto repo → auto listing PR); fork creation polling timeout raised 60s → 180s (GitHub's first fork copies the whole repo and can take over a minute)

## [v0.1.38] - 2026-08-20

### 🎯 亮点 / Highlights (zh)

- 🚀 **「一键上传 / 我的配置」**：配置市场新增「我的配置」子视图——GitHub device flow 登录（token 只存本机凭据槽）后，选择配置 zip → 本地 8 道校验 + 秘密扫描 → 一键上传到**你自己的公开仓库**（自动创建 `<login>/dsh-configs`）→ 自动 fork 官方市场仓库、改 `index.json` 收录**自托管引用**并提交自动 PR（固定分支 `dsh-market-sync/<itemId>`：未合并自动更新、已合并基于最新 main 重开）；支持查看已上传（收录状态徽章：未收录 / PR 待审核 / 已收录）、一键更新（元数据全自动：id / author / version / updatedAt / sha256 系统生成，版本纯自动 +1）、装回本地（复用市场下载 + 逐分区批准 + 回滚管道）。目标收录仓库固定 `xiajiajun516/dsh-config-market`，界面不可修改

### Highlights (en)

- 🚀 **One-click upload / "My configs"**: the Market panel gains a "My Configs" sub-view — after GitHub sign-in (device flow; token stays in the local credential slot), pick a config ZIP → local 8-step validation + secret scan → upload in one click to **your own public repo** (auto-created as `<login>/dsh-configs`) → auto-fork the official market repo, add a **self-hosted reference** to `index.json`, and open the listing PR automatically (fixed branch `dsh-market-sync/<itemId>`: auto-updated while unmerged, reopened from latest main after merge); view uploads with listing-status badges (not listed / PR pending / listed), update in one click (all metadata auto-generated — id / author / version / updatedAt / sha256; version bumps automatically), and install back locally (reusing the market download + per-section approval + rollback pipeline). The listing target repo is fixed to `xiajiajun516/dsh-config-market` and not editable in the UI

## [v0.1.37] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🐛 **修复异步操作切 tab 丢失状态**：远程同步的推送/拉取/一键同步、市场下载与确认导入、快照恢复等异步操作，在请求进行中切换 tab 再切回时不再丢状态——结果（推送/拉取报告、差异确认会话、导入结果、恢复计划与报告）在组件卸载期间完成也能落库，切回即恢复；进行中的 busy spinner 也随模块级 store 保留（刷新后清空，凭据仍仅内存白名单剔除）

### Highlights (en)

- 🐛 **Fix state loss for async operations on tab switch**: pushing/pulling/one-click sync, market download & confirmed import, and snapshot restore no longer lose their result when you switch tabs mid-request — results (push/pull reports, diff-confirm session, import outcome, restore plan & report) are persisted into the store even when the request settles after the view unmounted, and restore on return; in-flight busy spinners survive tab switches too (cleared on refresh; credentials stay memory-only behind the whitelist)

## [v0.1.36] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🐛 **修复同步快照二进制损坏（文件分区丢字节）**：文件类分区（技能/插件文件等）在内存为 Uint8Array，整份快照走 JSON 的通道（WebDAV 单文件快照、加密载荷）会把字节序列化成数字索引对象，拉取/解密后 `Buffer.from(对象)` 直接抛错；新增二进制安全序列化（文件字节 ↔ `{ $bin: base64 }`）——三个通道全部接入，往返字节无损
- 🔐 **Git 加密快照改「密文单文件」布局**：加密快照（密文载荷无法平铺为明文 JSON 分区）改走 `snapshots-encrypted/<id>.json` 整体 JSON 提交，与明文散文件目录并存——远端只存密文、本地不产生额外明文审计副本
- 🛡️ **市场条目禁止分区**：sessions（历史会话）/ pluginFiles（任意文件直通）/ self（本地环境）永久禁止进入市场条目——安全校验与条目生成两端强制拒绝（产品决策，详见市场仓库搭建规格书）
- 🏷️ **同步历史标记触发通道**：快照 manifest 与自动同步历史记录各自 transport（git/webdav），快照/历史列表显示通道徽章——多通道同步一次看清哪个通道做了什么
- 📖 **官方市场仓库搭建规格书**：新增 docs/design/2026-08-19-market-repo-setup-guide.md——索引格式、8 道安全校验、条目结构整份规格，可直接复制发给搭建 AI

### Highlights (en)

- 🐛 **Fix binary corruption in synced snapshots (file-section bytes)**: file-based sections (skills/plugin files…) hold `Uint8Array` in memory; any channel that JSON-serializes the whole snapshot (WebDAV single-file snapshots, encrypted payloads) mangled the bytes into numeric-index objects, making `Buffer.from(obj)` throw on pull/decrypt. A binary-safe serializer (bytes ↔ `{ $bin: base64 }`) is now wired into all three channels — lossless round-trips
- 🔐 **Git encrypted snapshots move to a ciphertext-single-file layout**: encrypted snapshots (ciphertext cannot be flattened into plaintext JSON sections) are now committed as a whole `snapshots-encrypted/<id>.json`, coexisting with the plaintext scatter-dir layout — remote keeps only ciphertext, no extra plaintext audit copy locally
- 🛡️ **Banned market sections**: `sessions` (chat history) / `pluginFiles` (arbitrary passthrough files) / `self` (local environment) are permanently forbidden in market items — enforced at both validation and item-generation (product decision, see the market repo setup spec)
- 🏷️ **Sync history records the triggering channel**: each snapshot manifest and autosync history entry now carries its `transport` (git/webdav), shown as a channel badge in the snapshot/history lists — multi-channel sync is now readable at a glance
- 📖 **Official market repo setup spec**: new docs/design/2026-08-19-market-repo-setup-guide.md — index format, 8-step security validation, item structure as a single spec, copy-paste ready for a setup AI

## [v0.1.35] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🛒 **配置市场发布向导（去中心化方案 B）**：配置市场新增「发布到市场」五步向导——选择配置 zip → 本地 dry-run 校验（内容合法且不含密钥）→ 生成条目包（L2 manifest + SHA-256 + sections）→ 推送作者仓库（生成 git 命令模板，插件不做任何 git 写操作、不持有凭据）→ 提交收录申请（index.json 片段 + PR 指引）；官方 index 只收录引用、保持只读零凭据，条目由作者自托管公开 git 仓库
- 🧩 **self 分区：插件自身配置纳入备份/迁移**：新增 self 适配器——导出/同步自动收集 `$DSH_HOME/dsh-config-manager/` 下的 sync-config / sync-autosync / sync-selection / ui-prefs / market-config 白名单配置（不含凭据值），换机器一键恢复
- 🔀 **同步通道独立子 tab**：远程同步面板 Git / WebDAV 改为子 tab 各自持有独立配置——自动同步（启用/间隔/状态）、同步模式与分区勾选、是否加密、远端快照列表均按通道独立（autosync / sync-selection schema v2 按通道命名空间 + v1 自动迁移）
- 💾 **UI 偏好落盘**：上次选择的同步通道从浏览器 localStorage 迁入磁盘 ui-prefs.json——换浏览器/换机器不丢，Host 可读写（浏览器关闭时自动同步也能读到）

- 🐛 **加密备份导入只输一次密码**：导入整体加密备份（DCA1 容器）时不再需要第二个「解密备份」页面——选完 ZIP 输入一次解锁密码即可，Host 解锁时顺带解出内部凭据覆盖清单（refs），该密码同时作为解密密码完成凭据恢复（导出时两者同源）
- 🐛 **修复切 tab / 刷新丢失面板状态**：快照恢复、远程同步、配置市场三个低频面板的非敏感 UI 状态（选中快照 / dry-run 计划 / 执行报告、通道表单 / 同步模式与分区勾选 / 一键同步差异确认会话、搜索词 / 类别筛选 / 条目详情与逐分区批准）现经模块级 runStore + sessionStorage 白名单持久化——切 tab 不丢、刷新后回到原 tab 并恢复现场；同步凭据（token / webdav 密码 / 加密与解密密码）仍仅内存，刷新后清空要求重输

### Highlights (en)

- 🛒 **Marketplace publish wizard (decentralized)**: a five-step "Publish to Marketplace" wizard — pick a config ZIP → local dry-run validation (valid content, no secrets) → generate the item package (L2 manifest + SHA-256 + sections) → push to your own repo (git command template generated; the plugin never performs git writes or holds credentials) → submit an index entry (index.json snippet + PR guidance); the official index stays read-only with zero credentials and only references author self-hosted public repos
- 🧩 **`self` section: the plugin's own config joins backup/migration**: a new `self` adapter collects the plugin's own config files under `$DSH_HOME/dsh-config-manager/` (sync-config / sync-autosync / sync-selection / ui-prefs / market-config whitelist, credential-free) for export & sync — restore everything on a new machine in one shot
- 🔀 **Per-channel sync sub-tabs**: the Sync panel now has Git / WebDAV sub-tabs, each owning independent settings — autosync (enabled / interval / status), sync mode & section selection, encryption toggle, and remote snapshot list are all per-channel (autosync / sync-selection schema v2 with namespaced channels + v1 auto-migration)
- 💾 **UI prefs on disk**: the last-selected sync channel moved from browser localStorage to `sync/ui-prefs.json` — survives browser/device changes and is readable by the Host process (autosync keeps working while the browser is closed)
- 🐛 **Encrypted backup import now asks for the password once**: the separate "decrypt backup" step is gone for fully-encrypted (DCA1) archives — enter the unlock password right after picking the ZIP; the Host returns the covered credential refs with the unlock response and reuses the same password (both layers derive from it at export time) to restore credentials
- 🐛 **Fix state loss on tab switch / page refresh**: non-sensitive UI state of the Snapshots / Sync / Market panels (selected snapshot + dry-run plan + restore report; channel form + sync mode & section selection + one-click sync confirm session; search / category filter / item detail + per-section approvals) is now mirrored into the module-level runStore and persisted via the sessionStorage whitelist — surviving tab switches and restoring after refresh, with the current panel re-opened; sync credentials (token / WebDAV password / encrypt & decrypt passwords) stay memory-only and are cleared after refresh

## [v0.1.34] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🆕 **关于（About）面板**：设置页新增第六个 tab——展示插件元数据（名称/仓库/作者）、当前插件版本与 DSH 版本/平台，并提供 Star / 文档 / Issues 快捷链接；链接恒等派生自仓库 URL，杜绝拼接错误
- ⬇️ **导出下载静默化**：导出 ZIP 完成后默认以 Blob + `<a download>` 静默下载到浏览器「下载」目录（无需另存为对话框）；需要选择保存位置时可走系统保存对话框（saveDialog 模式）
- 🔀 **同步配置 schema v3**：git 与 WebDAV 双命名空间共存——切换通道不再丢失另一通道的 repoUrl/url 配置，status 路由可回填另一通道配置
- 🐛 **修复加密备份解锁后 zipPath 丢失**：导入解锁加密备份时保留已记录的容器路径，避免 store 中已 patch 的 zipPath 被覆盖回 null
- ⚙️ **发布流程改进**：GitHub Release 亮点改为从 CHANGELOG.md 自动抽取（未写当前版本段则 fail fast），发版不再需要手动维护亮点列表

### Highlights (en)

- 🆕 **About panel**: new sixth tab in the settings page showing plugin metadata (name / repo / author), plugin version, DSH version and platform, with Star / Docs / Issues quick links derived from the repo URL (single source, no concatenation bugs)
- ⬇️ **Silent export download**: exported ZIPs now download straight to the browser's download directory via Blob + `<a download>` (no save dialog); opt into the system save dialog with saveDialog mode when a location choice is needed
- 🔀 **Sync config schema v3**: git and WebDAV namespaces now coexist — switching channels no longer drops the other channel's repoUrl/url, and the status route can backfill the inactive channel config
- 🐛 **Fix zipPath loss after unlocking encrypted backups**: the import wizard keeps the recorded container path when unlocking an encrypted archive, so the patched zipPath in the store is no longer overwritten to null
- ⚙️ **Release workflow improvement**: GitHub Release highlights are now auto-extracted from CHANGELOG.md (fail fast when the current version section is missing), no more hand-maintained highlight lists

## [v0.1.33] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🔐 **加密快照同步**：手动推送时可将整个同步快照的 sections 载荷用 AES-256-GCM **整体加密**后上传远端（`manifest.encrypted=true`），拉取/一键同步时输入密码解密——密码仅内存使用，绝不落盘/落日志
- 🛡️ **凭据随同步通道携带（可选）**：手动推送可导出真实凭据值（`includeSecrets`），但**强制要求同时加密**（安全不变量：密钥绝不明文进入同步通道）；自动同步恒不携带凭据
- 🚫 **自动同步智能跳过加密快照**：远端最新快照为加密 → 自动同步无密码无法解密，记录 `skipReason='encrypted'` 整体跳过（不误判失败），提示走手动输入密码同步
- ⚙️ **同步配置保存路由（sync/config）**：UI 表单自动保存 /「保存配置」按钮落盘同步通道配置，凭据走 DSH credentials 槽位；WebDAV `username` 留空时从持久化配置自动回填（挂载/刷新后不再因空用户名失败）
- ⏱️ **WebDAV 通道独立超时**：单请求放宽至 120s（适配坚果云等慢速 WebDAV 上传大快照/读写索引），错误消息携带实际毫秒数便于判断
- 🐛 **修复导入「解锁加密备份」阶段渲染让位**：decrypt-archive 阶段发生时不再停留在文件选择页，正确显示密码输入界面（import-decrypt-archive-render 回归）

### Highlights (en)

- 🔐 **Encrypted snapshot sync**: on manual push, the whole sync snapshot payload can be **encrypted with AES-256-GCM** before upload (`manifest.encrypted=true`); a password is asked on pull / one-click sync to decrypt — kept in memory only, never persisted or logged
- 🛡️ **Credentials may travel with the sync channel (opt-in)**: manual push can export real credential values (`includeSecrets`) but **requires encryption at the same time** (security invariant: secrets never enter the sync channel in plaintext); auto-sync never carries credentials
- 🚫 **Auto-sync skips encrypted snapshots**: when the remote latest snapshot is encrypted and no password is available, the sync records `skipReason='encrypted'` and skips the whole run (not a failure), prompting manual password-based sync
- ⚙️ **Sync config save route (`sync/config`)**: the UI autosaves / the "Save config" button persists channel config; credentials go to DSH credential slots; empty WebDAV `username` is backfilled from persisted config after mount/refresh
- ⏱️ **WebDAV channel timeout**: per-request timeout widened to 120s (for slow WebDAV like Jianguoyun uploading large snapshots / index I/O); error messages carry the actual milliseconds
- 🐛 **Fix import "unlock encrypted backup" step rendering**: the decrypt-archive stage now correctly shows the password input instead of staying on the file-selection page (import-decrypt-archive-render regression)