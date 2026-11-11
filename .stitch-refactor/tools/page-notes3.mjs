
import fs from 'node:fs/promises';
const payload = JSON.parse(await fs.readFile('.stitch-refactor/.render/page-notes.json', 'utf8'));
for (const [id, block] of Object.entries(payload)) {
  const p = '.stitch-refactor/pages/' + id + '.md';
  let s;
  try { s = await fs.readFile(p, 'utf8'); } catch { console.log(id, 'MISSING'); continue; }
  if (s.includes('第三轮（2026-11-12')) { console.log(id, 'SKIP already'); continue; }
  await fs.writeFile(p, s.replace(/\s*$/, '') + '\n\n' + block, 'utf8');
  console.log(id, 'appended');
}
