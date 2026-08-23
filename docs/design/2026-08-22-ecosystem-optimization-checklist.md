# dsh-config-manager 生态优化清单

> 日期：2026-08-22；更新：2026-08-23（P0-1/P0-2/P0-3 全部完成）
> 背景：调研 DSH 插件生态（beancookie/awesome-dsh-plugin、SihanTeng/awesome-deepseek-harness-plugins、awesome-dsh-plugin/awesome-dsh-plugin 三大榜单），对照本插件源码（v0.1.45，~2.65 万行）产出的优化行动清单。
> 状态：**三个 P0 均已完成**（P0-3 于 2026-08-23 收尾，npm test 1010/1010 绿灯）。

---

## 一、现状与定位结论

- **赛道护城河成立**：本插件是 DSH 生态里唯一做「全配置备份 + Git/WebDAV 同步 + 配置内容市场」的综合体。生态的备份/回滚类插件（says693/dsh-log-memory、azure5100/huahua-dsh-plugin-orchestra、crTnT/dsh-plugin-updater、cynch18/plugin-switch）都只覆盖单点。
- **安全已是第一梯队**：AES-256-GCM 加密备份/同步、BANNED_MARKET_SECTIONS + 秘密扫描 + 恒展示供应链警示。
- **CLI 零运行时依赖**是生态稀缺优点（reinstall/restore 只靠 node 内置 + core 引擎）。

---

## 二、待办清单（三个 P0 全部完成 ✅）

### ✅ P0-1 注册 Agent 可调用的模型工具（已完成 2026-08-22）
> 交付：`src/core/model-tools.ts`（createModelTools 纯编排 + registerModelTools defineTool 薄壳）+ `src/core/model-tools.test.ts`（9 用例）+ `src/index.ts` 接线（makeRoutes 返回 makeSyncEngine；apply() 调 registerModelTools）。

- [x] 设计工具契约：`config_backup` / `config_sync_push` / `config_sync_pull` / `config_list_snapshots` / `config_restore`（dry-run 预览 + confirm 门控）
- [x] host 半注册，复用 `src/core` 引擎（Exporter / SyncEngine / listSnapshots / planRestore / restore）
- [x] 安全不变量：secret 不回读/不落日志；restore 唯一危险写操作须 confirm:true；快照 id 防路径穿越（`assertValidSnapshotId`）
- [x] 输出 schema 统一 `type:'json'` 与 execute 返回 `JsonValue` 对齐；`ctx.get('tools')` 可选守卫（未组合 tools 的部署不注册不崩溃）
- [x] 9 个单测（backup 真实 ZIP+非敏感摘要 / listSnapshots 倒序+损坏跳过 / restore 门控+非法 id / sync push/pull 内存 transport / 注册层）

### ✅ P0-2 进入旗舰榜单（已完成 2026-08-23）
> PR：[beancookie/awesome-dsh-plugin#106](https://github.com/beancookie/awesome-dsh-plugin/pull/106)（Tools & Capabilities 分类，双 README 各加一行）。

- [x] 核对收录条件：`dsh-plugin` topic ✅、`dsh.bundle` manifest ✅、MIT ✅、npm 发布 ✅、活跃维护 ✅
- [x] 修正认知：beancookie 榜单收录 = 直接改 `README.en.md` + `README.md` 各加一行（**不是** data/plugins 目录——那是 awesome-dsh-plugin 的结构）
- [x] 描述突出「全配置备份+迁移+同步+加密+配置市场」广度，与同分类竞品（dsh-backup/dsh-market）区分
- [x] `node scripts/check-order.mjs` 离线校验通过（order OK）

### ✅ P0-3 定时备份/同步接入编排层（已完成 2026-08-23）
> 交付：`src/sync/backup-scheduler.ts` + `src/sync/backup-schedule-config.ts` + `src/sync/backup-scheduler.test.ts`（7 用例）+ `src/index.ts` 接线 + self 分区白名单加 `sync/backup-schedule.json`。

- [x] 宿主侧 `BackupScheduler`：按固定间隔（6h/12h/24h/7d）全量备份，start/stop/reload/runOnce + 启动触发阈值 + runs 防重
- [x] 安全设计：**定时备份恒 `includeSecrets=false` 且不加密**（加密密码仅内存不能持久化，与自动同步同语义；要加密备份走手动导出）
- [x] 配置持久化 `sync/backup-schedule.json`（原子写，损坏回退缺省）；随 self 分区备份迁移
- [x] `RunKind` 扩展 `'backup-schedule'` + `RunConflictError` 分支（并行线同步合入）
- [x] 外部调度层（dsh-automation cron / 任务看板）可直接调 `runOnce()`，或复用 P0-1 的 `config_backup` 模型工具在 agent 会话内驱动
- [x] README 卖点待补：将「内置定时全量备份」加入 README 亮点（下一步）

---

## 三、验证状态

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 0 错误 |
| `npm test` | ✅ 1010/1010（含新增 model-tools 9 + backup-scheduler 7） |
| `npm run build` | ✅ 成功 |

注：并行开发线（导入执行日志面板）曾整文件覆盖/删除本会话改动（untracked 文件被 git clean、index.ts 接线被 checkout 覆盖三次），已按「edit/write 后立即 git diff 验证」教训处理；其 wip 期间 typecheck 红灯已自行修复合入。

---

## 四、保持不动（已做得好）

- [x] 加密与供应链安全（AES-256-GCM、BANNED sections、secret 扫描、恒展示警示）
- [x] CLI 零运行时依赖（reinstall/restore）
- [x] E2E 加密同步（snapshot-crypto）

---

## 五、参考对比项

| 生态插件 | 与本文档的关联 |
|---|---|
| [says693/dsh-log-memory](https://github.com/says693/dsh-log-memory) | 会话日志增量备份，对应本插件 `sessions` 分区 |
| [azure5100/huahua-dsh-plugin-orchestra](https://github.com/azure5100/huahua-dsh-plugin-orchestra) | 插件清单级 backup/rollback + crash recovery |
| [cynch18/plugin-switch](https://github.com/cynch18/plugin-switch) | 插件启用/禁用 + backup |
| [crTnT/dsh-plugin-updater](https://github.com/crTnT/dsh-plugin-updater) | 插件更新 backup/rollback |
| [863683348/dsh-feed](https://github.com/863683348/dsh-feed) | 数据层被 **model tools** 查询（P0-1 参照） |
| [1e0zj/dsh-plugin-mall](https://github.com/1e0zj/dsh-plugin-mall) | 带「five agent tools for headless use」（P0-1 参照） |
| [dsh-automation](https://github.com/titanwings/dsh-automation) / [dsh-task-board](https://github.com/DamonKoy/dsh-web-ui) | cron/任务看板调度层（P0-3 参照） |
| [xiaoyuyu6420/dsh-backup](https://github.com/xiaoyuyu6420/dsh-backup) | 竞品：一键备份 + 定时自动备份（P0-2 同分类） |

---

## 六、榜单来源
- [beancookie/awesome-dsh-plugin](https://github.com/beancookie/awesome-dsh-plugin)
- [SihanTeng/awesome-deepseek-harness-plugins](https://github.com/SihanTeng/awesome-deepseek-harness-plugins)
- [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
