/**
 * P-1 / P-2 / P-3 打包契约回归护栏（L1）。
 *
 * 背景：`package.json` 的 `peerDependenciesMeta`（18 个 peer 全 `optional`）与 `files`
 * （含 `!lib/**` + `*.map` 排除项）此前**没有任何自动化测试覆盖**——全库无测试读这两个字段，
 * 回归时不会报警（例如把 UI 包误加回 runtime `dependencies`，或删掉 sourcemap 排除项）。
 * P-3 补上 DSH 兼容闸关心的 `peerDependencies` 范围（issue #53）。
 *
 * V-1（版本四处一致）补上 AGENTS.md 的「发版门禁 ①」：`package.json.version` ≡
 * `src/index.ts` 的 `PLUGIN_VERSION` ≡ `package-lock.json` 根 `version` ≡
 * `package-lock.json.packages[""].version`（此前全库零断言：只改 `package.json`、漏改
 * `src/index.ts`，CI 依旧全绿，用户端「关于」页显示的版本与安装包不同）。
 *
 * 本文件只读 `package.json` / `package-lock.json` / `src/index.ts` 三份文本，
 * 零依赖（`node:test` + `node:assert`），不触碰网络与磁盘其它位置。
 * 每一条断言都做过变异验证（见文件末注释）：把对应字段改坏必须红灯。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

interface PackageJson {
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  files?: string[];
  exports?: Record<string, { types?: string; default?: string }>;
}

interface PackageLockJson {
  version?: string;
  packages?: Record<string, { version?: string } | undefined>;
}

const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageJson;

/* ---------------------------------------------------------------- P-1: peers */

test('P-1: peerDependencies 的每一个键都在 peerDependenciesMeta 中且 optional === true', () => {
  const peers = Object.keys(pkg.peerDependencies ?? {});
  const meta = pkg.peerDependenciesMeta ?? {};

  assert.ok(peers.length > 0, 'peerDependencies 不应为空');
  assert.ok(
    pkg.peerDependenciesMeta !== undefined,
    'peerDependenciesMeta 必须存在：缺少它时 npm 会尝试安装全部 peer（headless 消费者被迫装 React UI 栈）',
  );

  const missing = peers.filter((name) => meta[name] === undefined);
  assert.deepEqual(
    missing,
    [],
    `以下 peer 缺少 peerDependenciesMeta 条目（会被强制安装）: ${missing.join(', ')}`,
  );

  const notOptional = peers.filter((name) => meta[name]?.optional !== true);
  assert.deepEqual(
    notOptional,
    [],
    `以下 peer 的 optional 不为 true: ${notOptional.join(', ')}`,
  );

  // 数量一致：meta 里不得有 peer 之外的悬空键（防止改名后留下陈旧条目）
  const metaKeys = Object.keys(meta);
  assert.equal(
    metaKeys.length,
    peers.length,
    `peerDependenciesMeta 条目数（${metaKeys.length}）必须与 peerDependencies 键数（${peers.length}）一致`,
  );
  const stray = metaKeys.filter((name) => !peers.includes(name));
  assert.deepEqual(stray, [], `peerDependenciesMeta 含非 peer 键: ${stray.join(', ')}`);
});

test('P-1: dependencies 仅含 js-yaml（UI 包不得回到 runtime 依赖）', () => {
  const deps = Object.keys(pkg.dependencies ?? {});
  assert.deepEqual(
    deps,
    ['js-yaml'],
    `运行时 dependencies 只允许 js-yaml，实际: ${deps.join(', ') || '(空)'}。` +
      'lucide-react / @radix-ui/* 已由 tsdown alwaysBundle 内联进 lib/client.js，' +
      '放回 dependencies 会迫使 headless 消费者安装整套 React UI 栈。',
  );
  // 显式点名：即使将来允许更多 runtime 依赖，这两个也必须留在 devDependencies
  for (const ui of ['lucide-react', '@radix-ui/react-dialog']) {
    assert.ok(!deps.includes(ui), `${ui} 不得出现在 dependencies`);
  }
});

/* ---------------------------------------------------------------- P-2: files */

