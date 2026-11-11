
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
  const inPanel = all.filter(el => panel.contains(el) && el !== panel);
  const rects = inPanel.map(el => ({ el, r: el.getBoundingClientRect() }));
  // 状态栏：面板内文字含「就绪」的最小容器
  let statusTop = p.bottom;
  for (const { el, r } of rects) {
    const txt = (el.textContent || '').trim();
    if (txt.startsWith('就绪') && txt.length < 20) statusTop = Math.min(statusTop, r.top);
  }
  let contentBottom = p.top;
  for (const { el, r } of rects) {
    if (r.height <= 0 || r.width <= 0) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') continue;
    if (r.bottom > statusTop + 1) continue;   // 状态栏自身或跨过它的层
    if (r.bottom > p.bottom - 1) continue;
    // 只统计「有实质内容」的盒子：跳过纯容器（子元素全部更矮且无背景/边框）
    if (r.height > 600) continue;
    contentBottom = Math.max(contentBottom, r.bottom);
  }
  return JSON.stringify({ gap: Math.round(statusTop - contentBottom), panelTop: Math.round(p.top), statusTop: Math.round(statusTop) });
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
const bad = out.filter(o => o.gap > 60).sort((a, b) => b.gap - a.gap);
console.log(JSON.stringify(out.map(o => o.id + ':' + (o.gap ?? o.error)), null, 0));
console.log('>60px:');
for (const b of bad) console.log('  ' + b.id + '  ' + b.gap + 'px');
