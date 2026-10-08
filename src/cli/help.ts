/**
 * 离线 CLI 帮助文案的单一事实源（2026-10 整理）。
 *
 * 帮助分两层，都由本文件渲染，**绝不在 index.ts 里再散写一遍文案**：
 *  - 速查页（`dcm help`）：按风险分组的命令表 + 通用选项，目标是「30 行内扫一眼就知道用哪个」；
 *  - 详情页（`dcm <命令> --help` / `dcm help <命令>`）：说明 / 选项 / 退出码 / 示例。
 *
 * 两条渲染约定（改文案前先读）：
 *  1. 速查页的「用法」列**只用 ASCII**（占位符写 `<file|path>` 而不是 `<文件|路径>`）：
 *     CJK 是双宽字符，混进 padEnd 对齐的一列会让整页参差。
 *  2. 退出码必须与实现一致 —— 判定逻辑在各 run* 函数里，这里只是结论；改了行为要同步改这里。
 */

/** import 的来源词表：必须与 src/foreign/registry.ts 的 FOREIGN_SOURCE_IDS 逐项一致（测试钉住） */
import { DEFAULT_BACKUP_SECTIONS } from '../core/backup-plan.ts';

export const IMPORT_SOURCE_IDS: readonly string[] = [
  'claude-code', 'hermes', 'cursor', 'codex', 'copilot', 'antigravity',
  'gemini', 'reasonix', 'opencode', 'mimocode', 'zcode', 'grokbuild', 'openclaw', 'pi',
  'kimi', 'kilocode', 'qoder', 'chatgpt', 'workbuddy', 'qwen', 'continue', 'cline',
  'goose', 'dsh4', 'zed', 'crush', 'teleagent', 'trae', 'vibe', 'dsh',
];

/** 详情页里的一个「左列 + 右列」条目（选项 / 退出码 / 子命令都用它） */
export interface HelpEntry {
  /** 左列，只用 ASCII */
  readonly flag: string;
  /** 右列说明（中文） */
  readonly desc: string;
}

export interface HelpSection {
  readonly title: string;
  readonly entries: readonly HelpEntry[];
}

export interface CommandHelp {
  /** 命令名（`dcm <name> --help` 与 `dcm help <name>` 的键） */
  readonly name: string;
  /** 详情页首行：`<name> — <title>` */
  readonly title: string;
  /** 速查页里那一行的用法片段（ASCII only、尽量短） */
  readonly usage: string;
  /** 速查页里那一行的摘要（中文、一行） */
  readonly summary: string;
  /** 详情页「用法」段（不含 `dcm` 前缀，每项一行） */
  readonly usageLines: readonly string[];
  /** 详情页「说明」段（每项一行） */
  readonly description: readonly string[];
  /** 详情页的键值段，按声明顺序渲染 */
  readonly sections: readonly HelpSection[];
  /** 详情页「示例」 */
  readonly examples: readonly string[];
}

/* ------------------------------------------------------------------ 速查页 */

export interface HelpRow {
  /** 用法片段（ASCII only） */
  readonly usage: string;
  /** 一行摘要 */
  readonly summary: string;
  /** 该行指向的详情页（CommandHelp.name；`sessions` 有三行指向同一页） */
  readonly help: string;
}

export interface HelpGroup {
  readonly title: string;
  readonly rows: readonly HelpRow[];
}

/** 通用选项（所有命令共有）——命令专属选项只出现在各自的详情页里 */
export const GENERAL_OPTIONS: readonly HelpEntry[] = [
  { flag: '--data-dir <dir>', desc: '快照 / 导出目录（缺省 $DSH_HOME/dsh-config-manager/snapshots）' },
  { flag: '--data-root <dir>', desc: '插件数据根 dataDir（自定义时必须显式传；缺省 $DSH_HOME/dsh-config-manager）' },
  { flag: '--home <dir>', desc: 'DSH home（缺省 $DSH_HOME，即 ~/.dsh）' },
  { flag: '-h, --help', desc: '显示本页帮助' },
];

