/**
 * t8（D3）：回滚点内置敏感文件排除 —— .env / 私钥等**不明文物化**进内容寻址仓库。
 *
 * 为什么必须真盘：判据落在走查分支（listChunkFiles）与对象仓写入之间，只有真目录 + 真采集
 * 才能证明「对象仓里确实没有明文字节」，而不是「files 数组里没有这个名字」。
 *
 * 覆盖：
 *  ① 敏感 5 类不进 files / 不进对象仓；模板与公钥照常进（白名单不能被一刀切）
 *  ② 用户 `!` 规则取消不了内置排除（与 node_modules 同档）
 *  ③ 敏感文件仍进走查证明名单 ⇒ 开了 removeCreated 的回退也不会把它当「留点后新建」删掉
 *  ④ 判据本身的形态表（大小写 / 子目录 / 后缀 / 模板放行）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { RollbackPointEngine, type RollbackPointRecord } from './rollback-point.ts'
import { builtinSensitiveReason } from './rollback-ignore-rules.ts'

/* --------------------------------------------------------------- fixture */

interface Fixture {
  root: string
  homeDir: string
  dataDir: string
  ws: string
  logFile: string
  cleanup: () => Promise<void>
}

/** 五个敏感文件（内容带可检索标记：对象仓里出现标记即证明漏了） */
const SENSITIVE_FILES: readonly { rel: string; body: string }[] = [
  { rel: '.env', body: 'TOPSECRET_ENV=1' },
  { rel: '.env.local', body: 'TOPSECRET_ENV_LOCAL=1' },
  { rel: 'id_rsa', body: 'TOPSECRET_RSA_PRIVATE_KEY' },
  { rel: 'app.pem', body: 'TOPSECRET_PEM' },
  { rel: 'src/a.key', body: 'TOPSECRET_KEY' },
]

/** 必须**照常采集**的白名单：模板文档与公钥 */
const ALLOWED_FILES: readonly { rel: string; body: string }[] = [
  { rel: '.env.example', body: 'KEY=changeme' },
  { rel: 'id_rsa.pub', body: 'ssh-rsa AAAA' },
  { rel: 'README.md', body: 'readme' },
]

async function makeFixture(): Promise<Fixture> {
  // 与 rollback-point.test.ts 同款：os.tmpdir() 在 Windows / macOS 上可能给非规范拼写，
  // 而引擎内部一律 realpath ⇒ 断言必须比规范化后的路径。
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-rollback-sensitive-')))
  const homeDir = path.join(root, 'home')
  const dataDir = path.join(homeDir, 'dsh-config-manager')
  const ws = path.join(root, 'ws')
  const logFile = path.join(homeDir, 'sessions', 'proj-key', 'session-1111', 'session-1111.jsonl.zstd')
  await fs.mkdir(path.dirname(logFile), { recursive: true })
  await fs.mkdir(path.join(ws, 'src'), { recursive: true })
  await fs.writeFile(logFile, 'frame-one')
  for (const item of [...ALLOWED_FILES, ...SENSITIVE_FILES]) {
    await fs.mkdir(path.dirname(path.join(ws, item.rel)), { recursive: true })
    await fs.writeFile(path.join(ws, item.rel), item.body)
  }
  return {
    root, homeDir, dataDir, ws, logFile,
    cleanup: async () => { await fs.rm(root, { recursive: true, force: true }) },
  }
}

function makeEngine(fx: Fixture): RollbackPointEngine {
  return new RollbackPointEngine({ dataDir: fx.dataDir, homeDir: fx.homeDir, sessionQuiescentMs: 0 })
}

async function capture(engine: RollbackPointEngine, fx: Fixture) {
  return await engine.capturePoint({
    chunks: [fx.ws],
    sessionId: 'session-1111',
    unitId: 'proj-key/session-1111',
    sessionLogPath: fx.logFile,
    cursorSeq: 3,
    turnSeq: 2,
    boundarySeq: 1,
    boundaryEndSeq: 6,
  })
}

/** 分块根相对路径（斜杠形式），断言与平台无关 */
function relOf(ws: string, target: string): string {
  return path.relative(ws, target).split(path.sep).join('/')
}

function sorted(list: readonly string[]): string[] {
  return [...list].sort()
}

/** 对象仓里是否存在明文字节（对象是内容寻址的原文副本：有标记就是真的物化了） */
async function storeHasMarker(engine: RollbackPointEngine, marker: string): Promise<string | null> {
  const dir = path.join(engine.storeDir, 'objects')
  let names: string[]
  try { names = await fs.readdir(dir) } catch { return null }
  const needle = Buffer.from(marker)
  for (const name of names) {
    const buf = await fs.readFile(path.join(dir, name))
    if (buf.includes(needle)) return name
  }
  return null
}

/* ============================================ ① 敏感文件不进 files / 对象仓 */

