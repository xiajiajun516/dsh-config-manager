# Agent 工具面（model tools）

> 这份文档钉住三件事：**agent 现在能调哪些工具**、**哪些能力永久不对 agent 开放**、**新增工具必须满足什么**。
> 判据一律落在代码上（文件:行）；与代码冲突以代码为准，并当轮修本文。
> 相关：`docs/contracts/compat-matrix.md`（R5 兼容风险）、`docs/architecture/sync.md`（分区放行）、`docs/contracts/bundle-format-v1.md`（`redactedHits` 出口）。

## 1. 工具面一览（9 个）

唯一注册点：`src/core/model-tools.ts`；装配点在 `src/routes/model-tools-deps.ts` 的 `createAgentToolDeps()`
（`src/index.ts` 的 `apply()` 只留 `registerModelTools(ctx, agentToolDeps)` 一行 —— `index.ts` 有体量棘轮，装配不再写在调用点）。
服务守卫：`src/core/model-tools.ts:843` 的 `ctx.get('tools')` —— 服务缺失记一条 warn 并 return，**绝不用 `ctx.tools` 属性访问**（Cordis 未声明 `inject` 时即便服务存在也会抛错，注释见 `:850-853`）。

| 工具 | 作用 | 读/写 | 范围 | 门禁与证据 |
| --- | --- | --- | --- | --- |
| `config_backup` | 导出配置 ZIP 到宿主导出的目录 | 写（本地磁盘） | 分区由 `only` 决定，缺省全量；**恒不含凭据值** | `runWithMutationLock('model-backup')`；`includeSecrets: false` 硬编码（`model-tools.ts:378` 附近调用 `Exporter.export`） |
| `config_list_snapshots` | 列出本地回滚快照 | 只读 | 快照目录 | `isConcurrencySafe: () => true`（`:888`） |
| `config_restore` | 预览/执行快照恢复 | 写（不可逆） | 单个快照 | `confirm:true` **必须带预览返回的 `planId`**；缺 → `plan-required`，不符 → `plan-changed`（`model-tools.ts:450-482`），锁内按当前盘面重算再比一次（`:496-511`）；op `model-restore` 仍是唯一能自动续跑 `model-restore` 日志的入口 |
| `config_sync_push` | 手动推送同步（写远端） | 写（本地 + 远端） | 通道 `git`/`webdav`/`gist`/`s3`；分区为 portable + `'auto'` 档可选分区 | `includeSecrets:true` → `include-secrets-forbidden`（`:543-550`，连引擎都不构造）；加密密码**先读 DSH 凭据槽**、入参 `password` 仅兼容（`:556-566`，返回 `passwordSource`）；op `model-sync-push` |
| `config_sync_pull` | 拉取差异预览（零写入） | 只读 | 同上 | `isConcurrencySafe`（`:994`）；解密密码同样槽位优先（`:609`） |
| `config_sync_preview` | 三方合并预览 + `planId` | 只读 | 同上，**分区 = 用户放行的 `'auto'` 档 − `sessions`** | `agentOptInSections()`（`model-tools.ts:641`）；不下发 `localPreview`/`remotePreview`/`ancestorPreview`；`isConcurrencySafe`（`:1124` 同款） |
| `config_sync_apply` | 落地三方合并 | 写（本地 + 远端索引） | 同上 | 必须带 `planId`；锁内重跑预览比指纹（`:702-712`）；op `model-sync-apply`；未知分区 id 只记进 `ignoredResolutions`，不写盘 |
| `config_import_plan` | 生成导入计划（零写入） | 只读 | **受控根内的 ZIP** | `isControlledZipPath()`（roots 缺失即 fail-closed）；加密归档 → `encrypted-archive`（解密要走 GUI）；`isConcurrencySafe`（`:1124`） |
| `config_import_apply` | 执行导入计划 | 写（不可逆，带补偿回滚） | 同上 | `confirm:true` + `planId`；重放决策重建计划比指纹（`:819-822`）；op `model-import-apply`；不接受 `secretInputs`/`decryptedCredentials` |

失败一律返回结构化 `{ ok:false, code, message, retryable, nextAction }`（`ModelToolFailure`，`model-tools.ts` helper 区），不是裸 `throw` —— 模型能据此决定「重新预览 / 去配密码 / 换路径 / 别再试」。

## 2. 三条硬边界

1. **凭据值永不上行**：`includeSecrets` 参数保留只为给出可读拒绝；引擎侧恒 `includeSecrets: false`。凭据值无法回滚（DSH 不回读），一旦上行就再也收不回来。
2. **密码只从凭据槽读**：`DSH_CONFIG_MANAGER_SYNC_<ENCRYPT|DECRYPT>_PASSWORD_<CHANNEL>`（`src/routes/route-support.ts:75`）。工具入参 `password` 会进会话历史，故标 deprecated、只在槽位为空时兜底。
3. **预览与执行同指纹**：`planId` = 服务端从**当前盘面**重算出的计划指纹（`src/core/restore-plan-fingerprint.ts`、`src/core/model-tool-plans.ts`）。这是 GUI 恢复路由 409 `plan-changed` 的模型面等价物（`src/routes/snapshots.ts:128`）。
   句柄表是**进程内存**的：TTL 30 分钟、上限 8 条、payload 只放重放材料（快照 id / 通道 / ZIP 路径 / 决策 JSON），绝不存密码或明文。

