// Takip 4. aşama tarayıcı testi (0.14.0, Zamanlanmış işler): bölüm ve "Zamanlanmış" çipi, satır sırası (dikkat isteyen öne),
// sonuç kodu metinleri, Devre dışı bırak (panelin kendi onay penceresi; tarayıcı confirm/alert/prompt YOK), verilmiş sözler
// (geçen kırmızı, okunamayan görünür), Claude görev dosyaları, bulut rutini bağlantısı, açık oturumdaki tekrarlı işler
// (boş tur ve kota uyarısı, Durdur; terminalde "Terminalden durdurun"), telefonda gizlenen düğmeler, projeye göre gruplama,
// gizle, İngilizce, 1280 koyu/açık + 390 telefon taşma ve dokunma hedefi ölçümü.
// Uydurma ortam (tools/takip_ortam.sh + tools/takip4_ortam.py) + sahte claude + sahte zamanlayıcı ile çalışan test kopyasında
// kullanılır (tools/takip4_ui_test.sh kurar). Geçici klasör yolu sayfaya giden yanıtlarda <gösterilecek kök> ile değiştirilir.
// "Klasörde göster" düğmesine BASILMAZ (Gezgin penceresi açar); yalnız varlığı ölçülür.
// Kullanım: node takip4_ui_test.mjs <debugPort> <url> <çıktıÖneki> <geçici klasör> [gösterilecek kök]
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const [port, url, out, tmpRoot, showRoot = "C:\\Projeler"] = process.argv.slice(2);
const hideRoot = join(tmpRoot, "projeler");
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
const until = async (expr, ms = 20000) => { for (let i = 0; i < ms / 250; i++) { if (await ev(expr)) return true; await sleep(250); } return false; };

const esc = (s) => JSON.stringify(s).slice(1, -1); // JSON içindeki hâli (ters bölüler çift)
// remote: sayfa telefondan açılmış gibi davranır (panel-remote meta değeri 1; sunucu tarafı tools/takip4_test.sh'ta denenir).
// extra: /api/followup yanıtına eklenecek döngüler (terminal oturumu gibi, bu ortamda üretilemeyen durumlar).
const INJECT = (lang, light, remote, extra) => `(() => {
  localStorage.setItem("panel.settings", JSON.stringify({ lang: "${lang}", light: ${light}, notify: false, sound: false }));
  window.__n = { confirm: 0, alert: 0, prompt: 0 };
  for (const k of ["confirm", "alert", "prompt"]) window[k] = () => { window.__n[k]++; return k === "confirm" ? false : null; };
  window.addEventListener("error", e => (window.__errors ||= []).push(String(e.message)));
  window.addEventListener("unhandledrejection", e => (window.__errors ||= []).push(String(e.reason)));
  if (${remote}) new MutationObserver(() => document.querySelector('meta[name="panel-remote"]')?.setAttribute("content", "1")).observe(document, { childList: true, subtree: true });
  const real = window.fetch.bind(window), hide = ${JSON.stringify(esc(hideRoot))}, show = ${JSON.stringify(esc(showRoot))}, extra = ${JSON.stringify(extra)};
  window.fetch = async (u, init = {}) => {
    if (typeof init.body === "string") init = { ...init, body: init.body.split(show).join(hide) };
    const r = await real(u, init);
    if (!String(u).startsWith("/api/") || !(r.headers.get("Content-Type") || "").includes("json")) return r;
    let text = (await r.text()).split(hide).join(show);
    if (String(u) === "/api/followup" && extra.length) { const d = JSON.parse(text); d.loops = [...d.loops, ...extra.map(x => ({ ...x, startedAt: Date.now() - x.ago, lastAt: Date.now() }))]; text = JSON.stringify(d); }
    return new Response(text, { status: r.status, headers: { "Content-Type": "application/json" } });
  };
})();`;

