# 外部来源迁移（foreign import）

对应规则：`AGENTS.md` §📌 常见坑「外部来源迁移」。本文只写证据。

## 1. 三处「文档说支持、代码没有」（2026-10-18 审计，基线 865c4ef）

| 声称 | 代码实际 | 位置 |
|---|---|---|
| 位置可被 `CLAUDE_CONFIG_DIR` 整体替换，命中报 `source-location-overridden` | 全仓不读 env，只用 `path.join(home, '.claude')` | `read-claude-code.ts`（改前 :213,:216）；doc:219/387 |
| `isSidechain` 子代理会话按 `unsupported-session-record` 计报 | `isSidechain` 在 `src/foreign/*.ts` **零命中**；子代理记录是 `type=user/assistant + isSidechain:true` ⇒ 正文被静默混进父对话 | doc:89-90 |
| `~/.claude/{plugins,cache,...}` 归入「不做也不报」 | 实际是**一行代码都没有**（不是「刻意不做之后报了码」） | doc:56 |

教训：**文档里的「已支持」必须能在代码里指到具体分支**；否则它会在审计时以「与实现冲突」的形式暴露，而不是以「未实现」暴露。

## 2. 「插件目录复制成功」≠「插件能运行」

三条独立证据，任何一条都足以否掉「把 `.claude/plugins/**` 拷进 DSH 插件目录」的做法：

1. DSH（0.2.1-rc.2 `app.asar`）的 `evaluatePluginCompatibility` 会按 `engines.dsh` 或 `@deepseek-ai/dsh*` peer **拦截装载**（`dsh-app-boot` 的 bundle 装载点与 profile preflight 都会 deny），Claude 插件的 `plugin.json` 里没有这些字段；
2. `dsh-claude-compat`（v0.8.1，MIT）自己也不是「拷目录」：它读插件清单后在**运行时**注册 skills/commands/agents，
   并且它的 hooks 走 `/bin/sh -c`（`hooks.js`）——**打开不可信仓库即任意命令**；
3. DSH 官方桥接包 `dsh-hooks-claude-code` 在本机**未安装**（asar 内 `grep -c dsh-hooks` = 0），
   只有「被登记 + 有依赖声明 + 会话格式给 hook 事件预留了位置」，字段级映射**无法实证**。

因此本插件的处置是：**迁移能无损复用的组件（skills / MCP），插件本体逐条报码，绝不复制代码、绝不执行 hook**。

## 3. 「同内容 → Skip」要求会话产物**逐字节确定性**

- DSH 的文件类分区判重是**逐字节**比较（同路径同内容 → Skip，不同内容 → Conflict）。
- 改前：会话产物里 `createdAt/updatedAt` 的回落是 `Date.now()`（`claude-sessions.ts` 两处 → `session-ir.ts` 三处），
  且 parse 与 synthesize 各取一次墙钟 ⇒ **同一来源转码两次字节必然不同** ⇒ 重复导入恒判 Conflict。
- 改后：墙钟**只在 parse 时解析一次**，回落链 = 记录时间戳 → `input.createdAtMs` → 墙钟（并记账 `timestampsFallback`）；
  `createdAtMs` 由读盘层用**文件 mtime** 填。
- 复现：`src/foreign/claude-code.test.ts` t13（同一输入两次转码字节逐字相同）、`claude-sessions.test.ts`（`createdAtMs` 幂等）。

## 4. 「写好了但没接线」是本仓最容易复发的一类缺陷

2026-10-18 一次就抓到两处：

1. `TranscodeResult.findings`（新加的如实报码通道）没有一个调用方读它 —— `kernel.collectSessionSections` 只读 `skip` 与 `session.info.ignored`；
2. `ClaudeSessionInput.recordSessionId` / `createdAtMs`（契约层已冻结）在读盘层**从未被填** ——
   于是「sessionId 不一致报码」与「幂等回落」在生产路径上都是死代码。

教训：**契约字段与消费方必须成对落地**，并有一条**跨层**测试（读盘层产出 → 翻译层带出 → 结果可见）；
只测单层会让「字段加了但没人填 / 没人读」全绿。

## 5. 静默截断与静默跳过（本轮修复）

| 现象 | 改前 | 改后 |
|---|---|---|
| 会话文件数超过 500 | 直接 `break`，**零报码** | `source-unreadable` + detail `max-sessions-reached`，count = 上限 |
| 技能目录是符号链接 | `continue`，无声消失 | `source-unreadable` + detail `symlink-skipped`（origin = 包内相对标签） |
| 项目数触顶（新增 50） | —— | `source-unreadable` + detail `max-projects-reached` |
| `settings.json` 的 permissions / 其余顶层键 | 整段丢弃 | `unsupported-permissions` / `unsupported-settings-keys`（只记键名与条数，**值不读**） |

## 6. 真值表护栏曾「只在文档里存在」

`docs/design/2026-10-04-foreign-import-v1.md` §8.2 与 `truth-table.ts` 文件头都写「由 `truth-table.test.ts` 交叉核对」，
**但仓库里没有这个文件** ⇒ 6 个配置类来源的 `probePaths` 一直没有任何交叉核对。
2026-10-18 补上 `src/foreign/truth-table.test.ts`（V1–V5）。
教训：**「护栏存在」本身也要有护栏** —— 文档提到某个守卫文件时，同轮把它建出来，或改成不写。

## 7. 本机 Claude Code 实测形态（2026-10-18，只记录结构与键名）

- `~/.claude`：`skills/`（7 个）、`hooks/<名>/*.cjs|ps1`、`plugins/known_marketplaces.json`、`plugins/marketplaces/<市场>/{.claude-plugin/{marketplace.json,plugin.json},plugins/,external_plugins/}`；`agents/`、`commands/`、`rules/` **不存在**。
- `~/.claude.json`：顶层 `mcpServers`、`lastVersionBase`、`projects`（键 = 项目绝对路径，2 个；每项含 `mcpServers`/`allowedTools`/`enabledMcpjsonServers`…）。
- `~/.claude/settings.json` 顶层键：`env`、`includeCoAuthoredBy`、`theme`、`hooks`（`PreToolUse`/`PostToolUse`）；`enabledPlugins` **缺失** ⇒ 0 个启用插件（所以插件分支本机只能靠夹具取证）。
- 项目级 `<root>/.claude/settings.local.json` 顶层键：`permissions`。
- 官方 marketplace 的 `marketplace.json` 顶层：`{$schema,name,description,owner,plugins[]}`，plugin 项字段 `name/description/author/category/source{source,url,path,ref,sha}/homepage`（本机 255 项）。
- 插件目录：`.claude-plugin/plugin.json`（`name/description/author`）+ `commands/`/`skills/`/`agents/`/`hooks/`/`.mcp.json`；`.mcp.json` 形如 `{ "<server>": { type, url, headers } }` —— **headers 里可能是真凭据**（实测 github 插件就是 `Authorization`）。
