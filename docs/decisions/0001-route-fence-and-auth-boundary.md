# ADR-0001：路由只经 `kit.endpoint()` 声明，围栏即认证边界

- 状态：已采纳（Accepted）
- 日期：2026-10-22（记录既有决策，非新决策）

## 背景

插件对外暴露 84 条 HTTP 路由（`src/index.ts` 7 条 + `src/routes/*.ts` 77 条；条数以 `tests/route/route-parity.test.ts` 的 `ROUTE_SNAPSHOT` 为准）。改造前每条路由各自写 `methods` 判断、`try/catch` 与来源检查，
于是出现三类历史缺陷：漏方法判断（POST 当 GET 用）、漏 `catch`（异常落到 webserver 的空体 400）、来源检查各写一份且口径不同。

同时有一个容易误判的事实：DSH 的 cookie 认证**不覆盖本插件**。DSH 把 cookie 拒绝挂在 `kind:'prefix', path:'/api'` 的 RPC 承载路由上，
而派发顺序是 exact 表先命中 ⇒ 这些 exact 路由永远进不到那条认证路由。

## 决策

1. 所有路由必须经 `src/routes/kit.ts` 的 `endpoint({path, methods}, handler)` 声明；`registerRoutes()` 对裸路由直接抛错（fail-fast，不静默少一道护栏）。
2. 包装在**注册点**统一做三件事：访问面围栏（回环放行，其余委托宿主；见下方「更新」）、方法白名单（→ 405）、顶层 `try/catch` → `writeRouteError`。
3. 统一错误形状与唯一错误类型：`RouteError`（含 `status`/`code`）保真，其余一律 500 JSON。
4. 路由计数与「全部经 kit」由测试钉住：`tests/route/route-fence.test.ts`、`tests/route/route-parity.test.ts`（逐条快照，条数以该文件的 `ROUTE_SNAPSHOT` 为准）。

## 后果

- 好：新增一条 API 的成本固定为「在所属组文件加一条 `endpoint(...)`」，护栏不可遗漏；计数漂移会红。
- 好：围栏成为**唯一的认证边界**，因此它的语义可以被明确写在文档里，而不是靠「DSH 应该会管」的错觉。
- 坏：**本机任意非浏览器进程无 token 即可调用全部 exact 路由**。远程/LAN 与跨站 CSRF 被围栏挡掉（2026-11-06 起 LAN 侧改由宿主信任面判定），但只要经代理或隧道暴露出去，就必须在注册点补认证。
- 坏：任何绕过 kit 的写法（直接 `webServer.register`）都会被启动期断言拦住 —— 这既是保护，也是迁移旧路由时的硬门槛。

## 证据

- `src/routes/kit.ts`（`endpoint`/`registerRoutes`/`writeRouteError`/`readJsonBody` 4 MiB 上限）
- `tests/route/route-fence.test.ts`（围栏三件事 + 裸路由抛错 + 路由集合结构不变量）
- `tests/route/route-parity.test.ts`（逐条快照 + 解析器自检）

## 更新（2026-11-06，issue #126）

原决策把围栏写成「只认 loopback」，于是宿主用 `dsh web --host <LAN 地址>` 起服务后，局域网里打开的内嵌面板每条 `/api/dsh-config-manager/*` 都 403
（`forbidden: loopback-only`），而 CLI 与 agent 工具正常 —— 用户看到的是「数据读取失败」，实际是访问方式不被接受。

围栏改为两段式（`src/routes/kit.ts` 的 `requestRejection`）：

1. `isLoopbackRequest` 成立 → 直接放行，行为与原来逐字节一致（本机 curl/脚本不受影响）。
2. 否则委托宿主 `connection.requestRejection`（`src/routes/request-trust.ts`）：Host/bind 地址、Origin 同源、`dsh-auth-*` 会话 cookie 由宿主判定。
   放行 → 进 handler；401 → `browser-session`；403 → `untrusted-authority`。
3. 拿不到该服务（老宿主 / 独立 `dcm web` 救急台）或调用抛错 → 退回原 `forbidden: loopback-only`，即更严方向。

结论不变：插件仍不自己做会话校验，经代理/隧道暴露仍须在注册点补认证；独立救急台 `src/cli/web/server.ts` 继续只绑 `127.0.0.1` 并直调 `isLoopbackRequest`。

## 备选方案（未采纳）

- **每条路由自己写检查**：已证明会漂移（见背景）。
- **依赖 DSH cookie 认证**：事实错误（exact 表先命中），会把「无认证」误当「已认证」。
