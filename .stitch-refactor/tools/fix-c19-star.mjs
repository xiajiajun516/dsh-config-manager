
import fs from 'node:fs/promises';
const p = '.stitch-refactor/out/T-08.html';
let s = await fs.readFile(p, 'utf8');
const from = '<button class="h-6 px-2 flex items-center justify-center rounded-[6px] bg-[#0F1115] hover:bg-[#43454A] text-white text-[10.5px] font-medium transition-colors shrink-0">⭐ 在 GitHub 上点赞</button>';
const to = '<button class="h-6 px-2 flex items-center justify-center rounded-[6px] bg-white border border-[#0000001A] text-[#0F1115] hover:bg-[#F5F5F5] text-[10.5px] font-medium transition-colors shrink-0">⭐ 在 GitHub 上点赞</button>';
if (!s.includes(from)) { console.log('SKIP: star button markup not found'); } else {
  s = s.replace(from, to);
  await fs.writeFile(p, s, 'utf8');
  console.log('T-08 OK: Star 主按钮降为白底描边（同屏 primary 唯一 = 立即更新）');
}
