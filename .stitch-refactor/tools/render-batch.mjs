
import fs from 'node:fs';
import path from 'node:path';
const ids = process.argv.slice(2);
const ROOT = path.resolve('.');
function pngSize(p) {
  const b = fs.readFileSync(p);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
const jobs = [];
for (const id of ids) {
  const shot = path.join(ROOT, '.stitch-refactor/shots', id + '-after.png');
  let w = 2560, h = 2048;
  if (fs.existsSync(shot)) { const s = pngSize(shot); w = s.w; h = s.h; }
  const dsf = h / 1010;
  jobs.push({
    id,
    url: 'file:///' + path.join(ROOT, '.stitch-refactor/out', id + '.html').replace(/\\/g, '/'),
    out: path.join(ROOT, '.stitch-refactor/.render', 'N-' + id + '.png'),
    vw: Math.round(w / dsf), vh: 1010, dsf,
    probe: 'JSON.stringify({P:(()=>{const r=document.querySelector(".plugin-window,.relative.w-\\\\[564px\\\\],body>div")?.getBoundingClientRect();return r?{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}:null})()})',
  });
}
fs.writeFileSync('.stitch-refactor/.render/jobs-new.json', JSON.stringify(jobs, null, 1));
console.log(jobs.map(j => j.id + ' ' + j.vw + 'x' + j.vh + ' dsf=' + j.dsf.toFixed(3)).join('\n'));
