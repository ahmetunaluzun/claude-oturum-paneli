// Başsız Chrome'da sayfayı telefon boyutunda açar, verilen JS adımlarını sırayla çalıştırır, ekran görüntüsü alır.
// Kullanım: node mobil_shot.mjs <debugPort> <url> <out.png> [genişlik=390] [yükseklik=844] [adım1] [adım2] ...
// Adım: sayfada çalışacak JS ifadesi; her adımdan sonra 900 ms beklenir. Son değerleri konsola yazar.
import { writeFileSync } from "node:fs";
const [port, url, out, w = "390", h = "844", ...steps] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const wait = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true })).result?.result?.value;
await send("Emulation.setDeviceMetricsOverride", { width: +w, height: +h, deviceScaleFactor: 2, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true });
// PRELOAD ortam değişkeni: sayfa betiklerinden ÖNCE çalışacak JS (ör. yükleme olayını saymak için)
if (process.env.PRELOAD) { await send("Page.enable"); await send("Page.addScriptToEvaluateOnNewDocument", { source: process.env.PRELOAD }); }
await send("Page.navigate", { url });
await sleep(2500);
for (const s of steps) { const v = await ev(s); if (v !== undefined) console.log(">", v); await sleep(900); }
// Yatay taşma ölçümü: sayfa genişliğinden taşan öğe var mı
console.log("taşma:", await ev(`(() => { const W = document.documentElement.clientWidth; return [...document.querySelectorAll("body *")].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > W + 1 && getComputedStyle(e).position !== "fixed"; }).slice(0, 5).map(e => e.tagName + "#" + e.id + "." + e.className).join(", ") || "yok"; })()`));
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
ws.close();
