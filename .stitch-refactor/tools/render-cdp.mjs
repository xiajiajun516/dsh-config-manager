
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9411;
const ROOT = path.resolve(".");

async function waitJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("cdp not up");
}

function conn(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    else if (m.method) listeners.forEach(f => f(m));
  });
  const ready = new Promise((res, rej) => { ws.addEventListener("open", () => res(1)); ws.addEventListener("error", rej); });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { ready, send, ws, on: (f) => listeners.push(f) };
}

const jobs = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const proc = spawn(CHROME, ["--headless=new","--disable-gpu","--no-sandbox","--hide-scrollbars",
  "--force-device-scale-factor=1","--font-render-hinting=none","--allow-file-access-from-files",
  `--user-data-dir=${path.join(ROOT, ".stitch-refactor/.render/profile")}`,
  `--remote-debugging-port=${PORT}`, "about:blank"], { stdio: "ignore" });

try {
  const ver = await waitJson(`http://127.0.0.1:${PORT}/json/version`);
  const br = conn(ver.webSocketDebuggerUrl);
  await br.ready;
  const { targetId } = await br.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await br.send("Target.attachToTarget", { targetId, flatten: true });
  const S = br.send;
  await S("Page.enable", {}, sessionId);
  await S("Runtime.enable", {}, sessionId);

  const report = [];
  for (const j of jobs) {
    await S("Emulation.setDeviceMetricsOverride", { width: j.vw, height: j.vh, deviceScaleFactor: j.dsf, mobile: false }, sessionId);
    await S("Page.navigate", { url: j.url }, sessionId);
    await new Promise(r => setTimeout(r, 1200));
    await S("Runtime.evaluate", { expression: "document.fonts.ready.then(()=>document.title)", awaitPromise: true, returnByValue: true }, sessionId);
    await new Promise(r => setTimeout(r, 700));
    const probe = await S("Runtime.evaluate", { expression: j.probe, awaitPromise: true, returnByValue: true }, sessionId);
    const shot = await S("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }, sessionId);
    await fs.writeFile(j.out, Buffer.from(shot.data, "base64"));
    report.push({ id: j.id, probe: probe.result?.value, bytes: Buffer.byteLength(shot.data, "base64") });
  }
  console.log(JSON.stringify(report, null, 1));
} finally {
  proc.kill("SIGKILL");
  try { await fs.rm(path.join(ROOT, ".stitch-refactor/.render/profile"), { recursive: true, force: true }); } catch {}
}
