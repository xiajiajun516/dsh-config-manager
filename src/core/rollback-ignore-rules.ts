/**
 * .dsh-rollback-ignore —— 回滚点捕获 / 回退走查共用的忽略规则（gitignore 常用子集）。
 *
 * 为什么需要它：竞品（dsh-rewind / dsh-turn-rewind）都允许用户把「不该进快照的东西」排除掉。
 * 本插件此前只有硬编码的 node_modules，大仓库里用户没有任何手段收窄捕获面。
 *
 * 语义（与 .gitignore 常用子集一致，且只在分块根读一份规则文件）：
 *  - 空行与 # 注释跳过；! 前缀 = 反向取消（最后一条命中的规则说了算）；
 *  - 尾 / = 只匹配目录；首 / = 相对规则文件所在目录（本实现里一律相对该目录）；
 *  - * / ? 不跨段，** 跨段。
 *
 * 三条硬边界（不得放宽）：
 *  ① 内置运行时依赖目录（EXCLUDED_DEP_DIR_NAMES，当前 node_modules）不可被反向取消。
 *  ② 被忽略的整个目录不进走查 ⇒ 证明名单不完整 ⇒ 该点的删除集整体拒绝（fail-closed），
 *     由调用方据匹配结果置 ignoreIncomplete；被忽略的文件仍逐条进 skipped，名单照样完整。
 *  ③ **内置敏感文件（凭据 / 私钥）同样不可被反向取消**：它们不进对象仓（不明文物化），
 *     但仍进走查名单（pathIndex）⇒ 删除集不会把它们误判成「留点后新建」。见 builtinSensitiveReason。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** 用户忽略规则文件名（分块根） */
export const IGNORE_RULE_FILE_NAME = '.dsh-rollback-ignore'

/** 内置运行时依赖目录名（与 utils/recursive-walk 的唯一来源保持一致） */
const EXCLUDED_DEP_SEGMENTS: readonly string[] = ['node_modules']

/**
 * 内置敏感文件表（判据见 {@link builtinSensitiveReason}）——**只收明确的凭据形态**，
 * 不放宽成「名字里带 secret/token 就算」：误判会让用户回滚点静默少文件，比多存几个文件更糟。
 *
 * **不按目录名判定**：密钥常放在任意子目录（src/a.key），按目录猜会漏。
 */
const SENSITIVE_BASENAMES: ReadonlySet<string> = new Set([
  '.npmrc', // npm token（_authToken）
  '.pypirc', // PyPI token
  '.netrc', // 明文登录口令
  '.git-credentials', // git 明文凭据
  '.htpasswd', // 散列口令（仍是凭据材料）
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', // OpenSSH 私钥（.pub 公钥已放行）
])

/** 私钥 / 证书容器后缀（文件本身就是凭据材料） */
const SENSITIVE_KEY_SUFFIXES: readonly string[] = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.ppk']

/** `.env.*` 里属于**模板**的形态：样例文件是文档，必须照常进快照（否则用户拷一份就丢） */
const ENV_TEMPLATE_SUFFIXES: ReadonlySet<string> = new Set(['.example', '.sample', '.template'])

interface IgnorePattern {
  /** 规则原文（诊断用） */
  raw: string
  negated: boolean
  dirOnly: boolean
  /** 已编译的正则（匹配「相对规则文件所在目录」的斜杠路径） */
  re: RegExp
}

/** 一份已解析的规则表（空规则 = 没有任何用户规则） */
export interface IgnoreRules {
  readonly root: string
  readonly patterns: readonly IgnorePattern[]
}

const EMPTY_RULES: IgnoreRules = { root: '', patterns: [] }

/** 单个字符是否需要正则转义（glob → RegExp 的唯一入口） */
function escapeRegExpChar(ch: string): string {
  const meta = '\\^$.*+?()[]{}|'
  return meta.includes(ch) ? '\\' + ch : ch
}

/**
 * glob body → RegExp（* / ? 不跨段，** 跨段）。导出只为让单测逐条钉住编译结果。
 */
export function ignoreGlobToRegExp(body: string): RegExp {
  const SEG = '[^/]'
  const SEP = '/'
  let out = '^'
  let i = 0
  while (i < body.length) {
    const ch = body[i] ?? ''
    if (ch === '*') {
      if (body[i + 1] === '*') {
        // ** 跨段；** 后跟 / 还可匹配零个整段（gitignore 的 **/foo 语义）
        if (body[i + 2] === '/') { out += '(?:[\\s\\S]*' + SEP + ')?'; i += 3 }
        else { out += '[\\s\\S]*'; i += 2 }
      } else { out += SEG + '*'; i += 1 }
    } else if (ch === '?') { out += SEG; i += 1 }
    else if (ch === '/') { out += SEP; i += 1 }
    else { out += escapeRegExpChar(ch); i += 1 }
  }
  return new RegExp(out + '$')
}

