/**
 * sync-view push 预览渲染模型测试（P0-②）：pushPreviewView 的 ok/error、
 * 分区行（计数 + changed 标记）、changedCount/remoteSnapshotCount、
 * 加密提示与只读提示。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { SyncPushPreview } from '../../sync/sync-engine.ts';
import { zhUiT } from '../../ui/i18n.ts';
import { pushPreviewView } from './sync-view.ts';

const t = zhUiT;

function okPreview(partial: Partial<SyncPushPreview> = {}): SyncPushPreview {
  return {
    ok: true,
    sections: [
      { section: 'settings', count: 12, changed: true },
      { section: 'prompts', count: 0, changed: false },
    ],
    remoteSnapshotCount: 3,
    encrypted: false,
    ...partial,
  };
}

test('pushPreviewView: ok 预览 → 分区行 + 变更计数 + 远端快照数（P0-②）', () => {
  const view = pushPreviewView(okPreview(), t);
  assert.ok(view !== null && view.ok);
  assert.equal(view.rows.length, 2);
  assert.deepEqual(view.rows[0], { section: 'settings', count: 12, changed: true });
  assert.deepEqual(view.rows[1], { section: 'prompts', count: 0, changed: false });
  assert.equal(view.changedCount, 1, '只有一个分区有变化');
  assert.equal(view.remoteSnapshotCount, 3);
  assert.equal(view.error, null);
  assert.ok(view.previewHint.length > 0, '恒显示只读预览提示');
  assert.equal(view.encryptedHint, '');
});

test('pushPreviewView: 加密预览 → 基线不可比提示（P0-②）', () => {
  // 加密时引擎将所有分区标记 changed（无法对比基线）：构造与 previewPush 输出一致的载荷
  const view = pushPreviewView(okPreview({
    encrypted: true,
    sections: [
      { section: 'settings', count: 12, changed: true },
      { section: 'prompts', count: 0, changed: true },
    ],
  }), t);
  assert.ok(view !== null && view.encryptedHint.length > 0, '加密提示非空');
  assert.equal(view.changedCount, 2, '加密时所有分区标记为 changed（无法对比基线）');
});

test('pushPreviewView: 首次推送（远端 0 快照）→ remoteSnapshotCount=0（P0-②）', () => {
  const view = pushPreviewView(okPreview({ remoteSnapshotCount: 0 }), t);
  assert.ok(view !== null);
  assert.equal(view.remoteSnapshotCount, 0);
});

test('pushPreviewView: 失败预览 → error 透传（P0-②）', () => {
  const view = pushPreviewView({ ok: false, sections: [], remoteSnapshotCount: 0, encrypted: false, message: 'no portable sections' }, t);
  assert.ok(view !== null && !view.ok);
  assert.equal(view.error, 'no portable sections');
  assert.equal(view.rows.length, 0);
});

test('pushPreviewView: null 预览 → null（无弹窗内容）', () => {
  assert.equal(pushPreviewView(null, t), null);
});