await send("Page.enable");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
let injected = null;
const native = { confirm: 0, alert: 0, prompt: 0 }, errors = [];
async function tally() {
  const n = await ev(`window.__n`);
  for (const k in native) native[k] += n[k];
  errors.push(...await ev(`window.__errors || []`));
}
async function open(width, { lang = "tr", light = false, height, remote = false, extra = [] } = {}) {
  if (injected) { await tally(); await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected }); }
  injected = (await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT(lang, light, remote, extra) })).result.identifier;
  await send("Emulation.setDeviceMetricsOverride", { width, height: height || (width < 500 ? 844 : 900), deviceScaleFactor: 1, mobile: width < 500 });
  await send("Page.navigate", { url: url + "?view=follow" });
  await until(`document.querySelector(".fu-chip") && !document.getElementById("btnFuRefresh").disabled`);
  await sleep(700);
}
const shot = async (name, full = false) => {
  await sleep(450);
  for (let i = 0; i < 3; i++) {
    const s = await Promise.race([send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full }), sleep(8000)]);
    if (s?.result?.data) { writeFileSync(`${out}_${name}.png`, Buffer.from(s.result.data, "base64")); return; }
  }
  check(`görüntü alınamadı: ${name}`, false, true);
};
const J = JSON.stringify;
const click = async (expr, waitMs = 350) => { await ev(`(${expr}).click()`); await sleep(waitMs); };
const conts = () => ev(`[...document.querySelectorAll(".fu-sec")].map(s => s.querySelector(".fu-name").textContent + ":" + (s.querySelector(".fu-fold").getAttribute("aria-expanded") === "true" ? "açık" : "kapalı"))`);
const contOf = (name) => `[...document.querySelectorAll(".fu-sec")].find(s => s.querySelector(".fu-name").textContent === ${J(name)})`;
const openCont = async (name) => { if (await ev(`(${contOf(name)})?.querySelector(".fu-fold").getAttribute("aria-expanded") === "false"`)) await click(`${contOf(name)}.querySelector(".fu-fold")`); };
// Satır: tür + başlık (aynı başlık başka türde de olabilir: proje adı hem dosya hem döngü satırında geçer)
const rowOf = (type, name, n = 0) => `[...document.querySelectorAll('.fu-row[data-type="${type}"]')].filter(r => r.querySelector("b").textContent === ${J(name)})[${n}]`;
const rowInfo = (type, name, n = 0) => ev(`(() => { const r = ${rowOf(type, name, n)}; if (!r) return null; return { dugme: [...r.querySelectorAll(".fu-side .btn")].map(b => b.textContent),
  etiket: [...r.querySelectorAll(".fu-tag")].map(x => x.textContent), ne: r.querySelector(".fu-what")?.textContent || "", yan: [...r.querySelectorAll(".fu-side small")].map(x => x.textContent),
  tur: r.querySelector(".fu-kind")?.textContent || "", ek: [...r.querySelectorAll(".fu-more .btn")].map(b => b.textContent), sinif: r.className.split(" ").filter(c => c === "fu-due" || c === "fu-stale") }; })()`);
const rowBtn = (type, name, label, n = 0) => click(`[...${rowOf(type, name, n)}.querySelectorAll(".btn")].find(b => b.textContent === ${J(label)})`);
const toggleRow = (type, name) => click(`${rowOf(type, name)}.querySelector(".fu-tog")`);
const titles = (sel = ".fu-row") => ev(`[...document.querySelectorAll(${J(sel)})].map(r => r.querySelector("b").textContent)`);
const chips = () => ev(`Object.fromEntries([...document.querySelectorAll(".fu-chip")].map(c => [c.dataset.filter, Number(c.querySelector("span").textContent)]))`);
const chip = (f) => click(`document.querySelector('.fu-chip[data-filter="${f}"]')`);
const mode = (m) => click(`document.querySelector('.fu-mode[data-mode="${m}"]')`);
const toasts = () => ev(`[...document.querySelectorAll(".toast")].map(x => x.textContent)`);
const box = () => ev(`(() => { const d = document.querySelector("#dlgAsk[open]"); if (!d) return null;
  return { title: document.getElementById("askTitle").textContent, list: [...document.querySelectorAll("#askList li")].map(x => x.textContent), buttons: [...document.querySelectorAll("#askButtons button")].map(b => b.textContent) }; })()`);
