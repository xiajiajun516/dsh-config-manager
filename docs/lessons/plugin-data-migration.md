# 第三方插件数据迁移（pluginData / pluginAssets）

> 本文件只放**证据与判据**；规则一行回 `AGENTS.md` 的「常见坑」并加指针。

## 1. 事实：插件数据目录在哪（2026-10-14 调研）

| 插件 | 数据目录 | 依据 | 取证 |
|---|---|---|---|
| `dsh-plugin-wallpaper-engine`（1270 star） | `~/.dsh-wallpaper-engine/`（`config.json`、`uploads/`、`cache/`、`bin/`） | README「配置与数据」表逐项明示；环境变量 `DSH_WE_DATA_DIR` / `DSH_WE_CACHE_DIR` / `DSH_WE_UPLOAD_DIR` | documented |
| `dsh-mnemon`（542 star） | `~/.mnemon/{runtime,data,documents}/`；环境变量 `MNEMON_DATA_DIR` | 本机实测目录存在；包内 `globalRoot = process.env.MNEMON_DATA_DIR || "~/.mnemon"` | measured |
| `dsh-ops`（1517 star） | `~/.fastctx/` | README：默认不删 `~/.fastctx/` 持久状态（`--purge-fastctx` 才删） | documented |
| `dsh-any-background`（44 star） | `~/.dsh/.dsh-any-background-data/` | README：设置落文件系统而非 localStorage | documented |
| `@opencode2dsh/dsh-plugin`（196 star） | `~/.opencode2dsh/` | README：`~/.opencode2dsh/adapter-status.json` | documented |

**有数据目录但刻意不收录**（凭据风险 —— 文件类分区的内容不进 SecretScanner 的剥离路径，带出去就是明文）：
`@mars-sea/dsh-commandcode-provider`（389 star，`~/.commandcode/auth.json`）、`dsh-agy-link`（111 star，`~/.dsh/agy-accounts/pool.json` 为账号池）。
**高星但没有自有数据目录**：`dsh-better-sidebar`（4175 star，状态全在 DSH settings/storages，已被既有 settings/sessions 分区覆盖）。

调研口径：以官方市场缓存里的 308 个插件名为候选，按 npm 周下载量排序取前 70，再抓各包 README 提取数据目录线索，
对命中项逐一核对最终位置与 GitHub star（匿名 API）。**未取证的插件一律不进内置表**，由 `dsh.dataDirs` 自述声明覆盖。

## 2. 为什么拆成两个分区

「大资产默认不勾选但可见」在既有导出选择模型里**没有单元级通道**：`Selection` 是 `{sections, excluded}` 的稀疏表示，
语义是「默认全选、只记例外」，`ExportUnit` 也没有默认排除字段。要支持「单元默认不勾选」就得改共享选择模型，
而它同时被导入向导与市场通道使用（改一处的语义漂移风险高于收益）。
因此按「配置 / 大资产」拆成两个分区，复用既有的 `defaultIncluded=false` 语义：两行并列、各有体积、各自勾选。

## 3. 四个实测坑（都已修）

### 3.1 `excludeRel` 是**区域相对**路径，不是 home 相对
`excludeRel: ['cache']` 配区域 `.dsh-wallpaper-engine` 时，判别对象是 `cache/…`（区域相对），
而遍历产出的是 `.dsh-wallpaper-engine/cache/…`（home 相对）。直接 `startsWith` 会让排除**永不命中**：
缓存与上传的壁纸会跟着配置分区一起进包（用户取消勾选大资产也照样带走几百 MB）。
由 `src/core/plugin-data-registry.test.ts` 的「最长前缀归属」用例钉住。

### 3.2 声明来源缓存必须带 ctx 键（`homeDir|profile`）
适配器实例被宿主长期复用。若缓存只按实例存，**源机装了某插件**就会放行**目标机**（没装该插件）的同名路径写入 ——
白名单变成「谁先导入谁说了算」。由 `src/adapters/plugin-data.test.ts` 的「未声明插件目录仍被拒」用例钉住。

### 3.3 目录区域不能用 `exists()` 判形态
门面的 `statSize` 对「目录」与「不存在」都返回 `null`，而 `exists()` 在内存 fs 上对目录是 false。
若按 `exists → statSize` 的顺序判，真机上目录区域会被整体跳过（什么都不带）。
正确顺序：先判「是不是普通文件」（`statSize` 非 null），其余一律按目录走遍历 —— 目录不存在时遍历返回空，两义同归「没有内容」。

### 3.4 离线 CLI 的显式归类
离线备份的目标集合是静态路径表（`SECTION_SPECS`），而第三方插件数据的区域要靠来源注册表 + 已安装插件清单推导，
且 adapter 走 HostContext 门面 —— 与「CLI 绝不 import DSH 门面」冲突。
手抄一份区域表必然漂移，故选择**显式不适用**：`OFFLINE_EXCLUDED_SECTIONS` + 用户显式 `--sections pluginData` 时给「改用 GUI」的可执行提示，
并由 `src/core/backup-plan.test.ts` 的「注册表所有分区都必须显式归类」守卫钉住。

## 4. 端到端证据（真实磁盘，两个全新 home/profile）

`tests/e2e/plugin-data-migration.test.ts`：用磁盘门面起两个临时 home（`mkdtemp`），走完整管道
（`Exporter.export` → ZIP → `Importer.createImportPlan` → `executeImportPlan`）验证五件事：
① 配置与轻量数据逐字节落到新 home；② `cache/` 既不进计划也不落盘；③ 上传的壁纸与本地数据库只随 `pluginAssets` 走；
④ 目标机既有文件判 `Conflict` 且**未被覆盖**；⑤ 伪造成 `plugin-data/.credentials.yaml` / 未声明插件目录的条目判 `Error`、执行期零写入。

顺带一条真机语义（写错会让门面直接抛错）：快照/回滚引擎传给 `ctx.fs` 的是 `resolveFileTarget` 解析出的**绝对路径**，
所以门面必须同时接受「home 相对」与「home 内的绝对」两种入参；测试门面因此要求绝对路径也必须落在 home 之内。

## 5. 已知边界（**未做**，别写成已支持）

- 离线 CLI 备份不收集这两个分区（见 3.4）。
- 工作区内的插件数据（如 `<workspace>/.mnemon`）不迁移：属于用户工程目录，误伤面大。
- 插件面板里改过「缓存 / 上传位置」（写进插件自己的 `config.json`，不是环境变量）时，本分区只看到默认位置 ——
  不读插件私有配置就无法判定，选择如实不做（env 覆盖则报码跳过，不猜）。
- 单分区字节闸门仍是 256 MiB（与导入侧上传上限同量级）：更大的资产单元会被**整块**剔除并写进导出告警。
