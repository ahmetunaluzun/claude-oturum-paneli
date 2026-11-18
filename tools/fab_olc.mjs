// Telefonda yüzen + düğmesi: alt bilgiyle çakışma ve kaydırırken çekilme ölçümü.
// Kullanım: node fab_olc.mjs <debugPort> <url> <genişlik>
const [port, url, width] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const wait = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true })).result?.result?.value;
await send("Emulation.setDeviceMetricsOverride", { width: Number(width), height: 844, deviceScaleFactor: 1, mobile: true });
await send("Page.navigate", { url });
await sleep(3000);
// Kaydırılabilir olsun diye ana içeriğe uzun bir boşluk ekle
await ev(`document.querySelector("footer.bottom").insertAdjacentHTML("beforebegin", '<div style="height:2000px"></div>')`);
const overlap = `(() => { const f = document.getElementById("btnNew").getBoundingClientRect();
  const r = document.createRange(); r.selectNodeContents(document.querySelector("footer.bottom"));
  return [...r.getClientRects()].some(t => t.right > f.left && t.left < f.right && t.bottom > f.top && t.top < f.bottom); })()`;
const away = `document.getElementById("btnNew").classList.contains("away")`;
await ev(`document.body.scrollTo(0, 600)`); await sleep(400);
console.log("scrollY:", await ev(`document.body.scrollTop`), "yükseklik:", await ev(`document.body.scrollHeight`), "btnNew var:", await ev(`!!document.getElementById("btnNew")`));
console.log(width, "aşağı kaydırınca çekildi:", await ev(away));
await ev(`document.body.scrollTo(0, 300)`); await sleep(400);
console.log(width, "yukarı kaydırınca döndü:", !(await ev(away)));
await ev(`document.body.scrollTo(0, document.body.scrollHeight)`); await sleep(400);
console.log(width, "sayfa sonunda görünür:", !(await ev(away)), "alt bilgiyle çakışma:", await ev(overlap));
ws.close();
