JSON.stringify([...document.querySelectorAll('button, [role=button], div, a')].filter(el => {
  const st = getComputedStyle(el);
  if (st.backgroundColor !== 'rgb(15, 17, 21)') return false;
  const r = el.getBoundingClientRect();
  if (r.height < 22 || r.height > 42 || r.width < 48) return false;
  const txt = (el.textContent || '').trim();
  return txt.length > 0 && txt.length < 24;
}).map(el => { const r = el.getBoundingClientRect(); return { t: (el.textContent || '').trim(), w: Math.round(r.width), h: Math.round(r.height) }; }))