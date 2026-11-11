
import fs from 'node:fs/promises';
const d = JSON.parse(await fs.readFile('.stitch-refactor/.render/readme-patch.json','utf8'));
const p='.stitch-refactor/README.md';
let s=await fs.readFile(p,'utf8');
let n=0;
for (const k of ['C','Env']) {
  const a = k==='C'? d.oldC : d.oldEnv, b = k==='C'? d.newC : d.newEnv;
  if (s.includes(a)) { s = s.replace(a,b); n++; }
}
await fs.writeFile(p,s,'utf8');
console.log('replaced', n);