const press = async (value) => { await ev(`document.querySelector('#dlgAsk[open] button[value="${value}"]').click()`); await sleep(400); };
const api = (path, body) => ev(`fetch(${J(path)}, { method: "POST", headers: { "X-Panel-Token": document.querySelector('meta[name="panel-token"]').content, "Content-Type": "application/json" }, body: JSON.stringify(${J(body)}) }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }))`);
const refresh = async () => { await click(`document.getElementById("btnFuRefresh")`, 600); await until(`!document.getElementById("btnFuRefresh").disabled`); await sleep(500); };
const measure = () => ev(`(() => { const de = document.documentElement, rows = [...document.querySelectorAll(".fu-row")], phone = matchMedia("(max-width: 640px)").matches;
  const over = rows.filter(r => { const b = r.getBoundingClientRect(); return [...r.querySelectorAll("b, small, .fu-what, .fu-job, .btn, .fu-tag, .fu-kind, .fu-new, .fu-tog")].some(e => { const q = e.getBoundingClientRect(); return q.width && (q.right > b.right + 1 || q.left < b.left - 1); }); }).length;
  const heads = [...document.querySelectorAll(".fu-fold")].filter(h => h.scrollWidth > h.clientWidth + 1 || h.getBoundingClientRect().right > innerWidth).map(h => h.textContent.trim().slice(0, 30));
  const btns = [...document.querySelectorAll(".fu-row .btn, .fu-head .btn, .fu-chip, .fu-mode")].filter(b => b.offsetWidth && (b.scrollWidth > b.clientWidth + 1 || b.getBoundingClientRect().right > innerWidth + 1)).map(b => b.textContent.trim().slice(0, 30));
  const small = phone ? [...document.querySelectorAll(".fu-fold, .fu-insess, .fu-chip, .fu-mode, .fu-tog, .fu-row .btn, .fu-head .btn")].filter(e => e.offsetWidth && e.getBoundingClientRect().height < 44).map(e => e.className + ":" + e.textContent.trim()) : [];
  const overlap = rows.filter(r => { const m = [...r.querySelectorAll(".fu-title > *")].map(e => e.getBoundingClientRect()).filter(q => q.width);
    return m.some((a, i) => m.some((b, k) => k > i && a.right > b.left + 1 && b.right > a.left + 1 && a.bottom > b.top + 1 && b.bottom > a.top + 1)); }).length;
  const wide = [...document.querySelectorAll("#viewFollow *")].filter(e => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 4).map(e => e.tagName + "." + e.className);
  return { ekranDisi: wide, yatayTasma: de.scrollWidth - de.clientWidth, tasanSatir: over, tasanBaslik: heads, kirpilanDugme: btns, kucukDokunmaHedefi: small, cakisanEtiket: overlap }; })()`);
const CLEAN = { ekranDisi: [], yatayTasma: 0, tasanSatir: 0, tasanBaslik: [], kirpilanDugme: [], kucukDokunmaHedefi: [], cakisanEtiket: 0 };
const SEC = "Zamanlanmış işler";
const tasks = () => JSON.parse(readFileSync(join(tmpRoot, "gorevler.json"), "utf8"));
const openAllRows = () => ev(`(async () => { for (const b of document.querySelectorAll('.fu-row:not(.fu-open) .fu-tog')) b.click(); })()`);