/** 分组顺序 = 推荐阅读顺序：先诊断、再备份、再修复、最后才是危险的重装 */
export const HELP_GROUPS: readonly HelpGroup[] = [
  {
    title: '救急台（本机网页，最省事）',
    rows: [
      { usage: 'web', summary: '离线救急台：只读诊断 + 逐项确认的修复', help: 'web' },
    ],
  },
  {
    title: '查看（不改本机配置）',
    rows: [
      { usage: 'snapshots', summary: '列出导入前快照', help: 'snapshots' },
      { usage: 'verify [<file|path>]', summary: '只读自检备份 ZIP（无参 = 导出目录全部）', help: 'verify' },
      { usage: 'sessions list | doctor', summary: '列出本机会话 / 体检并给处置建议', help: 'sessions' },
    ],
  },
  {
    title: '备份与迁移（只写新文件）',
    rows: [
      { usage: 'backup', summary: '离线文件级备份（写出后自动自检）', help: 'backup' },
      { usage: 'import --from <source>', summary: '外部 agent 配置 → 标准 bundle ZIP', help: 'import' },
    ],
  },
  {
    title: '修复（会改本机文件；先看 --dry-run 计划）',
    rows: [
      { usage: 'restore [--dry-run]', summary: '回滚到导入前快照', help: 'restore' },
      { usage: 'sessions repair', summary: '把会话日志目录归位（缺省只报告）', help: 'sessions' },
      { usage: 'recover-stale-lock', summary: '回收残留环境锁（持有者已确证死亡才回收）', help: 'recover-stale-lock' },
    ],
  },
  {
    title: '危险（改变 DSH 安装 / 可能清数据）',
    rows: [
      { usage: 'reinstall', summary: '重装 DSH 程序本体（破坏性选择需二次确认）', help: 'reinstall' },
    ],
  },
  {
    title: '帮助',
    rows: [
      { usage: 'help [command]', summary: '本页 / 命令详情', help: 'help' },
    ],
  },
];

/* ------------------------------------------------------------------ 详情页 */

/** 把逗号分隔的词表折行（import 的 30 个来源用它，避免手抄一首巨长的单行） */
function wrapCsv(items: readonly string[], indent: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const item of items) {
    const piece = line === '' ? item : ', ' + item;
    if (line !== '' && indent.length + line.length + piece.length > width) {
      out.push(indent + line + ',');
      line = item;
    } else {
      line += piece;
    }
  }
  if (line !== '') out.push(indent + line);
  return out;
}

const IMPORT_DESCRIPTION: readonly string[] = [
  '读取本机已装的外部 agent 配置，翻译成插件能导入的标准 bundle v1 ZIP。',
  '凭据值绝不进产物：只保留字段名与「需在 DSH 补录」的引用名。',
  '--cwd 给出项目级配置所在目录（缺省 = 进程当前目录）。',
  '可用来源（' + String(IMPORT_SOURCE_IDS.length) + '）：',
  ...wrapCsv(IMPORT_SOURCE_IDS, '  ', 78),
];

