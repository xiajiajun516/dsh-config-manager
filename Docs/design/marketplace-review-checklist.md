# 配置市场（m-market）后端安全校验清单（reviewer 核对稿）

> 依据：docs/design/marketplace.md（v1.0 修订版）+ 现有代码事实（src/index.ts / src/core/importer.ts / src/core/analyzer.ts / src/security/zip-security.ts / src/sync/sync-config.ts）。
> 用途：backend 实现 `src/market/`（security.ts / reader.ts / market-config.ts / index.ts 装配）时的逐项核对表；reviewer 据此验收。纯检查项，全部可静态核对或 node 测试验证。

---

## A. `market/download` 全流程（对照设计 §6 / §8）

| # | 检查项 | 必须 | 现有代码依据 |
|---|---|---|---|
| A1 | 条目目录名 `itemId` 先过 `SAFE_ITEM_ID_RE`（`/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`）；不合法直接拒绝，**不做任何读取** | 是 | §5.3（防 `items/<id>/` 路径穿越） |
| A2 | `items/<id>/manifest.json.id === itemId` 一致（来源一致） | 是 | §6-1 |
| A3 | `config.zip` 字节体积 ≤ `MAX_MARKET_ZIP_BYTES`（建议 64MB） | 是 | §6-2（zip bomb 首闸） |
| A4 | zip 经 `createHardenedZipParser()`（Zip Slip / 绝对路径 / 恶意条目 / 深度 / 解压比），任一条目违规 → 拒整包 | 是 | §6-3；现有 `src/index.ts:1172` 已注入同一 parser |
| A5 | `parseManifest` + `validateSectionData` 逐分区（复用 schema/manifest.ts + schema/config.ts） | 是 | §6-4 |
| A6 | 内部 `integrity/checksums.json` ↔ 实际条目（复用 hashing buildChecksums） | 是 | §6-5 |
| A7 | L2↔L3 一致性：`manifest.checksums.zip` == 实算 `config.zip` SHA-256；`manifest.sections` 与 zip 内部 sections 交集非空 | 是 | §6-6（防「描述与载荷不符」） |
| A8 | 供应链警示投影为 `MarketItemDetail.warnings`（manifest.provenance + 市场 URL + 下载时间 + 非官方横幅），**恒生成、恒展示** | 是 | §6-7 / §7.1 |
| A9 | 校验失败 → `status:'invalid'` + `errors[]`，**不进导入预览**，UI 显示原因 | 是 | §6 尾部 |
| A10 | 校验失败 → **不写任何缓存**（index/manifest/config.zip 一律不落）→ **删除已拉的临时 config.zip/manifest.json** | 是 | §5.2 / §6 尾部（零写入） |

## B. 确认导入（无新端点）

| # | 检查项 | 必须 | 依据 |
|---|---|---|---|
| B1 | **不存在 market/apply 端点**；§4.2 路由清单不得含它 | 是 | §4.2 / §8（已定） |
| B2 | `market/download` 返回的 `zipPath + plan` 由前端**直接调现有 `POST /execute`**（body `{zipPath, plan, opts}`，`confirm:true` 安全阀 + 回滚） | 是 | §4.2 / §8 |
| B3 | `zipPath` 必须严格落在 `<dataDir>/tmp`（复用 `makeRoutes` 现有 `tmpDir` 常量，或直接子目录）；**不得另起目录** | 是 | §8；`src/index.ts:1161 roots=[exportsDir, tmpDir]`；否则 `/execute` 400 |

## C. 无 secret 硬不变式

| # | 检查项 | 必须 | 依据 |
|---|---|---|---|
| C1 | 所有 market 端点请求体**不接受** token / 密码 / 凭据字段 | 是 | §1 / 设计 §9-2 |
| C2 | 所有 market 端点响应**不回传**任何 token / 密码 / 凭据值 | 是 | §1 / §9-2 |
| C3 | `repoUrl`（market add）：复用 `validateRepoUrl`，**拒绝含 userinfo**（`username:password@`）与空白/非 http(s) | 是 | §1 / §4.1 / `src/sync/sync-config.ts:156` |
| C4 | `market-config.json` 只存 `{url, addedAt}`，**无任何凭据**；写入前 url 过校验 | 是 | §5.1 / §9-2 |
| C5 | git 命令错误消息经 `mask()` 脱敏（公开 URL 本无 token，保留通用脱敏） | 是 | §4.1 |
| C6 | 下载包内 secret 值：**不采纳、要求重输**（走现有 importer 规则），市场层**不做任何回传/落盘** | 是 | §1 / 设计 §9-2 |

## D. 零写入到确认 / 只读

| # | 检查项 | 必须 | 依据 |
|---|---|---|---|
| D1 | `download/browse/refresh` 均**不落配置**；仅 `/execute(confirm:true)` 落盘 | 是 | 设计 §9-4 |
| D2 | `MarketReader` 只读：`git clone --depth 1` + `git pull --ff-only`，**绝无 push/写远端**路径复用 | 是 | §4.1 / §10 测试「只读不 push」 |
| D3 | 公开市场不注入凭据（默认无 token credential） | 是 | §4.1 |

## E. 纯渲染模型可测（架构纪律）

| # | 检查项 | 必须 | 依据 |
|---|---|---|---|
| E1 | `src/market/view.ts` 全为无副作用纯函数（statusText/listSummary/badge/警告/needsReview），node --test 直接测 | 是 | §7.2（与 sync-view.ts 同构） |
| E2 | `needsReview(detail)` 恒 true | 是 | §7.2 / 设计 §9-3 |
| E3 | `src/market/types.ts` 纯数据形状，不 import 运行时包 | 是 | §3.1（与 schema/types.ts 同纪律） |

## F. 测试矩阵补齐（对照设计 §10）

| # | 检查项 | 必须 |
|---|---|---|
| F1 | 解析：合法 index/缺失字段/未知字段拒绝/schemaVersion 不符/`id` 越界 | 是 |
| F2 | 校验：正常 zip / Zip Slip / zip bomb（超大条目）/ checksum 不匹配 / L2↔L3 不一致 / 空 sections | 是 |
| F3 | 读取：mock git exec 序列 / clone & pull 复用 / 只读不 push / 超时 / 脱敏 | 是 |
| F4 | 配置：add/remove 持久化 / userinfo url 拒绝 / **失败不写缓存** | 是 |
| F5 | 渲染：状态文案 / 徽章 / 供应链警示恒生成 / needsReview 恒 true | 是 |
| F6 | 集成：本地 bare repo 模拟市场 → browse → download → 校验 → preview → execute(confirm) → 回滚 | 是 |
| F7 | **失败路径**：下载校验失败不落缓存、临时文件被清（对 A10 的回归测试） | 是 |

---

## 验收结论（reviewer 填，落地后回填）
- [ ] A1–A10 全部通过
- [ ] B1–B3 无 market/apply、交接走单一 /execute、zipPath 落 dataDir/tmp
- [ ] C1–C6 无 secret 硬不变式成立
- [ ] D1–D3 零写入 / 只读成立
- [ ] E1–E3 纯渲染模型可测
- [ ] F1–F7 测试覆盖达标