// ================= bölüm, çip, sıra (Türe göre) =================
await open(1280);
await ev(`localStorage.removeItem("panel.follow")`);
await open(1280);
const upd = await ev(`fetch("/api/followup").then(r => r.json()).then(d => (d.updates.panel.newer ? 1 : 0) + (d.updates.claude.newer ? 1 : 0))`);
let c = await chips();
check("Zamanlanmış çipi: bölümdeki tüm satırlar (15 + Planlı işler satırı); Tümü yalnız bekleyenler (git 3 + plan 2 + dikkat isteyen 6 + güncelleme)", [c.sched, c.all, Object.keys(c)], [16, 11 + upd, ["all", "git", "next", "drive", "sched", "decisions"]]);
check("sekme rozeti = Tümü (bilgi satırları sayılmaz)", await ev(`document.getElementById("navFollow").textContent`), String(c.all));
await mode("type");
check("Türe göre: Zamanlanmış işler bölümü var, kapalı", (await conts()).includes(SEC + ":kapalı"), true);
check("kapalı bölüm başlığındaki sayı", await ev(`${contOf(SEC)}.querySelector(".count").textContent`), "16");
await openCont(SEC);
const ORDER = ["Ödeme sağlayıcısının yanıtını kontrol et", "Yayın sonrası hata kayıtlarına bak", "Okunamayan söz", "Okunamayan söz", "Rapor Gönder", "Yetkisiz Görev",
  "Sertifika yenilemesini doğrula", "Demo Yedek", "Kanca Temizliği", "Kapalı Görev", "Demo Mağaza", "Örnek API", "haftalik-rapor", "sabah-ozeti", "Planlı işler", "Bulut rutinleri"];
check("sıra: geçen söz, bugünkü söz, okunamayanlar, hatalı görevler; sonra bilgi satırları; bulut sonda", await titles("#fu-sched .fu-row"), ORDER);

// ---- zamanlayıcı görevleri ----
let r = await rowInfo("task", "Rapor Gönder");
check("hatalı görev: etiketler, sonuç metni, tek düğme", [r.etiket, /Sonraki: .* sonra · Son: .* önce — hata ile bitti \(çıkış kodu 1\)$/.test(r.ne), r.dugme], [["Görev Zamanlayıcı", "son çalışma hatalı"], true, ["Devre dışı bırak"]]);
check("sonuç kodları anlaşılır metne çevrildi", [(await rowInfo("task", "Demo Yedek")).ne.endsWith("— başarılı"), (await rowInfo("task", "Kanca Temizliği")).ne.endsWith("— şu an çalışıyor"),
  (await rowInfo("task", "Kapalı Görev")).ne, (await rowInfo("task", "Yetkisiz Görev")).ne.endsWith("— dosya bulunamadı")], [true, true, "henüz çalışmadı", true]);
check("devre dışı görev: etiket var, düğme yok, soluk", [(await rowInfo("task", "Kapalı Görev")).etiket, (await rowInfo("task", "Kapalı Görev")).dugme, (await rowInfo("task", "Kapalı Görev")).sinif], [["Görev Zamanlayıcı", "devre dışı"], [], ["fu-stale"]]);
check("kaynak izin vermiyorsa düğme yok", (await rowInfo("task", "Yetkisiz Görev")).dugme, []);
await toggleRow("task", "Rapor Gönder");
check("açılan ayrıntı: Klasörde göster + Ertele + Gizle; komut satırı görünür", [(await rowInfo("task", "Rapor Gönder")).ek, await ev(`${rowOf("task", "Rapor Gönder")}.querySelector(".fu-main small").textContent.startsWith("cmd.exe /c ")`)],
  [["Klasörde göster", "Ertele (yarına)", "Gizle"], true]);
await toggleRow("task", "Rapor Gönder");

// ---- Devre dışı bırak: panelin onay penceresi ----
await rowBtn("task", "Demo Yedek", "Devre dışı bırak");
let b = await box();
check("onay penceresi: başlık, komut, düğmeler", [b?.title, b?.list.length === 1 && b.list[0].startsWith("python.exe "), b?.buttons], ["“Demo Yedek” devre dışı bırakılsın mı?", true, ["Vazgeç", "Devre dışı bırak"]]);
await press("cancel");
check("Vazgeç: görev açık kaldı", tasks().find(x => x.name === "Demo Yedek").enabled, true);
await rowBtn("task", "Demo Yedek", "Devre dışı bırak");
await press("yes");
await until(`${rowOf("task", "Demo Yedek")}?.querySelectorAll(".fu-tag").length === 2`);
check("onaylandı: bildirim, satır devre dışı, düğme kalktı", [(await toasts()).includes("Demo Yedek devre dışı bırakıldı"), (await rowInfo("task", "Demo Yedek")).etiket, (await rowInfo("task", "Demo Yedek")).dugme],
  [true, ["Görev Zamanlayıcı", "devre dışı"], []]);
