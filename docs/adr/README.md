# docs/adr/ — 架构决策记录

短、少、只记「**当初为什么这样**」。一条决策一份，编号不复用。

| 编号 | 决策 |
|---|---|
| `0001-route-fence-and-auth-boundary.md` | 路由只经 kit 声明；围栏即认证边界 |
| `0002-encrypted-container-unlock-gate.md` | 未解锁容器不得进解析器 |
| `0003-sync-conditional-write-and-gist-exception.md` | 条件写；gist 是明确例外（写后复核 + 有界重做） |
| `0004-rollback-point-fork-archive.md` | 回退 = fork + 归档；回滚点 = 两态 + 内容寻址台账 |
| `0005-safe-mode-fail-closed.md` | SAFE MODE fail-closed，解除判据只有一份 |
| `0006-restore-auto-resume.md` | 恢复崩溃后续跑：逐项可证才续，三入口不跨续 |

## 加一条

`NNNN-短横线标题.md`（四位编号，下一条 = 现有最大 + 1），文首写状态：**已采纳 / 待决策 / 已废弃**。
只写：上下文 → 决策 → 后果（含代价）。不写实现步骤（那是 `docs/architecture/`），不写证据数据（那是 `docs/evidence/`）。

## 不变量

- 不改历史判断：决策变了就新开一条，并把旧条目标「已被 NNNN 取代」。
- 文件名不加 `adr-` 前缀（目录已表意）；引用直接写 `docs/adr/` 加四位编号（如 0004），不要写成目录名 + 省略号。
