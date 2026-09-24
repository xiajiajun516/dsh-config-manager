/**
 * 路由组的显式依赖契约（替代改造前的 makeRoutes 闭包捕获）。
 *
 * 唯一构造点：src/index.ts 的 makeRouteEnv()。类型由该构造推断（RouteEnvInferred），
 * 避免手抄一份类型后与实现漂移 —— 新增依赖时编译器会在组文件与构造点同时报错。
 */
import type { RouteEnvInferred } from '../index.ts'

/** 路由组共享依赖（见 makeRouteEnv 的构造注释）。 */
export type RoutesEnv = RouteEnvInferred
