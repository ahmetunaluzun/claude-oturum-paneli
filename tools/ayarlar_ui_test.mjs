// Ayarlar sekmesi: ⚙ ve "Ayarlar" sekmesi aynı görünümü açar, pencere (dialog) açılmaz; eski pencerenin her ayarı bir
// bölümde ve ekranda görünür (elementFromPoint); bölüm menüsü geniş ekranda yapışkan, dar ekranda yatay şerit; sayfa yana
// taşmaz; koyu ve açık temada. Kullanım: node ayarlar_ui_test.mjs <debugPort> <url> <çıktı öneki>
import { writeFileSync } from "node:fs";
const [port, url, out] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const wait = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "GEÇTİ" : "KALDI"}  ${name}${ok ? "" : ` (beklenen ${JSON.stringify(want)}, gelen ${JSON.stringify(got)})`}`);
  if (!ok) fail = 1;
};
const until = async (expr, ms = 6000) => { for (let i = 0; i < ms / 150; i++) { if (await ev(expr)) return true; await sleep(150); } return false; };
const size = async (w, h, mobile = false) => { await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile }); await sleep(500); };
const theme = async (light) => {
  await ev(`localStorage.setItem("panel.settings", JSON.stringify(Object.assign(JSON.parse(localStorage.getItem("panel.settings")||"{}"), {light:${light}, lang:"tr"}))); location.reload()`);
  await sleep(3200);
};
const openSettings = async () => { await ev(`document.getElementById("btnSettings").click()`); await until(`!document.getElementById("viewSettings").hidden`); await sleep(500); };
// Öğe ekranda mı: ortaya kaydırılır, orta noktasında kendisi (ya da içi/etiketi) var mı
const seen = (sel) => ev(`(async () => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return "yok";
  e.scrollIntoView({ block: "center", behavior: "instant" }); await new Promise(r => setTimeout(r, 60));
  const b = e.getBoundingClientRect(); if (!b.width || !b.height) return "boyutsuz";
  const x = b.left + b.width / 2, y = b.top + b.height / 2;
  if (x < 0 || x > innerWidth || y < 0 || y > innerHeight) return "ekran dışı";
  const hit = document.elementFromPoint(x, y);
  return hit && (e.contains(hit) || hit.contains(e) && hit.closest("label")) ? "görünür" : "örtülü: " + (hit?.id || hit?.className || hit?.tagName); })()`);
// Sayfayı body kaydırır (app.css): kaydırma konumu ve sayfa sonu oradan okunur
const SC = `(document.body.scrollHeight > document.body.clientHeight + 1 ? document.body : document.scrollingElement)`;
const scrollTop = async (y) => { await ev(`document.body.scrollTop = ${y}; document.scrollingElement.scrollTop = ${y}`); await sleep(300); };
const settle = async () => { let last = -1; for (let i = 0; i < 30; i++) { const y = await ev(`${SC}.scrollTop`); if (y === last) return; last = y; await sleep(120); } };
// Tam sayfa görüntü: kaydıran öğe body olduğu için görüntü süresince sayfa boyu serbest bırakılır
const shot = async (name) => {
  await scrollTop(0);
  // Sayfanın içerik güvenlik kuralı <style> eklemeye izin vermez: stil CSSOM ile verilir. Menüde seçili kalan bölüm de bırakılır.
  await ev(`(() => { for (const e of [document.documentElement, document.body]) { e.style.setProperty("height", "auto", "important"); e.style.setProperty("overflow", "visible", "important"); }
    dispatchEvent(new Event("wheel")); document.body.dispatchEvent(new Event("scroll")); })()`);
  await sleep(300);
  const { width, height } = (await send("Page.getLayoutMetrics")).result.cssContentSize;
  const s = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.min(height, 9000), scale: 1 } });
  writeFileSync(`${out}_${name}.png`, Buffer.from(s.result.data, "base64"));
  await ev(`(() => { for (const e of [document.documentElement, document.body]) { e.style.removeProperty("height"); e.style.removeProperty("overflow"); } })()`);
  await sleep(200);
};
// Yana taşma ve sıkışmış (18 px'ten kısa) onay satırı
const layout = () => ev(`(() => { const v = document.getElementById("viewSettings");
  const wide = [...v.querySelectorAll("*")].filter(e => e.offsetWidth && e.getBoundingClientRect().right > innerWidth + 1 && !e.closest(".set-nav")).map(e => e.id || e.className).slice(0, 3);
  const squeezed = [...v.querySelectorAll("label.check")].filter(l => l.offsetWidth && l.getBoundingClientRect().height < 18).length;
  return { pageOverflow: document.documentElement.scrollWidth > innerWidth + 1, wide, squeezed }; })()`);

const LEGACY = ["#sLight", "#sLang", "#sGithub", "#tqEnabled", "#sNotify", "#sSound", "#nEnabled", "#nStart", "#nEnd", "#nAutostart", "#btnNightLog",
  "#mwEmail", "#btnMwApp", "#mwPass", "#btnMwConnect", "#smDirect", "#smSenders", "#rEnabled", "#btnResetTabs", "#btnRestart", "#btnQuit"];

await size(1280, 900);
await send("Page.navigate", { url });
await sleep(3500);
await theme(false);

// ---- (a) Sekme ve bölümler ----
check("üst menüde Ayarlar sekmesi", await ev(`[...document.querySelectorAll("#nav button")].map(b => b.dataset.view)`), ["sessions", "recent", "skills", "follow", "settings"]);
check("eski pencere yok", await ev(`!!document.getElementById("dlgSettings")`), false);
await openSettings();
check("⚙: Ayarlar görünümü açık, sekme etkin, pencere açılmadı",
  await ev(`[!document.getElementById("viewSettings").hidden, document.querySelector("#nav button.active")?.dataset.view, !!document.querySelector("dialog[open]"), document.getElementById("viewSessions").hidden]`),
  [true, "settings", false, true]);
await ev(`document.querySelector('#nav button[data-view="sessions"]').click()`); await sleep(300);
check("Oturumlar'a dönüş", await ev(`[document.getElementById("viewSettings").hidden, document.getElementById("viewSessions").hidden]`), [true, false]);
await ev(`document.querySelector('#nav button[data-view="settings"]').click()`); await sleep(700);
check("Ayarlar sekmesi: görünüm açık ve ayarlar dolu (dil seçili)", await ev(`[!document.getElementById("viewSettings").hidden, document.getElementById("sLang").value]`), [true, "tr"]);
const NAV_ALL = ["setAccounts", "setWorkers", "setRouting", "setGeneral", "setNotify", "setNight", "setMail", "setPhone", "setGoogle", "setAdvanced"];
const navShown = await ev(`[...document.querySelectorAll("#setNav button")].filter(b => !b.hidden).map(b => b.dataset.sec)`);
check("bölüm menüsü: görünen her satırın bölümü var ve sıra doğru",
  [navShown.every(s => NAV_ALL.includes(s)), JSON.stringify(navShown) === JSON.stringify(NAV_ALL.filter(s => navShown.includes(s))),
    await ev(`[...document.querySelectorAll("#setNav button")].filter(b => !b.hidden).every(b => { const s = document.getElementById(b.dataset.sec); return s && !s.hidden && s.querySelector("h2"); })`)],
  [true, true, true]);
for (const need of ["setGeneral", "setNotify", "setNight", "setMail", "setPhone", "setAdvanced"]) check(`bölüm var: ${need}`, navShown.includes(need), true);
check("ayarlar bölümlerine dağılmış", await ev(`(() => { const sec = (id) => document.getElementById(id).closest(".set-sec")?.id;
  return [sec("sLight"), sec("sLang"), sec("sGithub"), sec("tqBox"), sec("sNotify"), sec("sSound"), sec("nEnabled"), sec("mailBox"), sec("remoteBox"), sec("btnResetTabs"), sec("btnRestart"), sec("btnQuit")]; })()`),
  ["setGeneral", "setGeneral", "setGeneral", "setGeneral", "setNotify", "setNotify", "setNight", "setMail", "setPhone", "setAdvanced", "setAdvanced", "setAdvanced"]);

for (const [light, tn] of [[false, "koyu"], [true, "acik"]]) {
  if (light) { await theme(true); await openSettings(); }
  for (const [w, h, mob, n] of [[1280, 900, false, "genis"], [500, 900, true, "telefon"]]) {
    await size(w, h, mob);
    await scrollTop(0);
    const bad = [];
    for (const sel of LEGACY) { const r = await seen(sel); if (r !== "görünür") bad.push(`${sel}: ${r}`); }
    check(`${tn} ${n}: eski ayarların hepsi ekranda görünür (${LEGACY.length})`, bad, []);
    check(`${tn} ${n}: yana taşma yok, sıkışmış onay satırı yok`, await layout(), { pageOverflow: false, wide: [], squeezed: 0 });
    // Bölüm menüsü: her satır kendi bölümünü başlığın hemen altına getirir ve etkin olur
    const navBad = [];
    for (const secId of navShown) {
      await ev(`document.querySelector('#setNav button[data-sec="${secId}"]').click()`); await sleep(150); await settle();
      const r = await ev(`(() => { const s = document.getElementById("${secId}"), top = document.querySelector("header.top");
        const stuck = getComputedStyle(top).position === "sticky" ? top.getBoundingClientRect().bottom : 0;
        const h2 = s.querySelector("h2").getBoundingClientRect(); const hit = document.elementFromPoint(h2.left + 4, h2.top + h2.height / 2);
        const sc = ${SC}, atEnd = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4;
        return { active: document.querySelector("#setNav button.active")?.dataset.sec, under: h2.top >= stuck - 1, near: h2.top - stuck < 80 || atEnd, hit: !!hit && s.contains(hit) }; })()`);
      if (r.active !== secId || !r.under || !r.near || !r.hit) navBad.push(`${secId}: ${JSON.stringify(r)}`);
    }
    check(`${tn} ${n}: menü satırı bölümünü başlığın altına getirir`, navBad, []);
    if (n === "genis") {
      await scrollTop(600);
      await ev(`dispatchEvent(new Event("wheel")); document.body.dispatchEvent(new Event("scroll"))`); await sleep(200);
      check(`${tn} genis: kaydırınca etkin satır değişir`, await ev(`document.querySelector("#setNav button.active")?.dataset.sec !== "${navShown[0]}"`), true);
      check(`${tn} genis: menü solda yapışkan`, await ev(`(() => { const n = document.getElementById("setNav").getBoundingClientRect(), top = document.querySelector("header.top").getBoundingClientRect();
        return [n.top >= top.bottom, n.top < top.bottom + 40, n.width < 260, getComputedStyle(document.getElementById("setNav")).flexDirection]; })()`), [true, true, true, "column"]);
    } else {
      check(`${tn} telefon: menü üstte yatay şerit`, await ev(`(() => { const n = document.getElementById("setNav");
        return [getComputedStyle(n).flexDirection, n.getBoundingClientRect().height < 70, n.getBoundingClientRect().right <= innerWidth + 1]; })()`), ["row", true, true]);
    }
    await shot(`${n}${light ? "_acik" : ""}`);
  }
  await size(1280, 900);
}
await theme(false);
await openSettings();
// Ayarlar çalışıyor: açık tema kutusu temayı değiştirir, kalıcıdır
await ev(`document.getElementById("sLight").click()`); await sleep(300);
check("açık tema kutusu çalışır ve saklanır", await ev(`[document.documentElement.dataset.theme, JSON.parse(localStorage.getItem("panel.settings")).light]`), ["light", true]);
await ev(`document.getElementById("sLight").click()`); await sleep(200);
// Adresten açılış
await send("Page.navigate", { url: url + "?view=settings" }); await sleep(3200);
check("?view=settings Ayarlar'ı açar", await ev(`[!document.getElementById("viewSettings").hidden, document.querySelector("#nav button.active")?.dataset.view]`), [true, "settings"]);

ws.close();
process.exit(fail);