/** 解析规则文件正文 → 规则表（无法解析的行一律跳过，绝不因此拒绝整份规则） */
export function parseIgnoreRules(text: string, root: string): IgnoreRules {
  const patterns: IgnorePattern[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    let body = line
    let negated = false
    if (body.startsWith('!')) { negated = true; body = body.slice(1) }
    let dirOnly = false
    if (body.endsWith('/')) { dirOnly = true; body = body.slice(0, -1) }
    if (body.startsWith('/')) body = body.slice(1)
    if (body === '') continue
    // 内置规则不可反向取消：!node_modules 之类的行直接丢掉（不报错、也不生效）
    if (negated && body.split('/').some((seg) => EXCLUDED_DEP_SEGMENTS.includes(seg))) continue
    try {
      patterns.push({ raw: line, negated, dirOnly, re: ignoreGlobToRegExp(body) })
    } catch { /* 非法模式跳过 */ }
  }
  return { root, patterns }
}

/** 读分块根的规则文件；不存在 / 读不出 / 空文件 → 空规则（绝不因此让捕获失败） */
export async function loadIgnoreRules(root: string): Promise<IgnoreRules> {
  try {
    const text = await fs.readFile(path.join(root, IGNORE_RULE_FILE_NAME), 'utf8')
    const parsed = parseIgnoreRules(text, root)
    return parsed.patterns.length === 0 ? EMPTY_RULES : parsed
  } catch {
    return EMPTY_RULES
  }
}

/**
 * 一条相对规则根的斜杠路径是否被忽略（最后一条命中的规则说了算）。
 * isDir 只影响 dirOnly 规则的匹配；被忽略目录的后代由调用方整棵跳过，不在这里递归判断。
 */
export function ignoreRuleMatches(rules: IgnoreRules, relPath: string, isDir: boolean): boolean {
  if (rules.patterns.length === 0) return false
  const normalized = relPath.split('\\').join('/').replace(/^\.\//, '')
  if (normalized === '') return false
  let decision = false
  for (const pattern of rules.patterns) {
    if (pattern.dirOnly && !isDir) continue
    if (pattern.re.test(normalized)) decision = !pattern.negated
  }
  return decision
}

/** 分块根 → 该路径的规则相对路径（斜杠形式）。不在分块内返回 null（调用方按无规则处理）。 */
export function ignoreRelativePath(root: string, target: string): string | null {
  const rel = path.relative(root, target)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split('\\').join('/')
}

/**
 * 内置敏感文件判据：命中返回原因码 `'sensitive'`（含凭据，**不回滚**），否则 null。
 *
 * `relPath` 是**相对分块根**的斜杠路径（来自 {@link ignoreRelativePath}）——只看文件名与后缀，
 * 不看目录：密钥常散落在任意子目录（src/a.key）。
 *
 * 与用户忽略规则的关键区别：**不可被 `!` 反向取消**。调用方在判定处独立调用本函数，
 * 而不是把它编译进 parseIgnoreRules 的 patterns —— 用户写 `!.env` 的动机通常是「我要能回滚我的
 * .env」，但那会把明文密码送进内容寻址仓库；这类文件宁可少回滚，也不明文物化。
 *
 * 大小写折半比较（Windows / macOS 上 .ENV 与 .env 是同一个文件）：宁可保守。
 * 刻意放行：`.env.example` / `.env.sample` / `.env.template`（模板是文档）、`*.pub`（公钥）。
 */
export function builtinSensitiveReason(relPath: string): string | null {
  const normalized = relPath.split('\\').join('/').replace(/^\.\//, '')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  if (base === '') return null
  // .env 家族：模板放行，其余（.env / .env.local / .env.production …）一律视为凭据
  if (base === '.env') return 'sensitive'
  if (base.startsWith('.env.')) {
    return ENV_TEMPLATE_SUFFIXES.has(base.slice('.env'.length)) ? null : 'sensitive'
  }
  if (SENSITIVE_BASENAMES.has(base)) return 'sensitive'
  // 公钥放行（先于后缀判定：foo.pem.pub 之类也不该算凭据）
  if (base.endsWith('.pub')) return null
  if (SENSITIVE_KEY_SUFFIXES.some((suffix) => base.endsWith(suffix))) return 'sensitive'
  return null
}