test('P-2: files 含 !lib/**/*.map 排除项', () => {
  const files = pkg.files;
  assert.ok(Array.isArray(files), 'files 必须是数组');
  assert.ok(
    files.includes('!lib/**/*.map'),
    `files 必须保留 '!lib/**/*.map' 排除项（否则 sourcemap 随包发布，体积显著增加）。实际: ${JSON.stringify(files)}`,
  );
});

test('P-2: files 仍包含 lib、src、cordis.patch.yml', () => {
  const files = pkg.files ?? [];
  for (const required of ['lib', 'src', 'cordis.patch.yml']) {
    assert.ok(files.includes(required), `files 必须包含 '${required}'。实际: ${JSON.stringify(files)}`);
  }
  // 排除项必须排在 'lib' 之后（npm 的 files 数组按顺序求值，顺序错则排除项失效）
  assert.ok(
    files.indexOf('!lib/**/*.map') > files.indexOf('lib'),
    "'!lib/**/*.map' 必须排在 'lib' 之后，否则排除不生效",
  );
});

/* ------------------------------------------------- exports["./schema"] 指向 */

test('exports["./schema"] 指向 lib/schema/index.{js,d.ts}（而非纯类型产物 types.js）', () => {
  const entry = pkg.exports?.['./schema'];
  assert.ok(entry !== undefined, 'exports["./schema"] 必须存在');
  assert.equal(entry.default, './lib/schema/index.js', 'default 必须指向 lib/schema/index.js');
  assert.equal(entry.types, './lib/schema/index.d.ts', 'types 必须指向 lib/schema/index.d.ts');
});
/* ---------------------------------- P-3: DSH peer 范围（issue #53，2026-09） */

/**
 * DSH ≥ 0.1.7 的兼容闸（`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`）对每一条
 * 形如 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer 逐个跑
 * `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`，任一不满足 → 整份 bundle
 * 在启动时被跳过（stderr 只多一行 skipping profile bundle，进程照常起来、功能静默消失）。
 *
 * 为什么不能用「带预发布版的 caret」：semver 会给它补一个 `-0` 上界 ——
 *   validRange('^0.1.0-rc.6') === '>=0.1.0-rc.6 <0.2.0-0'
 * 于是 0.2.0 的任何预发布版（含 0.2.0-rc.1）都落在区间外 → 0.2 线整体被闸掉。
 *
 * 现行区间（显式上下界，`-0` 锚住整条 0.2 线的上界）：
 *   >=0.1.0-rc.6 <0.3.0-0
 * 实测（DSH 自带 semver，与闸门同一份实现）：
 *   0.1.0-rc.5 ✗ ｜ 0.1.0-rc.6 ✓ ｜ 0.1.5-rc.2 ✓ ｜ 0.1.7-rc.2 ✓ ｜ 0.2.0-rc.1 ✓ ｜ 0.2.0 ✓
 *   0.3.0-0 ✗ ｜ 0.3.0-rc.1 ✗ ｜ 1.0.0 ✗
 * 另用 dsh-app-boot@0.2.0-rc.1 的 `evaluatePluginCompatibility` 真跑过本插件 manifest：
 *   改前（^0.1.0-rc.6）+ runtime 0.2.0-rc.1 → INCOMPATIBLE（14 条 peer 全中）；
 *   改后 + runtime 0.1.5-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.1 → 全部 COMPATIBLE。
 */
const DSH_PEER_RANGE = '>=0.1.0-rc.6 <0.3.0-0';

/**
 * DSH peer 条数期望值（**恒定**，不是下界）。
 *
 * 2026-10-12（captain 授权）：15 → 16 —— 宿主斜杠命令 /rollback 需要
 * `@deepseek-ai/dsh-commands` 的注册契约，故把它加进 peerDependencies（optional: true，
 * 未组合该服务的部署照常启动）。判据不变：条数恒定 + 每条都是显式上下界；
 * 放宽成 `>= 15` 会让「悄悄多加一条 peer」失去守卫。
 */
const DSH_PEER_COUNT = 16;

test('P-3: 全部 @deepseek-ai/dsh* peer 都用显式上下界（不得回退到带预发布版的 caret）', () => {
  const dshPeers = Object.entries(pkg.peerDependencies ?? {})
    .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'));
  assert.equal(
    dshPeers.length,
    DSH_PEER_COUNT,
    `DSH peer 应恒为 ${DSH_PEER_COUNT} 条，实际 ${dshPeers.length}: ${dshPeers.map(([n]) => n).join(', ')}`,
  );
  for (const [name, range] of dshPeers) {
    assert.equal(
      range,
      DSH_PEER_RANGE,
      `${name} 的范围必须是 ${DSH_PEER_RANGE}（当前 ${range}）：带预发布版的 caret 上界是 <0.2.0-0，会把整条 0.2 线挡在兼容闸之外（issue #53）`,
    );
  }
});

