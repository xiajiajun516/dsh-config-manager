# docs/lessons/ — AGENTS.md 的经验/证据库

> **规则在 `AGENTS.md`；这里只放「为什么」**：真机事故经过、量化数据、复现步骤、复核脚本、历史沿革。
> 条目的骨架来自 `AGENTS.md` 下移时的原文，之后按需在规则之外**补真机成因、量化数据与复现锚点**（因此个别小节的篇幅远大于对应规则）；`##` 小节按域分组，不保证与 `AGENTS.md` 小节一一对应。
> 例外 ①：`docs/lessons/known-pitfalls.md` 是 2026-09/10 更早一次下移的**冻结存档**（不再追加）。
> 例外 ②：`repo-overview.md` 是按「AGENTS.md 只收硬规则」下移的**非规则参考材料**（概览 / 目录结构 / 常用命令 / 本机环境注意 / UI 自查清单），不是经验或证据。

| 域文件 | 收录内容 | 对应 `AGENTS.md` 小节（`## Rules` 下） |
| --- | --- | --- |
| `git-and-release.md` | git 同步 origin / 删文件前 git status / 禁用 checkout -- 回滚 / LF↔CRLF / pnpm 发布年龄 / CI 平台矩阵与 tests 类型检查 | 通用（任何改动） |
| `profiles-and-instances.md` | profile 语义 / desktop 独占 / 复制档案 relink 与中断残留 / 隔离实例挂载 bundles / cordis.patch.yml !!js / pnpm 同树布局 | Profile / 插件数据 / 打包 |
| `foreign-import.md` | 外部来源迁移：三处「文档说支持、代码没有」/ 插件≠目录拷贝的三条证据 / 会话字节幂等 / 「写了没接线」/ 静默截断修复 / 真值表护栏缺失 / 本机 Claude Code 实测形态 | 会话 / 导入导出 / 外部来源 |
| `sessions-import-export.md` | 会话日志字节改写 / 可见性来源 / 子代理父子 / 排序时间 / 前缀映射 / recursive-walk / 归档缓存与预览同口径 / 格式版本体检落点 | 会话 / 导入导出 / 外部来源、架构与路由（只读预览与导出同口径） |
| `sessions-repair-diagnostics.md` | v0 打包行 / 检测口径 G-24 / 复核门与 catalog / 外部来源合成行 / 面板侧写路径 / 两侧诚实 / codec 锚点链 / 格式版本「按目标机写」 | 会话 / 导入导出 / 外部来源 |
| `security-and-credentials.md` | 凭据计划项「值的有无」/ 加密载荷 / 批量按钮 / 磁盘清理候选集 / DCA1 形态判定 / SAFE MODE / 值形状 G-36 / Secret 默认不导出 / sessionStorage 白名单 | 安全不变量（不得破坏）、备份 / 恢复 / 回滚点 |
| `sync-channel.md` | 同步分区逐分区放行 / 会话管理五条语义 / 只读端点无界挂起与首页骨架（2026-10 真机） | 同步（`src/sync/`）、安全不变量；对外契约见 `docs/spec/sync-channel-v1.md` |
| `recovery-console.md` | CLI 与救急台同门 / 灾备下线 / 救援模式与 reconcileBundles / 离线救急台 token 边界 / 聊天流用户消息的接管与换代适配 | 备份 / 恢复 / 回滚点、UI |
| `packaging-and-bundle.md` | bundle 是 cjs / 自包含护栏 / issue #57–#60 四条的真机成因 / MemFs | Profile / 插件数据 / 打包、架构与路由 |
| `plugin-data-migration.md` | 第三方插件数据目录的位置取证与收录口径 / 区域相对排除 / 声明缓存按 home 键 / 目录形态判定 / 离线 CLI 为何不收集 | Profile / 插件数据 / 打包 |
| `ui-design-system.md` | **原生设计资源取证方法**（asar 最小解析器 / 411 个 `--dsw-*` 定义集与引用集做差）/ 坑：`--dsw-alias-state-info-primary` 不存在导致 `--cm-info` 静默失效 / 刻意保留的偏离（12.5px 正文等）/ 无真机时的视觉核验方法 | UI（样式权威仍是 `DESIGN.md`） |
| `repo-overview.md` | **非规则参考**（2026-10-14 下移）：用途与技术栈 / 目录结构 / 常用命令 / 本机环境注意 / UI 自查清单 | 通用（任何改动）—— 验证顺序与环境注意的落地材料 |

## 约定

1. **只写证据**：事故经过、量化数字、复现与复核脚本、历史沿革；规则（必须/绝不 + 判据）写回 `AGENTS.md` 对应小节，并在那里留指针。**反向也成立**：任何从 `AGENTS.md` 下移的非规则材料（说明 / 清单 / 流程 / 示例）进本目录 —— AGENTS.md 只留一行指针。
2. **新增一条坑的顺序**：本目录写透 → `AGENTS.md` 补一行规则 + 指针；**不要把证据写回 AGENTS.md**（守卫 `node scripts/check-agents-budget.mjs` 会拦）。
3. 文件名 kebab-case，一个域一个文件；跨域内容放最相关的一处，别复制两份。
4. 域文件按主题命名而不是按日期；带日期的事故记录写在小节标题里（如 `（2026-10-07 真机事故）`）。
