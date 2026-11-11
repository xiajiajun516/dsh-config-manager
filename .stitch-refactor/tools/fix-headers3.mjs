
import fs from 'node:fs';
import path from 'node:path';
const OUT = '.stitch-refactor/out';
const ICONS = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
};
const ACTIONS = [
  { icon: 'search', label: '命令面板', title: '⌘/Ctrl+K' },
  { icon: 'clock', label: '活动' },
  { icon: 'history', label: '迁移历史' },
  { icon: 'info', label: '关于' },
];
const BTN = 'width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:4px;background:none;color:inherit;cursor:pointer';
const cluster = () => '<div style="display:flex;align-items:center;gap:4px;flex:none;margin-left:4px;color:#61666B">' +
  ACTIONS.map(a => '<button type="button" aria-label="' + a.label + '"' + (a.title ? ' title="' + a.title + '"' : '') + ' style="' + BTN + '">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[a.icon] + '</svg></button>').join('') +
  '</div>';
function matchDiv(s, o) {
  let i = o + 4, depth = 1;
  while (i < s.length) {
    const no = s.indexOf('<div', i), nc = s.indexOf('</div>', i);
    if (nc === -1) return -1;
    if (no !== -1 && no < nc) { depth++; i = no + 4; } else { depth--; i = nc + 6; if (depth === 0) return i; }
  }
  return -1;
}
const report = [];
for (const id of process.argv.slice(2)) {
  const p = path.join(OUT, id + '.html');
  let s = fs.readFileSync(p, 'utf8');
  const bodyAt = s.indexOf('<body');
  const win = s.slice(bodyAt, bodyAt + 3200);
  const m = />⌘K</.exec(win);
  if (!m) { report.push(id + ' SKIP no-kbd-in-nav'); continue; }
  const idx = bodyAt + m.index;
  const o = s.lastIndexOf('<div', idx);
  const c = matchDiv(s, o);
  if (o === -1 || c === -1) { report.push(id + ' SKIP bounds'); continue; }
  const seg = s.slice(o, c);
  if ((seg.match(/<span/g) || []).length + (seg.match(/<svg/g) || []).length > 8) { report.push(id + ' SKIP not-a-cluster'); continue; }
  const oldLen = c - o;
  s = s.slice(0, o) + cluster() + s.slice(c);
  fs.writeFileSync(p, s, 'utf8');
  report.push(id + ' OK ' + oldLen + 'B→' + cluster().length + 'B ariaHistory=' + (s.match(/aria-label="迁移历史"/g) || []).length);
}
console.log(report.join('\n'));
