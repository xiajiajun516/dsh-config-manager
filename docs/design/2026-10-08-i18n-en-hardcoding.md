
# 英文界面零中文 —— 验收契约与缺陷清单

- 日期：2026-10-08
- 归属任务：**t1（requirements，planner）** → 下游 t2/t3/t4/t5/t6/t7 实现、t8 验证、t9/t10 评审、t11 集成
- 状态：**冻结的验收契约**。本文档的判定口径只能用 amend 机制改（captain 裁决）；各实现作用域不得就地放宽。
- 来源诉求：「英文界面很多地方有中文，修复所有中文硬编码」。

> 记号：本文中 `path` / `cmd` 表示可复制粘贴的命令行与路径；所有数字均为 **2026-10-08 现测**（命令见 §5.0），不沿用任何旧估算。

---

## 0. 一页摘要：可机械判定的验收条件

| 编号 | 验收条件 | 判定命令（仓库根，PowerShell） | 通过判据 |
|---|---|---|---|
| **A1** | 全部用户可见中文已迁入 zh/en 目录：**全量静态守卫零命中** | `node --test tests/i18n-hardcoded-guard.test.ts` | 退出码 0；摘要行 `hits=0` |
| **A2** | **en 目录零 CJK**（7 本字典 + `locale/en.json`） | `$env:DCM_I18N_GUARD_SCOPE='src/client/locales.ts,src/ui/i18n.ts,src/core/messages.ts,src/client/history/history-locales.ts,src/client/market/market-locales.ts,src/client/recovery/recovery-locales.ts,src/client/sync/sync-locales.ts,locale/en.json'; node --test tests/i18n-hardcoded-guard.test.ts` | 退出码 0 |
| **A3** | **语言选择有单测证明**（根因不再复现） | `node --test tests/i18n-locale-runtime.test.ts` | 退出码 0（用例清单见 §4.4） |
| **A4** | **既有 zh 文案逐字不变**（既有测试断言依赖它） | `npm test` + `npm run typecheck` + `npm run typecheck:tests` | 三项退出码 0 |
| **A5** | 迁移期**不得新增豁免**：白名单条目计数锚定 | 同 A1（守卫内的过期/增长断言） | 退出码 0；白名单恒为 **4 条 128 命中**（t1 初始 2 条 73 + t12 授权的 2 条 55） |

作用域自检（各实现作用域自己的门禁；退出码 0 = 本作用域零命中）：

```powershell
$env:DCM_I18N_GUARD_SCOPE='src/client,src/ui'
node --test tests/i18n-hardcoded-guard.test.ts
$LASTEXITCODE                          # 0 = 本作用域零命中
Remove-Item Env:DCM_I18N_GUARD_SCOPE   # 变量名与语义见 §3.6
```

**迁移期红灯是预期状态**：守卫是绝对门禁，A1 只在 t3–t7 全部清零后才为绿；各成员用自己的 `DCM_I18N_GUARD_SCOPE` 判定自己的部分（见 §3.8）。

---

## 1. 根因（为什么切到英文界面还有中文）

中文能出现在英文界面上，有**两个同族根因 + 一个存量面**，三者都要治，缺一不可。

### 1.1 主根因：客户端渲染层的 `uiT` 一次性语言绑定

**代码（工作树，当前 HEAD）**：`src/client/index.ts:94`

```ts
const t = ctx.locale.bind(NS)
// 客户端展示层（报告/错误/进度/sync-view/market-view）翻译器：locale active 为 'en' 时用 en 目录。
const uiT: UiT = makeUiT(ctx.locale.getLocale().active === 'en' ? 'en' : 'zh')
const api = new ConfigManagerApi(uiT)
// …syncApi / marketApi / myConfigsApi / recoveryApi / historyApi / incidentApi 各用同一个 uiT 构造
// （7 个 Api 实例 + section inject 里的 uiT = 共 8 处引用同一个实例）
```

`apply()` 只在**插件加载时**执行一次 ⇒ `uiT` 把这个瞬间的语言**快照**固化进闭包。用户在设置里把界面语言切到 English 之后：

- DSH 官方 `ctx.locale.bind(NS)` 返回的 `t` **是活函数**：`bind` → `translate` 每次调用都读 `this.snapshot.active`（DSH `dsh-client-locale` 包 `lib/client.js:1414-1428`），所以走 `t()` 的设置页标题/按钮文案**会**跟着切；
- 本插件自造的 `uiT` **不是活函数**，于是所有走 `UiT` 的文案（报告 / 错误 / 进度 / 导入向导 / 同步视图 / 市场视图 / 档案与恢复提示）**永远是加载时那门语言**。

`ctx.locale.getLocale()` 的官方契约是「**当前不可变快照**（stable reference until the next change）」—— 把它当成「活的语言查询」就是本根因的写法错误。

**已发布 0.1.71 同款代码证据**（发布产物，不是估算）：

| 证据 | 值 |
|---|---|
| npm 已发布版本 | `dsh-config-manager@0.1.71`（registry `dist-tags.latest = 0.1.71`，2026-10-08 实测） |
| 发布 tarball | `npm pack dsh-config-manager@0.1.71` → `dsh-config-manager-0.1.71.tgz`，sha1 `0cbc6ed7cd48103ab35a67f90ce1eda0f5a785cd`（1430 files，18.7 MB unpacked） |
| 包内产物 | `package/lib/client.js:43206`：`const uiT = makeUiT(ctx.locale.getLocale().active === "en" ? "en" : "zh");` |
| 同版本源码 tag | `git show v0.1.71:src/client/index.ts` 中同一行 `const uiT: UiT = makeUiT(ctx.locale.getLocale().active === 'en' ? 'en' : 'zh')` |
| 本地产物 | `lib/client.js:43360` 同一行（工作树 0.1.71 构建产物） |

⇒ **用户装的就是这份代码**：英文界面上「很多地方有中文」由此而来。

### 1.2 同族根因：宿主引擎的消息翻译器同样被冻结

**代码（工作树）**：`src/index.ts:1543-1544`

```ts
this.language = resolveAppLanguage(ctx)      // ctx.settings.describe() 读 locale preference，一次
this.msg = makeMsg(this.language)            // MsgFunc 目录固定成加载时语言
```

`ConfigManagerHostContext` 在 `apply()` 里只 new 一次（`src/index.ts:3751`），`msg` 随后分发到 `routeEnv`（`src/index.ts:3175`）、`RunRegistry`（`:3933` / `:3940`）与各引擎（`src/core|sync|market|adapters|foreign`）。

**已发布 0.1.71 同款代码证据**：`package/lib/index.js:1387-1388` —— `this.language = resolveAppLanguage(ctx);` / `this.msg = makeMsg(this.language);`（`resolveAppLanguage` 在同文件 `:228`）。

**为什么这条也算「界面中文」**：宿主产出的报告/计划/错误文本经 API 回浏览器渲染；错误路径尤其直接 —— `src/routes/kit.ts:86` 的 `errorMessage(error)` 取 `error.message`，在 `:113` 走 `writeJsonError(res, 500, …)` 原样回客户端 ⇒ 引擎里的 `throw new Error('中文')` 会**逐字出现在 ErrorBanner**。所以宿主半必须同样「调用期解析语言」。

### 1.3 存量面：1180 处中文 literal 散在 124 个文件

即使两个绑定都修好，**写死在代码里的**中文仍然是中文（§5 列出全部现测命中）。这三层就是本次交付的全部内容。

---

## 2. 范围与排除项

### 2.1 纳入范围（唯一判定面）

用户可见文案的所有来源，都在下面三类里，全部受 §3 守卫约束：

1. **客户端渲染层**：`src/client/**`（React 壳）、`src/ui/**`（框架无关 UI 逻辑层）——走 `ConfigManagerKey`（`src/client/locales.ts`）或 `UiT`（`src/ui/i18n.ts`）。
2. **宿主引擎**：`src/core/**`、`src/sync/**`、`src/routes/**`、`src/adapters/**`、`src/foreign/**`、`src/market/**`、`src/utils/**`、`src/security/**`、`src/schema/**`、`src/profiles/**`、`src/migrations/**` —— 走 `src/core/messages.ts` 的 `MsgFunc`（zh 源 / en 镜像，`Record<keyof typeof zh, string>` 编译校验）。
3. **入口与目录**：`src/index.ts`（宿主入口）、`locale/zh.json` + `locale/en.json`（DSH 扩展点读的包级目录）。

### 2.2 排除项（每条都有理由，不是「懒得改」）

| 排除对象 | 理由 |
|---|---|
| `src/cli/**`（含离线救急台 `src/cli/web/**`） | 任务明示排除：终端 CLI 与离线救急台**保持中文**（救命通道，中文是刻意的） |
| 源码注释（`//`、块注释、JSDoc） | 不进界面；本仓注释以中文为主（AGENTS.md 语言约定） |
| `log.*` / `console.*` 调用的实参字符串 | 任务明示排除：日志不是界面文案。残余风险与补强见 §3.3-E2 |
| `*.test.ts` / `*.test.tsx` | 测试文件不进产物；且硬约束①要求既有断言里的中文原样保留 |
| `tests/**`（非 `*.test.ts` 的辅助文件） | 测试基建，不进 bundle |
| `src/**/fixtures/**` | 外部产品（Claude / Cursor / Copilot… ）的**样例配置**，是测试输入语料不是本插件文案（实测该目录 59 个文件、9 种扩展名，只有 13 个 `.json` 会被文本扫描器看到） |
| `locale/zh.json` | zh 目录源文件本身（整文件豁免）；其 en 镜像 `locale/en.json` **在扫描集内且必须零 CJK** |
| 7 本字典的 **zh 对象字面量区** | zh 文案的**单一事实源**（§3.3-E3）；en 区不豁免 |
| `README*.md` / `CHANGELOG.md` / `docs/**` / `.dsh/skills/**` | 面向开发者与仓库的文档，不是插件界面文案（AGENTS.md：文档以中文为主） |
| 白名单条目（初始 2 条，§3.5） | 逐条理由 + 计数锚定，不是通行证 |

### 2.3 明确的非目标（本次不做）

- 不译**界面上原样呈现的用户数据**（备份文件名、磁盘路径、用户自己起的名字、他人插件的原始错误）。
- 不回译**已经生成并落库/落 store 的字符串**（详见 §7）。
- 不改 DSH 自身的界面中文（只保证本插件 section 与它从宿主拿到的一切文本）。
- 不新增第二套 i18n 机制：一律走既有 7 本字典 + `makeMsg` / `makeUiT`（见 §4）。

