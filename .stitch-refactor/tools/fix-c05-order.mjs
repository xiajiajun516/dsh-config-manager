
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
for (const id of ids) {
  const p = '.stitch-refactor/out/' + id + '.html';
  let s = fs.readFileSync(p, 'utf8');
  const bs = buttons(s);
  if (bs.length < 2) { console.log(id + ' SKIP buttons=' + bs.length); continue; }
  const last = bs[bs.length - 1], prev = bs[bs.length - 2];
  if (text(last.raw) !== '取消') { console.log(id + ' SKIP last=' + text(last.raw)); continue; }
  // 同一容器内相邻：两段之间除空白/注释外不应有别的元素
  const between = s.slice(prev.end, last.start);
  if (/<\/div>|<div/.test(between)) { console.log(id + ' SKIP not-siblings'); continue; }
  const swapped = last.raw.replace(/\s+$/, '') + '\n' + prev.raw.replace(/\s+$/, '');
  s = s.slice(0, prev.start) + swapped + s.slice(last.end);
  // 与顺序相关的行内注释同步
  s = s.replace('顺序为确认在左、取消在最右', '顺序为取消在左、确认在最右（DESIGN.md §7-30：主操作恒在最右）');
  fs.writeFileSync(p, s, 'utf8');
  console.log(id + ' OK  ' + text(prev.raw) + ' <-> 取消');
}