export const COMMAND_HELP: readonly CommandHelp[] = [
  {
    name: 'web',
    title: '离线救急台（本机网页）',
    usage: 'web',
    summary: '离线救急台：只读诊断 + 逐项确认的修复',
    usageLines: ['web [--port <n>] [--no-open] [--home <dir>] [--data-dir <dir>] [--data-root <dir>] [--profile <name>] [--idle-timeout <min>]'],
    description: [
      '启动一个只绑 127.0.0.1 的本机网页，把诊断与修复动作摆成能点的界面：',
      '实例心跳 / SAFE MODE / 残留锁 / 快照 / 备份自检 / 磁盘占用 / 会话体检 / 档案实例。',
      '页面里的写动作都要显式确认，且与 CLI 共用同一实现；重装 DSH 需要终端里打印的 6 位码。',
      '启动后终端打印带一次性 token 的 URL 并打开浏览器；Ctrl+C 或空闲超时即退出。',
      '页面无脚本、无外链（CSP default-src none），token 换 HttpOnly + SameSite=Strict cookie。',
    ],
    sections: [
      {
        title: '选项',
        entries: [
          { flag: '--port <n>', desc: '监听端口（缺省 0 = 内核分配；恒只绑 127.0.0.1）' },
          { flag: '--no-open', desc: '启动后不打开浏览器（SSH / 无桌面场景）' },
          { flag: '--idle-timeout <min>', desc: '空闲多少分钟自动退出（0 = 不自动退出；缺省 30）' },
          { flag: '--home <dir>', desc: '要查看的 DSH home（缺省 $DSH_HOME，即 ~/.dsh）' },
          { flag: '--data-dir <dir>', desc: '快照 / 导出目录（历史语义）：尾段是 snapshots / exports 时按它的父目录当数据根，再派生 快照/导出/锁 三个目录；否则整条按数据根处理（缺省 $DSH_HOME/dsh-config-manager）' },
          { flag: '--data-root <dir>', desc: '插件数据根 dataDir（自定义时必须显式传；给了就以它为准）' },
          { flag: '--profile <name>', desc: '救急台操作的 DSH profile（缺省 web；影响「恢复」页的目标档案）' },
          { flag: '-h, --help', desc: '显示本页' },
        ],
      },
      {
        title: '退出码',
        entries: [
          { flag: '0', desc: '正常退出（Ctrl+C 或空闲超时）' },
          { flag: '1', desc: '启动失败或参数错误（错误信息打到 stderr）' },
        ],
      },
    ],
    examples: ['dcm web', 'dcm web --no-open --port 3099'],
  },
  {
    name: 'snapshots',
    title: '列出导入前的安全快照',
    usage: 'snapshots',
    summary: '列出导入前快照',
    usageLines: ['snapshots [--data-dir <dir>]'],
    description: [
      '快照是每次导入前自动留下的整机配置副本；本命令只读，按新→旧列出：',
      'ID / 创建时间 / 来源 ZIP / 状态 / 条目数 / 宿主文件数 / 插件数。',
      '没有任何快照时打印「无快照」并照常返回 0。',
      '目录存在却读不出来（权限 / 路径被文件占住）时，把事实打到 stderr 并以非 0 退出 —— 读不到 ≠ 没有快照。',
    ],
    sections: [
      {
        title: '选项',
        entries: [
          { flag: '--data-dir <dir>', desc: '快照目录（缺省 $DSH_HOME/dsh-config-manager/snapshots）' },
          { flag: '-h, --help', desc: '显示本页' },
        ],
      },
      {
        title: '退出码',
        entries: [
          { flag: '0', desc: '列出成功（目录不存在、没有快照也是 0）' },
          { flag: '1', desc: '快照目录存在但读不出来（≠ 没有快照；原因打到 stderr）' },
        ],
      },
    ],
    examples: ['dcm snapshots', 'dcm snapshots --data-dir D:/rescue/snapshots'],
  },
  {
    name: 'verify',
    title: '只读自检备份 ZIP',
    usage: 'verify [<file|path>]',
    summary: '只读自检备份 ZIP（无参 = 导出目录全部）',
    usageLines: ['verify [<file|path> | --id <file|path>] [--json] [--data-dir <dir>]'],
    description: [
      '重新读取备份 ZIP，核对结构与 integrity/checksums.json 的逐条 SHA-256；全程零写入。',
      '无参数时校验导出目录下全部 *.zip；也可以给一个文件名或完整路径。',
      '每个文件给一个判定：',
    ],
    sections: [
      {
        title: '判定',
        entries: [
          { flag: 'OK', desc: '结构合法且每个条目都对得上 SHA-256' },
          { flag: 'MISSING', desc: '文件不在（路径写错 / 已删除）' },
          { flag: 'CORRUPT', desc: '损坏或被改动，报错会点名具体条目' },
          { flag: 'UNSUPPORTED', desc: '本版本读不了（schema 过新，或需先解锁的加密容器）' },
          { flag: 'VERIFY_ERROR', desc: '检查本身失败（磁盘 I/O），绝不降级成猜测' },
        ],
      },
      {
        title: '选项',
        entries: [
          { flag: '--json', desc: '机器可读输出（退出码仍为 0/1；出错的 JSON 也走 stdout）' },
          { flag: '--id <file|path>', desc: '待校验目标（文件名或路径）；与位置参数同义，同时给出时以 --id 为准' },
          { flag: '--data-dir <dir>', desc: '导出目录（缺省 $DSH_HOME/dsh-config-manager/exports）' },
          { flag: '-h, --help', desc: '显示本页' },
        ],
      },
      {
        title: '退出码',
        entries: [
          { flag: '0', desc: '所有被检查的备份都是 OK' },
          { flag: '1', desc: '任一非 OK，或目标读不出来' },
        ],
      },
    ],
    examples: ['dcm verify', 'dcm verify --json', 'dcm verify D:/backups/dsh-config.zip'],
  },
  {
    name: 'backup',
    title: '离线文件级备份',
    usage: 'backup',
    summary: '离线文件级备份（写出后自动自检）',
    usageLines: ['backup [--sections <a,b,c>] [--out <path>] [--dry-run] [--data-dir <dir>]'],
    description: [
      '把不需要 DSH 运行时就能读的分区打包成 ZIP，结构与 GUI 导出一致：',
      'manifest.json + integrity/checksums.json + 分区目录；落盘后立刻用 verify 同一引擎自检。',
      '凭据类文件（.credentials.* / .env / *.pem 等）永不进包，符号链接不跟随。',
      '需要 DSH 服务层的分区不会被伪造，计划里列在「离线不可收集」。',
      'pluginFiles 是可选分区：原样拷贝第三方插件文件（其中可能有明文口令），确认过内容再选。',
    ],
    sections: [
      {
        title: '选项',
        entries: [
          { flag: '--sections <a,b,c>', desc: '分区白名单（缺省 ' + DEFAULT_BACKUP_SECTIONS.join(',') + '）' },
          { flag: '--out <path>', desc: '输出 ZIP 路径（缺省导出目录自动命名，绝不覆盖既有文件）' },
          { flag: '--dry-run', desc: '只打印待打包清单，零写入' },
          { flag: '--data-dir <dir>', desc: '导出目录（缺省 $DSH_HOME/dsh-config-manager/exports）' },
          { flag: '-h, --help', desc: '显示本页' },
        ],
      },
      {
        title: '退出码',
        entries: [
          { flag: '0', desc: '已写出且自检通过（--dry-run 也是 0）' },
          { flag: '1', desc: '没有可打包内容 / 写入失败 / 自检未通过 / 分区名非法' },
        ],
      },
    ],
    examples: [
      'dcm backup --dry-run',
      'dcm backup --out D:/rescue/config.zip',
      'dcm backup --sections skills,self',
    ],
  },
  {
    name: 'import',
    title: '外部 agent 配置 → 标准 bundle ZIP',
    usage: 'import --from <source>',
    summary: '外部 agent 配置 → 标准 bundle ZIP',
    usageLines: ['import --from <source> [--dry-run] [--out <path>] [--cwd <dir>] [--data-dir <dir>]'],
    description: IMPORT_DESCRIPTION,
    sections: [
      {
        title: '选项',
        entries: [
          { flag: '--from <source>', desc: '来源 id（必填；见上方清单，未知来源会列出可用项）' },
          { flag: '--dry-run', desc: '只打印分区摘要与未迁移项，零写入' },
          { flag: '--out <path>', desc: '输出 ZIP 路径（缺省导出目录自动命名，绝不覆盖）' },
          { flag: '--cwd <dir>', desc: '项目级配置所在目录（缺省 = 进程当前目录）' },
          { flag: '--data-dir <dir>', desc: '导出目录（缺省 $DSH_HOME/dsh-config-manager/exports）' },
          { flag: '-h, --help', desc: '显示本页' },
        ],
      },
      {
        title: '退出码',
        entries: [
          { flag: '0', desc: '转换出分区（--dry-run 也是 0）' },
          { flag: '1', desc: '未知来源 / 没有可导入内容 / 生成失败 / 产物自检未通过' },
        ],
      },
    ],
    examples: [
      'dcm import --from claude-code --dry-run',
      'dcm import --from cursor --out D:/rescue/cursor.zip',
    ],
  },
  {
    name: 'restore',
    title: '回滚到导入前快照',
    usage: 'restore [--dry-run]',
    summary: '回滚到导入前快照',
    usageLines: [
      'restore [--id <uuid>] [--dry-run] [--data-dir <dir>] [--data-root <dir>]',
      '        [--profile <name>] [--settings <path>]',
    ],
    description: [
      '把配置恢复到该快照的状态：每个被覆盖或被删除的文件先拷到 <快照目录>/pre-restore/，以便反悔。',
      '不带 --id 时挑最近一个非 rolled-back 的快照；--dry-run 只打印计划，零写入。',
      '真正执行前有三道门，任一不过就拒绝（没有 --force）：',
      '  ① SAFE MODE 存在未恢复的 transaction；② 环境锁被别的任务持有；',
      '  ③ 本机有 DSH 实例在跑（恢复会覆盖/删除它正在使用的文件）——关掉 DSH，或改用 dcm web 救急台。',
    ],
    sections: [
      {
        title: '选项',
        entries: [
          { flag: '--id <uuid>', desc: '目标快照 id（缺省 = 最近一个非 rolled-back 快照）' },
          { flag: '--dry-run', desc: '只打印恢复计划，零写入' },
          { flag: '--data-dir <dir>', desc: '快照目录（缺省 $DSH_HOME/dsh-config-manager/snapshots）' },
          { flag: '--data-root <dir>', desc: '插件数据根 dataDir（自定义时必须显式传）' },
          { flag: '--profile <name>', desc: '要恢复的 DSH profile（缺省 web）' },
          { flag: '--settings <path>', desc: '覆盖 settings 文件路径' },
          { flag: '-h, --help', desc: '显示本页' },
        ],
      },
      {
        title: '退出码',
        entries: [
          { flag: '0', desc: '全部动作成功（--dry-run 恒 0）' },
          { flag: '1', desc: '有失败步骤 / 没有可用快照 / 快照目录读不出来 / id 非法 / SAFE MODE、环境锁或「DSH 在跑」拒绝' },
        ],
      },
    ],
    examples: ['dcm restore --dry-run', 'dcm restore --id 3f1c...', 'dcm restore --profile dev --dry-run'],
  },
  {
    name: 'sessions',
    title: '会话日志体检与布局修复',
    usage: 'sessions list | doctor | repair',
    summary: '列出本机会话 / 体检并给处置建议',
    usageLines: [
      'sessions list   [--home <dir>] [--json]',
      'sessions doctor [--home <dir>] [--json]',
      'sessions repair [--home <dir>] [--fix] [--keep <dir>] [--map old=new]... [--json]',
    ],
    description: [
      'DSH 会校验「日志位置 == projectKey(header.cwd)/id」；位置不对就拒绝启动：',
      '报 corrupt session log 或 duplicate JSONL session id。',
      '插件只在 DSH 内部加载，所以 DSH 起不来时这是唯一的修复通道。',
      'repair 按每条会话首帧的 cwd 把目录归位（缺省只报告，--fix/--apply 才落盘）。',
      '--map old=new 用于跨机恢复：命中前缀会先改写首帧 cwd，其余帧逐字节保留。',
      '--keep <dir> 处理重复 id：点名保留哪一份，其余移进 sessions/.cm-repair-quarantine-<时间戳>/（只搬不删）。',
      '写盘前会检查 DSH 是否在跑；在跑则拒绝，避免边读边改。',
      '--json 的 ok 与退出码同源：0（无阻断级问题）时为 true，否则 false —— 两者不会互相矛盾。',
      '会话根不存在或存在却读不出来时，repair 都如实报错并非 0 退出（读不到 ≠ 没有会话）。',
    ],
    sections: [
      {
        title: '子命令',
        entries: [
          { flag: 'list', desc: '只读：列出本机会话' },
          { flag: 'doctor', desc: '只读：体检并给处置建议（前置条件、等价命令）' },
          { flag: 'repair', desc: '把会话日志目录归位（缺省 dry-run）' },
        ],
      },
      {
        title: '选项',
        entries: [
          { flag: '--home <dir>', desc: '要修复的 DSH home（缺省 $DSH_HOME，即 ~/.dsh）' },
          { flag: '--json', desc: '机器可读输出（list / doctor / repair 预览）' },
          { flag: '--fix, --apply', desc: 'repair 真的落盘（缺省只打印计划）' },
          { flag: '--keep <dir>', desc: '重复 id 时保留哪一份会话目录（其余移入隔离目录）' },
          { flag: '--map old=new', desc: '路径前缀映射（可重复；命中即改写首帧 cwd）' },
          { flag: '-h, --help', desc: '显示本页' },
        ],
      },
      {
        title: '退出码',
        entries: [
          { flag: '0', desc: '无阻断问题；repair 的 dry-run 恒 0（--json 的 ok 同时为 true）' },
          { flag: '1', desc: '有阻断问题（--json 的 ok 为 false）；repair 的 --fix 有失败/冲突/回滚；repair 的会话根不存在或读不出来；参数错误' },
          { flag: '2', desc: 'list / doctor 找不到会话根目录（repair 的同一情形是 1）' },
        ],
      },
    ],
    examples: [
      'dcm sessions list',
      'dcm sessions doctor --json',
      'dcm sessions repair',
      "dcm sessions repair --fix --map 'C:/Users/alice=D:/Work'",
    ],
  },
  {
    name: 'recover-stale-lock',
    title: '回收残留的环境锁',
    usage: 'recover-stale-lock',
    summary: '回收残留环境锁（持有者已确证死亡才回收）',
    usageLines: ['recover-stale-lock [--data-dir <dir>]'],
    description: [
      '环境锁记录「谁在操作」并带心跳，保证两个操作不会同时写你的配置。',
      '进程被强制结束（任务管理器 / kill -9）会留下死锁：之后每次操作都被拒，',
      '而且重试或重启 DSH 都没用 —— 插件绝不自行删锁（猜错会把活着的操作踢掉）。',
      'GUI 这时报「操作暂时无法执行」；GUI 侧等价入口是「事故恢复 → 回收残留锁」。',
      '本命令先 inspect，只有持有者被证明已死才原子回收；活锁一律拒绝，没有 --force。',
    ],
    sections: [
      {
        title: '选项',
        entries: [
          { flag: '--data-dir <dir>', desc: '用它派生锁目录所在的插件数据目录' },
          { flag: '-h, --help', desc: '显示本页' },
        ],
      },
      {
        title: '退出码',
        entries: [
          { flag: '0', desc: '已回收' },
          { flag: '1', desc: '锁未判定为 stale（不碰活锁），或回收的二次验证失败' },
        ],
      },
    ],
    examples: ['dcm recover-stale-lock'],
  },
  {
    name: 'reinstall',
    title: '重装 DSH 程序本体',
    usage: 'reinstall',
    summary: '重装 DSH 程序本体（破坏性选择需二次确认）',
    usageLines: ['reinstall [--version <v>] [--yes] [--list] [--wipe-config] [--dry-run] [--data-root <dir>]'],
    description: [
      '跨平台重装 @deepseek-ai/dsh 启动器（Windows 用 PowerShell，Unix 用 bash）。',
      '缺省只重装启动器 + 清全局缓存；数据类清理项（settings / plugins / data）默认不勾，',
      '任何破坏性选择都要再输入 YES 才继续。清 ~/.dsh 数据前先做 .reinstall-backup 应急备份，',
      'snapshots/ 目录永不触碰。真正执行前同样过 SAFE MODE 与环境锁两道门。',
    ],
    sections: [
      {
        title: '选项',
        entries: [
          { flag: '--list', desc: '只列出可选的清理项，然后退出' },
          { flag: '--yes', desc: '非交互：全选并跳过二次确认' },
          { flag: '--wipe-config', desc: '等价于勾选全部数据类（settings / plugins / data）' },
          { flag: '--version <v>', desc: '要安装的 DSH 版本（缺省 latest）' },
          { flag: '--dry-run', desc: '只打印重装计划，不执行' },
          { flag: '--data-root <dir>', desc: '插件数据根 dataDir（自定义时必须显式传）' },
          { flag: '-h, --help', desc: '显示本页' },
        ],
      },
      {
        title: '退出码',
        entries: [
          { flag: '0', desc: '完成（--list / --dry-run 也是 0）' },
          { flag: '1', desc: '有步骤失败 / 二次确认被取消 / SAFE MODE 或环境锁拒绝' },
        ],
      },
    ],
    examples: [
      'dcm reinstall --list',
      'dcm reinstall --dry-run',
      'dcm reinstall',
      'dcm reinstall --yes',
    ],
  },
  {
    name: 'help',
    title: '显示帮助',
    usage: 'help [command]',
    summary: '本页 / 命令详情',
    usageLines: ['help [command]', '<command> --help'],
    description: [
      '不带参数打印速查页；给一个命令名则打印该命令的详情页。',
      'dcm help verify 与 dcm verify --help 等价。',
    ],
    sections: [
      { title: '选项', entries: [{ flag: '-h, --help', desc: '显示速查页' }] },
    ],
    examples: ['dcm help', 'dcm help verify', 'dcm verify --help'],
  },
];

