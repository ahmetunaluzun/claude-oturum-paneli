// README ekran görüntüleri (docs/img/*.png). Uydurma ortamla (takip_ortam.sh + readme_ortam.py) açılmış test kopyasına karşı
// çalışır; tools/readme_gorsel_uret.ps1 çağırır. Gerçek oturum gösterilmez:
//  - /api/state yanıtı demo.json'dan kurulur (canlı kart için gerçek claude süreci gerekmez, hiçbiri başlatılmaz),
//  - telefondan erişim, gece modu ve terminal kotası yanıtları uydurma değerlerle verilir (Tailscale adı vb. görünmez),
//  - geri kalan JSON yanıtlarında geçici klasör yolu C:\Projeler / C:\Users\demo köküne çevrilir.
// Hiçbir eylem düğmesine BASILMAZ (yalnız kart, sekme, Yeni oturum ve Ayarlar açılır). Her görüntüden sonra sayfanın tüm metni,
// alan değerleri ve title/alt nitelikleri yasaklı sözcüklerle taranır; bulunursa görüntü silinir, çıkış kodu 1.
// Kullanım: node readme_shot.mjs <debugPort> <url> <outDir> <geçici kök> <demo.json> <yasaklı1,yasaklı2,...>
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
const [port, url, outDir, tempRoot, demoFile, banned = ""] = process.argv.slice(2);
const demo = JSON.parse(readFileSync(demoFile, "utf8"));
const home = process.env.USERPROFILE || "";
// Sabit liste yalnız genel iz taşır; kişiye/kuruma özel sözcükler (proje kökü, kurum adı...) depoya yazılmaz,
// README_YASAKLI ortam değişkeniyle (virgülle ayrılmış) verilir.
const BANNED = ["AppData", "\\Temp\\", "takip-shot", "readme-shot", ...banned.split(","), ...(process.env.README_YASAKLI || "").split(",")]
  .map(s => s.trim()).filter(s => s.length >= 3);

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

// Sayfaya, kendi betiklerinden ÖNCE enjekte edilen kod.
const injected = (o) => `(() => {
  localStorage.clear();
  localStorage.setItem("panel.settings", JSON.stringify({ lang: ${JSON.stringify(o.lang)}, light: ${o.light}, notify: true, sound: true }));
  ${o.remote ? `new MutationObserver((_, obs) => { const m = document.querySelector('meta[name="panel-remote"]'); if (m) { m.content = "1"; obs.disconnect(); } })
    .observe(document, { childList: true, subtree: true });` : ""}
  const DEMO = ${JSON.stringify(demo)};
  const MAP = ${JSON.stringify([[tempRoot + "\\projeler", "C:\\Projeler"], [tempRoot + "\\claude", "C:\\Users\\demo\\.claude"],
    [tempRoot, "C:\\Demo"], ...(home ? [[home, "C:\\Users\\demo"]] : [])])};
  const reEsc = (s) => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
  const RULES = MAP.flatMap(([a, b]) => [[JSON.stringify(a).slice(1, -1), JSON.stringify(b).slice(1, -1)], [a.replace(/\\\\/g, "/"), b.replace(/\\\\/g, "/")]])
    .map(([a, b]) => [new RegExp(reEsc(a), "gi"), b]);
  const rewrite = (txt) => RULES.reduce((t, [re, b]) => t.replace(re, () => b), txt);
  const realFetch = window.fetch.bind(window);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const HOST = "demo-pc.tail0000.ts.net";
  window.fetch = async (u, opt) => {
    const path = String(u), method = (opt && opt.method) || "GET";
    if (method === "GET" && path.startsWith("/api/state")) {
      const j = await (await realFetch(u, opt)).json();
      const shift = j.now - DEMO.now, at = (v) => v + shift;
      return json({ night: { enabled: true, active: false, waiting: null }, now: j.now, trayNotify: false,
        sessions: DEMO.sessions.map(s => ({ ...s, startedAt: at(s.startedAt), statusSince: at(s.statusSince) })),
        hosted: DEMO.hosted.map(h => ({ ...h, startedAt: at(h.startedAt), statusSince: at(h.statusSince) })),
        stats: DEMO.stats, usage: j.usage, home: "C:\\\\Users\\\\demo" });
    }
    if (method === "GET" && path === "/api/remote") {
      const j = await (await realFetch(u, opt)).json();
      return json({ enabled: true, host: HOST, tailscale: true, appQr: j.appQr, devices: [
        { id: "demo1", name: "iPhone", created: Date.now() - 6 * 86400000, lastSeen: Date.now() - 120000 },
        { id: "demo2", name: "Android", created: Date.now() - 2 * 86400000, lastSeen: Date.now() - 3 * 3600000 }] });
    }
    if (method === "GET" && path === "/api/remote/view")
      return json({ enabled: true, host: HOST, devices: [{ name: "iPhone", created: Date.now() - 6 * 86400000, lastSeen: Date.now(), current: true }] });
    if (method === "GET" && path === "/api/terminal-quota")
      return json({ enabled: true, available: true, currentStatusLine: null, ownGuard: false, error: null });
    if (method === "GET" && path === "/api/night") {
      const j = await (await realFetch(u, opt)).json();
      return json({ ...j, settings: { ...j.settings, enabled: true, start: "23:30", end: "07:00" }, active: false, waiting: null,
        autostart: true, autostartSupported: true, events: [] });
    }
    const r = await realFetch(u, opt);
    if (!path.startsWith("/api/") || !(r.headers.get("content-type") || "").includes("json")) return r;
    return new Response(rewrite(await r.text()), { status: r.status, headers: { "Content-Type": "application/json" } });
  };
})();`;

