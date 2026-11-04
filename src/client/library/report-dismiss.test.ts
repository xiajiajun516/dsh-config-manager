/**
 * 恢复报告「退出入口」守卫（本仓库 React 无组件测试框架，沿用 src/client/common/*.test.ts 的源码守卫模式）。
 *
 * 背景：快照恢复执行完成后，面板把结果渲染成「恢复报告」，但报告只有标题、
 * 没有任何按钮 —— 页面就停在报告上，用户找不到返回入口；且 report 随 runStore 切片
 * 落 sessionStorage，切页签/刷新后还会「复活」，等于把用户永久留在报告上。
 *
 * 因此钉住两条不变量：
 *  1. 报告头部必须渲染一个显式退出按钮（onClick=dismissReport）；
 *  2. dismissReport 必须经 patch()（= commit → runStore.patch）清空 report，
 *     只改本地 state 会让报告在切页签/刷新后重新出现；
 *  3. 按钮文案必须来自字典（zh/en 键集合相等，禁止硬编码用户可见字符串）。
 *
 * 已做变异验证：删掉按钮或把 dismissReport 改成 setState → 红灯。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
// UI v2：旧的 snapshots 面板已解散，恢复报告改由产物库的动作层以 Modal 呈递 ——
// 退出入口从「报告块内的按钮」变成「Modal.Footer 的完成按钮」，语义不变（必须显式退出）。
const PANEL = path.join(ROOT, 'src', 'client', 'library', 'LibraryActions.tsx')
// 字典已按页面域拆成 src/client/locales/*.ts（聚合器只剩 import/展开，没有字面量）——守卫跟着扫目录。
const LOCALES_DIR = path.join(ROOT, 'src', 'client', 'locales')

/** 剥掉块注释与行注释（注释里的同名文字会造成假阳性，见 AGENTS.md 的 bundle 扫描教训）。 */
function stripComments(src: string): string {
  // issue #70：CRLF 检出下按行切分 / 定长窗口都会失真 —— 一律先归一 LF。
  return src.replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

// issue #70：下面的窗口按字符数切片，CRLF 会多出 71 个 \r 把锚点挤出窗口 ⇒ 先折 LF。
const panelSrc = stripComments(fs.readFileSync(PANEL, 'utf8').replace(/\r\n/g, '\n'))

test('恢复报告：必须以 Modal 呈递，且退出按钮在 Modal.Footer 里', () => {
  // 锚点 = 恢复报告**自己的 Modal 开标签**。不能按 `report !== null` 定位：
  // ① 文件的 Modal 开标签在 `{report !== null && (` 之前（判断在 Modal.Body 里）；
  // ② 别处也有含该子串的表达式（如咨询弹窗的 `consult.report !== null`）⇒ 宽匹配会飘。
  const start = panelSrc.indexOf('<Modal open={report !== null}')
  assert.ok(start > 0, '找不到恢复报告 Modal（<Modal open={report !== null}>）')
  // issue #70：不再用「start + 900 字符」定长窗口（CRLF 下每行多 1 字节 → 覆盖的逻辑行数变少，
  // Windows CI 上 Footer 断言会假红）。改成自锚点起按行切片，与换行风格解耦。
  const block = panelSrc.slice(start).split('\n').slice(0, 30).join('\n')
  assert.match(block, /<Modal[\s\S]{0,200}title=\{t\('snapshots\.reportTitle'\)\}/, '报告必须走 Modal（Radix a11y + 正确层级）')
  assert.match(block, /<Modal\.Footer>[\s\S]{0,300}t\('snapshots\.reportDone'\)/, '退出按钮必须在 Modal.Footer 且文案来自字典')
})

test('恢复报告：默认不渲染（report 为 null），退出即清空 —— 绝不持久化', () => {
  // 旧实现把 report 存在 runStore 切片里，于是切页签/刷新后报告会「复活」。
  // UI v2 改为动作层内的**组件本地 state**：发起它的 Modal 一关就没了，无从复活。
  assert.match(panelSrc, /const \[report, setReport\] = useState<RestoreReport \| null>\(null\)/, 'report 必须是组件本地 state 且初值 null')
  assert.match(panelSrc, /onClick=\{\(\) => \{ setReport\(null\) \}\}/, '退出入口必须清空 report')
  const store = fs.readFileSync(path.join(ROOT, 'src', 'client', 'run-store.ts'), 'utf8')
  assert.ok(!/report: state\.snapshots\.report/.test(store), 'report 不得再进 toPersistedState（那正是「复活」的成因）')
})

test('恢复报告：snapshots.reportDone 在 zh / en 两套字典中都必须存在', () => {
  const files = fs.readdirSync(LOCALES_DIR).filter((name) => name.endsWith('.ts'))
  assert.ok(files.length > 0, '字典目录为空：拆分子文件找错位置了')
  const hits = files.flatMap((name) => [...fs.readFileSync(path.join(LOCALES_DIR, name), 'utf8').matchAll(/'snapshots\.reportDone':/g)])
  assert.equal(hits.length, 2, `snapshots.reportDone 必须 zh/en 各一条（实际 ${hits.length} 条）`)
})

test('issue #70（CRLF 检出）：报告守卫必须与换行风格解耦', () => {
  const raw = fs.readFileSync(PANEL, 'utf8');
  // 两侧都从归一 LF 的同一份文本派生（否则对已是 CRLF 的输入会得到 \r\r\n → 归一后变双换行）
  const lf = raw.replace(/\r\n?/g, '\n');
  // 剥注释结果必须与换行风格无关（原实现保留 \r，按行切分与定长窗口都会失真）
  assert.equal(
    stripComments(lf),
    stripComments(lf.replace(/\n/g, '\r\n')),
    'stripComments 必须先归一 LF，否则 CRLF 检出下守卫失真',
  );
  const crlf = stripComments(lf.replace(/\n/g, '\r\n'));
  const start = crlf.indexOf('<Modal open={report !== null}');
  assert.ok(start > 0, 'CRLF 下仍必须命中报告 Modal 锚点');
  // 按行切片（不再是 start+900 定长窗口）→ 与换行风格无关
  const block = crlf.slice(start).split('\n').slice(0, 30).join('\n');
  assert.match(block, /<Modal[\s\S]{0,200}title=\{t\('snapshots\.reportTitle'\)\}/, 'CRLF 下报告标题断言必须成立');
  assert.match(block, /<Modal\.Footer>[\s\S]{0,300}t\('snapshots\.reportDone'\)/, 'CRLF 下退出按钮断言必须成立');
});
