// Zamanlanmış görev satırları arayüz testi (ortamı tools/gorev_dugme_test.sh kurar). Bilinen Windows kodları gri bilgi
// (0x80070420 zaten çalışıyordu, 0xC000013A kapanışta durduruldu), gerçek arıza uyarı + "Claude'a incelet" öne çıkan düğme;
// açılan ayrıntıda Şimdi çalıştır / Logu aç / Claude'a incelet / "Bu kod bu görev için normal" (yeniden yüklemede kalıcı,
// geri alınabilir); Şimdi çalıştır panelin onay penceresinden geçer; İngilizce; 390 px. Tarayıcı confirm/alert/prompt YOK.
// Kullanım: node gorev_dugme_test.mjs <debugPort> <url> <çıktıÖneki> <geçiciKlasör>
import { writeFileSync } from "node:fs";
const [port, url, out, tmpRoot] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const wait = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ev = async (expr) => {
  const r = (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result;
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r?.result?.value;
};
let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "GEÇTİ " : "KALDI "} ${name}${ok ? "" : ` (beklenen ${JSON.stringify(want)}, gelen ${JSON.stringify(got)})`}`);
};
const until = async (expr, ms = 15000) => { for (let i = 0; i < ms / 250; i++) { if (await ev(expr)) return true; await sleep(250); } return false; };
const J = JSON.stringify;
const native = { confirm: 0, alert: 0, prompt: 0 }, errors = [];
const INJECT = (lang) => `(() => {
  const s = JSON.parse(localStorage.getItem("panel.settings") || "{}");
  localStorage.setItem("panel.settings", JSON.stringify({ ...s, lang: "${lang}", light: false, notify: false, sound: false }));
  window.__n = { confirm: 0, alert: 0, prompt: 0 };
  for (const k of ["confirm", "alert", "prompt"]) window[k] = () => { window.__n[k]++; return k === "confirm" ? false : null; };
  window.addEventListener("error", e => (window.__errors ||= []).push(String(e.message)));
  window.addEventListener("unhandledrejection", e => (window.__errors ||= []).push(String(e.reason)));
})();`;
let injected = null;
async function tally() { const n = await ev(`window.__n`) || { confirm: -1, alert: -1, prompt: -1 }; for (const k in native) native[k] += n[k]; errors.push(...await ev(`window.__errors || []`)); }
async function open(width, lang = "tr") {
  if (injected) { await tally(); await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected }); }
  injected = (await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT(lang) })).result.identifier;
  await send("Emulation.setDeviceMetricsOverride", { width, height: width < 500 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 500 });
  await send("Page.navigate", { url: url + "?view=follow" });
  await until(`document.querySelector(".fu-chip") && !document.getElementById("btnFuRefresh").disabled`);
  // Türe göre görünüm + Zamanlanmış işler bölümü açık (durum localStorage'da kalır; her açılışta denetlenir)
  await ev(`(() => { const m = document.querySelector('.fu-mode[data-mode="type"]'); if (m && m.getAttribute("aria-pressed") !== "true") m.click(); })()`);
  await sleep(300);
  await ev(`(() => { const s = [...document.querySelectorAll(".fu-sec")].find(s => s.querySelector(".fu-name").textContent === ${JSON.stringify(lang === "en" ? "Scheduled work" : "Zamanlanmış işler")});
    const f = s?.querySelector(".fu-fold"); if (f && f.getAttribute("aria-expanded") === "false") f.click(); })()`);
  if (!(await until(`document.querySelectorAll('.fu-row[data-type="task"]').length === 8`))) check("görev satırları göründü", await ev(`document.querySelectorAll('.fu-row[data-type="task"]').length`), 8);
  await sleep(500);
}
const shot = async (name) => { await sleep(400); const s = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }); writeFileSync(`${out}_${name}.png`, Buffer.from(s.result.data, "base64")); };
const click = async (expr, waitMs = 400) => { await ev(`(${expr}).click()`); await sleep(waitMs); };
const rowOf = (name) => `[...document.querySelectorAll('.fu-row[data-type="task"]')].find(r => r.querySelector("b").textContent === ${J(name)})`;
const row = (name) => ev(`(() => { const r = ${rowOf(name)}; if (!r) return null; return { yan: [...r.querySelectorAll(".fu-side .btn")].map(b => b.textContent),
  ek: [...r.querySelectorAll(".fu-more .btn")].map(b => b.textContent), etiket: [...r.querySelectorAll(".fu-tag")].map(x => x.textContent),
  ne: r.querySelector(".fu-what")?.textContent || "", acik: r.classList.contains("fu-open") }; })()`);
const btn = (name, label) => click(`[...${rowOf(name)}.querySelectorAll(".btn")].find(b => b.textContent === ${J(label)})`);
const expand = async (name) => { if (!(await row(name)).acik) await click(`${rowOf(name)}.querySelector(".fu-tog")`); };
const box = () => ev(`(() => { const d = document.querySelector("#dlgAsk[open]"); if (!d) return null;
  return { title: document.getElementById("askTitle").textContent, list: [...document.querySelectorAll("#askList li")].map(x => x.textContent), buttons: [...document.querySelectorAll("#askButtons button")].map(b => b.textContent) }; })()`);
const press = async (value) => { await ev(`document.querySelector('#dlgAsk[open] button[value="${value}"]').click()`); await sleep(400); };
const toasts = () => ev(`[...document.querySelectorAll(".toast")].map(x => x.textContent)`);
const api = (path, body) => ev(`fetch(${J(path)}, { method: "POST", headers: { "X-Panel-Token": document.querySelector('meta[name="panel-token"]').content, "Content-Type": "application/json" }, body: JSON.stringify(${J(body)}) }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }))`);
const measure = () => ev(`(() => { const rows = [...document.querySelectorAll(".fu-row")];
  const over = rows.filter(r => { const b = r.getBoundingClientRect(); return [...r.querySelectorAll("b, small, .fu-what, .btn, .fu-tag")].some(e => { const q = e.getBoundingClientRect(); return q.width && (q.right > b.right + 1 || q.left < b.left - 1); }); }).length;
  const small = matchMedia("(max-width: 640px)").matches ? [...document.querySelectorAll(".fu-row .btn")].filter(e => e.offsetWidth && e.getBoundingClientRect().height < 44).map(e => e.textContent) : [];
  return { yatayTasma: document.documentElement.scrollWidth - document.documentElement.clientWidth, tasanSatir: over, kucukDokunma: small }; })()`);
const CLEAN = { yatayTasma: 0, tasanSatir: 0, kucukDokunma: [] };

await send("Page.enable");
await open(1280);
await ev(`localStorage.removeItem("panel.follow")`);
await open(1280);
// (bölüm open() içinde açılır)
await sleep(400);

// ---- sonuç kodları: bilgi / hata ----
let r = await row("Edge İzleyici");
check("0x80070420: gri bilgi, 'zaten çalışıyordu'", [r.etiket, r.ne.endsWith("— zaten çalışıyordu, yenisi başlamadı")], [["Görev Zamanlayıcı"], true]);
r = await row("Bekçi");
check("0x800710E0 + görev çalışıyor: gri bilgi, 'zaten çalışıyordu'", [r.etiket, r.ne.endsWith("— zaten çalışıyordu, yenisi başlamadı")], [["Görev Zamanlayıcı"], true]);
r = await row("Reddedilen");
check("0x800710E0 + çalışan kopya yok: hata", [r.etiket, r.ne.endsWith("— zamanlayıcı başlatmayı reddetti (tek kopya kuralı ya da koşul)")], [["Görev Zamanlayıcı", "son çalışma hatalı"], true]);
r = await row("Kaynak Öncelik");
check("0xC000013A: gri bilgi, 'kapanışta durduruldu'", [r.etiket, r.ne.endsWith("— kapanışta durduruldu (Ctrl+C, pencere ya da oturum kapandı)")], [["Görev Zamanlayıcı"], true]);
r = await row("Günlük Rapor");
check("çıkış 2: hata etiketi + öne çıkan Claude'a incelet + Devre dışı bırak", [r.etiket, r.ne.endsWith("— hata ile bitti (çıkış kodu 2)"), r.yan], [["Görev Zamanlayıcı", "son çalışma hatalı"], true, ["Claude'a incelet", "Devre dışı bırak"]]);
check("öne çıkan düğme birincil", await ev(`[...${rowOf("Günlük Rapor")}.querySelectorAll(".fu-side .btn")][0].classList.contains("primary")`), true);
check("bilgi satırında yalnız Devre dışı bırak", (await row("Edge İzleyici")).yan, ["Devre dışı bırak"]);

// ---- açılan ayrıntı ----
await expand("Edge İzleyici");
check("bilgi satırı ayrıntısı: Şimdi çalıştır, Logu aç, Claude'a incelet, Klasörde göster (kod notu yok)", (await row("Edge İzleyici")).ek.filter(x => !x.startsWith("Ertele") && x !== "Gizle"),
  ["Şimdi çalıştır", "Logu aç", "Claude'a incelet", "Klasörde göster"]);
await expand("Günlük Rapor");
check("hatalı satır ayrıntısı: Logu aç yok (log bulunamadı), kod notu var", (await row("Günlük Rapor")).ek.filter(x => !x.startsWith("Ertele") && x !== "Gizle"),
  ["Şimdi çalıştır", "Bu kod bu görev için normal", "Klasörde göster"]);
await expand("Kapalı İş");
check("kapalı görevde Şimdi çalıştır yok", (await row("Kapalı İş")).ek.includes("Şimdi çalıştır"), false);

// ---- Logu aç (testte pencere açılmaz; açılacak yol döner) ----
const lg = await api("/api/schedule/log", { id: "\\Deneme\\Edge İzleyici" });
check("Logu aç ucu: komuttaki log dosyası", [lg.status, lg.data?.opened?.endsWith("\\Edge Izleyici\\cikti.log")], [200, true]);
await btn("Edge İzleyici", "Logu aç");
check("Logu aç düğmesi: uyarı yok", (await toasts()).filter(x => x.includes("bulunamadı")), []);

// ---- Şimdi çalıştır: onay penceresi ----
await btn("Günlük Rapor", "Şimdi çalıştır");
let b = await box();
check("onay penceresi: başlık, komut, düğmeler", [b?.title, b?.list.length === 1 && b.list[0].startsWith("py.exe "), b?.buttons], ["“Günlük Rapor” şimdi çalıştırılsın mı?", true, ["Vazgeç", "Şimdi çalıştır"]]);
await press("cancel");
await btn("Günlük Rapor", "Şimdi çalıştır");
await press("yes");
check("onaylandı: bildirim", (await toasts()).some(x => x.startsWith("Günlük Rapor başlatıldı")), true);
check("satır 'şu an çalışıyor' oldu, hata etiketi kalktı", await until(`${rowOf("Günlük Rapor")}?.querySelector(".fu-what").textContent.endsWith("— şu an çalışıyor")`, 8000), true);
check("hata etiketi kalktı", (await row("Günlük Rapor")).etiket, ["Görev Zamanlayıcı"]);

// ---- bu kod bu görev için normal ----
r = await row("Yardım Sitesi");
check("Yardım Sitesi (çıkış 1) başta hata", r.etiket, ["Görev Zamanlayıcı", "son çalışma hatalı"]);
await expand("Yardım Sitesi");
await shot("1280_hatali");
await btn("Yardım Sitesi", "Bu kod bu görev için normal");
await until(`!${rowOf("Yardım Sitesi")}.querySelector(".fu-tag.warn")`);
r = await row("Yardım Sitesi");
check("normal sayıldı: hata etiketi yok, metinde not, öne çıkan düğme yok", [r.etiket, r.ne.endsWith("— hata ile bitti (çıkış kodu 1) · bu görev için normal"), r.yan], [["Görev Zamanlayıcı"], true, ["Devre dışı bırak"]]);
check("bildirim", (await toasts()).some(x => x.startsWith("Yardım Sitesi: bu sonuç kodu artık hata sayılmayacak")), true);
await open(1280);
r = await row("Yardım Sitesi");
check("yeniden yüklemede kalıcı", [r.etiket, r.ne.endsWith("· bu görev için normal")], [["Görev Zamanlayıcı"], true]);
await expand("Yardım Sitesi");
check("ayrıntıda geri alma düğmesi", (await row("Yardım Sitesi")).ek.includes("Bu kodu yeniden hata say"), true);
await btn("Yardım Sitesi", "Bu kodu yeniden hata say");
await until(`!!${rowOf("Yardım Sitesi")}.querySelector(".fu-tag.warn")`);
check("geri alındı: yine hata", (await row("Yardım Sitesi")).etiket, ["Görev Zamanlayıcı", "son çalışma hatalı"]);
check("1280: taşma yok", await measure(), CLEAN);

// ---- İngilizce ----
await open(1280, "en");
r = await row("Edge İzleyici");
check("İngilizce: kod metni", r.ne.endsWith("— was already running, no new run started"), true);
await expand("Yardım Sitesi");
check("İngilizce: düğmeler", [(await row("Yardım Sitesi")).yan, (await row("Yardım Sitesi")).ek.filter(x => !x.startsWith("Snooze") && x !== "Hide")],
  [["Ask Claude to check", "Disable"], ["Run now", "Open log", "This code is normal for this task", "Show in folder"]]);
check("İngilizce: çevrilmemiş anahtar yok", await ev(`[...document.querySelectorAll("#viewFollow *")].filter(e => !e.children.length && /^fu[A-Z]\\w+$/.test(e.textContent.trim())).map(e => e.textContent)`), []);

// ---- telefon 390 px ----
await open(390);
await expand("Yardım Sitesi");
await ev(`${rowOf("Yardım Sitesi")}.scrollIntoView({ block: "start" })`);
await shot("390_hatali");
check("390 px: taşma yok, dokunma hedefleri ≥ 44 px", await measure(), CLEAN);

// ---- Claude'a incelet (en sonda: oturumlar görünümüne geçer) ----
await open(1280);
await btn("Yardım Sitesi", "Claude'a incelet", 900);
check("oturum açıldı, adı 'Görev: …'", await until(`fetch("/api/state").then(r => r.json()).then(d => d.hosted.some(h => h.name === "Görev: Yardım Sitesi"))`, 10000), true);
check("Oturumlar görünümüne geçti", await ev(`!document.getElementById("viewFollow") || document.getElementById("viewFollow").hidden`), true);
await sleep(1500);

await tally();
check("tarayıcının confirm / alert / prompt penceresi hiç açılmadı", native, { confirm: 0, alert: 0, prompt: 0 });
check("sayfada betik hatası yok", errors, []);
console.log(`\n${pass} geçti, ${fail} kaldı`);
ws.close();
process.exit(fail ? 1 : 0);
