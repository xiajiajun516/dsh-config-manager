# 路径映射的原生目录选择（三层降级）

> 日期：2026-10-28 · 状态：**已实现** · 上游约束：[AGENTS.md](../../AGENTS.md)（DI 走 Cordis fiber：可选服务一律 `ctx.get()`；界面只留能改变用户决定的信息）、[CHANGELOG](../../CHANGELOG.md)

## 1. 问题

导入向导「路径映射」要给每条待映射路径给出**本机绝对路径**。浏览器侧拿不到绝对路径：

- File System Access API 只给 `FileSystemDirectoryHandle`（不给盘符路径）；
- `<input type="file">` 只给文件名（且受浏览器伪路径保护）。

宿主（host 半）也拿不到 Electron 的 `dialog`：DSH 桌面壳以 **Node 模式**拉起宿主进程（`ELECTRON_RUN_AS_NODE=1`，`src/utils/desktop-carrier.ts`），进程里没有 `BrowserWindow`。所以「弹系统窗口」只能落到**操作系统自带的对话框程序**上。

## 2. 结论：三层降级，优先复用 DSH 自带能力

| 层 | 窗口 | 条件 | 实现 |
| --- | --- | --- | --- |
| ① | **DSH 宿主自带目录选择器**（就是「选择工作区目录」那个原生窗口） | DSH 客户端提供 `workspaces` 服务 | `ctx.get('workspaces').pickDirectory()`（`src/client/index.ts` 惰取 thunk → `ConfigManagerApi.pickDshPath`） |
| ② | 插件自己的系统对话框（Windows = `IFileOpenDialog` 文件夹模式 / macOS = `choose folder` / Linux = `zenity`→`kdialog`） | ①报告 `unavailable` | 宿主 `POST /path-browse` → `src/core/native-path-picker.ts` |
| ③ | 插件内置目录浏览器 | ①②都不可用 | `GET /path-browse` + `PathPickerDialog` |

**为什么①优先**：窗口由 DSH 主进程弹，跟宿主同生共死；插件不参与进程形态判断，也不编译 COM。②保留的原因是非桌面宿主/旧版本的 `host.pickDirectory` 会以 `directory-picker-unavailable` 失败，此时仍要能选路径。

## 3. 关键事实（取证）

- `workspaces.pickDirectory(): Promise<string | null>` —— 契约面 `@deepseek-ai/dsh-client-runtime` 的 `lib/types/client/contract/workspaces.ts`；服务经 `ctx.reflect.provide('workspaces', …)` 注册（runtime `apply` 先于插件 `apply`），因此插件 `ctx.get('workspaces')` 可用，且**必须在点击那一刻**取（宿主重连/服务重建后装载期快照会失效）。
- 该能力走 DSH 自己的 wire 客户端（`host.pickDirectory`，`caller-signal-only`，无服务端超时），**不经过**插件 `/api/dsh-config-manager/*` 围栏。
- 语义三分：返回路径 = 选中；返回 `null` = 用户取消（静默收手）；**调用抛错 / 服务缺失 = `unavailable`**（回落下一层，不当错误弹红条）。
- **代价（如实）**：`host.pickDirectory` 的请求体是空对象（`object({})`），**标题与起始目录都不可定制** —— 窗口标题固定为 DSH 的「Select Workspace Directory」，与「选择本机路径」的上下文不完全一致。若将来该能力开放参数，①层可直接补 title/startPath，②③无需改动。

## 4. 行为验收

- 选中任意一层 → 路径回填输入框；
- 任意一层点取消 → 零改动、零提示；
- ①不可用 → 弹②；②不可用 → 弹③；三层都没有才提示失败。

## 5. 测试与验证

- `tests/client/api-dsh-pick.test.ts`（6 条）：选中 / `null` / 空串 / 未注入 / 抛错 / 惰取第二次拿到新结果。
- `src/core/native-path-picker.test.ts`（9 条）：三平台 argv、取消与失败码、盘符根与 `/` 根归一化、zenity→kdialog 回落。
- 真机：Windows 上 `DCM_PICK_PROBE=1` 自检互操作装配；带 `timeoutMs: 3000` 真弹窗被 kill（证明 `Show()` 进了模态循环）。
