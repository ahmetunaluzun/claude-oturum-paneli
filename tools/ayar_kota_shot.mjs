// Ayarlar → "Terminal oturumlarında kota" kutusu: kapalı ve açık hâlin ekran görüntüsü + taşma ölçümü.
// Test kopyasıyla (CLAUDE_PANEL_CLAUDE_DIR geçici klasör) kullan; kutuyu gerçekten açıp kapatır.
// Kullanım: node ayar_kota_shot.mjs <debugPort> <url> <outPrefix> [genişlik] [light]
import { writeFileSync } from "node:fs";
const [port, url, out, width = "1280", theme] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const wait = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true })).result?.result?.value;
await send("Emulation.setDeviceMetricsOverride", { width: +width, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.clear(); localStorage.setItem("panel.settings", JSON.stringify({ lang: "tr", light: ${theme === "light"} }));` });
await send("Page.navigate", { url });
await sleep(3000);
const shot = async (name) => {
  await ev(`document.getElementById("tqBox").scrollIntoView({ block: "center" })`);
  await sleep(300);
  const s = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${out}_${name}.png`, Buffer.from(s.result.data, "base64"));
};
const measure = () => ev(`JSON.stringify((() => { const b = document.getElementById("tqBox"), d = document.querySelector("#dlgSettings form");
  return { box: Math.round(b.getBoundingClientRect().width), boxScroll: b.scrollWidth - b.clientWidth, dlgScroll: d.scrollWidth - d.clientWidth,
    state: document.getElementById("tqState").textContent, checked: document.getElementById("tqEnabled").checked }; })())`);
await ev(`document.getElementById("btnSettings").click()`);
await sleep(1200);
console.log("kapalı:", await measure());
await shot("kapali");
await ev(`document.getElementById("tqEnabled").click()`);
await sleep(500);
await ev(`document.querySelector('#dlgAsk[open] button[value="yes"]')?.click()`); // mevcut durum satırı varsa panelin onay penceresi
await sleep(1500);
console.log("açık:", await measure());
await shot("acik");
await ev(`document.getElementById("tqEnabled").click()`);
await sleep(1500);
console.log("geri kapalı:", await measure());
ws.close();
