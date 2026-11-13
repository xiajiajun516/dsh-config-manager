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

/**
 * 写回 patch 文档：`{__jsExpr}` 还原成 `!!js`，字符串一律带引号（issue #135）。
 *
 * `forceQuotes` 不是风格偏好，而是**跨大版本读回的前提**：本插件装在 js-yaml 5.x 上打印，
 * DSH 本体用 4.x 读回（桌面版随包 4.3.2）。5.x 的渲染器只按自己的解析规则决定要不要加引号，
 * 于是 `""` `Null` `~` `True` `007` `0x10` `.inf` 这类**字符串**被写成裸标量，
 * 4.x 按 YAML 1.1 隐式解析成 `null` / `true` / `7` / `16` / `Infinity` —— 两边读到不同的值，
 * 把该字段声明为必填 string 的插件启动时直接 ZodError。
 *
 * 代价（已知且接受）：字符串值普遍带引号；普通多行字符串从 `|` 块退化为双引号 + `\n`
 * （`!!js` 的块标量带标签，不受影响）。只影响写出去的字节，读侧语义不变：
 * 已经写成空标量的历史文件仍由 `loadPatchDocument` 读成 `""`，该层下次被写回时自动复原。
 */
export function dumpPatchDocument(value: unknown): string {
  return dump(value, { schema: PATCH_YAML_SCHEMA, forceQuotes: true })
}

/**
 * 键名在 DSH 读端（js-yaml 4.x）的**改判**形态。
 *
 * 为什么需要单独一层检查：`forceQuotes`（issue #135）只保**值**，键名是 js-yaml 自己决定加不加
 * 引号的 —— 5.x 只给「YAML 1.2 会改判」的键加引号，1.1-only 的形态（`007`、`True`、`.5`、`~`）
 * 一律裸写，于是 4.x 把键读成 `7` / `true` / `0.5` / `null`：配置静默改名，插件读不到自己的键。
 * 空键名更糟 —— `: 'v'` 会让 4.x **整份文件解析失败**（该层所有行一起失效）。
 */
export type PatchKeyHazardEffect = 'parse-fail' | 'rename'

/** 一处键名风险。 */
export interface PatchKeyHazard {
  /** 键所在容器的路径（`''` = 顶层；数组元素记作 `items[3]`） */
  path: string
  /** 出问题的键名原文（空串 = 空键名） */
  key: string
  /** `parse-fail` = 4.x 整份文件解析失败；`rename` = 键被改判成数字 / 布尔 / null */
  effect: PatchKeyHazardEffect
}

/**
 * 4.x（YAML 1.1 隐式解析）会改判的裸键形态 —— **只列实测会改判的**。
 *
 * 实测口径（`.tmp` 之外不留脚本，结论进 docs/evidence）：`0X10` / `0B101` / `+.5` / `-.5` /
 * `1_000` / `2020-01-01` / `yes` / `1.2`（5.x 自己会加引号或两端都是字符串）一律**不算**风险。
 */
const AMBIGUOUS_KEYS: readonly RegExp[] = [
  /^~$/,
  /^(?:null|Null|NULL|true|True|TRUE|false|False|FALSE)$/,
  /^[-+]?0x[0-9a-fA-F]+$/,
  /^[-+]?0b[01]+$/,
  /^[-+]?0o[0-7]+$/,
  /^[-+]?\d+$/,
  /^(?:[-+]?\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/,
  /^[-+]?\.(?:inf|Inf|INF)$/,
  /^\.(?:nan|NaN|NAN)$/,
]

/** 5.x 会把键裸写吗（不加引号）—— 用真 dumper 判，不靠推断引号规则。 */
function isKeyWrittenBare(key: string): boolean {
  try {
    return dumpPatchDocument({ [key]: 'x' }).startsWith(`${key}:`)
  } catch {
    return false
  }
}

function keyHazardEffect(key: string): PatchKeyHazardEffect | null {
  if (key === '') return 'parse-fail'
  if (!isKeyWrittenBare(key)) return null
  // 文档分隔符写进键位会把整份文件切成两段（`--- x: v` 连 5.x 自己都读不回来）
  if (key === '---' || key.startsWith('--- ')) return 'parse-fail'
  return AMBIGUOUS_KEYS.some((pattern) => pattern.test(key)) ? 'rename' : null
}

/**
 * 找出一个 patch 行里**会跨大版本读坏**的键名（issue #137）。
 *
 * 只扫键、不扫值（值由 `dumpPatchDocument` 的 `forceQuotes` 兜住）；`{__jsExpr}` 是本模块的
 * 内存形态不是用户键名，整棵子树跳过；YAML 锚点可以造环，同一对象只走一次。
 * 返回空数组 = 这一行写出去 4.x / 5.x 读到的键名一致。
 */
export function findPatchKeyHazards(value: unknown): PatchKeyHazard[] {
  const hazards: PatchKeyHazard[] = []
  const seen = new Set<object>()
  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return
    if (isPatchJsExpr(node)) return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`))
      return
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const effect = keyHazardEffect(key)
      if (effect !== null) hazards.push({ path, key, effect })
      walk(child, path === '' ? key : `${path}.${key}`)
    }
  }
  walk(value, '')
  return hazards
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