---

## 3. 守卫规格（冻结）

### 3.1 冻结路径与命令

| 文件 | 归属 | 说明 |
|---|---|---|
| `tests/helpers/i18n-scan.ts` | **t2（foundation）新建** | 扫描内核：词法分类、豁免、白名单、口径导出（含可注入的样本扫描入口供自检） |
| `tests/i18n-hardcoded-guard.test.ts` | **t2（foundation）新建** | 守卫用例：全量断言 + 作用域断言 + 白名单过期断言 + 内核自检（§3.7） |

- 两者都是 `.ts`，被 `npm test`（`node --test "tests/**/*.test.ts"`）与 `npm run typecheck:tests`（`tsconfig.tests.json`）覆盖 ⇒ 必须零类型错误、必须被 `npm test` 真正执行到。
- 命令（仓库根，PowerShell）：
  - 全量：`node --test tests/i18n-hardcoded-guard.test.ts`
  - 作用域：`$env:DCM_I18N_GUARD_SCOPE='<逗号分隔前缀>'; node --test tests/i18n-hardcoded-guard.test.ts`
- 守卫必须**每次运行都打印一行机器可读摘要**：`DCM_I18N_GUARD scope=<ALL|前缀列表> files=<n> hits=<n> allowlisted=<n>`，随后逐条打印 `path:line [literal|code] <摘录>`。

### 3.2 扫描集（默认全量）

```text
src/**/*.ts, src/**/*.tsx
  − src/cli/**                      （排除项 §2.2）
  − **/*.test.ts, **/*.test.tsx      （排除项 §2.2）
  − src/**/fixtures/**               （排除项 §2.2）
+ locale/en.json                     （在扫描集内：必须零 CJK 命中）
+ locale/zh.json                     （在扫描集内：整文件豁免）
```

**现测扫描集规模：412 个文件**（非测试 `src/**` 共 423 个 − `src/cli/**` 13 个 + 2 个 locale JSON）。

### 3.3 词法口径：注释剥离、命中单位、三条豁免

**逐字符词法状态机**（不是正则替换）为每个字符分类 `code` / `comment` / `string`（`string` 含模板字面量与正则字面量）：

