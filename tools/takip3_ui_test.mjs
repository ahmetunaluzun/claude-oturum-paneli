// Takip 3. aşama tarayıcı testi (0.13.0): süzgeç çipleri + sayılar, projeye göre gruplama ↔ türe göre görünüm, sıkı satır +
// tıkla-aç ayrıntı, Ertele / Gizle / geri gelme, "yeni" işareti, Drive satırları (Yükledim, dosya değişince geri gelme,
// Kütüğü kapat), Toplu menüsü ve seçerek toplu işlem, kalıcılık (yeniden yükleme), 1280 koyu/açık + 390 telefon taşma ölçümü.
// Uydurma ortam (tools/takip_ortam.sh <klasör> kutuk) + sahte claude ile çalışan test kopyasında kullanılır
// (tools/takip3_ui_test.sh kurar). Geçici klasör yolu sayfaya giden yanıtlarda <gösterilecek kök> ile değiştirilir.
// "Klasörde göster" düğmesine BASILMAZ (Gezgin penceresi açar); yalnız varlığı ölçülür.
// Kullanım: node takip3_ui_test.mjs <debugPort> <url> <çıktıÖneki> <gizlenecek kök> [gösterilecek kök]
import { writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
const [port, url, out, hideRoot, showRoot = "C:\\Projeler"] = process.argv.slice(2);
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
const INJECT = (lang, light) => `(() => {
  localStorage.setItem("panel.settings", JSON.stringify({ lang: "${lang}", light: ${light}, notify: false, sound: false }));
  window.__n = { confirm: 0, alert: 0, prompt: 0 };
  for (const k of ["confirm", "alert", "prompt"]) window[k] = () => { window.__n[k]++; return k === "confirm" ? false : null; };
  window.addEventListener("error", e => (window.__errors ||= []).push(String(e.message)));
  window.addEventListener("unhandledrejection", e => (window.__errors ||= []).push(String(e.reason)));
  const real = window.fetch.bind(window), hide = ${JSON.stringify(esc(hideRoot))}, show = ${JSON.stringify(esc(showRoot))};
  window.fetch = async (u, init = {}) => {
    if (typeof init.body === "string") init = { ...init, body: init.body.split(show).join(hide) };
    const r = await real(u, init);
    if (!String(u).startsWith("/api/") || !(r.headers.get("Content-Type") || "").includes("json")) return r;
    return new Response((await r.text()).split(hide).join(show), { status: r.status, headers: { "Content-Type": "application/json" } });
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
async function open(width, { lang = "tr", light = false, height } = {}) {
  if (injected) { await tally(); await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected }); }
  injected = (await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT(lang, light) })).result.identifier;
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
const rowOf = (name, cont) => `[...(${cont ? contOf(cont) : "document"}).querySelectorAll(".fu-row")].find(r => r.querySelector("b").textContent === ${J(name)})`;
const rowInfo = (name, cont) => ev(`(() => { const r = ${rowOf(name, cont)}; if (!r) return null; return { dugme: [...r.querySelectorAll(".fu-side .btn")].map(b => b.textContent),
  is: r.querySelector(".fu-job")?.textContent || "", etiket: [...r.querySelectorAll(".fu-tag")].map(x => x.textContent), tur: r.querySelector(".fu-kind")?.textContent || "",
  ek: [...r.querySelectorAll(".fu-more .btn")].map(b => b.textContent), yeni: !!r.querySelector(".fu-new") }; })()`);
const rowBtn = (name, label, cont) => click(`[...${rowOf(name, cont)}.querySelectorAll(".btn")].find(b => b.textContent === ${J(label)})`);
const chips = () => ev(`Object.fromEntries([...document.querySelectorAll(".fu-chip")].map(c => [c.dataset.filter, Number(c.querySelector("span").textContent)]))`);
const chip = (f) => click(`document.querySelector('.fu-chip[data-filter="${f}"]')`);
const mode = (m) => click(`document.querySelector('.fu-mode[data-mode="${m}"]')`);
const pressed = () => ev(`[document.querySelector('.fu-chip[aria-pressed="true"]').dataset.filter, document.querySelector('.fu-mode[aria-pressed="true"]').dataset.mode]`);
const store = (expr) => ev(`(() => { const s = JSON.parse(localStorage.getItem("panel.follow") || "{}"); return ${expr}; })()`);
const toasts = () => ev(`[...document.querySelectorAll(".toast")].map(x => x.textContent)`);
const box = () => ev(`(() => { const d = document.querySelector("#dlgAsk[open]"); if (!d) return null;
  return { title: document.getElementById("askTitle").textContent, list: [...document.querySelectorAll("#askList li")].map(x => x.textContent), buttons: [...document.querySelectorAll("#askButtons button")].map(b => b.textContent) }; })()`);
const press = async (value) => { await ev(`document.querySelector('#dlgAsk[open] button[value="${value}"]').click()`); await sleep(400); };
const menu = () => ev(`[...document.querySelectorAll(".pop-menu button")].map(b => b.textContent)`);
const menuPick = (label) => click(`[...document.querySelectorAll(".pop-menu button")].find(b => b.textContent === ${J(label)})`);
const api = (path, body) => ev(`fetch(${J(path)}, { method: "POST", headers: { "X-Panel-Token": document.querySelector('meta[name="panel-token"]').content, "Content-Type": "application/json" }, body: JSON.stringify(${J(body)}) }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }))`);
const state = (expr) => ev(`fetch("/api/state", { cache: "no-store" }).then(r => r.json()).then(d => ${expr})`);
const refresh = async () => { await click(`document.getElementById("btnFuRefresh")`, 600); await until(`!document.getElementById("btnFuRefresh").disabled`); await sleep(500); };
const measure = () => ev(`(() => { const de = document.documentElement, rows = [...document.querySelectorAll(".fu-row")], phone = matchMedia("(max-width: 640px)").matches;
  const over = rows.filter(r => { const b = r.getBoundingClientRect(); return [...r.querySelectorAll("b, small, .fu-what, .fu-job, .btn, .fu-tag, .fu-kind, .fu-new, .fu-tog")].some(e => { const q = e.getBoundingClientRect(); return q.width && (q.right > b.right + 1 || q.left < b.left - 1); }); }).length;
  const heads = [...document.querySelectorAll(".fu-fold")].filter(h => h.scrollWidth > h.clientWidth + 1 || h.getBoundingClientRect().right > innerWidth).map(h => h.textContent.trim().slice(0, 30));
  const btns = [...document.querySelectorAll(".fu-row .btn, .fu-allbar .btn, .fu-head .btn, .fu-chip, .fu-mode, .fu-bulk .btn")].filter(b => b.offsetWidth && (b.scrollWidth > b.clientWidth + 1 || b.getBoundingClientRect().right > innerWidth + 1)).map(b => b.textContent.trim().slice(0, 30));
  const small = phone ? [...document.querySelectorAll(".fu-fold, .fu-insess, .fu-chip, .fu-mode, .fu-tog, .fu-row .btn, .fu-bulk .btn, .fu-head .btn")].filter(e => e.offsetWidth && e.getBoundingClientRect().height < 44).map(e => e.className + ":" + e.textContent.trim()) : [];
  // Başlık + etiketler satırı sığmayınca etiketler birbirinin üstüne binmesin (aynı satırdaki iki işaret kesişmemeli).
  const overlap = rows.filter(r => { const m = [...r.querySelectorAll(".fu-title > *")].map(e => e.getBoundingClientRect()).filter(q => q.width);
    return m.some((a, i) => m.some((b, k) => k > i && a.right > b.left + 1 && b.right > a.left + 1 && a.bottom > b.top + 1 && b.bottom > a.top + 1)); }).length;
  const wide = [...document.querySelectorAll("#viewFollow *")].filter(e => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 4).map(e => e.tagName + "." + e.className);
  return { ekranDisi: wide, yatayTasma: de.scrollWidth - de.clientWidth, tasanSatir: over, tasanBaslik: heads, kirpilanDugme: btns, kucukDokunmaHedefi: small, cakisanEtiket: overlap }; })()`);
const CLEAN = { ekranDisi: [], yatayTasma: 0, tasanSatir: 0, tasanBaslik: [], kirpilanDugme: [], kucukDokunmaHedefi: [], cakisanEtiket: 0 };
const P = (...parts) => [showRoot, ...parts].join("\\");
const real = (...parts) => join(hideRoot, ...parts);

// ================= 1280 px, koyu, Türkçe: varsayılan görünüm =================
await open(1280);
await ev(`localStorage.removeItem("panel.follow")`);
await open(1280);
check("varsayılan: süzgeç Tümü, görünüm Projeye göre", await pressed(), ["all", "project"]);
const upd = await ev(`fetch("/api/followup").then(r => r.json()).then(d => (d.updates.panel.newer ? 1 : 0) + (d.updates.claude.newer ? 1 : 0))`);
let c = await chips();
check("çip sayıları: Git 3, Planlar 2, Drive 9, Kararlar 0; Tümü = toplam", c, { all: 14 + upd, git: 3, next: 2, drive: 9, sched: 1, decisions: 0 });
check("sekme rozeti = Tümü", await ev(`document.getElementById("navFollow").textContent`), String(c.all));
check("proje grupları: önce eski bekleyenler, sonra ada göre; güncellemeler sonda, hepsi kapalı", await conts(),
  ["Kılavuz Deposu:kapalı", "Mimari Belgesi:kapalı", "Stok Sayım:kapalı", "Yardım Sitesi:kapalı", "Demo Mağaza:kapalı", "Örnek API:kapalı", "Rapor Aracı:kapalı", "Bilgisayar:kapalı", "Güncellemeler:kapalı"]);
check("kapalı grup başlığı: sayı + tür özeti", await ev(`(() => { const s = ${contOf("Örnek API")}; return [s.querySelector(".count").textContent, s.querySelector(".fu-sum").textContent]; })()`), ["2", "Git · Plan"]);
check("kapalıyken satır çizilmez", await ev(`document.querySelectorAll(".fu-row").length`), 0);

// ---- Toplu menüsü: bölümler kapalıyken de "tüm depoları commit et ve gönder" ----
await click(`document.getElementById("btnFuBulk")`);
check("Toplu menüsü (her şey kapalıyken)", await menu(), ["Tüm bekleyen depoları commit et ve gönder (3)", "Öğe seç…"]);
await menuPick("Tüm bekleyen depoları commit et ve gönder (3)");
let b = await box();
check("toplu commit onayı: depo başına yapılacak", [b?.title, b?.list], ["3 depo sırayla işlensin mi?", ["Demo Mağaza — commit", "Örnek API — gönder", "Rapor Aracı — gönder"]]);
await press("cancel");
check("Vazgeç: iş başlamadı, Toplu düğmesi açık", [await ev(`fetch("/api/follow/jobs").then(r => r.json()).then(j => j.length)`), await ev(`document.getElementById("btnFuBulk").disabled`)], [0, false]);

// ---- grup aç: tür etiketi, sıkı satır, tıkla-aç ayrıntı ----
await openCont("Örnek API");
check("grupta satırlar tür etiketiyle", [(await rowInfo("Örnek API", "Örnek API"))?.tur, await ev(`[...${contOf("Örnek API")}.querySelectorAll(".fu-kind")].map(k => k.textContent)`)], ["Git", ["Git", "Plan"]]);
check("durum kalıcı: açık grup localStorage'da", await store(`Object.values(s.collapsed).filter(v => v === false).length`), 1);
const planRow = `[...${contOf("Örnek API")}.querySelectorAll(".fu-row")][1]`;
check("sıkı satır: yol gizli, açıklama tek satır, ek düğme yok", await ev(`(() => { const r = ${planRow}; return [getComputedStyle(r.querySelector("small")).display, getComputedStyle(r.querySelector(".fu-what")).whiteSpace, r.querySelectorAll(".fu-more").length, r.querySelector(".fu-tog").getAttribute("aria-expanded")]; })()`), ["none", "nowrap", 0, "false"]);
await click(`${planRow}.querySelector(".fu-main")`);
check("satıra tıkla: ayrıntı açılır (yol + Ertele / Gizle)", await ev(`(() => { const r = ${planRow}; return [r.classList.contains("fu-open"), getComputedStyle(r.querySelector("small")).display !== "none", r.querySelector("small").textContent, [...r.querySelectorAll(".fu-more .btn")].map(x => x.textContent), r.querySelector(".fu-tog").getAttribute("aria-expanded")]; })()`),
  [true, true, P("Örnek API"), ["Ertele (yarına)", "Gizle"], "true"]);
await click(`${planRow}.querySelector(".fu-tog")`);
check("ok düğmesi ayrıntıyı kapatır", await ev(`${planRow}.classList.contains("fu-open")`), false);
await openCont("Yardım Sitesi");
await click(`${rowOf("yardim.html")}.querySelector(".fu-main")`);
check("Drive satırı: proje · bölüm, sürüm, bekleme süresi, Yükledim; ayrıntıda Klasörde göster", await ev(`(() => { const r = ${rowOf("yardim.html")}; return [r.querySelector(".fu-what").textContent, [...r.querySelectorAll(".fu-tag")].map(x => x.textContent), / bekliyor$/.test(r.querySelector(".fu-side small").textContent),
  [...r.querySelectorAll(".fu-side .btn")].map(x => x.textContent), [...r.querySelectorAll(".fu-more .btn")].map(x => x.textContent), r.querySelector("small[title]").textContent]; })()`),
  ["Yardım Sitesi · AÇIK (Drive) — Yardım sayfaları 11.11 → 12.11 (12.11.2026)", ["v2.4.0"], true, ["Yükledim"], ["Klasörde göster", "Ertele (yarına)", "Gizle"], P("Yardım Sitesi", "yayin", "yardim.html")]);
await shot("1280_koyu");
check("1280 koyu (projeye göre): taşma yok", await measure(), CLEAN);

// ---- süzgeç çipleri ----
await chip("drive");
check("Drive süzgeci: yalnız kütüğü olan projeler, güncellemeler yok", await conts(), ["Kılavuz Deposu:kapalı", "Mimari Belgesi:kapalı", "Yardım Sitesi:açık"]);
check("süzgeçte grup sayısı yalnız o türün öğeleri", await ev(`[...document.querySelectorAll(".fu-sec .count")].map(x => x.textContent)`), ["4", "3", "2"]);
check("süzgeç rozet sayısını değiştirmez", await ev(`document.getElementById("navFollow").textContent`), String(c.all));
await chip("decisions");
check("Kararlar süzgeci boşken açık bilgi", await ev(`[document.querySelectorAll(".fu-sec").length, document.querySelector("#fuBody .fu-clean")?.textContent]`), [0, "Bu süzgeçte bekleyen bir şey yok"]);
await chip("next");
check("Planlar süzgeci", await conts(), ["Stok Sayım:kapalı", "Örnek API:açık"]);
await open(1280);
check("yeniden yüklemede süzgeç ve görünüm kalıyor", [await pressed(), await conts()], [["next", "project"], ["Stok Sayım:kapalı", "Örnek API:açık"]]);

// ---- türe göre görünüm ----
await mode("type");
check("Türe göre + Planlar süzgeci: tek bölüm", await conts(), ["Sıradaki işler:kapalı"]);
await chip("all");
check("Türe göre: bölümler (Drive dahil)", await conts(), ["Karar bekleyenler:açık", "Git:kapalı", "Sıradaki işler:kapalı", "Drive'a yüklenecekler:kapalı", "Zamanlanmış işler:kapalı", "Güncellemeler:kapalı"]);
check("bölüm sayıları çiplerle aynı", await ev(`[...document.querySelectorAll(".fu-sec .count")].map(x => Number(x.textContent))`), [0, 3, 2, 9, 1, upd]);
await open(1280);
check("yeniden yüklemede görünüm 'Türe göre' kalıyor", await pressed(), ["all", "type"]);
check("türe göre görünümde tür etiketi çizilmez", await ev(`document.querySelectorAll(".fu-kind").length`), 0);

// ---- Drive bölümü: üç biçim + okunamayan satırlar ----
await openCont("Drive'a yüklenecekler");
const DRV = "Drive'a yüklenecekler";
check("Drive satırları (en eski bekleyen üstte)", await ev(`[...${contOf(DRV)}.querySelectorAll(".fu-row b")].map(x => x.textContent)`),
  ["Etiket_Kilavuzu.docx", "Label_Guide.docx", "Okunamayan satır", "yardim.html", "egitim.html", "Mimari.docx", "Mimari.pdf", "Okunamayan satır", "Fis_Kilavuzu.docx"]);
check("olmayan dosya işaretli", (await rowInfo("Label_Guide.docx")).etiket, ["v1.3.0", "+1 eski sürüm yüklendi sayıldı", "dosya yok"]);
check("ek dosyalı satır", (await rowInfo("egitim.html")).etiket, ["v1.7.0", "+2 dosya"]);
check("eski sürümleri yüklendi sayılan satır (aynı belgenin yalnız en yüksek sürümü listede)", (await rowInfo("Etiket_Kilavuzu.docx")).etiket, ["v1.3.0", "+2 eski sürüm yüklendi sayıldı"]);
check("okunamayan satır: metni görünür, 'Yükledim' yok (sessiz atlanmaz)", await ev(`[...${contOf(DRV)}.querySelectorAll(".fu-row")].filter(r => r.querySelector("b").textContent === "Okunamayan satır").map(r => [r.querySelector(".fu-what").textContent, [...r.querySelectorAll(".fu-tag")].map(x => x.textContent).join(), r.querySelectorAll(".fu-side .btn").length])`),
  [["Kapak görseli sonra eklenecek", "okunamadı", 0], ["Sunum · 1.0 · hazırlanıyor", "okunamadı", 0]]);
check("kapatılmış bölümlerin dosyaları yok", await ev(`[...document.querySelectorAll(".fu-row b")].some(x => ["eski.html", "Eski.docx", "basvuru.html"].includes(x.textContent))`), false);

// ---- Yükledim: yerel işaret; dosya değişince geri gelir ----
await rowBtn("yardim.html", "Yükledim");
check("Yükledim: dosya satırı kalktı, kütük satırı çıktı", [await rowInfo("yardim.html"), await rowInfo("Yardım Sitesi", DRV)],
  [null, { dugme: ["Kütüğü kapat"], is: "", etiket: ["kütük"], tur: "", ek: [], yeni: false }]);
check("bildirim", (await toasts()).includes("yardim.html yüklendi olarak işaretlendi; dosya yeniden üretilirse satır geri gelir"), true);
check("alt satır: 1 öğe kenarda", await ev(`document.querySelector(".fu-aside")?.textContent`), "1 öğe gizli ya da ertelendi — göster");
await click(`document.querySelector(".fu-aside")`);
check("alt satıra tıkla: işaretli dosya 'yüklendi' etiketiyle, Geri getir", await ev(`(() => { const r = document.querySelector(".fu-aside + .fu-body .fu-row"); return [r.querySelector("b").textContent, [...r.querySelectorAll(".fu-tag")].map(x => x.textContent), [...r.querySelectorAll(".btn")].map(x => x.textContent)]; })()`),
  ["yardim.html", ["v2.4.0", "yüklendi"], ["Geri getir"]]);
await open(1280);
check("yeniden yüklemede 'Yükledim' işareti kalıyor", [await rowInfo("yardim.html"), (await rowInfo("Yardım Sitesi", DRV))?.dugme], [null, ["Kütüğü kapat"]]);
appendFileSync(real("Yardım Sitesi", "yayin", "yardim.html"), "yeniden üretildi\n");
const later = new Date(Date.now() + 5000); utimesSync(real("Yardım Sitesi", "yayin", "yardim.html"), later, later);
await refresh();
check("dosya değişti (mtime): satır geri geldi, kütük satırı ve alt satır kalktı", [(await rowInfo("yardim.html"))?.dugme, await rowInfo("Yardım Sitesi", DRV), await ev(`!!document.querySelector(".fu-aside")`), await store(`Object.keys(s.uploaded).length`)],
  [["Yükledim"], null, false, 0]);

// ---- Kütüğü kapat: gizli arka plan işi (panel kütüğe yazmaz) ----
await rowBtn("yardim.html", "Yükledim");
await rowBtn("Yardım Sitesi", "Kütüğü kapat", DRV);
b = await box();
check("Kütüğü kapat onayı: dosya listesi", [b?.title, b?.list, b?.buttons], ["Yardım Sitesi: kütük güncellensin mi?", ["yardim.html"], ["Vazgeç", "Kütüğü güncelle"]]);
await press("yes");
await until(`(${rowOf("Yardım Sitesi", DRV)})?.querySelector(".fu-job.run")`);
check("iş sürerken: 'Kütük güncelleniyor…', düğme yok, oturum kartı yok", [await rowInfo("Yardım Sitesi", DRV), await state(`d.hosted.length`)],
  [{ dugme: [], is: "Kütük güncelleniyor…", etiket: ["kütük"], tur: "", ek: [], yeni: false }, 0]);
await until(`[...((${rowOf("Yardım Sitesi", DRV)})?.querySelectorAll(".btn") || [])].some(x => x.textContent === "Tamam")`, 40000);
check("iş bitti: sonuç satırı + özet", await rowInfo("Yardım Sitesi", DRV), { dugme: ["Özet", "Tamam"], is: "✓ Kütük güncellendi", etiket: ["kütük"], tur: "", ek: [], yeni: false });
check("kapatılan dosya listeden çıktı, öteki duruyor, işaret temizlendi", [await rowInfo("yardim.html"), (await rowInfo("egitim.html"))?.dugme, await store(`Object.keys(s.uploaded).length`), (await chips()).drive], [null, ["Yükledim"], 0, 8]);
await rowBtn("Yardım Sitesi", "Tamam", DRV);
check("'Tamam': sonuç satırı kalktı", await rowInfo("Yardım Sitesi", DRV), null);

// ---- Ertele (yarına) ----
await openCont("Git");
await click(`${rowOf("Demo Mağaza", "Git")}.querySelector(".fu-main")`);
await rowBtn("Demo Mağaza", "Ertele (yarına)", "Git");
c = await chips();
check("Ertele: satır kalktı, sayılar düştü, alt satır", [await rowInfo("Demo Mağaza", "Git"), c.git, await ev(`document.getElementById("navFollow").textContent`) === String(c.all), await ev(`document.querySelector(".fu-aside")?.textContent`)],
  [null, 2, true, "1 öğe gizli ya da ertelendi — göster"]);
check("erteleme yarına kadar (yerel gece yarısı)", await store(`(() => { const u = Object.values(s.snoozed)[0], d = new Date(u); return [Object.keys(s.snoozed).length, u > Date.now(), u - Date.now() <= 86400000 + 5000, d.getHours() + d.getMinutes()]; })()`), [1, true, true, 0]);
await open(1280);
check("yeniden yüklemede ertelenen öğe gizli kalıyor", [await rowInfo("Demo Mağaza", "Git"), (await chips()).git], [null, 2]);
await ev(`(() => { const s = JSON.parse(localStorage.getItem("panel.follow")); for (const k in s.snoozed) s.snoozed[k] = Date.now() - 1000; localStorage.setItem("panel.follow", JSON.stringify(s)); })()`);
await open(1280);
check("süre dolunca ertelenen öğe geri geliyor", [(await rowInfo("Demo Mağaza", "Git"))?.dugme, (await chips()).git, await store(`Object.keys(s.snoozed).length`)], [["Commit et"], 3, 0]);

// ---- Gizle: imza değişince geri gelir ----
await click(`${rowOf("Rapor Aracı", "Git")}.querySelector(".fu-tog")`);
await rowBtn("Rapor Aracı", "Gizle", "Git");
check("Gizle: satır kalktı, imzasıyla saklandı", [await rowInfo("Rapor Aracı", "Git"), await store(`Object.entries(s.hidden).map(([k, v]) => [k.startsWith("git:"), v.split(",").slice(0, 3).join()])`)], [null, [[true, "0,0,true"]]]);
await open(1280);
await refresh();
check("yeniden yükleme + yeniden tarama: durum aynıyken gizli kalıyor", [await rowInfo("Rapor Aracı", "Git"), (await chips()).git], [null, 2]);
await click(`document.querySelector(".fu-aside")`);
check("gizli öğe alt satırda 'gizli' etiketiyle", await ev(`[...document.querySelectorAll(".fu-aside + .fu-body .fu-row")].map(r => [r.querySelector("b").textContent, [...r.querySelectorAll(".fu-tag")].pop().textContent])`), [["Rapor Aracı", "gizli"]]);
writeFileSync(real("Rapor Aracı", "yeni-rapor.txt"), "değişiklik\n");
writeFileSync(real("Demo Mağaza", "NEXT_SESSION.md"), "## Sepet\n\n- İndirim kuponu eklenecek\n");
await refresh();
check("depo durumu değişti: gizlenen öğe kendiliğinden geri geldi", [(await rowInfo("Rapor Aracı", "Git"))?.dugme, await store(`Object.keys(s.hidden).length`), await ev(`!!document.querySelector(".fu-aside")`)], [["Commit et ve gönder"], 0, false]);

// ---- "yeni" işareti: son bakıştan sonra çıkan öğe ----
await openCont("Sıradaki işler");
check("yeni çıkan plan 'yeni' işaretli; eskiler ve geri gelen değil", [(await rowInfo("Demo Mağaza", "Sıradaki işler"))?.yeni, await ev(`[...document.querySelectorAll(".fu-row")].filter(r => r.querySelector(".fu-new")).map(r => r.querySelector("b").textContent)`)], [true, ["Demo Mağaza"]]);
check("'yeni' işareti etiket sayılmaz, metni", await ev(`${rowOf("Demo Mağaza", "Sıradaki işler")}.querySelector(".fu-new").textContent`), "yeni");
await click(`document.querySelector('#nav button[data-view="sessions"]')`);
await click(`document.querySelector('#nav button[data-view="follow"]')`, 900);
check("sekmeden çıkıp dönünce (yeni bakış) işaret kalkar", await ev(`document.querySelectorAll(".fu-new").length`), 0);

// ---- seçerek toplu işlem ----
await click(`document.getElementById("btnFuBulk")`);
await menuPick("Öğe seç…");
check("seçim kipi: alt çubuk, kutular yalnız ertelenebilir satırlarda", [await ev(`document.getElementById("fuBulkBar").hidden`), await ev(`document.querySelector("#fuBulkBar b").textContent`), await ev(`[...document.querySelectorAll("#fuBulkBar .btn")].map(x => x.textContent + (x.disabled ? "(kapalı)" : ""))`),
  await ev(`document.querySelectorAll(".fu-row").length === document.querySelectorAll(".fu-pick").length`)],
  [false, "0 öğe seçili", ["Tümünü seç", "Commit et ve gönder(kapalı)", "Ertele (yarına)(kapalı)", "Gizle(kapalı)", "Yükledim(kapalı)", "Seçimden çık"], true]);
await click(`${rowOf("Örnek API", "Git")}.querySelector(".fu-main")`);
await click(`${rowOf("Stok Sayım")}.querySelector(".fu-main")`);
await click(`${rowOf("egitim.html")}.querySelector(".fu-main")`);
check("satıra tıkla: seçilir (ayrıntı açılmaz)", [await ev(`document.querySelector("#fuBulkBar b").textContent`), await ev(`document.querySelectorAll(".fu-row.fu-picked").length`), await ev(`document.querySelectorAll(".fu-row.fu-open").length`)], ["3 öğe seçili", 3, 0]);
await shot("1280_secim");
await click(`document.querySelector('#fuBulkBar [data-bulk="upload"]')`);
check("toplu Yükledim: yalnız Drive dosyası işlendi, atlananlar bildirildi, seçim kapandı", [(await toasts()).includes("1 dosya yüklendi olarak işaretlendi · 2 öğe atlandı: yalnız Drive dosyaları işaretlenir"), await rowInfo("egitim.html"), await ev(`document.getElementById("fuBulkBar").hidden`), await ev(`document.querySelectorAll(".fu-pick").length`)],
  [true, null, true, 0]);
await click(`document.getElementById("btnFuBulk")`); await menuPick("Öğe seç…");
await click(`[...document.querySelectorAll("#fuBulkBar .btn")].find(x => x.textContent === "Tümünü seç")`);
const allN = await ev(`document.querySelectorAll(".fu-row.fu-picked").length`);
check("Tümünü seç: görünen tüm seçilebilir satırlar", [allN > 8, await ev(`document.querySelector("#fuBulkBar b").textContent`) === allN + " öğe seçili"], [true, true]);
await click(`[...document.querySelectorAll("#fuBulkBar .btn")].find(x => x.textContent === "Seçimi kaldır")`);
await click(`${rowOf("Stok Sayım")}.querySelector(".fu-main")`);
await click(`${rowOf("Mimari.pdf")}.querySelector(".fu-main")`);
await click(`document.querySelector('#fuBulkBar [data-bulk="snooze"]')`);
check("toplu Ertele: iki öğe yarına ertelendi", [(await toasts()).includes("2 öğe yarına ertelendi"), await rowInfo("Stok Sayım"), await rowInfo("Mimari.pdf"), await store(`Object.keys(s.snoozed).length`)], [true, null, null, 2]);
await click(`document.getElementById("btnFuBulk")`); await menuPick("Öğe seç…");
await click(`${rowOf("Fis_Kilavuzu.docx")}.querySelector(".fu-main")`);
await click(`document.querySelector('#fuBulkBar [data-bulk="hide"]')`);
check("toplu Gizle", [(await toasts()).includes("1 öğe gizlendi"), await rowInfo("Fis_Kilavuzu.docx"), await ev(`document.querySelector(".fu-aside").textContent`)], [true, null, "4 öğe gizli ya da ertelendi — göster"]);
await click(`document.getElementById("btnFuBulk")`); await menuPick("Öğe seç…");
await click(`${rowOf("Örnek API", "Git")}.querySelector(".fu-main")`);
await click(`${rowOf("Örnek API", "Sıradaki işler")}.querySelector(".fu-main")`);
await ev(`document.querySelectorAll(".toast").forEach(x => x.remove())`);
await click(`document.querySelector('#fuBulkBar [data-bulk="commit"]')`);
b = await box();
check("toplu Commit et ve gönder: onayda yalnız Git satırı", [b?.title, b?.list], ["1 depo sırayla işlensin mi?", ["Örnek API — gönder"]]);
await press("yes");
await sleep(400);
check("atlanan öğe bildirildi, seçim kapandı", [(await toasts()).includes("1 öğe atlandı: yalnız Git satırları commit edilir"), await ev(`document.getElementById("fuBulkBar").hidden`)], [true, true]);
await until(`[...((${rowOf("Örnek API", "Git")})?.querySelectorAll(".btn") || [])].some(x => x.textContent === "Tamam")`, 30000);
check("toplu iş bitti: sonuç satırda, oturum açılmadı", [(await rowInfo("Örnek API", "Git"))?.is, await state(`d.hosted.length`)], ["✓ 2 commit gönderildi", 0]);
await rowBtn("Örnek API", "Tamam", "Git");
await click(`document.getElementById("btnFuBulk")`); await menuPick("Öğe seç…");
await ev(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`); await sleep(300);
check("Esc seçim kipinden çıkarır", await ev(`document.getElementById("fuBulkBar").hidden`), true);
// Geri getir: kenardaki öğeler tek tek döner
await click(`document.querySelector(".fu-aside")`);
for (let i = 0; i < 4; i++) await click(`document.querySelector(".fu-aside + .fu-body .fu-row .btn")`);
check("Geri getir: kenarda öğe kalmadı", [await ev(`!!document.querySelector(".fu-aside")`), await store(`[Object.keys(s.hidden).length, Object.keys(s.snoozed).length, Object.keys(s.uploaded).length]`), !!(await rowInfo("Stok Sayım"))], [false, [0, 0, 0], true]);

