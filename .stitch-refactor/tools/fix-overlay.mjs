
import fs from "node:fs/promises";

const MASK = '<div class="absolute inset-0 bg-[#0000003D] z-10 pointer-events-none"></div>';

function findDialogStart(s) {
  const re = /<div[^>]*class="[^"]*inset-0[^"]*items-center[^"]*justify-center[^"]*"/g;
  let m, last = -1;
  while ((m = re.exec(s)) !== null) last = m.index;
  return last;
}

function remap(prefix) {
  return prefix
    .replace(/text-\[#81858C\]/g, 'text-[@@T2@@]')
    .replace(/text-\[#61666B\]/g, 'text-[#0F1115]')
    .replace(/text-\[@@T2@@\]/g, 'text-[#61666B]')
    .replace(/bg-\[#EBEEF2\]/g, 'bg-[#FFFFFF]')
    .replace(/bg-\[#E9EBEF\]/g, 'bg-[#FAFAFA]')
    .replace(/\s*opacity-40\b/g, '')
    .replace(/bg-white\/40/g, 'bg-white')
    .replace(/bg-\[#00000008\]/g, 'bg-[#EBEEF2]');
}

const underlayIds = ['D-14', 'D-14b', 'D-15', 'D-16'];
const alphaFix = { 'D-01': ['bg-black/25', 'bg-[#0000003D]'], 'D-07': ['bg-black/25', 'bg-[#0000003D]'], 'D-13': ['bg-black/25', 'bg-[#0000003D]'], 'D-32': null };

for (const id of underlayIds) {
  const p = '.stitch-refactor/out/' + id + '.html';
  let s = await fs.readFile(p, 'utf8');
  const i = findDialogStart(s);
  if (i < 0) { console.log(id, 'SKIP: dialog wrapper not found'); continue; }
  const before = s.slice(0, i);
  if (/bg-\[#0000003D\]|bg-black\/25/.test(before)) { console.log(id, 'SKIP: mask already present'); continue; }
  const head = remap(before);
  s = head + MASK + '\n' + s.slice(i);
  await fs.writeFile(p, s, 'utf8');
  console.log(id, 'OK: underlay repainted to real colors + mask inserted');
}

for (const [id, pair] of Object.entries(alphaFix)) {
  if (!pair) continue;
  const p = '.stitch-refactor/out/' + id + '.html';
  let s = await fs.readFile(p, 'utf8');
  if (!s.includes(pair[0])) { console.log(id, 'SKIP: pattern absent'); continue; }
  s = s.split(pair[0]).join(pair[1]);
  await fs.writeFile(p, s, 'utf8');
  console.log(id, 'OK: overlay alpha normalized to #0000003D');
}