## 3. 与 HTTP / GUI 的口径差

- **分区放行**：agent 只按 `'auto'` 档（`selectionOptInSections(channel, true)`，`src/index.ts:3925`），并在此之上永久剔除 `sessions`（`AGENT_EXCLUDED_SECTIONS`）。界面上勾了 mcp 也不等于 agent 会带上 sessions。
- **三侧预览文本不下发**：GUI 逐键对比用的分段文本既贵又含配置内容，工具只给 `{path, kind, reason?}` 与计数。
- **一键同步（`/sync/apply-items`）不开放**：它依赖 HTTP 会话里的 `syncSessionId`，agent 侧没有这个上下文；需要落地走 `config_sync_preview` + `config_sync_apply`。
- **导入执行不接受密码**：加密归档在 `config_import_plan` 就被拒，解密路径留在 GUI。

## 4. 永久不开放清单

以下能力**明确不对 agent 开放**，不是「还没做」。放开任一条都要先满足「准入条件」列，并在此表写下新的判据。

| 能力 | 现有入口（证据） | 保护的不变量 | 准入条件（若要放开） |
| --- | --- | --- | --- |
| 插件自更新执行 | `POST /update-apply`（`src/routes/prefs.ts:171`，mutation gate `plugin-update`） | 检查只读、绝不自动安装；非 registry 与 desktop 档案带码拒绝；成功后必须重启 | 不需要：这是用户在场决策，模型无法判断「现在能不能重启」 |
| 磁盘清理 / 快照删除 / 备份文件删除 | `POST /disk-usage/cleanup`（`src/routes/backup.ts:184`）、`POST /backup-files/delete`（`:268`）、`POST /snapshots/delete` | 不可逆：删掉的快照是回滚的唯一凭据；候选集只含可重建区 | 永不开放删除；只读 `disk-usage` 可考虑单开只读工具 |
| 会话内容上行/下行 | `sessions` 分区（`src/sync/sync-engine.ts:422` `FORBIDDEN_SECTIONS` 之外的 `'manual'` 档） | sessions 绝不悄悄上下行；导出会话连带工作区，且含对话正文 | 只允许用户逐次显式选择；agent 侧永久排除 |
| 会话导出 | `GET /session-export`（`src/routes/session-export.ts:268`） | 外传用户对话正文 = 不可撤回的数据出境 | 不开放 |
| 凭据分区明文（`secrets` / `credentialsStatus`） | `includeSecrets` 参数、`secrets` 分区 | 凭据值不回读/不落盘/不进响应 | 永久禁止 |
| 路径浏览 | `GET|POST /path-browse`（`src/routes/path-browse.ts:47`；GUI 调用点 `src/client/import/PathMappingForm.tsx:83` 是**原生目录选择**） | 原生选择器语义不可移植：agent 没有「用户正在看的那个目录」 | 不开放；agent 用显式 `zipPath` + 受控根判定 |
| 档案启停 | `POST /profiles/launch`（`src/routes/profiles.ts:93`）、`/profiles/stop`（`:232`） | 起真实子进程（30 秒上限）并改运行态；失败形态只有本机可见 | 需要进程可观测性 + 用户在场 |
| 市场与我的发布的写动作 | `src/routes/me.ts:54`（upload）、`src/routes/me.ts:89`（update）、`src/routes/me.ts:149`（delete）、`src/routes/me.ts:129`（relist）、`src/routes/market.ts:57`（refresh） | 对外发布是身份行为，且会外传用户配置 | 不开放 |
| 恢复控制台写动作（解除 SAFE MODE / reconcile） | `prefix /recovery`（`src/routes/recovery.ts:488`） | SAFE MODE 的解除判据只有 `resolveSafeMode`，有未解决 incident 必拒；误解除会把半成品盘面当健康 | 不开放；只读诊断可单开 |

## 5. 新增 / 修改工具的准入清单

1. **只读优先**：只读工具必须声明 `isConcurrencySafe: () => true`，且真的零写入（测试断言盘面不变）。
2. **写操作三段式**：`预览返回 planId` → `执行必须带 planId` → `锁内重算比对`。三处缺一不可（否则模型能把旧确认套到新盘面）。
3. **范围来自宿主，不来自模型**：分区放行、受控根、通道配置都从 `deps` 注入；模型传的参数只能**收窄**。
4. **失败形状统一**：`{ ok:false, code, retryable, nextAction }`；不要抛裸错误（模型读不到 `code` 就会乱猜重试）。
5. **返回面最小化**：不下发配置正文、凭据值、三侧预览文本、内部实现细节（`blobPath` 之类不返回给模型）。
6. **敏感面单独设计**：任何可能外传凭据/会话/用户数据的工具，必须先写清风险与门禁，再进本文表。

## 6. 验证锚点

- `src/core/model-tools.test.ts` —— 9 个工具的编排与注册守卫（含 `plan-required`/`plan-changed`/`plan-expired`/`include-secrets-forbidden`/`sync-password-missing`/`path-not-controlled`/`confirm-required` 全码覆盖）
- `src/core/model-tool-plans.test.ts` —— 句柄 TTL/容量/幂等，三个指纹的「什么变了才算计划变了」
- `src/routes/snapshots.ts:128` + `tests/route/restore-route.test.ts` —— GUI 侧 409 与工具侧 `plan-changed` 同口径

