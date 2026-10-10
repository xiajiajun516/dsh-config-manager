# 恢复 / 救急台 / 救援模式 — 经验与证据存档

> 本文件是**经验/证据**：真机事故、量化数据、复现与复核脚本；**规则本体在 `AGENTS.md`**（对应小节读取）。
> 条目结构：每个 `###` 是原 `AGENTS.md` 的一条完整条目（逐字搬迁，未改写）。域 → 规则 的对应表见 `docs/lessons/README.md`。

## CLI 与救急台必须同一道写入门，且「机器可读字段」必须与退出码同源

- **CLI 与救急台必须同一道写入门，且「机器可读字段」必须与退出码同源**（2026-10-08 UX 审查）：`dcm restore` 此前只过 SAFE MODE + 环境锁，而救急台传 `checkWriteGates(..., { needsDshStopped: true })` —— 同一个动作在浏览器里被拒、在终端能覆盖 `$DSH_HOME`；现在 CLI 补第三道门（SAFE MODE → 环境锁 → DSH 未运行），`--dry-run` 仍只打印计划。同族三条：① `sessions doctor --json` 的 `ok` 必须 `blocking === 0`（恒 true 会让 CI 把「阻断启动 N 条」读成健康）；② `sessions repair` 在会话根读不出来时必须 exit 1 并说「读不到 ≠ 没有会话」（绝不打印「无需修复」）；③ 救急台 404/405/错误页的「可用页面」清单必须从 `page.ts` 的导航表**派生**（三份硬编码互不一致，还把 JSON 端点 `/healthz` 当页面推荐）。护栏：`src/cli/index-guards.test.ts`、`src/cli/sessions-repair.test.ts`、`src/cli/web/console-route-parity.test.ts`。

## 灾备快照线已收敛下线（2026-09）

- **灾备快照线已收敛下线（2026-09）**：watcher / 撤销重做 / 手动快照 / `/lifecycle` 整体删除；只留 `core/crash-report.ts` + `core/boot-rescue.ts`（并入「事故恢复」子 tab），**不再自建第二条恢复通道**。三条不许回退：`boot-state.json` 移到 `<dataDir>/boot-state/`（`adoptLegacyBootState` 幂等搬迁）；`BOOT_CRITICAL_RELS`/`profileCriticalRels` 搬进 `core/boot-paths.ts`（**导入安全闸门 `boot-safety.ts` 仍在用，删灾备不许连带删**）；`PanelId` 去掉 `'lifecycle'` 并在 `run-store` 迁移到 `snapshots` + `subTab='recovery'`。守卫：`src/core/incident-wiring.test.ts` + `tests/route/route-parity.test.ts` + `src/core/crash-report.test.ts`。

## 救援模式与 `reconcileBundles` 的硬冲突

- **救援模式与 `reconcileBundles` 的硬冲突**：进救援收窄 `dsh.profile.bundles` 后，插件自己的 `reconcileBundles`（`src/core/plugin-cli.ts`，规则 = 声明 `dsh.bundle.patch` 的依赖必须出现在 `bundles`）很快（秒级）就会用 `dependencies` 把用户插件全部加回，救援名存实亡。两条修法**不许拆开**：① `enterRescueMode` 必须同时 `stripDependencies`（退出时整份 `package.json` 逐字节还原）；② 救援激活期间 `reconcileBundles` 一律停手（`isRescueActiveSync`）。验证必须真机四阶段（收窄 → 数秒不被改写 → 重启不挂载 → 退出逐字节还原）；走 patch 层的插件**不要**写进 `dependencies`（否则 `duplicate loader entry id`）。复核见 known-pitfalls。

## 离线救急台（`dsh-config-manager web` / `dcm web`）

- **离线救急台（`dsh-config-manager web` / `dcm web`）**：① 服务端复用 `src/routes/kit.ts`（`endpoint()` + `registerRoutes`），页面服务端直出 HTML（零脚本零外链，CSP `default-src 'none'`），因此没有 client bundle 自包含问题；② **token 是这一层的边界**：kit 对无 Origin 头的请求放行，所以必须启动时生成 32 字节随机 token → 只打印到当前终端 → `/?token=…` 换 HttpOnly + SameSite=Strict 会话 cookie（**用过即废**），其余请求一律 403；③ **读路径只读、写路径有门**：GET 打开页面零写入，但**不是只读服务** —— 已有 **11 条 POST 写路由**（清单与行号见 `docs/known-pitfalls.md`「t93 容量腾挪」§2），`GET /healthz` 自报 `readOnly:false` + 由路由声明派生的 `writeRoutes`。真实边界 = 回环围栏（非回环 403）+ 一次性 token→HttpOnly 会话 cookie（**每个请求含写**都要 cookie，缺则 403）+ 方法白名单（405 走 HTML）；写动作各自过 CLI 同源的写入门（SAFE MODE → 残留锁 → DSH 未运行，fail-closed；`/reinstall/*` 另持 `runWithMutationLock`），磁盘清理只碰可重建缓存故不过 SAFE MODE 门、档案启停**刻意不过**那两道门（它正是「DSH 起不来」时的出口）。**绝不等于「插件 API 无认证」**；④ **判定不许重写**（与 CLI 共用 `src/cli/actions.ts`）。两个已修的坑（细节见 `docs/known-pitfalls.md`「t93 容量腾挪」§2）：心跳候选根必须与 SAFE MODE 同一套 `resolveControlRoots`；退出必须真退出（`close().finally(() => process.exit(0))`）。
