# 已知硬限制

这里记的是**当前架构下做不到**或**做了会出事故**的事，不是待办。写进来看的目的是：下一个 agent 不要在同一个方向重试三遍。

- 最后核对：2026-10-23

## 1. 凭据值无法回滚
DSH 不回读已写入的凭据明文，插件也无法凭 ref 反查值。因此「导入/导出后把凭据恢复成原样」在值层面不可实现；
能做的只有：值有无的判定、引用槽位的一致性、以及失败时如实报告。任何「备份里的凭据能还原成历史版本」的说法都是错的。

## 2. 插件安装/卸载需要重启才生效
> **类型：平台行为判断（仓内不可证）**。可用 `dsh-plugin-*` 观察，但本仓库没有测试覆盖宿主加载行为。

运行中的宿主不会热加载插件目录变化。因此导入报告里的「已安装」是**磁盘事实**，不是「当前进程已生效」；
界面必须说明「重启后生效」，自动化流程不得假装已经生效。

## 3. MCP 没有管理 API
只能靠组合 patch 行导入（见 `docs/lessons/` 对应域）。因此 MCP 分区的导入是「合并一段 YAML」，不是「调用宿主 API 注册服务器」；
冲突只能按行合并 + 显式提示，不能靠宿主兜底。

## 4. 浏览器侧界面状态（localStorage）不随迁移搬走
> **类型：设计约束（有意为之，非缺陷）**。

界面状态的三个载体，迁移行为**不一样**，不要混为一谈：

| 载体 | 内容 | 跨机器迁移？ |
|---|---|---|
| 磁盘 `ui-prefs.json` | 上次选择的同步通道等（`src/sync/ui-prefs.ts`，路由 `src/routes/sync.ts` 的 `/sync/ui-prefs`） | **会**：随 `self` 分区进备份/同步 |
| `sessionStorage` | 会话级草稿（导出/导入流程、表单值） | **不会**：由 `run-store.ts` 的 `toPersistedState()` **显式白名单**放行，默认拒绝；刷新可恢复、换机器不带走 |
| `localStorage` | 面板选择等纯浏览器侧 UI 状态 | **不会**：用户换机后看到默认页，而不是远端那台最后停留的页 |

只有最后一行是这条限制的内容，**有意的**：把浏览器侧 UI 状态塞进备份会让「恢复」意外改变界面。
**不是「已解禁」**：解禁要新增载体收集面 + 导入映射 + 迁移用例，并接受恢复时界面被改动。

## 5. 运行中的 DSH 不会重读会话日志
> **类型：平台行为判断（仓内不可证）**。2026-10-22 真机观察；本仓库能证明的只是「我们因此选了 fork + 归档」，证不了宿主行为本身。

宿主把活动会话缓存在内存里；离开再回来、整页刷新都不重读磁盘，平台也没有 drop/reload API。
⇒ **就地截断会话日志不可能对当前会话生效**。回退只能 fork + 归档（见 `docs/decisions/0004-rollback-point-fork-archive.md`）。

## 6. gist 端点不接受任何条件请求头
> **类型：外部服务行为 + 平台判断（仓内不可证）**；实证是 2026-08-11 的 issue #110 复现（见 `docs/lessons/sync-channel.md`），不是本仓库测试。

任何 `If-Match`/`If-None-Match`/`If-Modified-Since`/`If-Unmodified-Since` 都会被回 400。
⇒ gist 通道无法做条件写，只能「写后复核 + 有界重做（≤3 轮，冲突抛 index-conflict）」缓解。
**残余窗口关不上**：别人恰好在你「重读索引」和「PATCH」之间写入的条目仍会被整体覆盖（被覆盖的只是索引条目，载荷文件不丢，可从历史入口找回）。

## 7. DSH 的 cookie 认证不覆盖本插件的 exact 路由
> **类型**：前半句（DSH 的 cookie 策略）是**平台行为判断**，属宿主代码、仓内不可证；后半句（exact 表先命中）由 `tests/route/route-parity.test.ts` 钉住。

DSH 把 cookie 拒绝挂在 `kind:'prefix', path:'/api'` 的 RPC 承载路由上，而派发是 exact 表先命中。
⇒ 本插件 82 条路由的**唯一认证边界是 kit 的 loopback 围栏**。经代理/隧道暴露时必须另加认证，不能指望宿主。

## 8. 分区载荷版本只能「硬失败」，没有降级读取
读写器遇到不认识的载荷版本必须报错，而不是尽力解析：半解析的备份比拒绝更危险。
⇒ 兼容性策略是「新读旧可以，旧读新必须拒绝并提示升级插件」。

## 9. 加密容器必须先解锁才能进任何解析路径
ZIP 解析器面对加密容器只会给底层错误。所有接受归档的入口都必须先 `readContainerKind()` 判形态；
新增入口漏了这道闸门时，用户会看到「备份损坏」，而不是「请输入密码」。

## 10. 桌面端 `desktop` 档案是保留档案
启动/删除/改名一律以 `managedProfile` 拒绝；版本只能取 `profileContext.installAnchor`，不能按磁盘依赖树猜。

## 11. 插件自身是 bundle 包，隔离实例必须按 bundle 挂载
隔离实例里要生效，必须进 `dsh.profile.bundles`；直接拷 `node_modules` 不等于「已安装」。

## 12. 目标侧 realpath 围栏判不了硬链接
恢复前的目标侧防护用 `realpath` + 中间段解析挡 symlink/junction 写穿（`src/core/restore.ts` 的 `assertPlanTargetsSafe`）。
⇒ **同卷硬链接到 home 之外的路径拦不住**（硬链接没有可解析的跳转层）；UNC 路径、8.3 短名、大小写不敏感的卷也**未实测**，不能声称已覆盖。

## 13. 恢复崩溃后能续跑，但只在「能逐项证明」的前提下
恢复会逐动作写 journal step（预登记 + 完成后更新指纹，`src/core/restore-wal.ts`），所以崩溃后 reconcile 能判出
「全部完成（recovered）/ 部分完成（needs-attention）/ 一个都没动」。再点一次恢复会先跑 `judgeRestoreResume`（`src/core/restore-resume.ts`）：
同操作类型 + 同快照 + 计划与 step 一一对应 + 每个目标盘面只能等于 beforeFp 或 afterFp + 无回滚痕迹/失败项/外部副作用，成立才**接着做**。
⇒ 只要有一条不成立（典型：目标文件被用户改过、含插件卸载、是别的入口创建的 journal），仍然退回 423 `transaction-recovery-required`，
必须人工 reconcile —— 不存在「无条件接着做」。三个入口只续跑**自己**的 operationType（GUI `restore` / CLI `cli-restore` / model `model-restore`）。

## 14. 插件卸载是不可自证的外部副作用
`pluginRemove` 记 `external=true` 且不带指纹（`dsh plugin remove` 可能只改 package.json、未 prune node_modules）。
⇒ 恢复里只要出现插件卸载，崩溃后 reconcile 一律给 needs-attention，**不会**判 recovered —— 这是刻意的保守，不是缺陷。

## 15. 审计侧的两个「看似能做其实不能」
- **不能从文件名推断模块职责**：本仓库有多个「名字像 X、实现是 Y」的历史文件（例如 `core/rollback.ts` 是导入补偿引擎，不是回滚点引擎）。
- **不能把设计文档当实现**：`docs/design/` 是上游设计存档，可能早于实现；判断行为一律读代码 + 跑测试。