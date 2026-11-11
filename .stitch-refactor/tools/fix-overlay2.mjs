
import fs from "node:fs/promises";
let changed = [];
{
  const p = '.stitch-refactor/out/D-13.html';
  let s = await fs.readFile(p, 'utf8');
  const before = s;
  s = s.replace('style="background-color: rgba(0, 0, 0, 0.25);"', 'style="background-color: #0000003D;"');
  if (s !== before) { await fs.writeFile(p, s, 'utf8'); changed.push('D-13 overlay 0.25 -> #0000003D'); }
}
{
  const p = '.stitch-refactor/out/D-32.html';
  let s = await fs.readFile(p, 'utf8');
  const before = s;
  s = s.replace('style="background-color: rgba(0, 0, 0, 0.42);"', 'style="background-color: #0000003D;"');
  s = s.replace('class="flex-1 flex flex-col filter grayscale-[0.8] pointer-events-none select-none" style="opacity: 0.28;"', 'class="flex-1 flex flex-col pointer-events-none select-none"');
  if (s !== before) { await fs.writeFile(p, s, 'utf8'); changed.push('D-32 overlay 0.42 -> #0000003D, underlay grayscale/opacity removed'); }
}
console.log(changed.join('\n') || 'nothing changed');
