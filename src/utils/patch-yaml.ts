/**
 * `cordis.patch.yml` 的 YAML **方言**（issue #75）—— 宿主侧单一事实源。
 *
 * 为什么不能直接用 `yaml.load` / `yaml.dump`：这份文件不是普通 YAML。DSH 自己读它用的是
 * 「JSON_SCHEMA + 一个自定义标量标签 `!!js`」的方言（`@deepseek-ai/dsh-app-boot`：
 *   `const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)`，其中
 *   `JsExpr = new yaml.Type('tag:yaml.org,2002:js', { kind:'scalar', construct: (data) => ({ __jsExpr: data }), predicate: isJsExpr, represent: (data) => data['__jsExpr'] })`）
 * —— `!!js` 承载的是**行内 JS 表达式**（真机例：`disabled: !!js (function(){ … })()`）。
 *
 * 缺省 schema 遇到 `!!js` 会直接抛 `unknown scalar tag !<tag:yaml.org,2002:js>`（js-yaml 5 实测）。
 * 调用方若把它 catch 成「这一层没有 patch 行」，用户手写的整层配置就会在导出/同步/预览里凭空消失；
 * 导入写回时更会把整份文件重写成「只剩本次导入的行」—— 这正是 issue #75 报告的数据丢失。
 *
 * 两个形状与 DSH 逐字对齐（**改这里等于改对外契约**，见 `docs/contracts/bundle-format-v1.md`）：
 *  - 载入：`!!js <源码>` → `{ __jsExpr: <源码> }`
 *  - 写回：`{ __jsExpr: <源码> }` → `!!js <源码>`
 * 判据与 cordis 的 `isJsExpr`（`value instanceof Object && '__jsExpr' in value`）一致，于是 bundle 里
 * 存的 `raw` 既是普通 JSON（可安全过 `JSON.stringify` / 分区 JSON），又能还原成 DSH 认的表达式。
 *
 * 用 `JSON_SCHEMA`（而不是 js-yaml 的缺省 schema）是刻意的：**读法必须与 DSH 一致**，否则同一个文件
 * 我们和 DSH 会看到不同的值（例：`~` 在 YAML 1.2 Core 下是 null，在 JSON_SCHEMA 下是字符串 `"~"`，
 * 而 DSH 用的是后者 —— 导出的 raw 必须与 DSH 读到的相同）。
 */
import { JSON_SCHEMA, NOT_RESOLVED, defineScalarTag, dump, load } from 'js-yaml'

/** `!!js` 表达式的内存形态（与 DSH / cordis 的 `{__jsExpr}` 逐字同形）。 */
export interface PatchJsExpr {
  __jsExpr: string
}

/** 与 cordis `isJsExpr` 同判据（`value instanceof Object && '__jsExpr' in value`）。 */
export function isPatchJsExpr(value: unknown): value is PatchJsExpr {
  return typeof value === 'object' && value !== null && '__jsExpr' in value
}

/** `tag:yaml.org,2002:js`（`!!js`）：只认显式标签，构造 `{__jsExpr}`，写回还原源码文本。 */
const jsExprTag = defineScalarTag<PatchJsExpr>('tag:yaml.org,2002:js', {
  resolve: (source, isExplicit) => (isExplicit ? { __jsExpr: source } : NOT_RESOLVED),
  identify: isPatchJsExpr,
  represent: (data: PatchJsExpr) => String(data.__jsExpr),
})

/** patch 文件的 YAML schema（= DSH 的 `entryListSchema` 同款）。 */
export const PATCH_YAML_SCHEMA = JSON_SCHEMA.withTags(jsExprTag)

/**
 * 载入 patch 文档（任意 YAML 值）。
 *
 * 解析失败**抛出**（不吞）：调用方要么把它转成可见告警，要么拒绝覆盖写入 —— 两条路都好过
 * 「当作空文档、把用户的整层配置抹掉」。
 */
export function loadPatchDocument(text: string): unknown {
  return load(text, { schema: PATCH_YAML_SCHEMA })
}

/** 写回 patch 文档：`{__jsExpr}` 还原成 `!!js`，其余按 DSH 的 schema 打印。 */
export function dumpPatchDocument(value: unknown): string {
  return dump(value, { schema: PATCH_YAML_SCHEMA })
}

/**
 * 解析报错的**安全摘要**：只取首行。
 *
 * 为什么必须截断：js-yaml 的 `Error.message` 会在首行之后附带**出错处的源码片段**，而
 * `cordis.patch.yml` 里可能内联字面量密钥（`!!js` 表达式旁会出现明文 token / API Key）。
 * 这段摘要会流进启动日志、导出告警与浏览器回执 —— 片段一律不得带出去。
 */
export function describePatchYamlError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const firstLine = raw.split('\n', 1)[0] ?? ''
  return firstLine.trim().slice(0, 200)
}