// ---- projede oturum varsa (projeye göre görünümde de) gizlenir; karar/Drive görünür kalır ----
await mode("project");
check("Stok Sayım'da oturum aç (çalışır kalır)", (await api("/api/hosted", { cwd: P("Stok Sayım"), prompt: "BEKLE uzun iş" })).status, 200);
await until(`document.querySelector("#fuBody > .fu-insess:not(.fu-aside)")`);
check("oturumdaki projenin grubu kalktı, altta bilgi satırı", [(await conts()).some(x => x.startsWith("Stok Sayım:")), await ev(`document.querySelector("#fuBody > .fu-insess:not(.fu-aside)").textContent`)], [false, "1 proje şu an oturumda açık, gösterilmiyor"]);
await click(`document.querySelector("#fuBody > .fu-insess:not(.fu-aside)")`);
check("bilgi satırına tıkla: plan düğmesiz görünür", await ev(`(() => { const r = document.querySelector("#fuBody > .fu-insess + .fu-body .fu-row"); return [r.querySelector("b").textContent, [...r.querySelectorAll(".fu-tag")].map(x => x.textContent), r.querySelectorAll(".btn").length]; })()`), ["Stok Sayım", ["eski plan", "oturumda açık"], 0]);
await click(`document.querySelector("#fuBody > .fu-insess:not(.fu-aside)")`);
for (const k of await state(`d.hosted.map(h => h.key)`)) await api(`/api/hosted/${k}/stop`, {});
await until(`!document.querySelector("#fuBody > .fu-insess:not(.fu-aside)")`);
check("oturum kapanınca grup geri geldi", (await conts()).some(x => x.startsWith("Stok Sayım:")), true);