test('t8 ① 敏感文件不明文物化：不进 files、对象仓零明文字节；模板与公钥照常进', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)

  const captured = await capture(engine, fx)
  assert.equal(captured.ok, true, captured.detail ?? captured.code)
  const track = captured.point?.workspace
  assert.equal(track?.ok, true)
  // 设计内跳过 ≠ 降级（否则有 .env 的仓库每个点都挂着「回退可能不完整」）
  assert.equal(track?.degraded, false)
  const payload = track?.payload
  assert.ok(payload !== null && payload !== undefined)

  const files = sorted(payload.files.map((file) => relOf(fx.ws, file.path)))
  assert.deepEqual(files, ['.env.example', 'README.md', 'id_rsa.pub'],
    '只有模板 / 公钥 / 普通文件进快照，实际 ' + JSON.stringify(files))

  const sensitiveSkipped = sorted(payload.skipped
    .filter((entry) => entry.reason === 'sensitive')
    .map((entry) => relOf(fx.ws, entry.path)))
  assert.deepEqual(sensitiveSkipped, sorted(SENSITIVE_FILES.map((item) => item.rel)),
    '五个敏感文件必须逐条进 skipped(reason=sensitive)，实际 ' + JSON.stringify(sensitiveSkipped))
  assert.ok(payload.skippedCount >= SENSITIVE_FILES.length)
  assert.notEqual(payload.skippedTruncated, true, '五条远低于记录上限，不得被截断')

  // 记录（载荷 JSON）本身不得出现明文
  const record = captured.point as RollbackPointRecord
  assert.equal(JSON.stringify(record.workspace.payload).includes('TOPSECRET'), false)

  // 真盘：对象仓任何对象都不得含明文标记
  const leak = await storeHasMarker(engine, 'TOPSECRET')
  assert.equal(leak, null, '对象仓出现明文字节（对象 ' + String(leak) + '）')
})

/* ================================= ② 用户 ! 规则取消不了内置敏感排除 */

test('t8 ② 用户规则写 !.env 也不能让敏感文件被采集（内置不可反向取消）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  // 先正后反：按 gitignore 语义「最后一条命中说了算」，用户规则本会放行这三个
  await fs.writeFile(path.join(fx.ws, '.dsh-rollback-ignore'), [
    '.env',
    '!.env',
    '.env.local',
    '!.env.local',
    '*.pem',
    '!*.pem',
    '',
  ].join('\n'))
  const engine = makeEngine(fx)

  const captured = await capture(engine, fx)
  assert.equal(captured.ok, true, captured.detail ?? captured.code)
  const payload = captured.point?.workspace.payload
  assert.ok(payload !== null && payload !== undefined)
  const files = payload.files.map((file) => relOf(fx.ws, file.path))

  for (const rel of ['.env', '.env.local', 'app.pem']) {
    assert.equal(files.includes(rel), false, '内置敏感排除不可被 ! 规则取消：' + rel)
  }
  const sensitiveSkipped = payload.skipped.filter((entry) => entry.reason === 'sensitive').map((entry) => relOf(fx.ws, entry.path))
  for (const rel of ['.env', '.env.local', 'app.pem']) {
    assert.ok(sensitiveSkipped.includes(rel), rel + ' 必须以 reason=sensitive 留痕')
  }
  // 规则文件本身是普通文件，照常进快照（证明采集没有被整体中断）
  assert.ok(files.includes('.dsh-rollback-ignore'), JSON.stringify(files))
})

/* =============================== ③ 删除集不受影响（证明名单仍完整） */

test('t8 ③ 敏感文件仍在证明名单里：removeCreated 回退只删「真的在留点后新建」的路径', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx)
  const captured = await capture(engine, fx)
  const id = captured.point?.id ?? ''
  assert.notEqual(id, '')
  assert.equal(captured.ok, true, captured.detail ?? captured.code)

  // 留点之后新建一个普通文件：它才是删除候选
  await fs.writeFile(path.join(fx.ws, 'new.txt'), 'NEW')
  const preview = await engine.preview(id)
  assert.equal(preview.workspace.createdAfter, 1, '预览只该把 new.txt 算成「留点后新建」')

  // 只回退工作区段（本用例不关心会话 fork，故不注入 fork seam）
  const rewound = await engine.rewind({ id, userConfirmed: true, guardPolicy: 'off', removeCreated: true, mode: 'files' })
  assert.equal(rewound.outcome, 'restored', JSON.stringify(rewound.segments))
  const ws = rewound.segments.find((segment) => segment.state === 'workspace')
  assert.deepEqual(ws?.removedPaths, [path.join(fx.ws, 'new.txt')], '删除集只该有 new.txt')
  await assert.rejects(fs.readFile(path.join(fx.ws, 'new.txt')), { code: 'ENOENT' })

  // 敏感文件一个都不能少、内容一字不改（它们不在 files 里，但必须在证明名单里）
  for (const item of SENSITIVE_FILES) {
    assert.equal(await fs.readFile(path.join(fx.ws, item.rel), 'utf8'), item.body, item.rel + ' 被误删或改写')
  }
})

/* ================================================ ④ 判据形态表（纯函数） */

test('t8 ④ builtinSensitiveReason：保守命中 + 模板 / 公钥放行', () => {
  const hits = [
    '.env', '.env.local', '.env.production', '.ENV', 'conf/.env.staging',
    'id_rsa', 'x/id_ed25519', 'id_ecdsa', 'deep/dir/id_dsa',
    '.npmrc', 'sub/.pypirc', '.netrc', '.git-credentials', '.htpasswd',
    'a.pem', 'src/b.key', 'c.p12', 'd.pfx', 'e.jks', 'f.keystore', 'g.ppk',
  ]
  for (const rel of hits) assert.equal(builtinSensitiveReason(rel), 'sensitive', rel)

  const misses = [
    '.env.example', '.env.sample', '.env.template', 'conf/.env.example',
    'id_rsa.pub', 'x/id_ed25519.pub', 'README.md', 'src/main.ts', 'key.txt', 'env',
    '.envrc', 'not-a-key.pem.txt',
  ]
  for (const rel of misses) assert.equal(builtinSensitiveReason(rel), null, rel)
})
