
import fs from 'node:fs';
import path from 'node:path';

const OUT = '.stitch-refactor/out';
const ICONS = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
};
// 真实组件：IconButton 28x28 / radius 4 / icon 14 / navActions gap 4 + margin-left 4；仅第一个按钮有 title(=⌘/Ctrl+K)
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
  let i = o, depth = 0;
  while (i < s.length) {
    const nextOpen = s.indexOf('<div', i);
    const nextClose = s.indexOf('</div>', i);
    if (nextClose === -1) return -1;
    if (nextOpen !== -1 && nextOpen < nextClose) { depth++; i = nextOpen + 4; }
    else { depth--; i = nextClose + 6; if (depth === 0) return i; }
  }
  return -1;
}

const ids = process.argv.slice(2);
const report = [];
for (const id of ids) {
  const p = path.join(OUT, id + '.html');
  let s = fs.readFileSync(p, 'utf8');
  const before = s;
  const h0 = s.indexOf('<header');
  const h1 = s.indexOf('</header>');
  if (h0 === -1 || h1 === -1) { report.push(id + ' SKIP no-header'); continue; }
  const slice = s.slice(h0, h1);
  const m = /title="([^"]*)"/.exec(slice);
  if (!m || !/命令面板|⌘K|快速命令|搜索/.test(m[1])) { report.push(id + ' SKIP no-anchor (' + (m ? m[1] : 'none') + ')'); continue; }
  const iTitle = h0 + m.index;
  const o = s.lastIndexOf('<div', iTitle);
  if (o === -1 || o < h0) { report.push(id + ' SKIP no-container'); continue; }
  const c = matchDiv(s, o);
  if (c === -1) { report.push(id + ' SKIP unbalanced'); continue; }
  const oldLen = c - o;
  s = s.slice(0, o) + cluster() + s.slice(c);
  // P-02：页签里的前置图标（真实 navTab 只有文字）
  let tabIcons = 0;
  if (id === 'P-02') {
    s = s.replace(/(<a class="tab-item[^"]*">)\s*<i data-lucide="[^"]+"[^>]*><\/i>\s*/g, (mm, pre) => { tabIcons++; return pre; });
  }
  if (s === before) { report.push(id + ' NOCHANGE'); continue; }
  fs.writeFileSync(p, s, 'utf8');
  const n = (s.match(/aria-label="迁移历史"/g) || []).length;
  report.push(id + ' OK cluster ' + oldLen + 'B→' + cluster().length + 'B ariaHistory=' + n + (tabIcons ? ' tabIconsRemoved=' + tabIcons : ''));
}
console.log(report.join('\n'));
