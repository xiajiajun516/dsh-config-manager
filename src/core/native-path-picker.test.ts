/**
 * 原生目录选择器的调度逻辑单测（不弹窗、不 spawn 真进程：全部走注入的 spawner）。
 *
 * 真机那半（PowerShell 的 IFileOpenDialog 到底能不能弹出来）无法在无头测试里断言，
 * 由方案的 `Probe` 自检 + 人工目测覆盖；本文件只钉住**我们自己的**判断逻辑：
 * 三态区分（ok / canceled / unsupported·failed）、取消不当错误、能力缺失必须回落、
 * 起始路径与标题经环境变量传递、以及路径归一化不毁掉盘符根。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PICK_ENV_START,
  PICK_ENV_TITLE,
  pickNativeDirectory,
} from './native-path-picker.ts';
import type { NativePickExec, NativePickRun } from './native-path-picker.ts';

/** 造一个 spawner：按调用顺序吐出预设结果，并记录每次 run（便于断言 argv/env）。 */
function scripted(results: Partial<NativePickExec>[]): { spawner: (run: NativePickRun) => Promise<NativePickExec>; runs: NativePickRun[] } {
  const runs: NativePickRun[] = [];
  let index = 0;
  return {
    runs,
    spawner: async (run) => {
      runs.push(run);
      const preset = results[index] ?? {};
      index += 1;
      return { code: 0, stdout: '', stderr: '', missing: false, ...preset };
    },
  };
}

test('win32：选中路径 → ok，且起始路径/标题走环境变量而不是命令行', async () => {
  const { spawner, runs } = scripted([{ code: 0, stdout: 'D:\\Projects\\picked\\\r\n' }]);
  const result = await pickNativeDirectory({ platform: 'win32', startPath: 'D:\\Projects', title: '选择本机路径', spawner });
  assert.deepEqual(result, { ok: true, path: 'D:\\Projects\\picked' });
  const run = runs[0];
  assert.ok(run !== undefined);
  assert.equal(run.file, 'powershell');
  // -STA 必须在：PowerShell 7 默认 MTA，COM 模态窗口会直接失败。
  assert.ok(run.args.includes('-STA'));
  assert.equal(run.env[PICK_ENV_START], 'D:\\Projects');
  assert.equal(run.env[PICK_ENV_TITLE], '选择本机路径');
  // 用户给的字符串绝不进 argv（否则就等于拼进脚本了）。
  assert.ok(!run.args.some((arg) => arg.includes('picked') || arg.includes('选择本机路径')));
});

test('win32：退出码 2（用户取消）→ canceled，不是失败', async () => {
  const { spawner } = scripted([{ code: 2 }]);
  assert.deepEqual(await pickNativeDirectory({ platform: 'win32', spawner }), { ok: false, reason: 'canceled' });
});

test('win32：HRESULT 错误 → failed 并带回 detail', async () => {
  const { spawner } = scripted([{ code: 3, stderr: 'ERR:-2147024809\r\n' }]);
  const result = await pickNativeDirectory({ platform: 'win32', spawner });
  assert.deepEqual(result, { ok: false, reason: 'failed', detail: 'ERR:-2147024809' });
});

test('win32：powershell 不存在 → unsupported（客户端回落内置浏览器）', async () => {
  const { spawner } = scripted([{ missing: true, code: null }]);
  const result = await pickNativeDirectory({ platform: 'win32', spawner });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : '', 'unsupported');
});

test('win32：空 stdout 当作取消处理（窗口关了但没给路径）', async () => {
  const { spawner } = scripted([{ code: 0, stdout: '  \r\n' }]);
  assert.deepEqual(await pickNativeDirectory({ platform: 'win32', spawner }), { ok: false, reason: 'canceled' });
});

test('win32：盘符根与 POSIX 根的原样保留 / 常规尾部反斜杠剥离', async () => {
  for (const [stdout, expected] of [
    ['D:\\\r\n', 'D:\\'],
    ['D:\\Apps\\nodejs\\\r\n', 'D:\\Apps\\nodejs'],
    ['/home/me/docs/\r\n', '/home/me/docs'],
    ['/\r\n', '/'],
  ] as const) {
    const { spawner } = scripted([{ code: 0, stdout }]);
    const result = await pickNativeDirectory({ platform: 'win32', spawner });
    assert.deepEqual(result, { ok: true, path: expected }, `归一化 ${JSON.stringify(stdout)} 期望 ${expected}`);
  }
});

test('darwin：osascript 选中 → ok；取消（-128 / 退出码 1）→ canceled', async () => {
  const ok = scripted([{ code: 0, stdout: '/Users/me/Documents\n' }]);
  assert.deepEqual(await pickNativeDirectory({ platform: 'darwin', spawner: ok.spawner }), { ok: true, path: '/Users/me/Documents' });
  assert.equal(ok.runs[0]?.file, 'osascript');

  const canceled = scripted([{ code: 0, stderr: 'execution error: User canceled. (-128)\n' }]);
  assert.deepEqual(await pickNativeDirectory({ platform: 'darwin', spawner: canceled.spawner }), { ok: false, reason: 'canceled' });
});

test('linux：zenity 缺失时自动换 kdialog；两个都没有 → unsupported', async () => {
  const fallback = scripted([{ missing: true, code: null }, { code: 0, stdout: '/home/me\n' }]);
  assert.deepEqual(await pickNativeDirectory({ platform: 'linux', startPath: '/home', spawner: fallback.spawner }), { ok: true, path: '/home/me' });
  assert.equal(fallback.runs[0]?.file, 'zenity');
  assert.equal(fallback.runs[1]?.file, 'kdialog');

  const none = scripted([{ missing: true, code: null }, { missing: true, code: null }]);
  const result = await pickNativeDirectory({ platform: 'linux', spawner: none.spawner });
  assert.equal(result.ok === false ? result.reason : '', 'unsupported');
});

test('其他平台：直接 unsupported，且根本不 spawn', async () => {
  const { spawner, runs } = scripted([]);
  const result = await pickNativeDirectory({ platform: 'freebsd', spawner });
  assert.equal(result.ok === false ? result.reason : '', 'unsupported');
  assert.equal(runs.length, 0);
});
