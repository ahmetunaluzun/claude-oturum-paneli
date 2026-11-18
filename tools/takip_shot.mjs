// Takip sekmesi: 1280 px koyu + açık tema ve 390 px telefon görüntüsü, taşma ölçümü.
// Uydurma ortamla (tools/takip_ortam.sh) çalışan test kopyasında kullan. "Karar bekleyenler" satırı için /api/state yanıtına
// tarayıcıda uydurma bir oturum eklenir (claude başlatılmaz); geçici klasör yolu görüntüde <gösterilecek kök> ile değiştirilir.
// Hiçbir düğmeye BASILMAZ (düğmeler gerçek claude oturumu başlatır).
// Kullanım: node takip_shot.mjs <debugPort> <url> <outPrefix> [gizlenecek kök] [gösterilecek kök]
import { writeFileSync } from "node:fs";
const [port, url, out, hideRoot = "", showRoot = "C:\\Projeler"] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const wait = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true })).result?.result?.value;
await send("Page.enable");
let injected = null;
const inject = async (light) => {
  if (injected) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected });
  injected = (await send("Page.addScriptToEvaluateOnNewDocument", { source: `
    localStorage.clear(); localStorage.setItem("panel.settings", JSON.stringify({ lang: "${process.env.LANG_UI || "tr"}", light: ${light}, notify: false, sound: false }));
    const realFetch = window.fetch, hide = ${JSON.stringify(hideRoot)}, show = ${JSON.stringify(showRoot)};
    const json = (o) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });
    window.fetch = async (u, o) => {
      const r = await realFetch(u, o);
      if (String(u).startsWith("/api/state")) {
        const j = await r.json();
        j.hosted.push({ key: "demo00000001", sessionId: null, cwd: show + "\\\\Fatura Servisi", name: "Fatura Servisi", status: "idle",
          startedAt: j.now - 3600000, statusSince: j.now - 1500000, model: "opus", lastError: null, costUsd: 0, task: null, night: "decision" });
        return json(j);
      }
      if (hide && String(u).startsWith("/api/followup") && (!o || !o.method)) return json(JSON.parse((await r.text()).split(JSON.stringify(hide).slice(1, -1)).join(JSON.stringify(show).slice(1, -1))));
      return r;
    };` })).result.identifier;
};
const measure = () => ev(`JSON.stringify((() => {
  const de = document.documentElement, rows = [...document.querySelectorAll(".fu-row")];
  const over = rows.filter(r => { const b = r.getBoundingClientRect(); return [...r.querySelectorAll("b, small, .fu-what, .btn, .fu-tag")].some(e => { const q = e.getBoundingClientRect(); return q.width && (q.right > b.right + 1 || q.left < b.left - 1); }); }).length;
  const nav = document.getElementById("nav").getBoundingClientRect();
  const navOver = [...document.querySelectorAll("#nav button")].filter(b => b.scrollWidth > b.clientWidth + 1 || b.getBoundingClientRect().right > nav.right + 1).length;
  return { yatayTasma: de.scrollWidth - de.clientWidth, satir: rows.length, tasanSatir: over, tasanSekme: navOver,
    rozet: document.getElementById("navFollow").textContent, bolum: [...document.querySelectorAll(".fu-fold .fu-name")].map(h => h.textContent),
    dugme: [...document.querySelectorAll(".fu-row .btn")].map(b => b.textContent), temiz: [...document.querySelectorAll(".fu-clean")].map(p => p.textContent) };
})())`);
for (const [name, width, light] of [["1280_koyu", 1280, false], ["1280_acik", 1280, true], ["390_telefon", 390, false]]) {
  await inject(light);
  await send("Emulation.setDeviceMetricsOverride", { width, height: width < 640 ? 1500 : 1000, deviceScaleFactor: 1, mobile: width < 640 });
  await send("Page.navigate", { url: url + "?view=follow" });
  // Tarama bitene kadar bekle (en çok 20 sn).
  for (let i = 0; i < 40; i++) { await sleep(500); if (await ev(`document.querySelectorAll(".fu-sec").length === 4 && !document.getElementById("btnFuRefresh").disabled`)) break; }
  await sleep(1200);
  console.log(name, await measure());
  const s = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${out}_${name}.png`, Buffer.from(s.result.data, "base64"));
}
ws.close();