test('P-3: 区间形态 = 显式下界 + `-0` 上界（caret/tilde 一律不匹配）', () => {
  const shape = /^>=\d+\.\d+\.\d+-[0-9A-Za-z.-]+ <\d+\.\d+\.\d+-0$/;
  assert.match(DSH_PEER_RANGE, shape, '必须是「显式下界 + -0 上界」形态');
  assert.ok(!/[\^~]/.test(DSH_PEER_RANGE), '区间不得使用 caret / tilde');
  // 变异验证：被禁形态必须真的不匹配，否则这条规则形同虚设
  for (const bad of ['^0.1.0-rc.6', '~0.1.0-rc.6', '^0.2.0-rc.1', '>=0.1.0-rc.6 <0.3.0']) {
    assert.ok(!shape.test(bad), `${bad} 不应通过形态校验`);
  }
});

/* ------------------------------------------ V-1: 版本四处一致（发版门禁 ①） */

/**
 * AGENTS.md「🔢 版本三处必须同步（最易漏）」/「发版前必做两道门禁 ①」：
 *   `package.json.version` ≡ `src/index.ts` 的 `PLUGIN_VERSION`
 *   ≡ `package-lock.json` 根对象 `version` ≡ `package-lock.json.packages[""].version`
 * 实测此前**全库无任何断言**覆盖这条门禁（`ci.yml` / `publish.yml` 也没有对应步骤），
 * 于是「只改 package.json 的版本、不改 src/index.ts」可以一路发到用户机器上：
 * 安装的包是 0.1.99，而「关于」页（`GET /prefs` 回传的 `currentVersion`，源自
 * `PLUGIN_VERSION`）与导出 manifest 的 `exporter.version` 仍是旧值。
 *
 * 为什么不 import `src/index.ts` 取真实值：那是宿主入口，import 会拉起整条 DSH/Cordis
 * 依赖链与副作用；这里只需包字面量，源码级正则读取与同库其它源码守卫同口径。
 */
const pkgVersion = pkg.version;
const lock = JSON.parse(
  readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'),
) as PackageLockJson;

/** 从 `src/index.ts` 提取 `export const PLUGIN_VERSION = '<version>'` 的字面量。 */
function readPluginVersionFromSource(): string {
  const source = readFileSync(path.join(repoRoot, 'src', 'index.ts'), 'utf8');
  const match = /^export const PLUGIN_VERSION = '([^']+)'$/m.exec(source);
  assert.ok(
    match !== null,
    "src/index.ts 必须存在形如 `export const PLUGIN_VERSION = '<版本>'` 的导出行" +
      '（单引号字符串字面量，整行无缩进）——版本门禁无法从源码取值时不得静默通过',
  );
  const captured = match[1];
  assert.ok(captured !== undefined && captured.length > 0, 'PLUGIN_VERSION 不得为空字符串');
  return captured;
}

test("V-1: 四处版本自洽基准 —— package.json.version 存在且为语义化版本字符串", () => {
  assert.equal(
    typeof pkgVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(pkgVersion),
    true,
    `package.json.version 必须是非空的 <major>.<minor>.<patch> 形态字符串，实际: ${JSON.stringify(pkgVersion)}`,
  );
});

test('V-1: src/index.ts 的 PLUGIN_VERSION 必须与 package.json.version 一致', () => {
  const pluginVersion = readPluginVersionFromSource();
  assert.equal(
    pluginVersion,
    pkgVersion,
    `版本不同步：src/index.ts 的 PLUGIN_VERSION = ${pluginVersion}，` +
      `package.json.version = ${String(pkgVersion)}。` +
      '两处必须同时 bump —— 漏改 src/index.ts 时「关于」页与导出 manifest 的 exporter.version ' +
      '会与实际安装的包不同（AGENTS.md「版本三处必须同步」/ 发版门禁 ①）',
  );
});

