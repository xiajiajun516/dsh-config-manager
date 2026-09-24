/**
 * 日志器单测：级别解析（宿主入口 DSH_CONFIG_MANAGER_LOG_LEVEL 的默认值 = warn）
 * + 级别过滤（默认 warn 时 info/debug 不落 sink，warn/error 照常）+ 脱敏不回归。
 * 背景：用户要求启动 dsh web 后控制台不再输出常规 info 噪音（挂载横幅 / 调度器跳过 /
 * 导出与备份完成），故插件缺省级别由 info 改为 warn。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createLogger, parseLogLevel, redact, redactValue } from './logger.ts';

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

/* ================= P0-2 回归：字段名判定必须走 security 侧唯一口径 =================
 * 原实现（utils/logger.ts 自查）自带第二份名单 + toLowerCase 子串匹配：
 *   redactValue 用 lower.includes(f) —— 'api_key' 不含 'apikey'、'auth_header' 不含 'authorization'
 *   名单里压根没有 pwd / passphrase / authheader
 * 于是宿主日志（index.ts 的 createLogger 默认 console sink）漏掩码这些字段。
 * 口径唯一来源 = src/security/secret-scanner.ts 的 normalizeFieldName + isSensitiveFieldName。 */

/** 一次性覆盖验收清单里的全部键名（真实对象，不是字符串拼接） */
const SENSITIVE_META_KEYS = [
  'api_key', 'apikey', 'auth_header', 'authheader', 'Authorization',
  'pwd', 'passphrase',
] as const;

test('redactValue: 分隔符/大小写/名单差异的敏感键全部掩码（api_key|auth_header|pwd|passphrase…）', () => {
  const meta: Record<string, unknown> = {};
  for (const [i, k] of SENSITIVE_META_KEYS.entries()) meta[k] = `plaintext-${i}`;
  const redacted = redactValue(meta) as Record<string, unknown>;
  for (const k of SENSITIVE_META_KEYS) {
    assert.equal(redacted[k], '***REDACTED***', `字段 ${k} 必须被掩码: ${JSON.stringify(redacted)}`);
  }
});

test('redactValue: 嵌套对象 / 数组元素里的敏感键同样掩码，非敏感键零误伤', () => {
  const redacted = redactValue({
    nested: { auth_header: 'h', pwd: 'p' },
    list: [{ passphrase: 'pp' }, { note: 'keep' }],
    user: 'alice',
    sessionIds: ['s1'],
    monkey: 'banana',
    path: 'C:/tmp/x',
  }) as Record<string, unknown>;
  assert.deepEqual(redacted['nested'], { auth_header: '***REDACTED***', pwd: '***REDACTED***' });
  assert.deepEqual(redacted['list'], [{ passphrase: '***REDACTED***' }, { note: 'keep' }]);
  // 反例：不能被过宽子串吃掉（secret-scanner 明确不收 'key'/'session' 这类过宽词）
  assert.equal(redacted['user'], 'alice');
  assert.deepEqual(redacted['sessionIds'], ['s1']);
  assert.equal(redacted['monkey'], 'banana');
  assert.equal(redacted['path'], 'C:/tmp/x');
});

test('redactValue: 原对象不被就地改写（返回新对象）', () => {
  const original = { api_key: 'sk-plain' };
  redactValue(original);
  assert.equal(original['api_key'], 'sk-plain');
});

