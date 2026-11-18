// Dikte uçtan uca (0.8.13): Chrome sahte mikrofonla (--use-file-for-fake-audio-capture) 🎤'a basılır, birkaç saniye
// kaydedilir, yeniden basılır; panelin çevirdiği metin yazma kutusuna düşmeli. Kota kutusundaki "bu hızla" satırını da yazdırır.
// Kullanım: node dikte_test.mjs <debugPort> <url> <kayıt sn> <beklenen sözcük>
const [port, url, secs, expect] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const wait = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true })).result?.result?.value;
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
await sleep(3000);
console.log("kota:", await ev(`[...document.querySelectorAll("#usage .ring")].map(r => r.innerText.replace(/\\s+/g, " ")).join(" || ")`));
console.log("düğme:", await ev(`document.getElementById("dMic")?.title`));
await ev(`document.getElementById("dMic").click()`);
await sleep(1500);
console.log("kayıtta:", await ev(`document.getElementById("dMic").className`));
await sleep(Number(secs) * 1000);
const t0 = Date.now();
await ev(`document.getElementById("dMic").click()`);
let state = "";
for (let i = 0; i < 120; i++) {
  await sleep(500);
  state = await ev(`document.getElementById("dMic").textContent`);
  if (state === "🎤") break;
}
const text = await ev(`document.getElementById("dInput").value`);
console.log(`çeviri süresi: ${((Date.now() - t0) / 1000).toFixed(1)} sn`);
console.log("metin:", text);
console.log("toast:", await ev(`[...document.querySelectorAll(".toast")].map(x => x.textContent).join(" | ")`));
ws.close();
const ok = state === "🎤" && text.toLowerCase().includes(expect.toLowerCase());
console.log(ok ? "GEÇTİ" : "KALDI");
process.exit(ok ? 0 : 1);