check("yalnız o görev kapandı (sahte zamanlayıcı dosyası)", tasks().filter(x => !x.enabled).map(x => x.name), ["Demo Yedek", "Kapalı Görev"]);

// ---- verilmiş sözler ----
r = await rowInfo("promise", "Ödeme sağlayıcısının yanıtını kontrol et");
check("tarihi geçen söz: kırmızı satır, 'gün geçti' etiketi, proje adı", [r.sinif, r.etiket.length, r.etiket[1], r.ne], [["fu-due"], 2, "3 gün geçti", "Örnek API"]);
check("geçen söz kırmızı çiziliyor", await ev(`(() => { const s = getComputedStyle(${rowOf("promise", "Ödeme sağlayıcısının yanıtını kontrol et")}.querySelector("b")).color.match(/\\d+/g).map(Number); return s[0] > 150 && s[0] > s[1] * 1.8; })()`), true);
check("bugünkü söz: 'bugün' etiketi", (await rowInfo("promise", "Yayın sonrası hata kayıtlarına bak")).etiket[1], "bugün");
check("ileri tarihli söz: kalan gün, uyarı yok", [(await rowInfo("promise", "Sertifika yenilemesini doğrula")).yan, (await rowInfo("promise", "Sertifika yenilemesini doğrula")).sinif], [["10 gün sonra"], []]);
check("okunamayan sözler görünür (sessiz atlanmaz), ham metniyle", [(await rowInfo("promise", "Okunamayan söz", 0)).ne, (await rowInfo("promise", "Okunamayan söz", 1)).ne, (await rowInfo("promise", "Okunamayan söz", 0)).etiket],
  ["2026-13-45 — Tarihi bozuk söz", "yarın — Biçimsiz söz", ["okunamadı"]]);

// ---- Claude görev dosyaları, masaüstü görevleri, bulut ----
check("görev dosyası: yalnız 'var' bilgisi", [(await rowInfo("sfile", "Demo Mağaza")).etiket, (await rowInfo("sfile", "Demo Mağaza")).ne], [["Claude görev dosyası"], "scheduled_tasks.json var; içeriği gösterilmiyor (dosya biçimi belgelenmemiş)"]);
check("yalnız kilit dosyası olan proje", (await rowInfo("sfile", "Örnek API")).ne, "Yalnız kilit dosyası var (scheduled_tasks.lock); görev dosyası yok");
check("masaüstü görevi: ad + istemin ilk satırı", [(await rowInfo("sdesk", "sabah-ozeti")).etiket, (await rowInfo("sdesk", "sabah-ozeti")).ne], [["masaüstü görevi"], "Dünkü commit'leri özetle ve açık işleri listele."]);
await toggleRow("sdesk", "sabah-ozeti");
check("masaüstü görevi: zamanlama bilinmiyor diye yazıyor", await ev(`${rowOf("sdesk", "sabah-ozeti")}.querySelector(".fu-main small").textContent.startsWith("Zamanlama bilinmiyor (dosyada yazmıyor)")`), true);
await toggleRow("sdesk", "sabah-ozeti");
check("bulut rutinleri: yalnız bağlantı", await ev(`(() => { const a = ${rowOf("cloud", "Bulut rutinleri")}.querySelector("a.btn"); return [a.textContent, a.href, a.target]; })()`), ["claude.ai'de aç", "https://claude.ai/code/routines", "_blank"]);

