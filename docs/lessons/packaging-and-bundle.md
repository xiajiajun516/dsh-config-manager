# 打包与 client bundle — 经验与证据存档

> 本文件是**经验/证据**：真机事故、量化数据、复现与复核脚本；**规则本体在 `AGENTS.md`**（对应小节读取）。
> 条目结构：每个 `###` 是原 `AGENTS.md` 的一条完整条目（逐字搬迁，未改写）。域 → 规则 的对应表见 `docs/lessons/README.md`。

## MemFs 测试

- **MemFs 测试**：内存 fs key 与宿主 path 解耦（win32 home 注入 cwd）。

## client bundle 是 cjs + `window.__ModuleLoader__.load`

- **client bundle 是 cjs + `window.__ModuleLoader__.load`**（tsdown.config.ts），改 format/入口会破坏加载器；CSS Modules 只认 `.module.css`；**`src/client/` 不 import node 模块**（`PathMappingForm` 刻意做了轻量等价实现）；**style 属性只允许极小修补**（如 MarketPanel `paddingTop:4`），常规布局用 CSS 类。

## issue #57–#60 四条硬约束

- **issue #57–#60 四条硬约束**：ⓐ `file:` spec 打包前必须 `stat` 判形态（`src/core/local-plugin-pack.ts` 的 `statKind`：目录走 `npm pack`、`.tgz` 直接读取；判不出来回落目录流程），profile 目录用 `HostContext.profileDir` 不硬拼；ⓑ 同步快照 JSON 体积上限**读写必须同口径**（`deserializeSnapshot` 用 `MAX_OWN_PAYLOAD_JSON_BYTES` 512 MiB，**不是** `parseJsonSafe` 的缺省 64 MiB），读不出来的一律经 `unreadableSnapshots` 回传可见；ⓒ `runStore.patch()` 会清空密码字段，任何无关 patch 之后必须 `runStore.patchSyncPasswords()` 把在途输入写回**内存**；ⓓ git 源安装需要 `scripts.prepare`（本包已补），pnpm 11 仍要 `allowBuilds`（键逐字照抄 pnpm 打印的那行）；门禁在 `tests/packaging-contract.test.ts` 的 `G-21`。

## client bundle 自包含护栏

- **client bundle 自包含护栏**：`src/utils/bundle-scan.ts`（零依赖扫描内核，**多趟并集**避免注释内反引号导致的状态失衡假阴性）+ `src/client/bundle-selfcontained.test.ts`（产物护栏，白名单仅 react/react-dom/react-dom/client/react/jsx-runtime）。**必须 Build 之后单独跑**——`npm test` 在 Build 前执行，此时 `lib/client.js` 不存在，测试会跳过；故 `ci.yml`/`publish.yml` 各有一独立步骤。注释里的同名字符串会造成假阳性（本仓库实测过）。