// ================= 1280 px, açık tema (türe göre, her şey açık) =================
await mode("type");
await ev(`(() => { const s = JSON.parse(localStorage.getItem("panel.follow")); s.collapsed = {}; for (const k of ["decisions", "git", "next", "drive", "updates"]) s.collapsed[k] = false; localStorage.setItem("panel.follow", JSON.stringify(s)); })()`);
await open(1280, { light: true });
await click(`${rowOf("Mimari.docx")}.querySelector(".fu-tog")`);
await shot("1280_acik");
check("1280 açık (türe göre, tümü açık): taşma yok", await measure(), CLEAN);

// ================= 390 px telefon =================
await open(390, { height: 2600 });
await shot("390_tur");
check("390 telefon (türe göre): taşma yok, dokunma hedefleri ≥ 44 px", await measure(), CLEAN);
await mode("project");
await click(`document.getElementById("btnFuFold")`);
await click(`${rowOf("egitim.html")}.querySelector(".fu-tog")`);
await shot("390_telefon");
check("390 telefon (projeye göre, tümü açık, bir satır ayrıntılı): taşma yok, hedefler ≥ 44 px", await measure(), CLEAN);
await click(`document.getElementById("btnFuBulk")`);
check("390: Toplu menüsü ekranda", await ev(`(() => { const m = document.querySelector(".pop-menu").getBoundingClientRect(); return [m.left >= 0, m.right <= innerWidth, [...document.querySelectorAll(".pop-menu button")].every(x => x.getBoundingClientRect().height >= 44)]; })()`), [true, true, true]);
await menuPick("Öğe seç…");
await click(`${rowOf("egitim.html")}.querySelector(".fu-main")`);
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await sleep(400);
check("390x844: toplu çubuk ekranda, düğmeler sığıyor ve ≥ 44 px", await ev(`(() => { const r = document.getElementById("fuBulkBar").getBoundingClientRect(), bs = [...document.querySelectorAll("#fuBulkBar .btn")];
  return [r.left >= 0, r.right <= innerWidth, r.bottom <= innerHeight, bs.filter(x => x.getBoundingClientRect().height < 44 || x.scrollWidth > x.clientWidth + 1 || x.getBoundingClientRect().right > r.right + 1).length, document.documentElement.scrollWidth - innerWidth]; })()`), [true, true, true, 0, 0]);