1. 状态：`code`、`line`（`//` 到行尾）、`block`（`/* … *`/`）、`'…'`、`"…"`、模板字面量（反引号；其中插值段 —— 即 `\`{ 起 —— 递归回 `code`，用大括号深度配对）、`/…/`（正则字面量；按前一个有效字符是否为 `( , = : [ ! & | ? { } ; + - * % ~ ^ < >` 之一，或前一个标识符为 `return` / `typeof` / `instanceof` / `case` / `in` / `of` / `do` / `else` / `yield` / `await` / `delete` / `void` / `new` 来判定）。
2. 字符串内 `\` 转义跳过下一个字符；字符串内未闭合换行按终止处理（防一个笔误吞掉整个文件）。
3. **命中单位 = （文件, 行, 该行内的字面量序号）**：一行里同一个字面量只记 1 条（避免「一句话 40 个汉字 = 40 条」的噪声）；同一字面量跨多行时每行各 1 条。
4. **CJK 字符类（冻结，用 broad）**：

```js
/[\u2E80-\u2EFF\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6]/gu
```

   覆盖：CJK 部首补充 / CJK 标点（顿号、句号、冒号、括号、引号… ）/ 扩展 A / 统一表意 / 兼容表意 / 兼容形式 / **全角形式与半角 CJK 标点**。**刻意包含全角标点**：`'＋ New private repository…'`（`src/client/sync/sync-locales.ts:433`，en 区，U+FF0B）在英文界面上同样是缺陷。刻意排除半角片假名（U+FF66+，日文）。
   > 类中不含 ASCII、不含拉丁/希腊/西里尔字母、不含 U+2018 / U+2019 / U+201C / U+201D（弯引号 —— 英文正文合法）。

**三条豁免（E1–E3）+ 一条白名单（W）**：

- **E1 注释**：`comment` 类字符一律忽略。
- **E2 日志实参**：位于 `log.*` / `console.*` **调用实参区间**内的命中豁免。区间判定 = 在 `code` 位置找到左括号，其前的 callee 文本匹配
  `/(?:^|[^\w$])(?:[\w$]+\.)*(?:log\.(?:trace|debug|info|warn|error)|console(?:\.[a-z]+)?)$/`
  （覆盖 `log.warn(…)/this.log.warn(…)/host.log.error(…)/console.warn(…)/console(…)`），再用**只看 code 位置**的括号配对找闭括号，取整段为豁免区。
  > **残余风险（记录在案，不由守卫强制）**：`src/profiles/**` 的启动/停止失败会把**日志尾部**回传界面（`launchFailed` 带日志尾部），这类日志文案**可能**被用户看到。该作用域（t7）应把「会回传界面的那几条」主动迁入目录，而不是依赖 E2 豁免。
- **E3 目录 zh 区**：仅在下列对象的**对象字面量区间**内豁免 —— `uiZh | zh | syncZh | marketZh | recoveryZh | historyZh | gistZh | s3Zh`（`(?:^|[^\w$.])<id>\s*(?::[^=]*)?=\s*\{` 起，按 code 位置的大括号深度配对到收尾）。**en 区不豁免** ⇒ 「en 目录零 CJK」由同一趟扫描自动覆盖，无需第二条断言。**t16 起还需「归属门禁」**（未归属文件里的 zh 对象不享豁免，见本节末「t16 加固」）。
- **W 白名单**：`tests/helpers/i18n-scan.ts` 导出的常量数组，条目形状冻结为

```ts
export interface I18nAllowlistEntry {
  /** workspace 相对 POSIX 路径（逐字相等匹配） */
  readonly file: string
  /** 现测命中数（精确相等：增长=新缺陷，减少=条目过期，两种都必须改条目） */
  readonly expectedHits: number
  /** 「为什么用户看不到它」的可核验理由（不得写「内部用」这类不可核验的话） */
  readonly reason: string
}
```

**E3 归属门禁 + fail-closed（t16 引入、t18 收紧；**验证状态见下**）**—— 两条防线由「按名字 / fail-open」改为「按归属 / fail-closed」：

1. **E3 归属门禁**：zh 对象字面量的豁免**不再只按标识符名**，还必须能**归属**到一本真目录 —— 判据 `isCatalogOwnerFile`：① 文件在显式清单 `KNOWN_CATALOG_FILES` 里（`src/ui/i18n.ts`、`src/client/locales.ts`、4 本客户端域字典、`src/migrations/messages-migrations.ts`），或 ② 文件自身**在 code 位置**调用 `registerMessageCatalog(` / `registerBaseMessageCatalog(` / `makeCatalogMsg(`。**未归属文件里的 `const zh = { a: '中文' }` 照常计入命中**（`scanText` 的 `catalogOwner` 缺省 `false`；`scanFile` / `scanAll` 按文件自动判定）；内核自检 **S9** / **S11**（20 处合法 zh 形状逐一可归属）覆盖**正例**。
   ✅ **该门禁已修复并经 t19 独立复验通过（2026-10-08）**：E3 属主判定**只认 code 位置**的 `register*MessageCatalog` / `makeCatalogMsg` 调用（`codeOnlyText` 掩码 + 原始文本快速预筛 + 内核自检 **S12**）；**注释 / 字符串里的字样不授予豁免**（t19 复跑：注释版 / 字符串版探针 → `exit 1` 并点名该行、真实调用 → `exit 0`、掩码不拼假匹配），区间未闭合 fail-closed。修复链 = **t18（修复）→ t19（独立复验，verdict=pass）**。
   ⚠ **不得**写成「任何文本形态都不能绕开归属」—— t19 另报两条 low 残余：① 正则**无左边界** ⇒ `myregisterMessageCatalog(` 这类**后缀名**也会授予整文件 zh 豁免；② **类型注解 / 声明形态**（`registerMessageCatalog(id: string, …): void`）也被算作「调用」。两条见 §3.9 的 V1-① / V1-②。**量化免责**：现树**无假属主**（14 个含匹配的文件里只有 `src/core/engine-locale.ts` 的定义形态与 `src/sync/s3/messages.ts`，均不持有用户可见 zh 字典）。
2. **fail-closed**：词法区间（单/双引号字符串、块注释、模板、正则、模板插值）与 E2/E3 的括号 / 大括号配对**未闭合**时，**不再静默豁免其后整段**，而是 (a) 不施加该豁免、(b) 产出 `ScanAnomaly`；守卫新增 **A3**（生效作用域内 anomalies 必须为 0，报「不可判定（扫描区间未闭合）」）与 **S10**（六种未闭合样本）。**这一条已由 t17 独立验证认可**（其结论原文：「fail-closed（A3）与归属门禁的**正例**都成立」）。

> **F4 口径留白（t16 只写进内核头注释，未改判定）**：① `LOG_CALLEE_RE` 要求 callee 紧贴 `(` ⇒ `log.info ('中文')` 不享 E2 豁免（保守误红）；② A2 的零 CJK 断言只在生效作用域内的目录文件上跑，**全量运行才是 A2 的门禁**；③ `.css` 不在扫描集（实测 `src/client/config-manager.module.css` 14917 个 CJK 全在注释内、剥离注释后 0）。三条都登记在 §3.9 的 F4。

### 3.4 豁免优先级与判定顺序（不得换序）

1. 文件在扫描集内？（§3.2）
2. 整文件豁免？（仅 `locale/zh.json`）
3. 字符在注释内？→ 忽略（E1）
4. 字符在 log/console 实参区间内？→ 忽略（E2）
5. 字符在目录 zh 区？→ 忽略（E3）
6. 文件在白名单里？→ 计入白名单计数（W），**不计入缺陷数**
7. 其余 → **命中**（缺陷）

### 3.5 白名单（4 条，合计 128 命中；最终态）

| # | 文件 | expectedHits | 理由（可核验） |
|---|---|---|---|
| 1 | `src/foreign/truth-table.ts` | 61 | 该文件的 `refs` / `dynamic` 是**取证文本数据**（`FOREIGN_TRUTH_TABLES` 的字段），供 `truth-table.test.ts` 与各来源单测逐平台比对，**从不渲染**：实测非测试导入方全部在 `src/foreign/**` 内，且 `src/ui/foreign-view.ts` 只消费 `source.paths`（界面路径说明走 `ui/i18n.ts` 的 `foreign.paths` / `foreign.pathsNone`） |
| 2 | `src/ui/test-helpers.ts` | 12 | 文件头自述「**仅供 `src/ui/*.test.ts` 使用，不参与生产构建语义**」；实测除 `*.test.ts` 外零导入方，且从 client 打包入口 `src/client/index.ts` 不可达（tsdown 单入口）⇒ 不进 `lib/client.js` |
| 3 | `src/ui/commands.ts` | 49 | `COMMANDS[].keywords` 是命令面板的**检索同义词**、不是文案：唯一消费方 `filterCommands` → `matchScore`（`src/ui/commands.ts:196-207`）只对关键词做 `toLowerCase` / `startsWith` / `includes` 并折成分档数值，返回值 `CommandMatch` 只带 `{item, disabled}`，关键词从不作为文本离开本模块；面板可见标题由调用方注入 `titleOf(titleKey)`（`:222` / `:237`），由壳层 `src/client/common/CommandPalette.tsx` 用 `t(item.titleKey)` 渲染客户端字典 `src/client/locales.ts`；文件头 `:7-12` 自述「零依赖、与语言无关：文案键只声明字面量联合」。中文词只是让中文用户搜得到命令（删掉只会让检索退化，不改变任何显示文本） |
| 4 | `src/ui/errors.ts` | 6 | `buildErrorRules()` 的 `match` 是**正则字面量**，只对宿主产出的错误消息（可能含中文原文）做 `.test()` 子串判定以挑选规则（`src/ui/errors.ts:31-76`），正则本身从不进入返回值或界面；显示文本来自规则里的 UiT 键 `error.*.title` / `error.*.action`（`:83-90` 写进 `ActionableError.title` / `suggestedAction`），由 `src/ui/i18n.ts` 字典渲染、经 `src/client/common/ErrorBanner.tsx` 与 `src/ui/import-wizard.ts` 展示。中文在这里是**匹配能力**（宿主错误消息是中文时才能命中友好标题），迁走会让匹配失效 |

**无过期条目断言（冻结语义）**：

- 每条白名单的 `expectedHits` 与实测命中数**精确相等**，否则守卫失败并打印差值；
- 实测为 0 的条目视为**过期**，同样失败（要求删除该条目）；
- 白名单**总命中数**作为一行输出（`allowlisted=128`），条目数锚定为 **4 条**（A5 断言 `ALLOWLIST_TOTAL_HITS=128` / `ALLOWLIST_ENTRY_COUNT=4`）；集成时必须仍为 128（除非 amend 明确批准）。
- 每条条目的 `reason` 由 A5 校验**可核验性**：trim 后 ≥ 20 字、且必须含 `src/` 消费方路径（挡「内部用」这类不可核验的话），`expectedHits` 必须是精确数字。

> 新增白名单条目的唯一通道：作用域所有者把「文件 + 现测命中数 + 用户看不到它的可核验理由」报给 captain，由 t2 的所有者落进 `tests/helpers/i18n-scan.ts`（硬约束②：不越界改别人的写作用域）。
> **t12（captain 授权）实际新增的两条**即上表 3 / 4（55 命中）：两条都属「匹配模式 / 检索同义词」而非用户可见文案 —— 迁走会让中文匹配能力消失，或把中文搬进 E3 豁免区（等价于不可见），故保持原样登记。
> **落条实测（同一工作树口径）**：off（临时移除这两条）`allowlisted=73 hits=597` → on（恢复）`allowlisted=128 hits=542`，差集恰为 `src/ui/commands.ts` ×49 + `src/ui/errors.ts` ×6，**反向差集为空**（零新增）。

### 3.6 `DCM_I18N_GUARD_SCOPE`（名字与语义冻结）

| 项 | 冻结值 |
|---|---|
| 变量名 | `DCM_I18N_GUARD_SCOPE`（逐字；**不带** `DSH_` 前缀） |
| 值语法 | 逗号分隔的 **workspace 相对 POSIX 前缀**：`src/client,src/ui`、`src/core`、`src/sync,src/routes,src/adapters,src/foreign` |
| 匹配 | 按**目录段边界**：前缀命中该前缀自身或其下 `/**`；写成文件路径时**逐字相等**。`src/client` **不得**命中 `src/client2`，`src/ui` **不得**命中 `src/ui-x` |
| 缺省 | 未设置 / 空串 / 全空白 ⇒ **全量扫描集** |
| 生效方式 | **只收窄文件列表**；E1–E3、白名单与过期断言、内核自检**始终全局生效** |
| 非法值 | 绝对路径（盘符或 `//` 开头）、含反斜杠、含 `..` 段 ⇒ **直接失败**并打印用法（绝不静默当空集 —— 空集会让门禁假绿） |
| 退出码 | 0 ⇔ **该作用域零命中**（`node --test` 语义：任一断言失败即 1） |
| 输出 | 摘要行回显生效作用域与命中数（§3.1） |

### 3.7 守卫内核自检（必须真跑，不得只写在注释里）

`tests/i18n-hardcoded-guard.test.ts` 必须用**内存样本**（不依赖工作树当前状态）至少覆盖：

| 用例 | 输入 | 期望 |
|---|---|---|
| S1 | 含中文的行注释、块注释、JSDoc | 0 命中（E1） |
| S2 | 同一文件里 `log.info('中文')` + `const a = '中文'` | 恰好 1 命中（E2 不过宽） |
| S3 | 字符串里含 `//`、`/*`、单引号、双引号、反引号、插值前缀、反斜杠转义，其后跟中文 | 中文仍必须命中（防「注释剥离吃掉代码」的**假阴性**） |
| S4 | 同一文件：zh 字典对象（含中文）+ en 字典对象（无中文）+ 一处普通中文字面量 | 恰好 1 命中（E3 精确到对象字面量） |
| S5 | 各类 CJK 各 1 字符（含全角 `＋` U+FF0B 与顿号 U+3001） | broad 全命中（冻结验证） |
| S6 | 白名单条目 `expectedHits` 大于 / 小于实测，或实测为 0 | 三种情况都失败（§3.5） |
| S7 | `DCM_I18N_GUARD_SCOPE='src/client'`，且 `src/client2/a.ts` 有命中 | 不命中 `src/client2`（目录段边界） |
| A3 | 词法区间 / E2 括号 / E3 大括号**未闭合**（语法残缺样本） | 该文件判**不可判定**并红（fail-closed，绝不静默零命中） |
| S9 | 未归属文件里的 `const zh = { a: '中文' }` | 照常命中（E3 归属门禁的**正例**；t19 独立复验通过，残余 low 见 §3.9 V1-①/②） |
| S10 | 未闭合的字符串 / 块注释 / 正则 / 模板 / 括号 / 大括号六种样本 | 每种都产出异常且**不施加豁免** |
| S11 | 20 处合法 zh 形状（12 处 `register*MessageCatalog` + s3/gist 的 `makeCatalogMsg` + 7 本客户端字典） | 逐一声明归属方式、全部可归属（**正例**；同 S9） |
| S12 | 属主判据只认 **code 位置**：注释版 / 字符串版 `registerMessageCatalog(` + 真实调用 + 掩码不拼假匹配 | 注释 / 字符串字样**不授予**豁免；真实调用授予（t18 加固，t19 独立复验通过） |

### 3.8 迁移期口径（写清楚，避免误判）

- 守卫落地到 t3–t7 清零之间的**全量红灯是预期状态**，不是回归；`npm test` 在这段窗口内会红（守卫是其中一条用例）。
- 每个实现作用域**只用** `DCM_I18N_GUARD_SCOPE` 形式判定自己（退出码 0）；不得为了让全量绿而放宽口径。
- 守卫落地后必须**立即做一次全量基线比对**：逐文件命中数必须与 §5 的表一致。不一致 ⇒ 要么守卫实现偏离本文档，要么 §5 数字过时（走 amend）；**不得**先改数字再改实现。
- **并发期门禁口径（2026-10-08 实测）**：t3–t7 并行改同一棵工作树时，整树 `npm run typecheck` / `npm run typecheck:tests` / `npm test` 的报错**若全部落在自己作用域之外**，不作为个体任务失败判据 —— 实测同一命令连续三次运行的报错文件集不断变化（`src/client/sync/**` → `src/schema/**`；错误数 5 → 85 → 70），且零条涉及当事任务的文件。个体任务只跑 `DCM_I18N_GUARD_SCOPE` 作用域门禁 + 自己文件的隔离类型检查；**全树门禁由 t8（独立验证）与 t11（集成）在全部实现落地后统一执行**（t8 实测：`typecheck` / `typecheck:tests` / `npm test`（4052 用例 4050 pass / 0 fail / 2 skipped）全绿）。
  > **t12 证据摘要（本条口径的第一次实际适用）**：t12（白名单落条）交付完成且作用域门禁 `exit 0`（`scope=src/ui/commands.ts,src/ui/errors.ts files=2 hits=0 allowlisted=128`），但契约 verify 的 `npm run typecheck:tests` 当时 `exit 1`，报错 100% 落在 t3/t7 正在写的文件、零条涉及 t12 的两文件（隔离类型检查 `exit 0`）⇒ 按硬约束③走 amend 报回 captain，**没有**为了绿灯而放宽口径。
- **§3.3 的守卫内核弱点与残余见 §3.9**（t9 评审 F1–F4 + t19 的 V1-①/②；**F3 已由 t16 加固并经 t17/t19 独立验证认可**；**F2（注释/字符串旁路）已由 t18 修复 + t19 独立复验 verdict=pass 勾销**，但**不得**写成「任何文本形态都不能绕开归属」—— 两条 low 残余见 §3.9；F4 为已登记的口径留白）。

### 3.9 守卫的已知弱点与残余（如实登记，不得隐去）

> 来源：t9 对抗性评审（verdict=pass，5 条 low）**+ t17 对 t16 加固的独立验证（verdict=failed）+ t19 对 t18 修复的独立复验（verdict=pass，另报 2 条 low）**。**本节只登记收尾时仍然存在的弱点**；
> 证据（探针均已删除）：t17 的注释版旁路探针当时 ★ 反例 `exit 0` → **t18 修复后 t19 复跑**：注释版 / 字符串版 → `exit 1` 并点名、真实调用 → `exit 0`、掩码不拼假匹配、fail-closed 与边界回归全过、两个守卫产物 SHA256 与探针前逐字相同；
> t16 的正例探针（未注册文件里的 `const zh = { a: '中文' }`）→ `exit 1 hits=1`；三条未闭合探针 → A3 报 `unclosed-*` 且**不豁免**。

| # | 弱点 | 当前是否可达 | 处置 |
|---|---|---|---|
| F1 | 白名单是**整文件**豁免（一条 `{file, expectedHits, reason}` 放过整文件），没有按行 / 按模式锚定，也没有 `approvedBy` / 到期日 | 可达，但**不可静默增长**：条目数锚定 4、总数锚定 128、单文件计数精确相等 ⇒ 该文件里新增任何中文立刻红；`reason` 还必须含 `src/` 消费方路径并走 captain 审批 | **仍然存在**（登记在案）；加固方向：`lineRanges` / `literalPattern` + 到期日 |
| V1-① | **E3 属主正则无左边界**：`CATALOG_OWNER_CALL_RE` 只要求字样出现 ⇒ `myregisterMessageCatalog(` 这类**后缀名**也会给整文件授予 zh 豁免（t19 独立复验报的 low 残余） | 可达（潜在旁路；**现树无假属主**） | **仍然存在（low）**；加固方向：加左边界后再判（已写进 t18/t19 的后续 acceptance） |
| V1-② | **类型注解 / 声明形态也算「调用」**：`registerMessageCatalog(id: string, …): void` 这样的声明会让该文件成为属主（t19 报的 low 残余） | 可达（潜在旁路；**现树无假属主**） | **仍然存在（low）**；加固方向：`(` 后紧跟 `\w+\s*:` 判为类型注解、不授予 |

> **已勾销（修复 + 独立复验通过）**：
> **F2**（E3 归属门禁的原始文本旁路）：t16 首版在**原始文本**上跑 `CATALOG_OWNER_CALL_RE` ⇒ 注释 / 字符串里提一句 `registerMessageCatalog(` 就给整文件授予豁免（t17 探针 ★ 反例 `exit 0`，t17 判 t16 failed）；**t18 修复**（只认 code 位置的调用：`codeOnlyText` 掩码 + 快速预筛 + 自检 **S12**）→ **t19 独立复验 verdict=pass**（注释版 / 字符串版 → `exit 1` 并点名、真实调用 → `exit 0`、掩码不拼假匹配、两个守卫产物 SHA256 与探针前逐字相同）。残余 low 见上表 **V1-① / V1-②**。
> **F3**（E2/E3 区间配对未闭合时 fail-open ⇒ 其后整段中文静默不计）：t16 改为 **fail-closed** —— 不施加豁免 + 产出 `ScanAnomaly`；守卫 **A3**（生效作用域 anomalies 必须为 0，报「不可判定（扫描区间未闭合）」）与 **S10**（六种未闭合样本）覆盖；t17 / t19 两轮独立验证均认可。

> **F4 口径留白（t16 已写进 `tests/helpers/i18n-scan.ts` 头注释第 16–35 行；非弱点，保留登记）**：① `LOG_CALLEE_RE` 要求 callee 紧贴 `(` ⇒ `log.info ('中文')` 不享 E2 豁免（**保守误红，方向安全**；要放行需单独决策并在末尾加 `\s*`）；② A2 的零 CJK 断言只在生效作用域内的目录文件上跑，**全量运行才是 A2 的门禁**；③ `.css` 不在扫描集（t16 独立复算 `src/client/config-manager.module.css`：total CJK=14917 / **nonComment=0**），纳入 .css 需单独决策。

> **本节与 §3.3 的关系**：§3.3 已按**加固后语义**描述（E3 只认 **code 位置**的 `register*` / `makeCatalogMsg` 调用、注释/字符串字样不授予、区间未闭合 fail-closed），证据 = **t18 修复 + t19 独立复验 verdict=pass**；措辞上限（不得写「任何文本形态都不能绕开归属」）与两条 low 残余 **V1-① / V1-②** 见上表。

---

## 4. 引擎语言运行时接口（冻结）

### 4.1 目标语义（唯一需要记住的一句话）

**语言必须在「取文案的那一刻」解析，而不是在「装配的那一刻」。** 这与 DSH 官方 `ctx.locale.bind(ns)` 的 `t` 完全同语义（`dsh-client-locale` 的 `bind` → `translate` 每次读 `snapshot.active`，`lib/client.js:1414-1428`）。

### 4.2 接口

### 4.2 接口（**与实际交付对齐**，2026-10-08 收口）

设计期草案是 `src/core/msg-types.ts` 的 `LanguageProvider` + 新文件 `src/core/live-msg.ts` 的 `createLiveMsg`；
实际交付收敛成**一个文件 + 一个模块级语言源**（宿主半不需要跨层注入 provider，域目录在引擎侧自注册）：

```ts
// src/core/engine-locale.ts（新文件，归 t2）—— 宿主 / 引擎半的活翻译器 + 域目录注册
export type LanguageId = 'zh' | 'en'
/** 语言源允许的缓存上界（毫秒）：只给非请求路径兜底（请求入口应 invalidate）。 */
export const LANGUAGE_TTL_MS = 1000

/** 设定引擎语言（固定值）：宿主构造期按 resolveAppLanguage(ctx) 初始化。 */
export function setEngineLocale(locale: LanguageSource): void
/** 注册「调用期解析」的语言活源：宿主用 () => resolveAppLanguage(ctx)。 */
export function setEngineLanguageSource(resolve: () => LanguageId): void
/** 当前引擎语言（调用期解析；函数源按 LANGUAGE_TTL_MS 缓存，解析失败回落 zh，绝不抛错）。 */
export function getEngineLocale(now?: number): LanguageId
/** 强制失效：下一次 getEngineLocale() 必须重新解析（路由入口 / 测试用）。 */
export function invalidateEngineLocale(): void

/** 注册一本追加目录（领域模块的键并入既有目录）；**只在既有目录未命中时生效**。 */
export function registerMessageCatalog(catalog: MessageCatalog): void
/** 活翻译器（MsgFunc 形状）：查找顺序 既有目录 → en 回退既有 zh → 注册目录 → 键名。 */
export function engineMsg(key: string, params?: MsgParams): string

// src/ui/i18n.ts（扩展）：客户端渲染半的活翻译器
/** read() 在每次取文案时调用；zh 缺省行为与 makeUiT 逐字一致。 */
export function makeLiveUiT(read: () => LanguageId): UiT
/** 接线活源（模块级 liveUiT 用）；未接线时等价 zhUiT。 */
export function setUiLanguageSource(read: () => LanguageId): void
```

**接线（实际落地，四条）**：

1. 宿主（`src/index.ts` 构造 `ConfigManagerHostContext` 时）：`setEngineLocale(resolveAppLanguage(ctx))` + `setEngineLanguageSource(() => resolveAppLanguage(ctx))` + `this.msg = engineMsg`；`language` 由 readonly 字段改为 **getter** 委托 `getEngineLocale()`（消费点 `src/routes/history.ts:41` 不改）。
2. 路由入口（`src/routes/kit.ts` 的 `endpoint()` 注册点）：每次请求调 `invalidateEngineLocale()` ⇒ **每个请求**都拿到最新语言；TTL 只给非请求路径（调度器、后台任务）兜底。
3. 客户端（`src/client/index.ts`）：`const readLanguage = () => ctx.locale.getLocale().active === 'en' ? 'en' : 'zh'` → `setUiLanguageSource(readLanguage)` + `const uiT: UiT = makeLiveUiT(readLanguage)`。**不得**在 `apply()` 里再出现 `makeUiT(`（源码级守卫 T6 钉住）。
4. 缺省不变：`zhMsg` / `zhUiT` 与所有引擎构造的 `msg: MsgFunc = zhMsg` 默认值保持原样（测试、离线 CLI、未注入路径行为逐字不变）；域目录 `registerMessageCatalog({id, zh, en})` **只在既有目录未命中时生效**，基础目录由 `src/core/messages.ts` 经 `registerBaseMessageCatalog` 反向注册（避免循环依赖）。

### 4.3 为什么不选「订阅后重建」，以及成本

- **不选订阅重建**：`uiT` 在构造期被 7 个 Api 实例构造 + section `inject` 一起捕获（共 8 处引用），订阅式重建需要把「谁还持有旧引用」全部翻新；且切语言那一刻**已生成的报告/进度文本**仍是旧语言。
- **成本**：客户端 `getLocale()` 只返回一个已冻结的快照对象并读 `.active`（零分配）；宿主 `resolveAppLanguage` 走 `ctx.settings.describe()`，因此用 `LANGUAGE_TTL_MS=1000` + 请求入口 `invalidate()` 把非请求路径的开销上界钉在「≤1 次/秒」。
- **不做**：不改 `MsgFunc` 签名、不改字典键类型、不引入新依赖、不动 `src/cli/`。

### 4.4 语言选择单测（路径冻结 + 用例清单）

**冻结路径：`tests/i18n-locale-runtime.test.ts`（新文件，归 t3 / impl-ui）**。用例：

| 用例 | 断言 |
|---|---|
| T1 同一实例跟随语言 | 同一个 `makeLiveUiT(read)` 返回值：`read` 返回 zh 时输出中文 → 把 `read` 的返回改为 en → **同一函数**输出英文 → 再切回 zh 输出中文（钉死根因） |
| T2 zh 缺省逐字不变 | `makeLiveUiT(() => 'zh')` 与 `zhUiT` 在一组键上输出**逐字相等** |
| T3 回退 | en 缺键 → 回退 zh → 再回退键名（与 `makeUiT` 一致）；`{param}` 插值缺参原样保留 |
| T4 宿主半同款 | `engineMsg`（`setEngineLanguageSource` 的活源切 en 后）同一函数引用输出英文；未设定语言时与 `zhMsg` 对全部既有键逐字相等 |
| T5 失效上界 | provider 源值变化后：调 `invalidate()` 则**当次**调用即为新语言；不调时最迟 `LANGUAGE_TTL_MS` 后必须已为新语言（注入假时钟/假 `now`） |
| T6 根因静态钉死 | 源码级：`src/client/index.ts` 文本中**不得**出现 `makeUiT(`（必须用 `makeLiveUiT`） |

> T1–T5 用仓库既有姿势（`node:test` + `node:assert`，零依赖；生产模块 import 带 `.ts` 后缀）。T6 按既有源码级守卫先例折 LF 后读。
> 各模块的就地单测另放模块旁（`src/ui/i18n.test.ts` 已存在；`src/core/engine-locale.test.ts` 为实际交付的宿主半单测，含 372 键 zh/en 冻结指纹、TTL / invalidate 边界与注册目录优先级），本文件只是**跨层**证明。

---

## 5. 缺陷清单（**迁移前基线**，2026-10-08 现测；按 6 个实现作用域）

> **最终态（2026-10-08 收口，t11 集成）**：全量守卫 `node --test tests/i18n-hardcoded-guard.test.ts` → **exit 0**，摘要行
> `DCM_I18N_GUARD scope=ALL files=424 hits=0 allowlisted=128`（**收尾实测 17/17** 通过；t16 + t18 加固后自检从 S1–S7 扩到 A3 + S1–S12）⇒ **全部用户可见中文已迁入 zh/en 目录**。
> （**不变量是 `hits=0` / `allowlisted=128`**；`files=` 随新增源文件与**在途探针**浮动 —— t1 基线 412、t2 后 424、t16/t17 期间实测 424↔426。）
> 下表是**迁移前**（基线 commit `ce03fe5`）的逐作用域缺陷数，保留作对照与审计依据。
>
> **实测基线推进（同一工作树口径）**：迁移前红 **1107 + 白名单 73 = 1180** → t2 落守卫（含 `src/index.ts` 的 23 条）后 **1084 + 73 = 1157**
> → t12 落两条白名单后 hits **再减 55**（`src/ui/commands.ts` 49 + `src/ui/errors.ts` 6）→ **最终 `hits=0` / `allowlisted=128`**。
> 扫描文件数 412（基线）→ 424（新增 12 个域目录文件等）。

### 5.0 统计口径与命令（先读这段，再看数字）

- **口径**：§3.2 扫描集 + §3.3 词法口径（注释剥离、log/console 实参豁免、目录 zh 区豁免）+ §3.3-4 的 CJK broad 类 + §3.3-3 命中单位。
- **白名单**（§3.5，最终 **4 条 128 命中**；本表是迁移前基线、当时为 2 条 73 命中）在这张表里**不扣除**：表中「命中」= 该作用域的全部命中；「待迁移」= 命中 − 白名单。
- **命令**（现测命令 = 附录 A 的参考实现；t2 落地后等价命令 = 守卫）：

```powershell
# 分组总览（现测；附录 A 存为 i18n-scan.reference.mjs）
node i18n-scan.reference.mjs --group
# 逐文件命中数
node i18n-scan.reference.mjs --byfile
# 某作用域逐条（file:line + 摘录）
node i18n-scan.reference.mjs --scope src/client,src/ui
# t2 落地后的等价命令（冻结入口）
$env:DCM_I18N_GUARD_SCOPE='src/client,src/ui'; node --test tests/i18n-hardcoded-guard.test.ts
```

- **基线**：`git rev-parse HEAD` = `ce03fe542508cd5ad109b68fbafcbea0e1b262ed`（version `0.1.71`）—— 下表数字是**该 commit 的工作树**现测；工作树若在实现期被别的改动动了中文文案，数字会变，**以守卫在 t2 落地时的首次全量输出为准**（§3.8 的基线比对）。
- **迁移前总计：扫描 412 文件，命中 1180，有命中的文件 124；扣白名单后待迁移 1107。**（最终态：424 文件 / `hits=0` / `allowlisted=128`。）
- **§3.8 的基线比对已完成**：`tests/helpers/i18n-scan.ts` 与附录 A 参考实现**逐命中等价**（412 文件 / 1180 命中；file:line + kind + 摘录 0 差异），分组 23 / 144 / 356 / 306 / 255 / 96 与下表完全一致；落条后逐条 diff 只剩 `src/index.ts` 的 23 条、**零新增**。
- 实测**无未归属文件**（124 个命中文件全部落在下表 6 个作用域里）。
- **遇到「好像不渲染」的字符串怎么办**：默认**迁**（搬进 zh 目录 + 新增 en 值，zh 逐字不变）—— 迁移成本远低于评审成本，也不要先自行判断「用户看不到」；只有当它确实是**数据或测试语料**（例：外部产品样例文件、真值表证据文本）时，才按 §3.5 走 captain 加白名单，并给出可核验理由。

| 作用域（任务 / 成员） | 前缀 | 命中 | 文件 | 白名单 | 待迁移 |
|---|---|---|---|---|---|
| **G1** foundation（t2） | `src/index.ts`、`src/core/messages.ts`、`src/core/msg-types.ts`、`locale/`、守卫两文件 | **23** | 1 | 0 | 23 |
| **G2** impl-ui（t3） | `src/client/**`、`src/ui/**` | **144** | 24 | 12 | 132 |
| **G3** impl-core（t4） | `src/core/**`、`src/migrations/**` | **356** | 25 | 0 | 356 |
| **G4** impl-data（t5） | `src/market/**`、`src/utils/**` | **306** | 14 | 0 | 306 |
| **G5** impl-flow（t6） | `src/sync/**`、`src/routes/**`、`src/adapters/**`、`src/foreign/**` | **255** | 49 | 61 | 194 |
| **G6** impl-infra（t7） | `src/security/**`、`src/schema/**`、`src/profiles/**` | **96** | 11 | 0 | 96 |

> **作用域归属的唯一显式假设**：`src/index.ts`（宿主入口，23 命中）与 `locale/*.json` 归 **G1 / t2**（t3–t7 的任务标题都不含它）。若 captain 另有安排，走 amend 改这一行即可，不影响其它数字。

### 5.1 G1 foundation（t2）：23 命中 / 1 文件 — `src/index.ts`

逐条（现测；`--scope src/index.ts`）：

| 行 | 该行内的中文片段 |
|---|---|
| 1553 | 顿号（`sessionFormatTried.slice(0, 6).join('、')`）与 `' 等'` |
| 1554 | 顿号（`sessionFormatTried.join('、')`） |
| 1770 | `口令写入 DSH credentials 失败：` / `（请在 DSH 凭据管理里配置` / `后重试）` |
| 1792 | `写入 DSH credentials 失败：` / `（请在 DSH 凭据管理里配置` / `后重试）` |
| 1812 | `写入 DSH credentials 失败：` / `（请在 DSH 凭据管理里配置` / `后重试）` |
| 1857 | `密钥` |
| 2230 | `恢复动作缺少` |
| 2239 | `恢复动作缺少` |
| 2248 | `恢复动作缺少插件名` |
| 2253 | `卸载失败` |
| 2264 | `未知动作` |
| 2548 | `自动保留清理删除` / `个旧快照` |
| 2942 | `自动同步` / `（` / `）` |

> 1553/1554 的中文分隔符出现在**用户可见的告警文本**里（`sessionFormatTried` 提示）；`955` 等 `this.log.warn` 行的中文**不在**命中内 —— E2 豁免。

### 5.2 G2 impl-ui（t3）：144 命中 / 24 文件

范围 `src/client/**`、`src/ui/**`；命令 `node i18n-scan.reference.mjs --scope src/client,src/ui`

| 文件 | 命中 | 行范围 |
|---|---|---|
| `src/ui/commands.ts` | 49 | 93–191 |
| `src/ui/export-flow.ts` | 14 | 92–105 |
| `src/client/run-store.ts` | 13 | 1820–2151 |
| `src/client/sync/SyncPanel.tsx` | 12 | 509–1303 |
| `src/ui/test-helpers.ts` ⚑白名单 | 12 | 85–134 |
| `src/ui/errors.ts` | 6 | 40–70 |
| `src/ui/import-wizard.ts` | 6 | 345–545 |
| `src/client/about/about-view.ts` | 5 | 157–164 |
| `src/client/sync/history-model.ts` | 3 | 99–106 |
| `src/client/sync/sync-view.ts` | 3 | 462–929 |
| `src/ui/artifact-view.ts` | 3 | 233–324 |
| `src/client/about/release-notes-view.ts` | 2 | 167–172 |
| `src/client/sync/SyncConfirmView.tsx` | 2 | 365 |
| `src/client/sync/SyncLogList.tsx` | 2 | 86 |
| `src/client/sync/SyncRepositoryPicker.tsx` | 2 | 126–169 |
| `src/ui/foreign-view.ts` | 2 | 238 |
| `src/client/library/LibraryPanel.tsx` | 1 | 201 |
| `src/client/market/MyConfigsWizard.tsx` | 1 | 192 |
| `src/client/sync/ChannelClearConfirmDialog.tsx` | 1 | 51 |
| `src/client/sync/ChannelConfigDialog.tsx` | 1 | 165 |
| `src/client/sync/UnreadableSnapshotsBanner.tsx` | 1 | 31 |
| `src/client/sync/sync-locales.ts` | 1 | 433 |
| `src/ui/report.ts` | 1 | 50 |
| `src/ui/types.ts` | 1 | 56 |

> 三处容易误判，实测结论：① `src/ui/export-flow.ts` 的 `CATEGORY_DESCRIPTIONS` 是**界面/报告文案而非数据**（进 `description`，文件自称「报告文本 / 日志用」）⇒ 迁；② `src/ui/types.ts:56`（`EXPORT_GROUPS` 的 `note`）是**UI 分组说明文案**，但它当前只经 `groupedCatalog()` 返回，而该方法**生产调用方为 0**（唯一调用方是 `ui/export-flow.test.ts`）⇒ 仍按 UI 文案迁（1 条），只是不要按「当前正在渲染」理解；③ `src/client/sync/sync-locales.ts:433` 是 **en 区**命中，A2 的唯一违规（见 §5.7）。

### 5.3 G3 impl-core（t4）：356 命中 / 25 文件

范围 `src/core/**`、`src/migrations/**`；命令 `node i18n-scan.reference.mjs --scope src/core,src/migrations`

| 文件 | 命中 | 行范围 |
|---|---|---|
| `src/core/backup-verify.ts` | 32 | 149–300 |
| `src/core/verify-recovery.ts` | 32 | 61–251 |
| `src/core/model-tools.ts` | 29 | 71–458 |
| `src/core/backup.ts` | 28 | 150–803 |
| `src/core/plugin-cli.ts` | 27 | 612–712 |
| `src/core/backup-plan.ts` | 26 | 141–345 |
| `src/core/migration-consult.ts` | 25 | 215–440 |
| `src/core/reconcile.ts` | 21 | 129–349 |
| `src/core/reinstall.ts` | 21 | 46–288 |
| `src/core/recovery-orchestrator.ts` | 18 | 198–432 |
| `src/core/restore.ts` | 17 | 284–920 |
| `src/core/local-plugin-pack.ts` | 15 | 325–400 |
| `src/migrations/index.ts` | 13 | 32–64 |
| `src/core/migration-history.ts` | 12 | 338–426 |
| `src/core/consult-source.ts` | 6 | 78–209 |
| `src/core/journal.ts` | 5 | 197–439 |
| `src/core/run-registry.ts` | 5 | 83–91 |
| `src/core/phase3-host.ts` | 4 | 29–457 |
| `src/core/transaction-coordinator.ts` | 4 | 112–230 |
| `src/core/validator.ts` | 4 | 105–108 |
| `src/core/boot-rescue.ts` | 3 | 417–424 |
| `src/core/checkpoint.ts` | 3 | 693–1303 |
| `src/core/local-plugin-host.ts` | 3 | 72–127 |
| `src/core/exporter.ts` | 2 | 377 |
| `src/core/boot-safety.ts` | 1 | 170 |

> `src/core/messages.ts` 本身 **0 命中**（zh 区豁免、en 区零 CJK，现测）。G3 的键**追加**进该文件（§6.3）。

### 5.4 G4 impl-data（t5）：306 命中 / 14 文件

范围 `src/market/**`、`src/utils/**`；命令 `node i18n-scan.reference.mjs --scope src/market,src/utils`

| 文件 | 命中 | 行范围 |
|---|---|---|
| `src/utils/env-lock.ts` | 56 | 484–1218 |
| `src/utils/zip.ts` | 41 | 110–549 |
| `src/market/index-parser.ts` | 36 | 41–254 |
| `src/market/my-repo.ts` | 32 | 54–847 |
| `src/market/security.ts` | 30 | 64–210 |
| `src/market/git-file-writer.ts` | 29 | 128–326 |
| `src/market/prepare.ts` | 23 | 88–230 |
| `src/market/github-repos.ts` | 19 | 143–625 |
| `src/utils/session-log-repair.ts` | 14 | 400–504 |
| `src/utils/atomic-write.ts` | 10 | 187–356 |
| `src/utils/json.ts` | 8 | 25–82 |
| `src/utils/proxy.ts` | 5 | 182–237 |
| `src/market/types.ts` | 2 | 50 |
| `src/market/url.ts` | 1 | 16 |

### 5.5 G5 impl-flow（t6）：255 命中 / 49 文件

范围 `src/sync/**`、`src/routes/**`、`src/adapters/**`、`src/foreign/**`；命令 `node i18n-scan.reference.mjs --scope src/sync,src/routes,src/adapters,src/foreign`

| 文件 | 命中 | 行范围 |
|---|---|---|
| `src/foreign/truth-table.ts` ⚑白名单 | 61 | 126–451 |
| `src/sync/layout.ts` | 20 | 131–267 |
| `src/routes/profiles.ts` | 16 | 108–245 |
| `src/routes/recovery.ts` | 15 | 176–578 |
| `src/routes/sync.ts` | 14 | 734–1026 |
| `src/sync/github-auth.ts` | 11 | 105–214 |
| `src/foreign/registry.ts` | 10 | 224–429 |
| `src/sync/sync-engine.ts` | 9 | 276–1514 |
| `src/sync/backup-scheduler.ts` | 7 | 243–394 |
| `src/routes/import.ts` | 6 | 157–326 |
| `src/sync/sync-history.ts` | 6 | 71–90 |
| `src/adapters/workspaces.ts` | 5 | 217–434 |
| `src/routes/snapshots.ts` | 5 | 147–212 |
| `src/sync/review-queue.ts` | 5 | 58–147 |
| `src/sync/s3/s3-providers.ts` | 5 | 58–77 |
| `src/sync/snapshot-crypto.ts` | 5 | 32–76 |
| `src/adapters/link-report.ts` | 4 | 37–66 |
| `src/adapters/plugins.ts` | 4 | 80–733 |
| `src/adapters/sessions.ts` | 4 | 370–384 |
| `src/sync/autosync-scheduler.ts` | 4 | 496–641 |
| `src/adapters/ui.ts` | 3 | 44–58 |
| `src/sync/backup-files.ts` | 3 | 155–201 |
| `src/sync/blob-store.ts` | 3 | 98 |
| `src/foreign/bundle.ts` | 2 | 60–70 |
| `src/routes/kit.ts` | 2 | 233 |
| `src/routes/market.ts` | 2 | 177 |
| `src/sync/snapshot-json.ts` | 2 | 90–129 |
| `src/adapters/plugin-files.ts` | 1 | 39 |
| `src/adapters/prompts.ts` | 1 | 162 |
| `src/foreign/continue.ts` | 1 | 34 |
| `src/foreign/crush.ts` | 1 | 30 |
| `src/foreign/gemini.ts` | 1 | 31 |
| `src/foreign/goose.ts` | 1 | 30 |
| `src/foreign/kilocode.ts` | 1 | 29 |
| `src/foreign/kimi.ts` | 1 | 33 |
| `src/foreign/mimocode.ts` | 1 | 29 |
| `src/foreign/openclaw.ts` | 1 | 33 |
| `src/foreign/opencode.ts` | 1 | 30 |
| `src/foreign/pi.ts` | 1 | 35 |
| `src/foreign/qoder.ts` | 1 | 32 |
| `src/foreign/qwen.ts` | 1 | 32 |
| `src/foreign/teleagent.ts` | 1 | 30 |
| `src/foreign/workbuddy.ts` | 1 | 32 |
| `src/foreign/zcode.ts` | 1 | 29 |
| `src/foreign/zed.ts` | 1 | 30 |
| `src/sync/ancestor.ts` | 1 | 22 |
| `src/sync/s3/s3-transport.ts` | 1 | 562 |
| `src/sync/s3/sigv4.ts` | 1 | 85 |
| `src/sync/webdav/webdav-transport.ts` | 1 | 550 |

### 5.6 G6 impl-infra（t7）：96 命中 / 11 文件

范围 `src/security/**`、`src/schema/**`、`src/profiles/**`；命令 `node i18n-scan.reference.mjs --scope src/security,src/schema,src/profiles`

| 文件 | 命中 | 行范围 |
|---|---|---|
| `src/schema/config.ts` | 26 | 45–168 |
| `src/schema/manifest.ts` | 18 | 60–122 |
| `src/security/encryption.ts` | 17 | 85–271 |
| `src/schema/versions.ts` | 11 | 59–84 |
| `src/security/integrity.ts` | 9 | 51–98 |
| `src/security/secret-scanner.ts` | 6 | 362–396 |
| `src/security/zip-security.ts` | 4 | 86–100 |
| `src/schema/section-registry.ts` | 2 | 393 |
| `src/profiles/dsh-profile-launcher.ts` | 1 | 262 |
| `src/profiles/dsh-profile-runtime.ts` | 1 | 212 |
| `src/security/vault.ts` | 1 | 71 |

### 5.7 A2 专项：en 目录零 CJK（现测）

命令（现测 / t2 落地后的等价命令见 §3.1 的作用域形式）：

```powershell
node i18n-scan.reference.mjs --scope "src/client/locales.ts,src/ui/i18n.ts,src/core/messages.ts,src/client/history/history-locales.ts,src/client/market/market-locales.ts,src/client/recovery/recovery-locales.ts,src/client/sync/sync-locales.ts,locale/en.json"
```

**迁移前现测：8 个文件（7 本字典 + `locale/en.json`），命中 1。最终态：`files=8 hits=0`（t3 已把那条全角 `＋` 改成半角；A2 在作用域收窄时只覆盖生效作用域内的目录文件，**门禁是全量运行**）。**

| 项 | 现测 |
|---|---|
| 违规 | `src/client/sync/sync-locales.ts:433` —— `'＋ New private repository…'`（全角 `＋` U+FF0B，位于 **en 区**） |
| 其余 7 个文件 | 0 命中（`ui/i18n.ts`、`core/messages.ts`、`client/locales.ts`、`history` / `market` / `recovery` 字典 + `locale/en.json`） |

**7 本字典的键数 / zh-en 键集合相等（现测，命令同 `DEVELOPERS.md` §i18n 的重数命令）**：

| 字典 | zh / en | same |
|---|---|---|
| 字典 | zh / en（迁移前现测） | zh / en（**最终态**） | same |
|---|---|---|---|
| `src/client/locales.ts` | 865 / 865 | **873 / 873** | true |
| `src/ui/i18n.ts` | 498 / 498 | **528 / 528** | true |
| `src/core/messages.ts` | 372 / 372 | **380 / 380** | true |
| `src/client/history/history-locales.ts` | 54 / 54 | **54 / 54** | true |
| `src/client/market/market-locales.ts` | 183 / 183 | **184 / 184** | true |
| `src/client/recovery/recovery-locales.ts` | 385 / 385 | **385 / 385** | true |
| `src/client/sync/sync-locales.ts` | 323 / 323 | **336 / 336** | true |

> 最终态另含 13 本**引擎侧域目录**（`registerMessageCatalog` 并入；**20 本合计 3446 个 zh 键**含上面 7 套；逐本清单见 `DEVELOPERS.md` §i18n）。
> **键数口径（全文统一为现测值）**：`src/core/messages.ts` 迁移前 **372**（**不是**旧文档 2026-10-02 的 **353**；t9 评审 F5 亦确认过）→ 最终 **380**；7 套客户端字典按上表「最终态」列；目录数按 **20 本**（含 s3 / gist；t8 报告的 19 本 / 3430 键为不含 gist 的口径）。

> 与 `DEVELOPERS.md` 的 2026-10-02 表**不同是正常的**（该表自己写了「改动文案后如要引用数量，请重新实测」）。迁移只会**增加**键（硬约束①：zh 值逐字不变、只新增 en 值）。

---

## 6. 落地顺序与门禁

### 6.1 顺序（依赖图给出的自然序，不得跳步）

1. **t2** 先落守卫（`tests/helpers/i18n-scan.ts` + `tests/i18n-hardcoded-guard.test.ts`，含 §3.5 初始白名单 2 条与 §3.7 自检 S1–S7）与引擎语言运行时（§4 宿主半 + `makeLiveUiT` + `src/index.ts` 的 23 处）。
   - 自检：`npm run typecheck`、`npm run typecheck:tests`、`node --test tests/i18n-hardcoded-guard.test.ts`；S1–S7 必须真跑。
   - 收尾必做：**全量跑一次并与 §5 逐文件表比对**（不一致 ⇒ §3.8 的处理）。
2. **t3** 修主根因（`src/client/index.ts:94` → `makeLiveUiT`）+ 冻结单测（§4.4）+ G2 清零。
3. **t4–t7** 各自 scope 清零；每条自检 `DCM_I18N_GUARD_SCOPE=<自己的前缀>` 退出码 0。
4. **t8** 独立验证：A1–A5 + 真机切语言（设置 → English → 逐页签走：主页 / 产物库 / 同步 / 环境 / 导入向导 / 市场 / 恢复 / 历史）。
5. **t9 / t10** 评审：守卫是否可能假阴性（吃掉代码）或假阳性（豁免过宽）；语言运行时是否真有单测证明；白名单理由是否可核验。
6. **t11** 集成：`CHANGELOG.md` 的 `## [Unreleased]` 写用户可见修复（AGENTS.md 硬要求），`DEVELOPERS.md` §i18n 补「语言运行时 + 静态守卫」两段；`DESIGN.md` 无需改（无视觉变更）。

### 6.2 硬约束（照抄任务书，供各作用域对照）

1. **zh 文案逐字不变**：只新增 en 值／把字面量搬进 zh 目录，**不得改 zh 字面量本身**（既有测试断言依赖它）。搬运时拼接顺序、空格、全角标点必须逐字保留。
2. **只改自己的写作用域**：需要改别人作用域（含 `tests/helpers/i18n-scan.ts` 的白名单、`src/core/messages.ts` 的既有键）时先报 captain，不越界。
3. **契约本身写错**（验收不可达成 / 命令与环境不符）走 amend 让 captain 改，不糊弄门禁。

### 6.3 键落位（避免「放进哪本字典」的来回）

| 消费面 | 目录 | 谁追加 |
|---|---|---|
| React 壳（`t()`，`ConfigManagerKey` 编译校验） | `src/client/locales.ts` | t3 |
| React 壳的独立命名空间（同步 / 市场 / 恢复 / 历史） | `src/client/{sync,market,recovery,history}/*-locales.ts` | t3（跨域键由该域所有者提供文案） |
| `src/ui/**` 纯逻辑层（`UiT`） | `src/ui/i18n.ts`（`uiZh` / `uiEn` 各追加） | t3 |
| 引擎 / 宿主 / `routes` / `adapters` / `foreign`（`MsgFunc`） | `src/core/messages.ts` | t2 / t4 / t5 / t6 / t7 **追加式**（只加自己的键，不动别人的键） |

> 追加式写法的既有先例：`src/sync/s3/messages.ts` 与 `src/sync/gist/messages.ts`（`makeCatalogMsg`，键可由目录拥有者并入）。**本次不在 `src/**` 新增第二套目录文件**：直接追加进上表四本（同文件追加由串行执行保证，不并发写）。

### 6.4 命名与体例（沿用既有）

- 键名 `域.小驼峰`，与既有风格一致（`export.sectionFailed` / `import.secretAlreadyConfigured` / `sync.sessionsTombstoned`）。
- 插值一律 `{param}`，缺参原样保留；**不做**复数/日期格式化（与既有 `interpolate` 同口径）。
- en 值写**自然英文**（不是直译腔），但不得改变占位符名与数量。

---

## 7. 残余风险与明确不做（写清楚，防止后续被当成缺陷）

1. **已生成的字符串不回译**：切语言前已经产出并落进 `run-store` / 报告对象 / 历史的文本仍是旧语言（下个请求或下次渲染即新语言）。这是活函数方案的固有边界，**不修**。
2. **`log.*` / `console.*` 保持中文**（E2）。例外：`src/profiles/**` 里**会随 `launchFailed` 回传界面**的日志尾部文案，t7 应主动迁入目录（守卫不强制 ⇒ 评审时看这条）。
3. **`src/cli/**`（含离线救急台）保持中文**：它的用户是终端前的人，中文是刻意的。
4. **注释 / 测试 / fixtures 不进字典**：`tests/**` 与 `*.test.ts` 里的中文是断言语料。
5. **历史落盘文本属数据**：`core/migration-history.ts` 之类**已写入磁盘/汇报对象的历史记录**不回译；但其中**硬编码在源码里的字面量**（§5.3 的 12 命中）仍要迁。
6. **DSH 自身界面的中文**不在本计划内。
7. **in-flight 请求**：切语言瞬间正在返回的响应可能是旧语言一次（下一次请求即修正）。
8. **不做**：不引入 ICU/格式化库、不改 `MsgFunc` 签名、不为守卫引入新依赖、不改 `src/cli/`、不做 UI 视觉调整。
9. **`src/core/model-tools.ts` 的 5 条工具描述在 `apply()` 期解析**（DSH 的工具注册是「**注册即快照**」语义）：会话中途切语言**不会**即时更新这 5 条描述，要重启 DSH 才生效。**不修**（改它要动 DSH 的工具注册契约）。
10. **各域目录的键归属自检口径**：调用点引用的键必须存在于**已注册**目录（基础目录 ∪ `registerMessageCatalog` 注册的域目录）；键类型由 `tsc` 的 `keyof typeof zh` 强制，跨域引用另有运行时自检（t7 对 11 个调用点 / 66 键做过 100% 核对）。**新增域目录时必须同时 `registerMessageCatalog`**，否则 `engineMsg` 只会回退键名（可见缺陷，不崩溃）。
11. **`src/cli/index.ts:1025` 仍按文案子串判 corrupt 锁**（`detail.includes('无有效 owner')`）：CLI 恒 zh 故当前正确；**若 CLI 将来接语言源，必须改成结构性判据**（参照 `src/utils/env-lock.ts` 的 `corruptOwnership`），否则英文界面下这条判定会失效。
12. **语言映射边界：只有精确 `'zh'` 视为中文**，`'zh-Hans'` / `'zh-TW'` 等语言包 id 一律回落 en（`src/client/index.ts` 的 `readLanguage` 与 `src/index.ts` 的 `resolveAppLanguage` 同口径）。DSH 内建仅 zh/en，当前无实际影响；**引入 zh-* 语言包前必须决策是否改前缀匹配**（改动面：两处映射 + `tests/i18n-locale-runtime.test.ts` 的 B1/B2 断言）。

---

## 附录 A　参考实现（§5 全部数字由这段代码跑出；口径即此代码）

用法（把下面整段存为 `i18n-scan.reference.mjs`，仓库根执行）：

```powershell
node i18n-scan.reference.mjs --group                    # 分组总览（§5 的表）
node i18n-scan.reference.mjs --byfile                   # 逐文件命中数
node i18n-scan.reference.mjs --scope src/client,src/ui  # 逐条 file:line + 摘录
node i18n-scan.reference.mjs --classes narrow           # 只算表意字（对照用）
node i18n-scan.reference.mjs --no-log-exempt            # 关掉 E2 豁免（对照用，看日志面有多大）
```

**t2 的 `tests/helpers/i18n-scan.ts` 必须与本实现等价**（允许重写为 TS、允许更好的词法处理；不允许语义偏离）。落地后按 §3.8 做基线比对。

```js

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

export const CJK_NARROW = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
export const CJK_BROAD = /[\u2E80-\u2EFF\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6]/;

const REGEX_PREV = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>']);
const KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await', 'delete', 'void', 'new']);

export function classify(src) {
  const n = src.length;
  const cls = new Array(n).fill('code');
  const stack = [];
  let i = 0;
  const cur = () => (stack.length ? stack[stack.length - 1] : null);
  const TICK = String.fromCharCode(96);
  while (i < n) {
    const st = cur();
    const c = src[i];
    if (st && st.s === 'line') { cls[i] = 'comment'; if (c === '\n') stack.pop(); i++; continue; }
    if (st && st.s === 'block') {
      cls[i] = 'comment';
      if (c === '*' && src[i + 1] === '/') { cls[i + 1] = 'comment'; stack.pop(); i += 2; continue; }
      i++; continue;
    }
    if (st && (st.s === 'sq' || st.s === 'dq')) {
      cls[i] = 'string';
      const q = st.s === 'sq' ? "'" : '"';
      if (c === '\\') { if (i + 1 < n) cls[i + 1] = 'string'; i += 2; continue; }
      if (c === q || c === '\n') stack.pop();
      i++; continue;
    }
    if (st && st.s === 'tpl') {
      cls[i] = 'string';
      if (c === '\\') { if (i + 1 < n) cls[i + 1] = 'string'; i += 2; continue; }
      if (c === TICK) { stack.pop(); i++; continue; }
      if (c === '$' && src[i + 1] === '{') { cls[i] = 'string'; cls[i + 1] = 'string'; stack.push({ s: 'code', depth: 0, fromTpl: true }); i += 2; continue; }
      i++; continue;
    }
    if (st && st.s === 're') {
      cls[i] = 'string';
      if (c === '\\') { if (i + 1 < n) cls[i + 1] = 'string'; i += 2; continue; }
      if (c === '[') st.inClass = true;
      else if (c === ']') st.inClass = false;
      else if (c === '\n') { stack.pop(); i++; continue; }
      else if (c === '/' && !st.inClass) { stack.pop(); i++; continue; }
      i++; continue;
    }
    if (c === '/' && src[i + 1] === '/') { stack.push({ s: 'line' }); i += 2; continue; }
    if (c === '/' && src[i + 1] === '*') { stack.push({ s: 'block' }); i += 2; continue; }
    if (c === "'") { stack.push({ s: 'sq' }); i++; continue; }
    if (c === '"') { stack.push({ s: 'dq' }); i++; continue; }
    if (c === TICK) { stack.push({ s: 'tpl' }); i++; continue; }
    if (c === '/') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) j--;
      const prevChar = j >= 0 && cls[j] === 'code' ? src[j] : '';
      let k = j;
      while (k >= 0 && /[\w$]/.test(src[k])) k--;
      const word = src.slice(k + 1, j + 1);
      if (prevChar === '' || REGEX_PREV.has(prevChar) || KEYWORDS.has(word)) { stack.push({ s: 're', inClass: false }); i++; continue; }
    }
    if (st && st.fromTpl) {
      if (c === '{') st.depth++;
      else if (c === '}') { if (st.depth === 0) { stack.pop(); i++; continue; } st.depth--; }
    }
    i++;
  }
  return cls;
}

function matchParen(src, cls, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (cls[i] !== 'code') continue;
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return src.length;
}

export const LOG_CALLEE_RE = /(?:^|[^\w$])(?:[\w$]+\.)*(?:log\.(?:trace|debug|info|warn|error)|console(?:\.[a-z]+)?)$/;

function logArgRanges(src, cls, cjkOnly) {
  const ranges = [];
  const re = /\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = m.index;
    if (cls[open] !== 'code') continue;
    const head = src.slice(0, open).match(LOG_CALLEE_RE);
    if (!head) continue;
    ranges.push([open, matchParen(src, cls, open)]);
  }
  return ranges;
}

const ZH_IDS = ['uiZh', 'zh', 'syncZh', 'marketZh', 'recoveryZh', 'historyZh', 'gistZh', 's3Zh'];

function zhDictRanges(src, cls) {
  const ranges = [];
  for (const id of ZH_IDS) {
    const re = new RegExp('(?:^|[^\\w$.])' + id + '\\s*(?::[^=]*)?=\\s*\\{', 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
      const open = src.indexOf('{', m.index + m[0].length - 1);
      if (open < 0) continue;
      let depth = 0, end = src.length;
      for (let i = open; i < src.length; i++) {
        if (cls[i] !== 'code') continue;
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      ranges.push([open, end]);
    }
  }
  return ranges;
}

const inRanges = (idx, ranges) => ranges.some((r) => idx >= r[0] && idx <= r[1]);

/**
 * 命中单位 = 一个「字面量片段 × 行」：同一行内同一字面量只记 1 条。
 * 返回 { line, kind, chars, excerpt }。
 */
export function scanText(src, opts) {
  const o = opts || {};
  const cls = classify(src);
  const logRanges = o.exemptLog === false ? [] : logArgRanges(src, cls);
  const zhRanges = o.exemptCatalog === false ? [] : zhDictRanges(src, cls);
  const classes = o.classes === 'narrow' ? CJK_NARROW : CJK_BROAD;
  const n = src.length;
  const lineOf = new Int32Array(n + 1);
  { let ln = 1; for (let i = 0; i < n; i++) { lineOf[i] = ln; if (src[i] === '\n') ln++; } lineOf[n] = ln; }
  const litOf = new Int32Array(n + 1);
  { let id = 0; for (let i = 0; i < n; i++) { if (cls[i] === 'string' && (i === 0 || cls[i - 1] !== 'string')) id++; litOf[i] = id; } }
  const groups = new Map();
  const re = new RegExp(classes.source, 'gu');
  let m;
  while ((m = re.exec(src)) !== null) {
    const idx = m.index;
    if (cls[idx] === 'comment') continue;
    if (inRanges(idx, logRanges)) continue;
    if (inRanges(idx, zhRanges)) continue;
    const key = lineOf[idx] + '#' + litOf[idx];
    let g = groups.get(key);
    if (!g) { g = { line: lineOf[idx], kind: cls[idx] === 'string' ? 'literal' : 'code', chars: 0, first: idx, last: idx }; groups.set(key, g); }
    g.chars++;
    if (idx < g.first) g.first = idx;
    if (idx > g.last) g.last = idx;
  }
  return [...groups.values()].map((g) => {
    const excerpt = src.slice(g.first, Math.min(src.length, g.last + 1)).replace(/\s+/g, ' ').trim().slice(0, 160);
    return { line: g.line, kind: g.kind, chars: g.chars, excerpt };
  });
}

export const SCAN_ROOTS = ['src'];
export const EXCLUDE_FILE_RE = /\.(test|spec)\.tsx?$/;
export const EXCLUDE_PREFIX = ['src/cli/'];
export const WHOLE_FILE_ZH_EXEMPT = ['locale/zh.json'];

const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'dist', 'outputs', '.tmp', '.agent-teams', 'fixtures']);

export function walkDir(root, out) {
  for (const name of readdirSync(root)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(root, name);
    const st = statSync(full);
    if (st.isDirectory()) walkDir(full, out);
    else if (/\.(ts|tsx|json)$/.test(name)) out.push(full.split(sep).join('/'));
  }
}

export function listScanFiles(extra) {
  const out = [];
  for (const r of SCAN_ROOTS) walkDir(r, out);
  for (const f of extra || []) out.push(f);
  return out
    .filter((p) => !EXCLUDE_FILE_RE.test(p))
    .filter((p) => !EXCLUDE_PREFIX.some((x) => p.startsWith(x)))
    .sort();
}

export function scanFile(rel, opts) {
  if (WHOLE_FILE_ZH_EXEMPT.includes(rel)) return [];
  const src = readFileSync(rel, 'utf8').replace(/\r\n/g, '\n');
  return scanText(src, opts).map((h) => ({ file: rel, line: h.line, kind: h.kind, chars: h.chars, excerpt: h.excerpt }));
}

export function scanAll(opts) {
  const files = listScanFiles(opts && opts.extra);
  const scoped = opts && opts.scope && opts.scope.length
    ? files.filter((f) => opts.scope.some((s) => f === s || f.startsWith(s.endsWith('/') ? s : s + '/')))
    : files;
  const hits = [];
  for (const f of scoped) hits.push(...scanFile(f, opts));
  return { files: scoped, hits };
}

const GROUPS = [
  ['G1 foundation (t2)', ['src/index.ts', 'src/ui/i18n.ts', 'src/core/messages.ts', 'locale/']],
  ['G2 impl-ui (t3)', ['src/client/', 'src/ui/']],
  ['G3 impl-core (t4)', ['src/core/', 'src/migrations/']],
  ['G4 impl-data (t5)', ['src/market/', 'src/utils/']],
  ['G5 impl-flow (t6)', ['src/sync/', 'src/routes/', 'src/adapters/', 'src/foreign/']],
  ['G6 impl-infra (t7)', ['src/security/', 'src/schema/', 'src/profiles/']],
];

function main() {
  const args = process.argv.slice(2);
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const scope = (get('--scope') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const classes = get('--classes') || 'broad';
  const opts = { scope, classes, extra: ['locale/en.json', 'locale/zh.json'], exemptLog: !args.includes('--no-log-exempt') };
  const { files, hits } = scanAll(opts);
  const byFile = new Map();
  for (const h of hits) byFile.set(h.file, (byFile.get(h.file) || 0) + 1);
  console.log('classes=' + classes + ' files=' + files.length + ' hits=' + hits.length + ' filesWithHits=' + byFile.size);
  if (args.includes('--group')) {
    for (const [name, prefixes] of GROUPS) {
      const g = hits.filter((h) => prefixes.some((p) => h.file === p || h.file.startsWith(p)));
      const gf = new Set(g.map((h) => h.file));
      console.log(name.padEnd(20) + ' hits=' + String(g.length).padStart(5) + '  files=' + String(gf.size).padStart(4));
    }
    return;
  }
  if (args.includes('--byfile')) {
    for (const f of [...byFile.keys()].sort((a, b) => byFile.get(b) - byFile.get(a))) console.log(String(byFile.get(f)).padStart(4) + '  ' + f);
    return;
  }
  if (args.includes('--json')) { console.log(JSON.stringify(hits, null, 1)); return; }
  for (const h of hits) console.log(h.file + ':' + h.line + ' [' + h.kind + '] ' + h.excerpt);
}

if (process.argv[1] && process.argv[1].endsWith('i18n-scan.reference.mjs')) main();

```

---

## 附录 B　本次取证用到的命令与产物（可重放）

| 用途 | 命令 / 路径 |
|---|---|
| 现测扫描内核 | 附录 A（本次落在 `.tmp/i18n-evidence/i18n-scan.reference.mjs`） |
| 分组 / 逐文件统计 | `node .tmp/i18n-evidence/i18n-scan.reference.mjs --group` / `--byfile` |
| en 目录体检 | `node .tmp/i18n-evidence/i18n-scan.reference.mjs --scope "<7 本字典 + locale/en.json>"` |
| 字典键数重数 | `DEVELOPERS.md` §i18n 的 node 一行命令（§5.7 输出） |
| 已发布产物取证 | `npm pack dsh-config-manager@0.1.71 --pack-destination <dir>` → `tar -xzf` → grep `package/lib/client.js` / `package/lib/index.js` |
| 同版本源码取证 | `git show v0.1.71:src/client/index.ts` / `git show v0.1.71:src/index.ts` |
| DSH 官方 locale 语义取证 | `D:\Apps\DSH\resources\app.asar` → `dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js`（`getLocale` / `subscribe` / `setLocale` / `bind` 注释与实现） |

**契约自评（供 t9/t10 复核）**：

- 可机械判定？是：A1–A5 五条全部是「命令 + 退出码」，无主观项；缺陷数字逐文件列出且可由附录 A 复现。
- 会不会误判？已把两类最容易误判的写法钉在文档里：① 注释/日志里的中文（E1/E2：**逐字符**计数是 10364 个 CJK 字符，按 §3.3-3 的「字面量 × 行」命中单位、扣掉注释与日志实参后是 **1180 条**命中）；② 「中文是不是用户可见」的边界（§2.2 每条理由 + §3.5 白名单的可核验理由 + 允许用于 `throw new Error` 的错误文本，因为 `src/routes/kit.ts:113` 原样回浏览器）。
- 有没有漏面？扫描集覆盖 `src/**` 全部非 CLI 非测试文件 + `locale/*.json`；124 个命中文件 100% 落在 6 个作用域内（实测无未归属）。
- 有没有做不到的验收？A4 依赖既有 zh 文案逐字不变，这是本契约唯一对实现者的**语义**要求，其余都是机械规则。



## 附录：AGENTS.md §i18n 原文（2026-10-10 下移，逐字）

### i18n
- i18n：**禁止硬编码用户可见字符串**；文案进字典，`src/ui/` 走 `UiT`（活翻译器 `liveUiT` / `makeLiveUiT`），React 壳走 `t()`（`ConfigManagerKey` 编译校验，zh 源 / en 镜像），宿主 / 引擎走 `engineMsg`（`src/core/engine-locale.ts`：活语言 + 各域目录经 `registerMessageCatalog` 并入）。**语言在「取文案那一刻」解析**，不得在装配期快照（`makeUiT(...)` / `makeMsg(...)` 出现在 `apply()` 里即缺陷）。
- **新增用户可见文案必须进目录**：zh 逐字保留、en 补齐；既有键的 zh/en 指纹冻结在 `src/core/engine-locale.test.ts`（只许追加，改既有键即红）。**静态守卫**：全量 `node --test tests/i18n-hardcoded-guard.test.ts`（退出码 0 = 全仓零命中）；作用域自检 `$env:DCM_I18N_GUARD_SCOPE='src/client,src/ui'; node --test tests/i18n-hardcoded-guard.test.ts`（只收窄文件列表，退出码 0 = 本作用域零命中）。扫描集 = `src/**`（−`src/cli/**` −`*.test.ts` −`fixtures/**`）+ `locale/*.json`；注释 / `log.*`·`console.*` 实参 / 目录 zh 区豁免；白名单 4 条 128 命中（已登记的非渲染匹配文本，**新增豁免只能走 captain** → `tests/helpers/i18n-scan.ts`）。
- **7 套字典的对照表与「查不到 key 不等于缺陷」的排查姿势见 `DEVELOPERS.md`——那一段极易误判，漏读会产出 600+ 假阳性。**
