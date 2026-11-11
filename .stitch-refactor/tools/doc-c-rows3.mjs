
import fs from 'node:fs/promises';
const patches = JSON.parse(await fs.readFile('.stitch-refactor/.render/doc-patches.json', 'utf8'));
const p = '.stitch-refactor/consistency.md';
let s = await fs.readFile(p, 'utf8');
for (const [from, to] of patches) {
  if (!s.includes(from)) { console.log('MISS:', from.slice(0, 20)); continue; }
  s = s.replace(from, to);
  console.log('OK:', from.slice(0, 4));
}
await fs.writeFile(p, s, 'utf8');