/* ------------------------------------------------------------------ 渲染 */

/** 速查页「用法」列的宽度（全表统一，保证摘要起始列一致） */
export function usageColumnWidth(): number {
  let width = 0;
  for (const group of HELP_GROUPS) {
    for (const row of group.rows) width = Math.max(width, row.usage.length);
  }
  return width;
}

/** 键值段对齐渲染（左列宽度按本段内最长者算，段与段之间不互相牵制） */
function renderEntries(entries: readonly HelpEntry[], indent: string): string[] {
  const width = entries.reduce((w, e) => Math.max(w, e.flag.length), 0);
  return entries.map((e) => indent + e.flag.padEnd(width) + '  ' + e.desc);
}

/** 速查页（`dcm help`）：分组命令表 + 通用选项 + 上手顺序 */
export function renderOverview(version: string): string[] {
  const width = usageColumnWidth();
  const lines: string[] = [];
  lines.push('dsh-config-manager (dcm) v' + version + ' — DSH 配置离线救急 CLI');
  lines.push('DSH 起不来时也能用：快照 / 备份 / 校验 / 修复 / 重装');
  lines.push('');
  // 这两行刻意不带右列说明：`<命令>` 是双宽字符，任何 padEnd 对齐都会歪
  // （速查页的用法列只用 ASCII 也是同一个原因）。细节入口由下面的「帮助」分组和页脚给出。
  lines.push('用法');
  lines.push('  dcm <命令> [选项]');
  lines.push('  dcm <命令> --help');
  lines.push('');
  for (const group of HELP_GROUPS) {
    lines.push(group.title);
    for (const row of group.rows) {
      lines.push('  ' + row.usage.padEnd(width) + '  ' + row.summary);
    }
    lines.push('');
  }
  lines.push('通用选项');
  lines.push(...renderEntries(GENERAL_OPTIONS, '  '));
  lines.push('');
  lines.push('第一次用？  dcm verify → dcm backup → dcm snapshots → dcm restore --dry-run');
  lines.push('细节页：    dcm verify --help   或   dcm help verify');
  return lines;
}

/** 单命令详情页；不认识的名字返回 null（调用方决定怎么报错） */
export function renderCommandHelp(name: string, version: string): string[] | null {
  const cmd = COMMAND_HELP.find((c) => c.name === name);
  if (cmd === undefined) return null;
  const lines: string[] = [];
  lines.push(cmd.name + ' — ' + cmd.title);
  lines.push('');
  lines.push('用法');
  for (const line of cmd.usageLines) lines.push('  dcm ' + line);
  lines.push('');
  lines.push('说明');
  for (const line of cmd.description) lines.push('  ' + line);
  for (const section of cmd.sections) {
    lines.push('');
    lines.push(section.title);
    lines.push(...renderEntries(section.entries, '  '));
  }
  lines.push('');
  lines.push('示例');
  for (const example of cmd.examples) lines.push('  ' + example);
  lines.push('');
  lines.push('版本 ' + version + ' · 全部命令：dcm help');
  return lines;
}
