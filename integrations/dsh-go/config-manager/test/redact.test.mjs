import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { redact, safeText, isSensitiveFieldName, REDACTED } from '../lib/redact.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const hostModule = join(root, '..', '..', '..', 'src', 'security', 'redaction.ts')
const hostAvailable = existsSync(hostModule)

/**
 * 语料 = 仓库里真实会进视图/日志的形状：JSON 字段、KV、URL 参数、厂商前缀、PEM 头、JWT。
 * 插件里的 redact.js 是宿主 src/security/redaction.ts 的副本；这条测试钉住两者不漂移。
 */
const CORPUS = [
  'api_key=sk-abc123def456 keep=1',
  '{"password":"hunter2","user":"bob"}',
  'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij',
  'url https://user:pass@example.com/path',
  'token: abcd1234',
  'note: ok',
  'password: s3cr3t',
  'risk-assessment=none',
  '-----BEGIN RSA PRIVATE KEY-----',
  'ghp_abcdefghijklmnopqrstuvwx',
  'AKIAIOSFODNN7EXAMPLE',
  'secret=deadbeef&next=1',
  'Bearer credentials are required',
  'access_token=xyz&refresh_token=abc',
  'cookie: session=abcdef; other=1',
  'plain text with no secrets at all',
  'client_secret="s3cr3t-value"',
]

test('redaction 副本与宿主实现逐字一致（语料回归，宿主改口径时这里会红）', { skip: hostAvailable ? false : '宿主源文件不在仓库内（安装后的拷贝没有 src/）' }, async () => {
  const host = await import(pathToFileURL(hostModule).href)
  const mismatches = []
  for (const text of CORPUS) {
    const mine = redact(text)
    const theirs = host.redact(text)
    if (mine !== theirs) mismatches.push({ text, mine, theirs })
  }
  assert.deepEqual(mismatches, [])
})

test('凭据形状必被掩码，普通文本不被误伤', () => {
  assert.equal(redact('api_key=sk-abc123def456'), `api_key=${REDACTED}`)
  assert.equal(redact('note: ok'), 'note: ok')
  assert.equal(redact('risk-assessment=none'), 'risk-assessment=none')
  assert.match(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij'), /\*\*\*REDACTED\*\*\*/)
  assert.match(redact('-----BEGIN RSA PRIVATE KEY-----'), /\*\*\*REDACTED\*\*\*/)
  // URL userinfo 只掩密码段，保留用户名（与宿主同名规则一致）。
  assert.equal(redact('https://user:pass@example.com/path'), 'https://user:***REDACTED***@example.com/path')
})

test('字段名判据：大小写、驼峰、前后缀都算敏感', () => {
  for (const name of ['password', 'apiKey', 'API_KEY', 'clientSecret', 'refreshToken', 'authorization', 'webhookSecret']) {
    assert.equal(isSensitiveFieldName(name), true, name)
  }
  for (const name of ['user', 'risk', 'notes', 'path', 'count']) {
    assert.equal(isSensitiveFieldName(name), false, name)
  }
})

test('safeText 先脱敏再截断（不许把明文截断后才脱敏）', () => {
  const long = `${'x'.repeat(300)} password=abcdef`
  const out = safeText(long, 40)
  assert.ok([...out].length <= 41)
  assert.ok(!out.includes('abcdef'))
})

test('redact 源码里没有把明文写回日志的旁路（无 console 调用）', () => {
  const source = readFileSync(join(root, 'lib', 'redact.js'), 'utf8')
  assert.equal(/console\.[a-z]+/.test(source), false)
})
