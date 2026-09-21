/**
 * 日志器单测：级别解析（宿主入口 DSH_CONFIG_MANAGER_LOG_LEVEL 的默认值 = warn）
 * + 级别过滤（默认 warn 时 info/debug 不落 sink，warn/error 照常）+ 脱敏不回归。
 * 背景：用户要求启动 dsh web 后控制台不再输出常规 info 噪音（挂载横幅 / 调度器跳过 /
 * 导出与备份完成），故插件缺省级别由 info 改为 warn。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createLogger, parseLogLevel } from './logger.ts';

test('parseLogLevel: 合法值原样返回（大小写 / 空白不敏感）', () => {
  assert.equal(parseLogLevel('debug'), 'debug');
  assert.equal(parseLogLevel('info'), 'info');
  assert.equal(parseLogLevel('warn'), 'warn');
  assert.equal(parseLogLevel('error'), 'error');
  assert.equal(parseLogLevel(' INFO '), 'info');
  assert.equal(parseLogLevel('Error'), 'error');
});

test('parseLogLevel: 缺省 / 空 / 非法值 → fallback（插件默认 warn）', () => {
  assert.equal(parseLogLevel(undefined), 'warn');
  assert.equal(parseLogLevel(''), 'warn');
  assert.equal(parseLogLevel('   '), 'warn');
  assert.equal(parseLogLevel('verbose'), 'warn');
  assert.equal(parseLogLevel('silent'), 'warn');
  // fallback 可显式指定（其它宿主接线 / 测试可复用）
  assert.equal(parseLogLevel(undefined, 'info'), 'info');
  assert.equal(parseLogLevel('bogus', 'debug'), 'debug');
});

test('默认级别 warn：info/debug 不输出，warn/error 照常输出', () => {
  const lines: { level: string; message: string }[] = [];
  const log = createLogger({
    level: parseLogLevel(undefined),
    sink: (level, message) => {
      lines.push({ level, message });
    },
  });

  // 启动噪音：挂载横幅 + 两个调度器的「未达阈值」跳过
  log.info('config-manager 已挂载', { homeDir: 'C:\\Users\\x\\.dsh' });
  log.info('自动同步启动触发跳过（git）：距上次运行未达阈值');
  log.info('定时备份启动触发跳过：距上次运行未达阈值');
  // 操作噪音：导出 / 备份完成 / 保留策略清理
  log.info('导出完成', { file: 'export-plain-0000.zip' });
  log.info('手动备份完成', { zip: 'dsh-config-auto-0000.zip' });
  log.info('定时备份保留策略清理', { removed: ['old.zip'] });
  log.debug('调试细节');

  // 只有真问题才进控制台
  log.warn('自动同步连续失败 3 次，请检查仓库配置/凭据（git）');
  log.error('导出失败');

  assert.deepEqual(
    lines.map((l) => l.level),
    ['warn', 'error'],
  );
  assert.deepEqual(
    lines.map((l) => l.message),
    ['自动同步连续失败 3 次，请检查仓库配置/凭据（git）', '导出失败'],
  );
});

test('级别放宽后 info 恢复输出（DSH_CONFIG_MANAGER_LOG_LEVEL=info 的排查路径）', () => {
  const lines: string[] = [];
  const log = createLogger({
    level: parseLogLevel('info'),
    sink: (_level, message) => {
      lines.push(message);
    },
  });

  log.debug('不输出');
  log.info('config-manager 已挂载');
  assert.deepEqual(lines, ['config-manager 已挂载']);
});

test('生产路径（默认 console sink）: info 静音 + meta 脱敏不因改级别放宽', () => {
  const printed: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => {
    printed.push(args.map((a) => String(a)).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    printed.push(args.map((a) => String(a)).join(' '));
  };
  try {
    const log = createLogger({ level: parseLogLevel(undefined) });
    log.info('同步凭据已写入', { password: 'plain-text' }); // 静音：不落 console
    log.warn('凭据读取失败', { password: 'plain-text' }); // 输出 + 脱敏
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  assert.equal(printed.length, 1, '只有 warn 一行落 console');
  const line = printed[0]!;
  assert.match(line, /"level":"warn"/);
  assert.match(line, /"msg":"凭据读取失败"/);
  assert.ok(line.includes('"password":"***REDACTED***"'), 'meta 敏感字段必须脱敏: ' + line);
  assert.ok(!line.includes('plain-text'), '明文不得出现在日志行: ' + line);
});
