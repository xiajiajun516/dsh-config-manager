
import fs from 'node:fs';
const p = '.stitch-refactor/out/D-22.html';
let s = fs.readFileSync(p, 'utf8');
const mine = /<button class="w-\[24px\] h-\[24px\] flex items-center justify-center text-\[#81858C\] hover:text-\[#0F1115\] rounded-\[4px\] hover:bg-\[#00000008\] transition-colors shrink-0" title="关闭" aria-label="关闭" type="button"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"\/><path d="m6 6 12 12"\/><\/svg><\/button>/;
if (!mine.test(s)) throw new Error('D-22 added close btn not found');
s = s.replace(mine, '');
// 给原有的 ✕ svg 补可访问名（真实 Modal.Header 传 closeLabel）
s = s.replace('<svg class="w-[14px] h-[14px] text-[#61666B] cursor-pointer hover:text-[#0F1115] transition-colors shrink-0" fill="none"', '<svg role="button" aria-label="关闭" title="关闭" class="w-[14px] h-[14px] text-[#61666B] cursor-pointer hover:text-[#0F1115] transition-colors shrink-0" fill="none"');
fs.writeFileSync(p, s, 'utf8');
console.log('D-22 close count =', (s.match(/aria-label="关闭"/g) || []).length);
