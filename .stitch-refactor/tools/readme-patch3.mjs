
import fs from 'node:fs/promises';
const { from, to } = JSON.parse(await fs.readFile('.stitch-refactor/.render/readme-patch.json', 'utf8'));
const p = '.stitch-refactor/README.md';
let s = await fs.readFile(p, 'utf8');
if (!s.includes(from)) { console.log('MISS'); process.exit(1); }
s = s.replace(from, to);
const tail = [
  '',
  '## 第三轮 C 行清扫（2026-11-12）',
  '',
  '- 按钮次序（C-05）：按**各自组件族**忠实呈现，不擅自统一；两族并存的原因与源码行号见 ' + String.fromCharCode(96) + 'consistency.md' + String.fromCharCode(96) + '。',
  '- 留白（C-08）：用 ' + String.fromCharCode(96) + 'tools/probe-gaps.mjs' + String.fromCharCode(96) + ' 逐屏量，结论是面板内无 >80px 死白；真缺陷只有 D-33/D-37 被画成顶部锚定，已改绝对居中。',
  '- 遮罩审计：4 屏（D-14/D-14b/D-15/D-16）原来用「改灰 / opacity」假装压暗，已改为真实色 + ' + String.fromCharCode(96) + '#0000003D' + String.fromCharCode(96) + ' 遮罩；D-01/D-07/D-13 的 0.25 与 D-32 的 0.42 归一，D-32 另去掉 grayscale 滤镜。像素核验同族（' + String.fromCharCode(96) + '#B6…C5' + String.fromCharCode(96) + '）。',
  '- 主按钮唯一（C-19）：T-08 的 Star 由 primary 降为白底描边（产品真实是同屏两个 primary，见 ' + String.fromCharCode(96) + 'AboutPanel.tsx:186/219' + String.fromCharCode(96) + '）。',
  '',
].join('\n');
await fs.writeFile(p, s.replace(/\s*$/, '') + '\n' + tail, 'utf8');
console.log('README patched');
