JSON.stringify([...document.querySelectorAll('div')].filter(d => {
  const bg = getComputedStyle(d).backgroundColor || '';
  const m = bg.match(/rgba?\(([^)]+)\)/);
  if (!m) return false;
  const p = m[1].split(',').map(Number);
  const a = p.length === 4 ? p[3] : 1;
  return a >= 0.15 && p[0] < 40 && p[1] < 40 && p[2] < 40;
}).map(d => { const r = d.getBoundingClientRect(); return { cls: String(d.className).slice(0, 40), bg: getComputedStyle(d).backgroundColor, w: Math.round(r.width), h: Math.round(r.height) }; }))