# 打包与 client bundle — 经验与证据存档

> 本文件是**经验/证据**：真机事故、量化数据、复现与复核脚本；**规则本体在 `AGENTS.md`**（对应小节读取）。
> 条目结构：每个 `###` 对应 `AGENTS.md` 的一条规则；正文在规则之外补真机成因、量化数据与回归锚点（规则本体仍以 `AGENTS.md` 为准）。域 → 规则 的对应表见 `docs/lessons/README.md`。

## MemFs 测试

- **MemFs 测试**：内存 fs key 与宿主 path 解耦（win32 home 注入 cwd）。

## client bundle 是 cjs + `window.__ModuleLoader__.load`

- **client bundle 是 cjs + `window.__ModuleLoader__.load`**（tsdown.config.ts），改 format/入口会破坏加载器；CSS Modules 只认 `.module.css`；**`src/client/` 不 import node 模块**（`PathMappingForm` 刻意做了轻量等价实现）；**style 属性只允许极小修补**（如 MarketPanel `paddingTop:4`），常规布局用 CSS 类。

## issue #57–#60 四条硬约束

- **issue #57–#60 四条硬约束**：ⓐ `file:` spec 打包前必须 `stat` 判形态（`src/core/local-plugin-pack.ts` 的 `statKind`：目录走 `npm pack`、`.tgz` 直接读取；判不出来回落目录流程），profile 目录用 `HostContext.profileDir` 不硬拼；ⓑ 同步快照 JSON 体积上限**读写必须同口径**（`deserializeSnapshot` 用 `MAX_OWN_PAYLOAD_JSON_BYTES` 512 MiB，**不是** `parseJsonSafe` 的缺省 64 MiB），读不出来的一律经 `unreadableSnapshots` 回传可见；ⓒ `runStore.patch()` 会清空密码字段，任何无关 patch 之后必须 `runStore.patchSyncPasswords()` 把在途输入写回**内存**；ⓓ git 源安装需要 `scripts.prepare`（本包已补），pnpm 11 仍要 `allowBuilds`（键逐字照抄 pnpm 打印的那行）；门禁在 `tests/packaging-contract.test.ts` 的 `G-21`。

**成因（真机，`CHANGELOG.md` v0.6.x 段）**：

- ⓐ `link:`/`file:` 的 spec 有**两种合法形态**（目录 / 已打包 tarball），打包路径却一律当目录 spawn `npm pack` ⇒ 真机 9 个 `file:/abs/x.tgz` 插件**全部** `spawn ENOTDIR` 被跳过，而备份仍报 `ok:true`（按设计只记 warning）—— 用户以为「备份成功 = 备份完整」，恢复时装不回这批插件。修法必须**判不出形态回落目录流程**（绝不猜成文件），归档名仍 `local-plugins/<文件名>`、不含路径分隔符，导入端重写逻辑才不用改；回归 `src/core/local-plugin-pack.test.ts` +5 例。
- ⓑ 加密单文件布局把整份快照塞进**一个** JSON，写入侧**没有体积守卫**，读取侧却走 `parseJsonSafe` 的缺省 64 MiB（那是防**不可信输入**的闸门）；加密载荷「JSON → base64 → 加密 → 再 base64」约 **×1.78** 膨胀，勾上 `sessions` 后单文件轻松越界（真机 4 个快照均 ≈66 MiB）。后果**全是静默的**：`list()` 逐条跳过 ⇒ 远端列表为空（而 `currentSnapshotId` 仍指着那条）、`download()` 报「快照损坏」、`hasNewRemoteSnapshot()` 恒 false ⇒ 自动同步永远 `skipReason: upToDate`。修复只抬高**自产载荷**上限（512 MiB），`DEFAULT_MAX_JSON_BYTES` 64 MiB 一行未动；回归 `src/sync/snapshot-json.test.ts` +2 例。
- ⓒ `runStore.patch()` 每次都跑持久化白名单，而白名单**把密码字段写成空串**（安全不变量）⇒ 任何无关 patch（远端快照列表到货、GitHub 授权轮询结束、自动同步状态刷新）都会清掉 `state.sync.webdavPassword`。真机表现：输入几个字符就被清空、粘贴同样被清空、「保存配置」按钮闪一下（防抖自动保存被反复取消）且没有成功提示。`patchSyncPasswords()` 只写内存切片（不触发 `save()`），`toPersistedState` 白名单与 `applyPersisted` 的归零**都未放宽**；回归在 `src/client/run-store.test.ts`。
- ⓓ 本包 `files: ["lib", …]` 只发预构建产物（npm 安装无需构建），而 `dsh plugin add git+https://…` 拿到源码树、pnpm 需要一个 pnpm 认的构建入口；此前只有 `prepare`（只在 `npm publish` 前跑）⇒ git 安装 100% `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，用户只看到 `dsh: plugin command failed`。补 `prepare: npm run build` 后仍受 pnpm 11 供应链策略约束：`allowBuilds` 键要逐字照抄 pnpm 打印的那行（含完整 git URL + commit sha，只写包名不生效）—— 这一步包作者无法免除。

## client bundle 自包含护栏

- **client bundle 自包含护栏**：`src/utils/bundle-scan.ts`（零依赖扫描内核，**多趟并集**避免注释内反引号导致的状态失衡假阴性）+ `src/client/bundle-selfcontained.test.ts`（产物护栏，白名单仅 react/react-dom/react-dom/client/react/jsx-runtime）。**必须 Build 之后单独跑**——`npm test` 在 Build 前执行，此时 `lib/client.js` 不存在，测试会跳过；故 `ci.yml`/`publish.yml` 各有一独立步骤。注释里的同名字符串会造成假阳性（本仓库实测过）。
