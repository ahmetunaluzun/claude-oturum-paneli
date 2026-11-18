// Yeni oturum → Klasörler: kök çipine girer, arama yazar (alt klasör araması dahil), ekran görüntüsü alır.
// Ayrıca kota kutusundaki "kalan süre" satırlarını yazdırır.
// Kullanım: node arama_shot.mjs <debugPort> <url> <genişlik> <arama> <out.png>
import { writeFileSync } from "node:fs";
const [port, url, width, query, out] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const wait = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true })).result?.result?.value;
const w = Number(width);
await send("Emulation.setDeviceMetricsOverride", { width: w, height: w < 600 ? 844 : 900, deviceScaleFactor: 1, mobile: w < 600 });
await send("Page.navigate", { url });
await sleep(3000);
console.log("kota:", await ev(`[...document.querySelectorAll("#usage .ring")].map(r => r.innerText.replace(/\\s+/g, " ")).join(" || ")`));
console.log("kota taşma:", await ev(`(() => { const b = document.getElementById("usage"); return b.scrollWidth > b.clientWidth + 1; })()`));
await ev(`document.getElementById("btnNew").click()`);
await sleep(1000);
await ev(`document.querySelector('#projTabs [data-tab="browse"]').click()`);
await sleep(1000);
await ev(`document.querySelector('#dirRoots .chip')?.click()`);
await sleep(1000);
await ev(`(() => { const s = document.getElementById("projSearch"); s.value = ${JSON.stringify(query)}; s.dispatchEvent(new Event("input")); })()`);
await sleep(1200);
console.log("yol:", await ev(`[...document.querySelectorAll("#dirCrumbs button")].map(b=>b.textContent).join(" > ")`));
console.log("düzey1:", await ev(`document.querySelectorAll("#projList .dir-row:not(.self):not(.deep)").length`),
  "alt:", await ev(`document.querySelectorAll("#projList .dir-row.deep").length`),
  "başlık:", await ev(`document.querySelector("#projList .dir-deep-head")?.textContent || "-"`));
console.log("satırlar:", await ev(`[...document.querySelectorAll("#projList .dir-row:not(.self)")].slice(0, 6).map(r => r.innerText.replace(/\\s+/g, " ")).join(" | ")`));
console.log("liste taşma:", await ev(`(() => { const b = document.getElementById("projList"); return b.scrollWidth > b.clientWidth + 1; })()`));
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
ws.close();