await shot("390_secim");
// Sona kaydırınca seçim çubuğu son satırın düğmelerini örtmemeli (alt boşluk).
await ev(`(document.scrollingElement || document.body).scrollTo(0, 1e6); document.body.scrollTo(0, 1e6)`); await sleep(500);
check("390x844 sona kaydırınca toplu çubuk hiçbir satırı örtmüyor", await ev(`(() => { const f = document.getElementById("fuBulkBar").getBoundingClientRect();
  return [...document.querySelectorAll("#fuBody .fu-row, #fuBody .fu-fold")].filter(e => { const r = e.getBoundingClientRect(); return r.height && r.bottom > f.top + 1 && r.top < f.bottom - 1; }).length; })()`), 0);
await click(`[...document.querySelectorAll("#fuBulkBar .btn")].pop()`);

// ================= İngilizce =================
await open(1280, { lang: "en" });
check("İngilizce: çevrilmemiş anahtar yok", await ev(`[...document.querySelectorAll("#viewFollow *")].filter(e => !e.children.length && /^(fu|pc|err_)[A-Za-z_]+$/.test(e.textContent.trim())).map(e => e.textContent)`), []);
check("İngilizce: çipler, görünüm, Toplu", await ev(`[[...document.querySelectorAll(".fu-chip")].map(x => x.firstChild.textContent), [...document.querySelectorAll(".fu-mode")].map(x => x.textContent), document.getElementById("btnFuBulk").textContent]`),
  [["All", "Git", "Plans", "Drive", "Scheduled", "Decisions"], ["By project", "By type"], "Bulk"]);
await mode("type");
await click(`${rowOf("Mimari.docx")}.querySelector(".fu-tog")`);
check("İngilizce: Drive satırı ve ayrıntı düğmeleri", await ev(`(() => { const r = ${rowOf("Mimari.docx")}; return [[...r.querySelectorAll(".fu-side .btn")].map(x => x.textContent), [...r.querySelectorAll(".fu-more .btn")].map(x => x.textContent), /^waiting /.test(r.querySelector(".fu-side small").textContent)]; })()`),
  [["Uploaded"], ["Show in folder", "Snooze (tomorrow)", "Hide"], true]);
check("İngilizce: çevrilmemiş anahtar yok (ayrıntı açıkken)", await ev(`[...document.querySelectorAll("#viewFollow *")].filter(e => !e.children.length && /^(fu|pc|err_)[A-Za-z_]+$/.test(e.textContent.trim())).map(e => e.textContent)`), []);

await tally();
check("yerleşik confirm/alert/prompt hiç çağrılmadı", native, { confirm: 0, alert: 0, prompt: 0 });
check("sayfada betik hatası yok", errors, []);
console.log(`\n${pass} geçti, ${fail} kaldı`);
ws.close();
process.exit(fail ? 1 : 0);