// ---- açık oturumdaki tekrarlı işler ----
check("oturum yokken tekrarlı iş satırı yok", (await titles('.fu-row[data-type="loop"]')).length, 0);
r = await api("/api/hosted", { cwd: join(showRoot, "Demo Mağaza"), prompt: "ZAMANLA" });
check("panel oturumu başladı", r.status, 200);
for (let i = 0; i < 30; i++) { await refresh(); if ((await titles('.fu-row[data-type="loop"]')).length === 3) break; await sleep(500); }
check("3 tekrarlı iş satırı (2 cron + 1 döngü)", await titles('.fu-row[data-type="loop"]'), ["Demo Mağaza", "Demo Mağaza", "Demo Mağaza"]);
const loops = () => ev(`[...document.querySelectorAll('.fu-row[data-type="loop"]')].map(r => ({ etiket: [...r.querySelectorAll(".fu-tag")].map(x => x.textContent), ne: r.querySelector(".fu-what").textContent,
  alt: r.querySelector(".fu-main small").textContent, dugme: [...r.querySelectorAll(".fu-side .btn")].map(x => x.textContent + (x.classList.contains("primary") ? "*" : "")), yan: [...r.querySelectorAll(".fu-side small")].map(x => x.textContent) }))`);
let L = await loops();
check("boş dönen döngü öne geçti: aralık + ardışık boş tur uyarısı, Durdur vurgulu", [L[0].etiket, L[0].ne, L[0].dugme], [["5 dk arayla", "3 tur üst üste değişiklik yok"], "Dağıtım sürüyor mu diye bakılacak", ["Durdur*"]]);
check("döngü ayrıntısı: /loop argümanı, süre, token, tur", /^\/loop 5m dağıtım durumunu denetle · .* önce başladı · o günden beri 90 token · 4 tur$/.test(L[0].alt), true);
check("cron satırları: ifade, tek sefer etiketi, istem, Durdur", [L[1].etiket, L[1].ne, L[1].dugme, L[2].etiket, L[2].ne], [["*/30 * * * *"], "Derleme durumunu denetle", ["Durdur"], ["0 9 * * *", "tek sefer"], "Sabah raporunu gönder"]);
check("cron ayrıntısı: token sayısı yerel biçimde", [/o günden beri 1,4.B token$/.test(L[1].alt), /o günden beri 120 token$/.test(L[2].alt)], [true, true]);
check("Zamanlanmış çipi: üç satır eklendi", (await chips()).sched, 19);

// ---- kota düşükken uyarı ----
const reset = new Date(Date.now() + 3 * 3_600_000).toISOString();
writeFileSync(join(tmpRoot, "claude", "usage-cache.json"), JSON.stringify({ five_hour: { utilization: 85, resets_at: reset }, seven_day: { utilization: 40, resets_at: reset }, _cached_at: Date.now() / 1000 }));
await refresh();
L = await loops();
check("kota düşük: her tekrarlı işte uyarı etiketi", L.map(x => x.etiket.includes("kota düşük")), [true, true, true]);
check("kota düşük: bölüm altında açıklama", await ev(`[...document.querySelectorAll("#fu-sched .fu-clean")].map(x => x.textContent)`), ["Kota düşük (5 saatlik %15, haftalık %60 kaldı): 3 tekrarlı iş kota harcamayı sürdürüyor"]);
await ev(`document.getElementById("fu-sched").scrollIntoView()`);
await shot("1280");

// ---- Durdur: onay + oturuma mesaj ----
await click(`document.querySelector('.fu-row[data-type="loop"] .fu-side .btn')`);
b = await box();
check("Durdur onayı: panelin penceresi", [b?.title, b?.buttons], ["Demo Mağaza: tekrarlı işler durdurulsun mu?", ["Vazgeç", "Durdur"]]);
await press("cancel");
check("Vazgeç: döngüler duruyor", (await loops()).length, 3);
await click(`document.querySelector('.fu-row[data-type="loop"] .fu-side .btn')`);
await press("yes");
check("Durdur: bildirim", (await toasts()).some(x => x === "Demo Mağaza: durdurma mesajı gönderildi"), true);
for (let i = 0; i < 30; i++) { await refresh(); if ((await loops()).length === 0) break; await sleep(500); }
check("oturum durdurdu: tekrarlı iş satırı kalmadı, kota notu kalktı", [(await loops()).length, await ev(`document.querySelectorAll("#fu-sched .fu-clean").length`)], [0, 0]);
check("oturum açık kaldı (panel kapatmadı)", await ev(`fetch("/api/state").then(r => r.json()).then(d => d.hosted.length)`), 1);