let scriptId = null;
async function load(o, query = "") {
  if (scriptId) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId });
  scriptId = (await send("Page.addScriptToEvaluateOnNewDocument", { source: injected(o) })).result.identifier;
  await send("Emulation.setDeviceMetricsOverride", { width: o.width, height: o.height, deviceScaleFactor: 1, mobile: o.width < 640 });
  await send("Emulation.setTouchEmulationEnabled", { enabled: o.width < 640 });
  await send("Page.navigate", { url: url + query });
  await sleep(3000);
}

// Sayfada görünen ya da gömülü her metin: yasaklı sözcük var mı.
const leakCheck = () => ev(`(() => {
  const bad = ${JSON.stringify(BANNED)}.map(s => s.toLowerCase());
  const parts = [document.body.innerText, document.title];
  document.querySelectorAll("input, textarea, select").forEach(e => parts.push(e.value, e.placeholder));
  document.querySelectorAll("*").forEach(e => { for (const a of ["title", "alt", "aria-label", "href", "data-path"]) if (e.getAttribute(a)) parts.push(e.getAttribute(a)); });
  const all = parts.join("\\n").toLowerCase();
  return JSON.stringify(bad.filter(b => all.includes(b)));
})()`);

let failed = false;
async function shot(name, clip) {
  const file = join(outDir, name + ".png");
  if (existsSync(file)) unlinkSync(file);
  const leaks = JSON.parse((await leakCheck()) ?? "[\"betik hatası\"]");
  const over = await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  const s = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  if (leaks.length) { failed = true; console.log(`${name}: SIZINTI ${leaks.join(", ")} — görüntü yazılmadı`); return; }
  writeFileSync(file, Buffer.from(s.result.data, "base64"));
  console.log(`${name}: yazıldı (yasaklı sözcük yok, yatay taşma ${over} px)`);
}
const click = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e) e.click(); return !!e; })()`);
const desk = { lang: "tr", light: false, remote: false, width: 1280, height: 800 };

// 1-2) Oturumlar, koyu ve açık tema
await load(desk);
await shot("oturumlar-koyu");
await load({ ...desk, light: true });
await shot("oturumlar-acik");

// 3) Konuşma çekmecesi (panel oturumu)
await load(desk);
console.log("kart:", await click(`.card[data-id="${demo.drawer}"]`));
await sleep(2500);
await shot("konusma");

// 4) Yeni oturum penceresi
await load(desk);
await click("#btnNew");
await sleep(1500);
await click('#projTabs [data-tab="recent"]');
await sleep(500);
await ev(`(() => { const b = [...document.querySelectorAll("#projList .proj")].find(x => x.textContent.includes("Demo Mağaza")); if (b) b.click();
  const p = document.getElementById("fPrompt"); p.value = "Ürün arama kutusuna otomatik tamamlama ekle; en çok aranan 5 ürünü öner."; p.blur(); })()`);
await sleep(500);
await shot("yeni-oturum");

// 5) Takip sekmesi (git taraması bitene kadar bekle)
await load(desk, "?view=follow");
for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector(".fu-chip") && document.querySelectorAll(".fu-sec").length >= 3 && !document.getElementById("btnFuRefresh").disabled`)) break; await sleep(500); }
await sleep(1200);
// Varsayılan görünüm projeye göre gruplamadır (0.13.0). Demo projelerinin çoğunda oturum açık olduğu için Git / Sıradaki
// işler satırları gizli gelir; README'de içerik görünsün diye gruplar açılır ve "N proje şu an oturumda açık" satırına dokunulur.
await click("#btnFuFold"); await sleep(400);
await click(`#fuBody > .fu-insess:not(.fu-aside)[aria-expanded="false"]`); await sleep(400);
await shot("takip");

// 6-7) Skill kütüphanesi, Son oturumlar
await load(desk, "?view=skills");
await shot("skill-kutuphanesi");
await load(desk, "?view=recent");
await shot("son-oturumlar");

// 8) Ayarlar (pencerenin tamamı sığsın diye uzun sayfa, görüntü pencereye kırpılır)
await load({ ...desk, height: 2000 });
await click("#btnSettings");
await sleep(2500);
// 0.21.0'dan beri Ayarlar bir sekme ve uzun: görüntü Hesaplar + Yapay zekâ işçileri bölümleriyle sınırlanır (altı kesik/boş kalmasın).
const box = JSON.parse(await ev(`JSON.stringify(document.getElementById("viewSettings").getBoundingClientRect())`));
const workersBottom = await ev(`document.getElementById("setWorkers").getBoundingClientRect().bottom`);
const pad = 24;
await shot("ayarlar", { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: Math.min(2000, workersBottom - box.y + 2 * pad) });

// 9-10) Telefon (telefondan erişim görünümü: bilgisayara özel düğmeler gizli)
const phone = { lang: "tr", light: false, remote: true, width: 390, height: 844 };
await load(phone);
await shot("telefon-oturumlar");
console.log("kart:", await click(`.card[data-id="${demo.drawer}"]`));
await sleep(2500);
await shot("telefon-konusma");

ws.close();
process.exit(failed ? 1 : 0);
