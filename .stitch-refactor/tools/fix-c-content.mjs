
import fs from 'node:fs';
const P = (id) => '.stitch-refactor/out/' + id + '.html';
const log = [];
function edit(id, fn) {
  const p = P(id); const before = fs.readFileSync(p, 'utf8'); const after = fn(before);
  if (after === before) throw new Error(id + ' NOCHANGE');
  fs.writeFileSync(p, after, 'utf8'); log.push(id + ' OK');
}

// D-30：命令面板真实命令表（5 组 21 条）+ 列表 280px 限高内滚（去掉内联 336px 假高）
edit('D-30', s => {
  const row = (t, active) => active
    ? '<div class="w-full h-[26px] flex items-center px-3 cursor-pointer hover:bg-[#EBEEF2]/50 rounded-md"><span class="text-[12.5px] text-[#0F1115] leading-none">' + t + '</span></div>'
    : '<div class="w-full h-[26px] flex items-center px-3 cursor-pointer hover:bg-[#EBEEF2]/50 rounded-md"><span class="text-[12.5px] text-[#0F1115] leading-none">' + t + '</span></div>';
  const group = (label, items, first) =>
    '<div class="w-full flex flex-col' + (first ? '' : ' mt-1') + '"><div class="px-[6px] py-[6px] text-[11px] text-[#81858C] font-medium leading-none' + (first ? '' : ' border-t border-[#0000001A] mt-1') + '">' + label + '</div>' +
    items.map(t => row(t)).join('') + '</div>';
  const body =
    group('前往', ['首页','产物库','同步','环境'], true) +
    group('产物库', ['全部','本机快照','备份文件','远端快照','市场配置'], false) +
    group('动作', ['市场','发布到市场','导出','导入','从其它 agent 导入','维护与诊断'], false) +
    group('视图', ['活动记录','迁移历史','关于'], false) +
    group('处置', ['事故恢复','救援模式','回滚点（工作区 + 会话回退）'], false);

  let out = s.replace(' style="height: 336px;"', '');
  const start = out.indexOf('<!-- 分组 1：前往 -->');
  const endMark = '<!-- 3. 提示区 32px';
  const end = out.indexOf(endMark);
  if (start === -1 || end === -1) throw new Error('D-30 list bounds missing');
  out = out.slice(0, start) + '<!-- 真实命令表：5 组 21 条（src/ui/commands.ts COMMANDS），空查询时按组列出，280px 限高内滚 -->\n' + body + '\n</div>\n' + out.slice(end);
  return out;
});

// D-29：遮罩下的「同步分区」用真实分区显示名（sectionLabel），补满卡片
edit('D-29', s => {
  const labels = ['设置','UI 偏好','Provider 与模型','插件清单','MCP 服务器','提示词','技能','Agent 预设','全局指令','工作区','插件散落配置','凭据状态'];
  const rows = labels.map((t, i) => '<div style="display: flex; justify-content: space-between; font-size: 11px; color: #61666B; padding-bottom: 5px;' + (i < labels.length - 1 ? ' border-bottom: 0.5px solid #0000000D;' : '') + '"><span>' + t + '</span><span style="color: #22C55E;">已对齐</span></div>').join('\n');
  const openTag = '<div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">';
  const oi = s.indexOf(openTag);
  if (oi === -1) throw new Error('D-29 list open missing');
  // 找配对的 </div>
  let i = oi + openTag.length, depth = 1;
  while (depth > 0) {
    const no = s.indexOf('<div', i), nc = s.indexOf('</div>', i);
    if (nc === -1) throw new Error('D-29 list close missing');
    if (no !== -1 && no < nc) { depth++; i = no + 4; } else { depth--; i = nc + 6; }
  }
  const replacement = '<div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px; flex: 1 1 auto; overflow: hidden;">\n' + rows + '\n</div>';
  return s.slice(0, oi) + replacement + s.slice(i);
});
console.log(log.join('\n'));
