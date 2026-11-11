
import fs from 'node:fs';
const ids = ['D-07','D-09','D-10','D-15','D-17','D-18','D-20','D-25','D-26','D-34','D-35','D-38'];
function buttons(s) {
  const out = []; let i = 0;
  while (true) {
    const a = s.indexOf('<button', i); if (a < 0) break;
    const b = s.indexOf('</button>', a); if (b < 0) break;
    out.push({ start: a, end: b + 9, raw: s.slice(a, b + 9) });
    i = b + 9;
  }
  return out;
}
const text = (raw) => raw.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const commentFix = {
  'D-09': [['取消在左、危险按钮在最右（DESIGN.md §7-30）', '危险按钮在左、取消在右（ConfirmDialog 家族）']],
  'D-10': [['(取消 + 确认导入，确认在最右；DESIGN.md §7-30)', '(确认导入 + 取消，按 SyncConfirmView 源码 DOM 顺序)']],
  'D-15': [['按钮右对齐：左描边取消、最右深色危险确认', '按钮右对齐：左深色危险确认、右描边取消'],
           ['最右深色危险按钮「重新克隆」', '左边深色危险按钮「重新克隆」']],
  'D-17': [['最右深色主按钮「复制」', '左边深色主按钮「复制」']],
  'D-18': [['左 ghost「取消」、最右红底「停止」', '左红底「停止」、右 ghost「取消」']],
  'D-20': [['「取消」在左、「执行恢复」在最右', '「执行恢复」在左、「取消」在右']],
  'D-25': [['顺序为取消在左、确认在最右（DESIGN.md §7-30：主操作恒在最右）', '顺序为确认在左、取消在最右（ConfirmDialog 家族实际渲染）']],
  'D-26': [['左边「取消」ghost，最右「清理」危险主按钮', '左边「清理」危险主按钮，右边「取消」ghost'],
           ['最右：危险主按钮「清理」', '左边：危险主按钮「清理」']],
  'D-35': [['「取消」在左、「确认回滚」在最右', '「确认回滚」在左、「取消」在右']],
};
for (const id of ids) {
  const p = '.stitch-refactor/out/' + id + '.html';
  let s = fs.readFileSync(p, 'utf8');
  const bs = buttons(s);
  const last = bs[bs.length - 1], prev = bs[bs.length - 2];
  if (text(prev.raw) !== '取消') { console.log(id + ' SKIP revert prev=' + text(prev.raw)); }
  else {
    const swapped = last.raw.replace(/\s+$/, '') + '\n' + prev.raw.replace(/\s+$/, '');
    s = s.slice(0, prev.start) + swapped + s.slice(last.end);
  }
  for (const [a, b] of (commentFix[id] || [])) { if (s.includes(a)) s = s.replace(a, b); else console.log(id + ' MISS comment: ' + a); }
  fs.writeFileSync(p, s, 'utf8');
  const after = buttons(s);
  console.log(id + ' -> ' + after.slice(-2).map(b => text(b.raw)).join(' | '));
}
