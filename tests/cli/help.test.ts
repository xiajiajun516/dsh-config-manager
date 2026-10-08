/**
 * 离线 CLI 帮助的两层渲染（2026-10 整理）：速查页（分组 / 对齐）+ 每命令详情页。
 *
 * 这里钉的是**结构性契约**：命令不丢、分组不漏、详情页字段齐、--help 主题路由正确、
 * 帮助里写的事实与实现同源。文案措辞不钉（改措辞不该红），
 * 但命令名 / 选项名 / 退出码这些「用户可依赖的事实」要钉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMAND_HELP, HELP_GROUPS, IMPORT_SOURCE_IDS,
  renderCommandHelp, renderOverview, usageColumnWidth,
} from '../../src/cli/help.ts';
import { parseCli, runCli, type CliIo } from '../../src/cli/index.ts';
import { FOREIGN_SOURCE_IDS } from '../../src/foreign/registry.ts';
import { DEFAULT_BACKUP_SECTIONS } from '../../src/core/backup-plan.ts';

function captureIo(): { io: CliIo; out: string[] } {
  const out: string[] = [];
  return { io: { log: (s) => { out.push(s); }, error: (s) => { out.push(s); } }, out };
}

test('H-01 速查页：分组引用的详情页都存在，且没有孤儿详情页', () => {
  const names = new Set(COMMAND_HELP.map((c) => c.name));
  const referenced = new Set<string>();
  for (const group of HELP_GROUPS) {
    assert.ok(group.rows.length > 0, '分组不能为空：' + group.title);
    for (const row of group.rows) {
      assert.ok(names.has(row.help), '分组「' + group.title + '」的 ' + row.usage + ' 指向不存在的详情页 ' + row.help);
      referenced.add(row.help);
    }
  }
  for (const name of names) {
    assert.ok(referenced.has(name), '详情页 ' + name + ' 在速查页里没有入口（孤儿）');
  }
});

test('H-02 速查页：命令都在、摘要同一列起、用法列只用 ASCII', () => {
  const lines = renderOverview('9.9.9');
  const width = usageColumnWidth();
  const text = lines.join('\n');
  for (const cmd of COMMAND_HELP) {
    if (cmd.name === 'sessions') continue; // 有三行，逐行断言在下面
    assert.ok(text.includes(cmd.name), '速查页缺少命令 ' + cmd.name);
  }
  const starts = new Set<number>();
  for (const group of HELP_GROUPS) {
    for (const row of group.rows) {
      assert.match(row.usage, /^[\x20-\x7E]+$/, '速查页用法列必须是 ASCII（CJK 会让对齐歪）：' + row.usage);
      const line = lines.find((l) => l.startsWith('  ' + row.usage.padEnd(width)));
      assert.ok(line !== undefined, '速查页找不到这一行：' + row.usage);
      starts.add(line!.indexOf(row.summary));
    }
  }
  assert.equal(starts.size, 1, '所有摘要必须从同一列开始（当前有 ' + [...starts].join(', ') + '）');
  assert.ok(text.includes('recover-stale-lock'), '速查页必须列出 recover-stale-lock');
  assert.ok(text.includes('残留'), '速查页必须说明它用于回收残留锁');
});

test('H-03 详情页：字段齐全、未知命令返回 null', () => {
  for (const cmd of COMMAND_HELP) {
    const lines = renderCommandHelp(cmd.name, '9.9.9');
    assert.ok(lines !== null, '详情页渲染失败：' + cmd.name);
    const text = lines!.join('\n');
    assert.ok(text.startsWith(cmd.name + ' — ' + cmd.title), cmd.name + ' 详情页首行不对');
    for (const usage of cmd.usageLines) {
      assert.ok(text.includes('  dcm ' + usage), cmd.name + ' 详情页缺用法行：' + usage);
    }
    assert.ok(cmd.description.length > 0, cmd.name + ' 必须有说明');
    assert.ok(cmd.examples.length > 0, cmd.name + ' 必须有示例');
    for (const example of cmd.examples) {
      assert.ok(text.includes('  ' + example), cmd.name + ' 详情页缺示例：' + example);
    }
    let hasHelpFlag = false;
    for (const section of cmd.sections) {
      assert.ok(text.includes(section.title), cmd.name + ' 缺小节：' + section.title);
      for (const entry of section.entries) {
        assert.ok(text.includes(entry.flag), cmd.name + ' 缺条目 ' + entry.flag);
        assert.ok(text.includes(entry.desc), cmd.name + ' 缺条目说明：' + entry.desc);
        if (entry.flag.includes('--help')) hasHelpFlag = true;
      }
    }
    assert.ok(hasHelpFlag, cmd.name + ' 详情页必须列出 --help');
    assert.match(text, /版本 9\.9\.9/);
  }
  assert.equal(renderCommandHelp('nope', '9.9.9'), null, '未知命令必须返回 null');
});

test('H-04 parseCli：<命令> --help 与 help <命令> 都带上主题', () => {
  // 不含 help：`dcm help --help` 视作裸 help（打速查页），单独在下面钉住
  const commands = ['snapshots', 'restore', 'reinstall', 'recover-stale-lock', 'verify', 'backup', 'import', 'web', 'sessions'];
  for (const command of commands) {
    const r = parseCli([command, '--help']);
    assert.ok(r.ok, command + ' --help 不应报错');
    if (!r.ok) continue;
    assert.equal(r.options.command, 'help');
    assert.equal(r.options.helpTopic, command, command + ' --help 应带上主题');
  }
  // sessions 的子动作与独立解析器（此前这三种写法都会报「未知参数」）
  for (const args of [['sessions', '--help'], ['sessions', 'repair', '--help'], ['sessions', 'doctor', '-h']]) {
    const r = parseCli(args);
    assert.ok(r.ok, args.join(' ') + ' 不应报错');
    if (r.ok) assert.equal(r.options.helpTopic, 'sessions');
  }
  // `dcm help --help` 视作裸 help（打速查页）；`dcm help help` 才查 help 的详情页
  const bareHelp = parseCli(['help', '--help']);
  assert.ok(bareHelp.ok);
  if (bareHelp.ok) assert.equal(bareHelp.options.helpTopic, undefined, 'dcm help --help 应视作裸 help');
  const helpTopic = parseCli(['help', 'help']);
  assert.ok(helpTopic.ok);
  if (helpTopic.ok) assert.equal(helpTopic.options.helpTopic, 'help');

  const topic = parseCli(['help', 'verify']);
  assert.ok(topic.ok);
  if (topic.ok) assert.equal(topic.options.helpTopic, 'verify', 'help <命令> 应带上主题');
  const plain = parseCli(['help']);
  assert.ok(plain.ok);
  if (plain.ok) assert.equal(plain.options.helpTopic, undefined, '裸 help 不带主题');
});

test('H-05 runCli：help <命令> 打详情页；未知主题报错并回落速查页', async () => {
  const ok = captureIo();
  assert.equal(await runCli(['help', 'verify'], ok.io, {}), 0);
  const okText = ok.out.join('\n');
  assert.match(okText, /^verify — /, '必须直接打 verify 详情页');
  // 用法行如实列出 --id（2026-10-08：verify 现在文档化 --id 别名；位置参数与 --id 二选一）
  assert.match(okText, /dcm verify \[<file\|path> \| --id <file\|path>\]/);

  const viaFlag = captureIo();
  assert.equal(await runCli(['backup', '--help'], viaFlag.io, {}), 0);
  assert.match(viaFlag.out.join('\n'), /^backup — /);

  const bad = captureIo();
  assert.equal(await runCli(['help', 'nope'], bad.io, {}), 1, '未知主题必须非零退出');
  const badText = bad.out.join('\n');
  assert.match(badText, /未知命令/, '必须明说命令名不认识');
  assert.match(badText, /用法/, '未知主题后要回落速查页');
});

test('H-06 帮助里的事实与实现同源（防漂移）', () => {
  assert.deepEqual([...IMPORT_SOURCE_IDS], [...FOREIGN_SOURCE_IDS], 'import 来源清单必须与 registry 一致');
  const backup = COMMAND_HELP.find((c) => c.name === 'backup');
  assert.ok(backup !== undefined);
  const opt = backup!.sections.flatMap((s) => s.entries).find((e) => e.flag === '--sections <a,b,c>');
  assert.ok(opt !== undefined, 'backup 详情页必须说明 --sections');
  for (const id of DEFAULT_BACKUP_SECTIONS) {
    assert.ok(opt!.desc.includes(id), 'backup 缺省分区说明缺少 ' + id);
  }
});
