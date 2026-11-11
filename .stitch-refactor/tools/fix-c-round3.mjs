
import fs from 'node:fs';
const P = '.stitch-refactor/out/';
function matchDiv(s, o) {
  let i = o + 4, depth = 1;
  while (i < s.length) {
    const no = s.indexOf('<div', i), nc = s.indexOf('</div>', i);
    if (nc === -1) return -1;
    if (no !== -1 && no < nc) { depth++; i = no + 4; } else { depth--; i = nc + 6; if (depth === 0) return i; }
  }
  return -1;
}
const XBTN = '<button class="w-[24px] h-[24px] flex items-center justify-center text-[#81858C] hover:text-[#0F1115] rounded-[4px] hover:bg-[#00000008] transition-colors shrink-0" title="关闭" aria-label="关闭" type="button"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>';

// D-22：真实 Modal.Header 有关闭按钮（SessionHealthDialog.tsx:299-303 closeLabel=t('common.close')）
{
  const p = P + 'D-22.html'; let s = fs.readFileSync(p, 'utf8');
  const hdr = '<div class="pt-[12px] px-[14px] pb-[8px] flex items-center justify-between shrink-0">';
  const hi = s.indexOf(hdr);
  if (hi === -1) throw new Error('D-22 header missing');
  const hEnd = matchDiv(s, hi);
  const clusterOpen = '<div class="flex items-center space-x-[8px]">';
  const ci = s.indexOf(clusterOpen, hi);
  if (ci === -1 || ci > hEnd) throw new Error('D-22 cluster missing');
  const cEnd = matchDiv(s, ci);
  const insertAt = cEnd - 6; // before </div>
  s = s.slice(0, insertAt) + XBTN + s.slice(insertAt);
  fs.writeFileSync(p, s, 'utf8');
  console.log('D-22 OK close=' + (s.match(/aria-label="关闭"/g) || []).length);
}
// D-28：v0.8.0 发布日期 = CHANGELOG 的 2026-11-10
{
  const p = P + 'D-28.html'; let s = fs.readFileSync(p, 'utf8');
  if (!s.includes('2026-11-09')) throw new Error('D-28 date anchor missing');
  s = s.replace('2026-11-09', '2026-11-10');
  fs.writeFileSync(p, s, 'utf8');
  console.log('D-28 OK date');
}
