# docs/contracts/ — 对外契约

回答「**外部要照着实现什么**」。改这里的任何格式行为必须同步文档并重跑 `tests/conformance/`（规则在 `AGENTS.md`）。

| 文档 | 契约面 |
|---|---|
| `bundle-format-v1.md` | 备份包（config.zip）v1 的 ZIP 布局、manifest 字段、分区语义、加密与向前兼容 |
| `bundle-manifest.schema.json` | manifest 的机器可读 schema（上一份的配套文件，非 md） |
| `sync-channel-v1.md` | 同步通道的索引/快照/能力矩阵 |
| `market-index-v1.md` | 第三方市场仓库 `index.json` 的字段、校验规则与安全边界 |
| `plugin-data-declaration.md` | 插件通过 `dsh.dataDirs` 自述数据目录的声明格式 |
| `headless-consumption.md` | 无 UI 消费契约：`/core` `/schema` `/client` 导出面与宿主注入要求 |
| `compat-matrix.md` | DSH 版本兼容矩阵（host 服务 / client 包 / peer / engines）与升级风险 R1–R15、M1–M8 |

## 加一条

- 只有当**仓外的人需要照着实现**时才新建契约；仓内实现细节写 `docs/architecture/`。
- 文件名带版本后缀（`-v1`）表示不可静默变更；不兼容改动 = 新文件 + 旧文件标「已被 vN 取代」。
- 文首必须有一行版本声明（照抄 `docs/contracts/compat-matrix.md` 顶部那行的写法）；`check-doc-versions.mjs` 会把它钉成当前版本。

## 不变量

- 契约与代码同轮改；`tests/conformance/` 是契约的可执行副本。
- 缺口不写进契约里当承诺：缺口在 `docs/known-issues/known-gaps.md`。