test('生产路径（默认 console sink）: 弱名单时代漏掩码的键在日志行里不留明文', () => {
  const printed: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    printed.push(args.map((a) => String(a)).join(' '));
  };
  try {
    const log = createLogger({ level: 'warn' });
    log.warn('同步失败', {
      api_key: 'sk-leak-1',
      auth_header: 'Bearer sk-leak-2',
      pwd: 'leak-3',
      passphrase: 'leak-4',
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(printed.length, 1);
  const line = printed[0]!;
  for (const leak of ['sk-leak-1', 'sk-leak-2', 'leak-3', 'leak-4']) {
    assert.ok(!line.includes(leak), `明文不得出现在日志行（${leak}）: ${line}`);
  }
  assert.ok(line.includes('***REDACTED***'), '必须出现掩码标记: ' + line);
});

test('redact（文本级）: api_key= / auth_header: 形态按字段名判定掩码', () => {
  const text = 'connect api_key=sk-plain-1 auth_header: Bearer sk-plain-2 pwd=pw-plain-3 done';
  const out = redact(text);
  for (const leak of ['sk-plain-1', 'sk-plain-2', 'pw-plain-3']) {
    assert.ok(!out.includes(leak), `文本级明文不得残留（${leak}）: ${out}`);
  }
  // 幂等：掩码产物再跑一遍不变
  assert.equal(redact(out), out);
});

/* ================= 审计残留（t26）：注入 sink 不得绕过脱敏 + meta 与 msg 同口径 =================
 * 原实现：脱敏写在**默认 console sink 的闭包**里 —— 注入自定义 sink（宿主/审计文件/测试内存 sink）
 * 直接拿到明文 msg 与 meta；且 meta 只做字段名级掩码，不像 msg 那样扫值形状（sk-/JWT/Bearer…）。
 * 修复后：脱敏在 createLogger 的核心包装里完成，任何 sink 只能拿到已脱敏的值，且两者同一口径。 */

test('注入自定义 sink：msg 与 meta 同样被脱敏（脱敏在 logger 核心，不在默认 console sink 闭包里）', () => {
  const got: { level: string; message: string; meta?: Record<string, unknown> }[] = [];
  const log = createLogger({
    level: 'debug',
    sink: (level, message, meta) => {
      got.push({ level, message, ...(meta === undefined ? {} : { meta }) });
    },
  });

  log.error('请求失败 Authorization: Bearer sk-custom-sink-leak-0001', {
    note: 'sk-custom-sink-leak-0002',                    // 键名不敏感、值是密钥 → 值形状掩码
    nested: { api_key: 'sk-plain-in-custom-sink-0003' }, // 键名敏感 → 整值替换
    list: [{ pwd: 'pw-leak-0004' }],
    user: 'alice',
    path: 'C:/tmp/x',
  });

  assert.equal(got.length, 1);
  const line = JSON.stringify(got[0]);
  for (const leak of ['sk-custom-sink-leak-0001', 'sk-custom-sink-leak-0002', 'sk-plain-in-custom-sink-0003', 'pw-leak-0004']) {
    assert.ok(!line.includes(leak), `自定义 sink 不得拿到明文（${leak}）: ${line}`);
  }
  assert.ok(line.includes('***REDACTED***'), '必须出现掩码标记: ' + line);
  // 零误伤（形状扫描不得吃掉正常值）
  assert.equal(got[0]!.meta?.['user'], 'alice');
  assert.equal(got[0]!.meta?.['path'], 'C:/tmp/x');
});

test('meta 与 msg 同口径：值形状（sk-/JWT/Bearer/GitHub PAT/URL query）同样掩码，键名不敏感也不漏', () => {
  const got: Record<string, unknown>[] = [];
  const log = createLogger({
    level: 'warn',
    sink: (_level, _message, meta) => {
      if (meta !== undefined) got.push(meta);
    },
  });

  log.warn('w', {
    note: 'sk-abc1234567890123456789012',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.zmFrZXNpZ25hdHVyZQ',
    header: 'Bearer abcdefghijklmnop',
    url: 'https://example.com/p?token=query-secret-value&page=1',
    gh: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    count: 3,
    ok: true,
    empty: '',
  });

  const flat = JSON.stringify(got[0]);
  for (const leak of [
    'sk-abc1234567890123456789012',
    'eyJhbGciOiJIUzI1NiJ9',
    'abcdefghijklmnop',
    'query-secret-value',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  ]) {
    assert.ok(!flat.includes(leak), `meta 明文不得残留（${leak}）: ${flat}`);
  }
  assert.equal(got[0]?.['count'], 3, '数字原样保留');
  assert.equal(got[0]?.['ok'], true);
  assert.equal(got[0]?.['empty'], '');
});

test('形状扫描零误伤：正常 meta / msg 不被掩码（本机路径 / URL 端口 / 等号参数 / 普通列表）', () => {
  const got: { message: string; meta?: Record<string, unknown> }[] = [];
  const log = createLogger({
    level: 'info',
    sink: (_level, message, meta) => {
      got.push({ message, ...(meta === undefined ? {} : { meta }) });
    },
  });

  log.info('导出完成 dsh-config-2026-09-13.zip', {
    file: 'dsh-config-2026-09-13.zip',
    sizeBytes: 1024,
    home: 'C:/Users/x/.dsh',
    url: 'http://127.0.0.1:3080/api/dsh-config-manager/status',
    interval: 'interval=30m',
    user: 'alice',
    list: ['a', 'b'],
  });

  const line = JSON.stringify(got[0]);
  assert.ok(line.includes('dsh-config-2026-09-13.zip'), '正常文件名不得被掩码: ' + line);
  assert.equal(got[0]!.meta?.['home'], 'C:/Users/x/.dsh');
  assert.equal(got[0]!.meta?.['url'], 'http://127.0.0.1:3080/api/dsh-config-manager/status');
  assert.equal(got[0]!.meta?.['interval'], 'interval=30m');
  assert.deepEqual(got[0]!.meta?.['list'], ['a', 'b']);
  assert.equal(got[0]!.meta?.['sizeBytes'], 1024);
});
