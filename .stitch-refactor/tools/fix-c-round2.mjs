
import fs from 'node:fs';
const OUT = '.stitch-refactor/out/';
const P = (id) => OUT + id + '.html';
const log = [];
function edit(id, fn) {
  const p = P(id); const before = fs.readFileSync(p, 'utf8'); const after = fn(before);
  if (after === before) { log.push(id + ' NOCHANGE'); return; }
  fs.writeFileSync(p, after, 'utf8'); log.push(id + ' OK');
}
const ICO = (d) => '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
const defs = [
  '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
];

// 1) D-34：underlay 文字图标 → 同一套四图标
edit('D-34', s => {
  const re = /<div class="underlay-icons">[\s\S]*?<\/div>/;
  if (!re.test(s)) throw new Error('D-34 anchor missing');
  return s.replace(re, '<div class="underlay-icons" style="display:flex;align-items:center;gap:12px;color:#81858C">' + defs.map(d => ICO(d)).join('') + '</div>');
});

// 2) D-10：footer 次序翻转为 [确认导入][取消]
edit('D-10', s => {
  const re = /(<div class="modal-action-row">)\s*<button class="btn-ghost" type="button">取消<\/button>\s*<button class="btn-primary" type="button">确认导入<\/button>/;
  if (!re.test(s)) throw new Error('D-10 anchor missing');
  return s.replace(re, '$1\n          <button class="btn-primary" type="button">确认导入</button>\n          <button class="btn-ghost" type="button">取消</button>');
});

// 3) T-02a：解锁并继续 = 密码为空时的禁用态（源码 disabled + loading 语义）
edit('T-02a', s => {
  const re = /<button class="w-full h-\[28px\] rounded-\[8px\] bg-\[#0F1115\] hover:bg-\[#43454A\] active:scale-\[0.99\] text-\[#FFFFFF\] text-\[12\.5px\] font-medium flex items-center justify-center transition-colors">解锁并继续<\/button>/;
  if (!re.test(s)) throw new Error('T-02a anchor missing');
  return s.replace(re, '<button class="w-full h-[28px] rounded-[8px] bg-[#EBEEF2] text-[#81858C] text-[12.5px] font-medium flex items-center justify-center cursor-default" disabled>解锁并继续</button>');
});

// 4) D-27：正文发布说明 = 实际到手的最新一条（v0.8.0），与顶部「未找到 v0.9.0 的发布说明」自洽
edit('D-27', s => {
  if (!s.includes('v0.9.0 · 2026-11-11')) throw new Error('D-27 anchor missing');
  return s.replace('v0.9.0 · 2026-11-11', 'v0.8.0 · 2026-11-10');
});

// 5) D-35：卡片宽 519 → 528（与同族 525–531 对齐）
edit('D-35', s => {
  if (!s.includes('width: 519px')) throw new Error('D-35 anchor missing');
  return s.replace('width: 519px', 'width: 528px');
});
console.log(log.join('\n'));