// ---- terminal oturumu: düğme yerine bilgi ----
const TERM = [{ id: "wake:t1", type: "wakeup", sessionId: "t1", key: null, pid: 4242, name: "Terminal Demo", cwd: join(showRoot, "Rapor Aracı"), root: join(showRoot, "Rapor Aracı"),
  schedule: null, recurring: true, delaySeconds: 1200, prompt: "Sıra bekleniyor", ago: 5_400_000, tokens: 48_200, runs: 6, noopStreak: 1 }];
await open(1280, { extra: TERM });
await openCont(SEC);
L = await loops();
check("terminal döngüsü: Terminal etiketi, düğme yok, 'Terminalden durdurun'", [L.length, L[0]?.etiket, L[0]?.dugme, L[0]?.yan], [1, ["20 dk arayla", "Terminal", "kota düşük"], [], ["Terminalden durdurun"]]);

// ================= projeye göre gruplama, süzgeç, gizle =================
await mode("project");
let g = await conts();
check("projeye göre: projesiz satırlar 'Bilgisayar' grubunda; sözü geçen proje öne geçti", [g.some(x => x.startsWith("Bilgisayar:")), g[0].startsWith("Örnek API:") || g[0].startsWith("Rapor Aracı:")], [true, true]);
await openCont("Örnek API");
check("proje grubunda tür adı: Söz / Zamanlanmış", [(await rowInfo("promise", "Yayın sonrası hata kayıtlarına bak")).tur, (await rowInfo("task", "Yetkisiz Görev")).tur, (await rowInfo("sfile", "Örnek API")).tur], ["Söz", "Zamanlanmış", "Zamanlanmış"]);
check("kapalı grup özeti türleri sayıyor", await ev(`${contOf("Bilgisayar")}.querySelector(".fu-sum").textContent`), "Zamanlanmış · Planlı iş");
await chip("sched");
g = await conts();
check("Zamanlanmış süzgeci: yalnız zamanlanmış işi olan gruplar, güncellemeler yok", [g.some(x => x.startsWith("Güncellemeler")), g.some(x => x.startsWith("Bilgisayar:")), g.some(x => x.startsWith("Temiz Kütüphane"))], [false, true, false]);
await mode("type");
check("Türe göre + Zamanlanmış süzgeci: tek bölüm", (await conts()).map(x => x.split(":")[0]), [SEC]);
await openCont(SEC);
const before = (await chips()).sched;
await toggleRow("task", "Kanca Temizliği");
await rowBtn("task", "Kanca Temizliği", "Gizle");
check("Gizle: satır kalktı, sayı düştü, alt satırda geri getirilebilir", [await rowInfo("task", "Kanca Temizliği"), (await chips()).sched, await ev(`document.querySelector(".fu-aside")?.textContent`)], [null, before - 1, "1 öğe gizli ya da ertelendi — göster"]);
await open(1280, { extra: TERM });
check("yeniden yüklemede gizli kalıyor, süzgeç kalıyor", [await rowInfo("task", "Kanca Temizliği"), await ev(`document.querySelector('.fu-chip[aria-pressed="true"]').dataset.filter`)], [null, "sched"]);
await click(`document.querySelector(".fu-aside")`);
await click(`[...document.querySelectorAll(".fu-row .btn")].find(b => b.textContent === "Geri getir")`);
await openCont(SEC);
check("Geri getir: satır döndü", (await rowInfo("task", "Kanca Temizliği"))?.etiket, ["Görev Zamanlayıcı"]);
check("tekrarlı iş ertelenemez / gizlenemez (her zaman görünür)", await ev(`(() => { const r = document.querySelector('.fu-row[data-type="loop"]'); r.querySelector(".fu-tog").click(); return true; })()`) && await ev(`document.querySelector('.fu-row[data-type="loop"] .fu-more') === null`), true);