test('V-1: package-lock.json 根对象 version 必须与 package.json.version 一致', () => {
  assert.equal(
    lock.version,
    pkgVersion,
    `版本不同步：package-lock.json 顶层 "version" = ${String(lock.version)}，` +
      `package.json.version = ${String(pkgVersion)}。` +
      '请在版本 bump 后重跑 `npm install --legacy-peer-deps` 让 lock 根对象同步（或手工改这一行）',
  );
});

test('V-1: package-lock.json.packages[""].version 必须与 package.json.version 一致', () => {
  const entry = lock.packages?.[''];
  assert.ok(
    entry !== undefined,
    'package-lock.json 的 packages[""] 根条目缺失：lock 文件结构已损坏，请重跑 `npm install --legacy-peer-deps`',
  );
  assert.equal(
    entry.version,
    pkgVersion,
    `版本不同步：package-lock.json 的 packages[""].version = ${String(entry.version)}，` +
      `package.json.version = ${String(pkgVersion)}。` +
      'lockfileVersion 3 的根条目版本与顶层 version 必须同源，否则 `npm ci` 与发布产物会各说各话',
  );
});

/* ------------------------------------------------- G-21: git 源安装可构建（issue #58） */

/**
 * issue #58 的根因不是「往仓库里塞了不该有的东西」，而是**包缺少 git 安装所需的构建入口**：
 * npm 上发的是预构建产物（`lib/`），而 `dsh plugin add git+https://...` 拿到的是**源码树** ——
 * pnpm 需要在 clone 里跑一个构建脚本才能得到 `lib/`。此前 `scripts` 里没有任何 pnpm 认的
 * 构建入口（`prepare` 只在**发布前**校验、不参与安装），于是 git 安装 100% 失败：
 * ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED ... needs to execute build scripts。
 *
 * 三条断言把「git 安装能构建」钉成契约（真机复核：加白名单后
 * `pnpm add git+file:///<repo>` 走完 prepare → lib/index.js 与 lib/client.js 均产出）。
 */
test('G-21: scripts.prepare 必须存在且真的跑构建（git 源安装的唯一构建入口）', () => {
  const scripts = (pkg as { scripts?: Record<string, string> }).scripts ?? {};
  const prepare = scripts['prepare'];
  assert.ok(
    typeof prepare === 'string' && prepare.trim() !== '',
    'package.json 必须声明 scripts.prepare —— 缺了它 `dsh plugin add git+https://...` 必然失败'
      + '（pnpm 在 clone 里找不到任何构建入口；npm 安装不受影响，所以本地与 CI 都不会报警）',
  );
  assert.match(
    prepare,
    /npm run build|npm run bundle/,
    'scripts.prepare 必须调用本仓库的构建脚本（build/bundle）—— 换别的命令会让 git 安装'
      + '得到一个没有 lib/ 的包（安装「成功」但插件加载即失败）',
  );
});

test('G-21: files 白名单必须收进 lib/（git 安装的构建产物要能被打包）', () => {
  const files = pkg.files ?? [];
  assert.ok(
    files.includes('lib'),
    'files 未包含 lib：npm 忽略 .gitignore 但仍遵守 files —— 漏掉它会让发布产物缺少构建输出',
  );
});

test('G-21: 构建产物目录被 gitignore（prepare 现构建的前提，不得提交 lib/）', () => {
  const ignore = readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  assert.match(
    ignore,
    /^lib\/?$/m,
    '.gitignore 必须忽略 lib/ —— 若把构建产物提交进仓库，git 安装拿到的可能是过期产物，'
      + '而 prepare 的成败不再代表「源码能构建」',
  );
});

/* ------------------------------------------------------------ 变异验证记录

V-1（版本四处一致，2026-09 新增）：把 `src/index.ts` 的 `PLUGIN_VERSION` 临时改成
`'0.0.0-test'` → 「V-1: src/index.ts 的 PLUGIN_VERSION 必须与 package.json.version 一致」
**红灯**（AssertionError: actual `0.0.0-test` / expected `0.1.67`，其余 10 条仍绿）；
改回 `'0.1.67'` 后 11/11 全绿，并用 `node` 读回确认磁盘上恢复原值。
（P-1 / P-2 / P-3 的变异验证记录见 `docs/spec/known-gaps.md` §1 L1 与 issue #53。）
*/

