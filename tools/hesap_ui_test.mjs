// İki hesaplı kota görünümü (Accounts.cs): üst çubukta her hesap adıyla iki halka; geniş, dar ve telefon ekranında
// görünür mü, taşma var mı, koyu/açık temada. Kullanım: node hesap_ui_test.mjs <debugPort> <url> <çıktı öneki>
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
// Her halka ekranda ve üstünde başka öğe yok mu (elementFromPoint), üst çubuk yatay taşıyor mu
const measure = `(() => {
  const box = document.getElementById("usage");
  const names = [...box.querySelectorAll(".acct-name")].map(e => e.textContent);
  const rings = [...box.querySelectorAll(".ring")];
  const visible = rings.filter(r => { const b = r.getBoundingClientRect(); if (!b.width) return false;
    const x = b.left + Math.min(14, b.width / 2), y = b.top + b.height / 2;
    return x >= 0 && x <= innerWidth && r.contains(document.elementFromPoint(x, y)); }).length;
  const top = document.querySelector(".top");
  const clipped = [...box.querySelectorAll(".acct-name, .ring b")].filter(e => e.scrollWidth > e.clientWidth + 1).length;
  return { multi: box.classList.contains("multi"), names, rings: rings.length, visible,
    overflow: top.scrollWidth > top.clientWidth + 1, clipped, crit: box.querySelectorAll(".ring.crit").length,
    title: rings[0]?.title || "" };
})()`;
async function shot(w, h, mobile, name) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await sleep(900);
  const m = await ev(measure);
  const s = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: mobile ? 260 : 120, scale: 1 } });
  writeFileSync(`${out}_${name}.png`, Buffer.from(s.result.data, "base64"));
  return m;
}
await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
await sleep(3500);
for (const light of [false, true]) {
  await ev(`localStorage.setItem("panel.settings", JSON.stringify(Object.assign(JSON.parse(localStorage.getItem("panel.settings")||"{}"), {light:${light}, lang:"tr"}))); location.reload()`);
  await sleep(3500);
  const theme = light ? "acik" : "koyu";
  for (const [w, h, mob, n] of [[1500, 900, false, "genis"], [1100, 900, false, "dar"], [390, 844, true, "telefon"]]) {
    const m = await shot(w, h, mob, `${theme}_${n}`);
    check(`${theme} ${n}: iki hesap adıyla`, [m.multi, m.names], [true, ["Kişisel", "Örnek Şirket A.Ş."]]);
    check(`${theme} ${n}: 4 halka, hepsi görünür`, [m.rings, m.visible], [4, 4]);
    check(`${theme} ${n}: üst çubuk taşmıyor, metin kesilmiyor`, [m.overflow, m.clipped], [false, 0]);
    if (n === "genis") {
      check(`${theme}: kişisel haftalık %1 kırmızı`, m.crit, 1);
      check(`${theme}: halkanın üstünde yenilenme saati`, m.title.includes("Yenilenme:"), true);
    }
  }
}
// Kart: rozet hesap adını taşır, ⋯ menüsünde öteki hesaba geçiş
await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.setItem("panel.settings", JSON.stringify(Object.assign(JSON.parse(localStorage.getItem("panel.settings")||"{}"), {light:false}))); location.reload()`);
await sleep(3500);
check("kart rozeti: Terminal · şirket", await ev(`document.querySelector('.card .kind-badge')?.textContent`), "Terminal · Örnek Şirket A.Ş.");
await ev(`document.querySelector('.card .more').click()`);
await sleep(500);
const items = await ev(`[...document.querySelectorAll('.pop-menu [role=menuitem]')].map(b => b.textContent)`);
check("⋯ menüsünde kişisel hesaba geçiş", items?.includes("Kişisel hesabında devam et"), true);
check("kendi hesabına geçiş yok", items?.some(x => x.includes("Örnek Şirket A.Ş. hesabında")), false);
const s2 = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`${out}_menu.png`, Buffer.from(s2.result.data, "base64"));
// Yeni oturum penceresi: hesap seçimi görünür; kayıtlı projede şirket hesabı, başka klasörde varsayılan hesap seçili
await ev(`document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}))`);
await sleep(300);
await ev(`document.getElementById("btnNew").click()`);
await sleep(1200);
const pickAcct = (p) => ev(`(() => { const c = document.getElementById("fCwd"); c.value = ${JSON.stringify(p)};
  c.dispatchEvent(new Event("input")); const s = document.getElementById("fAccount"), r = document.getElementById("fAccountRow");
  return { shown: !r.hidden && r.getBoundingClientRect().height > 0, picked: s.selectedOptions[0]?.textContent, n: s.options.length }; })()`);
check("yeni oturum: kayıtlı proje şirket hesabında", await pickAcct(process.env.HESAP_PROJ), { shown: true, picked: "Örnek Şirket A.Ş.", n: 2 });
check("yeni oturum: alt klasör de projenin hesabında", (await pickAcct(process.env.HESAP_PROJ + "\\alt")).picked, "Örnek Şirket A.Ş.");
check("yeni oturum: başka klasör kişisel hesapta", (await pickAcct(process.env.HESAP_BASKA)).picked, "Kişisel");
const s3 = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`${out}_yeni_oturum.png`, Buffer.from(s3.result.data, "base64"));
// Kota önerisi: kişisel hesapta boşta oturum yokken şerit yok; oturum gelince görünür, "Şimdi değil" susturur
await ev(`document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"})); location.reload()`);
await sleep(3500);
const hint = () => ev(`(() => { const h = document.getElementById("quotaHint"), b = h.getBoundingClientRect();
  const btn = document.getElementById("btnQuotaMove"), r = btn.getBoundingClientRect();
  return { shown: !h.hidden && b.height > 0, text: document.getElementById("quotaHintText").textContent, move: btn.textContent,
    btnOnTop: !h.hidden && btn.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)),
    overflow: h.scrollWidth > h.clientWidth + 1 }; })()`);
check("kota önerisi: kişisel hesapta oturum yokken görünmez", (await hint()).shown, false);
writeFileSync(process.env.HESAP_KISISEL_PATH, process.env.HESAP_KISISEL_JSON);
let hs;
for (let i = 0; i < 20; i++) { await sleep(500); hs = await hint(); if (hs.shown) break; }
check("kota önerisi: görünür, düğme tıklanabilir, taşmıyor", [hs.shown, hs.btnOnTop, hs.overflow], [true, true, false]);
check("kota önerisi metni", hs.text, "Kişisel hesabında %1 kota kaldı. Boştaki 1 oturum Örnek Şirket A.Ş. hesabına geçirilebilir (orada %92 var); konuşmalar kaybolmaz.");
check("kota önerisi düğmesi", hs.move, "Örnek Şirket A.Ş. hesabına geçir");
for (const [w, h, mob, n] of [[1500, 900, false, "genis"], [390, 844, true, "telefon"]]) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: mob });
  await sleep(700);
  const m = await hint();
  check(`kota önerisi ${n}: düğme görünür, taşma yok`, [m.btnOnTop, m.overflow], [true, false]);
  const s4 = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: mob ? 500 : 300, scale: 1 } });
  writeFileSync(`${out}_kota_onerisi_${n}.png`, Buffer.from(s4.result.data, "base64"));
}
await ev(`document.getElementById("btnQuotaLater").click()`);
await sleep(2500);
check("Şimdi değil: öneri susar (durum yenilense de)", (await hint()).shown, false);
ws.close();
process.exit(fail);