// ================= taşma: 1280 koyu / açık =================
await openAllRows();
await sleep(400);
check("1280 koyu, tüm satırlar açık: taşma yok", await measure(), CLEAN);
await open(1280, { light: true, extra: TERM });
await openCont(SEC);
check("1280 açık tema: taşma yok", await measure(), CLEAN);
check("açık temada geçen söz okunur kırmızı", await ev(`getComputedStyle(${rowOf("promise", "Ödeme sağlayıcısının yanıtını kontrol et")}.querySelector("b")).color`), "rgb(179, 49, 42)");

// ================= telefon (uzak erişim): düğmeler gizli =================
await open(390, { remote: true, extra: [{ ...TERM[0], id: "wake:p1", sessionId: "p1", key: "panel-anahtari", pid: null, name: "Panel Demo", noopStreak: 4 }, ...TERM] });
await openCont(SEC);
check("telefon: sayfa uzak kipte", await ev(`document.querySelector('meta[name="panel-remote"]').content`), "1");
check("telefon: görevlerde 'Devre dışı bırak' yok", await ev(`[...document.querySelectorAll('.fu-row[data-type="task"] .fu-side .btn')].length`), 0);
await openAllRows();
await sleep(400);
check("telefon: hiçbir satırda 'Klasörde göster' yok; Ertele / Gizle var", await ev(`[[...document.querySelectorAll(".fu-more .btn")].filter(b => b.textContent === "Klasörde göster").length, [...document.querySelectorAll(".fu-more .btn")].some(b => b.textContent === "Gizle")]`), [0, true]);
check("telefon: panel oturumundaki döngüde Durdur var, terminalde bilgi", [(await loops())[0].dugme, (await loops())[1].yan], [["Durdur*"], ["Terminalden durdurun"]]);
check("telefon 390 px, tüm satırlar açık: taşma yok, dokunma hedefleri ≥ 44 px", await measure(), CLEAN);
await ev(`(async () => { for (const b of document.querySelectorAll('.fu-row.fu-open .fu-tog')) b.click(); })()`);
await sleep(400);
check("telefon 390 px, satırlar kapalı: taşma yok", await measure(), CLEAN);
await ev(`document.getElementById("fu-sched").scrollIntoView()`);
await shot("390_telefon");

// ================= İngilizce =================
await open(1280, { lang: "en", extra: TERM });
await openCont("Scheduled work");
await openAllRows();
await sleep(400);
check("İngilizce: çevrilmemiş anahtar yok", await ev(`[...document.querySelectorAll("#viewFollow *")].filter(e => !e.children.length && /^(fu|pc|err_)[A-Za-z_]+$/.test(e.textContent.trim())).map(e => e.textContent)`), []);
check("İngilizce: çip, görev etiketi, düğme, söz", [await ev(`document.querySelector('.fu-chip[data-filter="sched"]').firstChild.textContent`), (await rowInfo("task", "Rapor Gönder")).etiket, (await rowInfo("task", "Rapor Gönder")).dugme,
  (await rowInfo("promise", "Ödeme sağlayıcısının yanıtını kontrol et")).etiket[1]], ["Scheduled", ["Task Scheduler", "last run failed"], ["Disable"], "3 day(s) overdue"]);
check("İngilizce: taşma yok", await measure(), CLEAN);

await tally();
check("tarayıcının confirm / alert / prompt penceresi hiç açılmadı", native, { confirm: 0, alert: 0, prompt: 0 });
check("sayfada betik hatası yok", errors, []);
console.log(`\n${pass} geçti, ${fail} kaldı`);
ws.close();
process.exit(fail ? 1 : 0);
