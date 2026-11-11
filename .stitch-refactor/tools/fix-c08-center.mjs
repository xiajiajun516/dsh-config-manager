
import fs from 'node:fs';
let s, n;
// D-37：原「距顶 40px」→ 绝对居中（真实 .dialogMask 是 flex center）
s = fs.readFileSync('.stitch-refactor/out/D-37.html', 'utf8');
n = s.replace('class="absolute left-[11.5px] top-[40px] w-[541px]', 'class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[541px]');
if (n === s) console.log('D-37 MISS');
s = n.replace('（宽 541px、高 600px、居中、距顶 40px）', '（宽 541px、垂直水平居中：mask 为 flex center）');
fs.writeFileSync('.stitch-refactor/out/D-37.html', s, 'utf8');
console.log('D-37 ok');
// D-33：原 mt-[96px] → 绝对居中
s = fs.readFileSync('.stitch-refactor/out/D-33.html', 'utf8');
n = s.replace('class="relative z-20 w-[541px] mx-auto mt-[96px]', 'class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-20 w-[541px]');
if (n === s) console.log('D-33 MISS');
s = n.replace('(宽 541px, 上边距 96px)', '(宽 541px, 绝对居中)');
fs.writeFileSync('.stitch-refactor/out/D-33.html', s, 'utf8');
console.log('D-33 ok');
