
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9412;
const ROOT = path.resolve(".");
async function waitJson(url, tries = 80) {
  for (let i = 0; i < tries; i++) { try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {} await new Promise(r => setTimeout(r, 250)); }
  throw new Error("cdp not up");
}
function conn(url) {
  const ws = new WebSocket(url); let id = 0; const pending = new Map();
  ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } });
  const ready = new Promise((res, rej) => { ws.addEventListener("open", () => res(1)); ws.addEventListener("error", rej); });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) })); });
  return { ready, send, ws };
}
const ids = process.argv.slice(2);
const files = ids.length ? ids : (await fs.readdir(".stitch-refactor/out")).filter(f => f.endsWith(".html")).map(f => f.replace(".html", "")).sort();
const EXPR = `(() => {
  const all = [...document.querySelectorAll('*')];
  let panel = null;
  for (const el of all) { const r = el.getBoundingClientRect(); if (Math.abs(r.width - 564) < 2 && Math.abs(r.height - 720) < 2) { panel = el; break; } }
  if (!panel) return JSON.stringify({ error: 'no-panel' });
  const p = panel.getBoundingClientRect();
  let statusTop = p.bottom;
  for (const el of all) { if (!panel.contains(el)) continue; const t = (el.textContent||'').trim(); const r = el.getBoundingClientRect(); if (t.startsWith('就绪') && t.length < 20) statusTop = Math.min(statusTop, r.top); }
  let card = null, best = 0;
  for (const el of all) {
    if (el === panel || !panel.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 555 || r.height > 660 || r.width < 380) continue;
    const cs = getComputedStyle(el);
    if (parseFloat(cs.borderTopLeftRadius || '0') < 8) continue;
    if (cs.position === 'fixed') continue;
    const area = r.width * r.height;
    if (area > best) { best = area; card = r; }
  }
  if (!card) return JSON.stringify({ gap: Math.round(statusTop - p.top), card: 'none' });
  return JSON.stringify({ above: Math.round(card.top - p.top), below: Math.round(statusTop - card.bottom), h: Math.round(card.height), center: Math.round((card.top + card.bottom) / 2 - (p.top + statusTop) / 2) });
})()`;
const proc = spawn(CHROME, ["--headless=new","--disable-gpu","--no-sandbox","--hide-scrollbars","--force-device-scale-factor=1","--font-render-hinting=none","--allow-file-access-from-files",
  `--user-data-dir=${path.join(ROOT, ".stitch-refactor/.render/profile2")}`, `--remote-debugging-port=${PORT}`, "about:blank"], { stdio: "ignore" });
const out = [];
try {
  const ver = await waitJson(`http://127.0.0.1:${PORT}/json/version`);
  const br = conn(ver.webSocketDebuggerUrl); await br.ready;
  const { targetId } = await br.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await br.send("Target.attachToTarget", { targetId, flatten: true });
  await br.send("Page.enable", {}, sessionId);
  await br.send("Runtime.enable", {}, sessionId);
  for (const id of files) {
    const url = pathToFileURL(path.join(ROOT, '.stitch-refactor/out', id + '.html')).href;
    await br.send("Emulation.setDeviceMetricsOverride", { width: 1263, height: 1010, deviceScaleFactor: 1, mobile: false }, sessionId);
    await br.send("Page.navigate", { url }, sessionId);
    await new Promise(r => setTimeout(r, 900));
    const res = await br.send("Runtime.evaluate", { expression: EXPR, returnByValue: true }, sessionId);
    let v = res.result?.value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch {} }
    out.push({ id, ...(v || {}) });
  }
} finally { proc.kill(); }
const bad = out.filter(o => o.card !== 'none' && Math.abs(o.center) > 40);
for (const b of bad) console.log('OFF-CENTER ' + b.id + ' above=' + b.above + ' below=' + b.below + ' h=' + b.h);