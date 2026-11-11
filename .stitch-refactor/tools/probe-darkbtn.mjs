
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9414, ROOT = path.resolve(".");
const EXPR = fs.readFileSync(".stitch-refactor/tools/expr-darkbtn.js", "utf8");
async function waitJson(url, tries = 80) { for (let i = 0; i < tries; i++) { try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {} await new Promise(r => setTimeout(r, 250)); } throw new Error("cdp down"); }
function conn(url) { const ws = new WebSocket(url); let id = 0; const p = new Map();
  ws.addEventListener("message", ev => { const m = JSON.parse(ev.data); if (m.id && p.has(m.id)) { const { res, rej } = p.get(m.id); p.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } });
  const ready = new Promise((res, rej) => { ws.addEventListener("open", () => res(1)); ws.addEventListener("error", rej); });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const mid = ++id; p.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) })); });
  return { ready, send, ws }; }
const ids = process.argv.slice(2);
const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--allow-file-access-from-files", "--user-data-dir=" + path.join(ROOT, ".stitch-refactor/.render/profile4"), "--remote-debugging-port=" + PORT, "about:blank"], { stdio: "ignore" });
const out = [];
try {
  const ver = await waitJson("http://127.0.0.1:" + PORT + "/json/version");
  const br = conn(ver.webSocketDebuggerUrl); await br.ready;
  const { targetId } = await br.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await br.send("Target.attachToTarget", { targetId, flatten: true });
  await br.send("Page.enable", {}, sessionId); await br.send("Runtime.enable", {}, sessionId);
  for (const id of ids) {
    await br.send("Emulation.setDeviceMetricsOverride", { width: 1263, height: 1010, deviceScaleFactor: 1, mobile: false }, sessionId);
    await br.send("Page.navigate", { url: pathToFileURL(path.join(ROOT, ".stitch-refactor/out", id + ".html")).href }, sessionId);
    await new Promise(r => setTimeout(r, 1200));
    const r = await br.send("Runtime.evaluate", { expression: EXPR, returnByValue: true }, sessionId);
    out.push({ id, darkButtons: r.result?.value ?? r.exceptionDetails?.text ?? null });
  }
} finally { proc.kill(); }
console.log(JSON.stringify(out));