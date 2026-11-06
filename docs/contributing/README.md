# docs/contributing/ — 怎么维护这个仓库的文档与版本号

| 文档 | 内容 |
|---|---|
| `doc-maintenance.md` | **文档维护规则**：改动要不要写文档、写哪份、AI 流程、季度人工清单 |
| `versioning.md` | **版本管理规范**：三数字语义与 0.x 本地约定、预发布命名、历史版本保留、「已发布」的四项定义、发布前检查清单、版本变更判断模板 |

## 加一条

「人怎么维护仓库」的规范放这里；「代码怎么工作」放 `docs/architecture/`。
新增规则先写证据（`docs/evidence/` 或真机复现），再回来补一行判据。

## 不变量

- 版本号以 `package.json` 为唯一真值，其余三处（`src/index.ts` 的 `PLUGIN_VERSION`、`package-lock.json` 两处、`docs/contracts/compat-matrix.md` 声明行）由 `check-doc-versions.mjs` 与 `tests/packaging-contract.test.ts` 钉住。
- 文档结构的边界（8 分区、两跳可达）写在这里，不散落在各 README。
