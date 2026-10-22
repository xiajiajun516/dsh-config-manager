# ADR-0005：SAFE MODE 必须 fail-closed，且解除判据只有一份

- 状态：已采纳（Accepted）
- 日期：2026-10-22（记录既有决策）

## 背景

插件会改用户 `$DSH_HOME` 与会话日志。一旦上一次操作留下「半截状态」或用户主动踩了闸，继续写就是二次伤害。
所以需要 SAFE MODE：拦下所有写操作，直到用户显式解除。

难点不在拦，而在**判据**：如果「是否 blocked」有多份实现（启动侧、路由侧、CLI 侧、救急台侧各写一遍），就会出现
「界面说被拦、CLI 照写」这种分叉 —— 审计里真的发现过（CLI `sessions repair --fix` 曾只查「DSH 是否在运行」）。

## 决策

1. 落盘即跨重启生效；解除判据只有 `resolveSafeMode` 一份，扫描失败一律按 blocked 处理（**fail-closed**）。
2. 启动侧陈旧标记复位用 `resolveStartupSafeMode`；`GET /recovery/status` 回传 `safeMode.blocked/clearable`。
3. 解除端点不过 mutation gate，但有未解决 incident 时必拒。
4. 所有写路径共用同一道门：CLI 与离线救急台都走 `checkWriteGates()`（SAFE MODE → 残留环境锁 → DSH 未运行），
   判据顺序与文案一致，不各自为政。

## 后果

- 好：任何写入口（GUI、CLI、救急台）对「能不能写」给出同一个答案。
- 坏：fail-closed 意味着扫描本身出问题时插件会「看起来坏了」，需要清楚的诊断文案（`safeMode.blocked` 与 `clearable` 分开表达）。
- 坏：新增写路径时必须记得过这道门 —— 这是一条**容易漏**的规则，所以进了 `AGENTS.md` 的安全不变量。

## 证据

- `src/core/recovery-orchestrator.ts`（`resolveSafeMode`，issue #56 起为单一实现）、`src/core/startup-barrier.ts`（`resolveStartupSafeMode`，启动侧陈旧标记复位）
- `src/cli/actions.ts`（`checkWriteGates`、`readSafeMode`、`readLockState`、`readRunningInstances`）
- `src/cli/index-guards.test.ts`（SAFE MODE / 残留锁下 `sessions repair --fix` 必须 exit 1）
