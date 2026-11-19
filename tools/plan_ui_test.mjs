// Planlı işler tarayıcı testi (0.16.0): Zamanlanmış işler bölümündeki plan satırları (sıra, etiket, durum metni, düğmeler),
// "Planla" formu (tür seçimi alanları gizler/gösterir, doğrulama hatası formda, kaydedince satır gelir), ⋯ menüsü (Düzenle formu
// doldurur, Kapat, Sil onaylı), "İncele" fark penceresi → Birleştir (panelin onay penceresi; tarayıcı confirm/alert/prompt YOK),
// İngilizce, 1280 koyu/açık + 390 telefon taşma ve dokunma hedefi ölçümü, görüntüler.
// tools/plan_ui_test.sh kurar. Geçici klasör yolu sayfaya giden yanıtlarda <gösterilecek kök> ile değiştirilir.
// Kullanım: node plan_ui_test.mjs <debugPort> <url> <çıktıÖneki> <geçici klasör> [gösterilecek kök]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const [port, url, out, tmpRoot, showRoot = "C:\\Projeler"] = process.argv.slice(2);
const hideRoot = join(tmpRoot, "projeler");
const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === "page");
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
const esc = (s) => JSON.stringify(s).slice(1, -1);
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
    const text = (await r.text()).split(hide).join(show);
    return new Response(text, { status: r.status, headers: { "Content-Type": "application/json" } });
  };
})();`;
await send("Page.enable");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
let injected = null;
const native = { confirm: 0, alert: 0, prompt: 0 }, errors = [];
async function tally() { const n = await ev(`window.__n`); for (const k in native) native[k] += n[k]; errors.push(...await ev(`window.__errors || []`)); }
async function open(width, { lang = "tr", light = false } = {}) {
  if (injected) { await tally(); await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected }); }
  injected = (await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT(lang, light) })).result.identifier;
  await send("Emulation.setDeviceMetricsOverride", { width, height: width < 500 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 500 });
  await send("Page.navigate", { url: url + "?view=follow" });
  await until(`document.querySelector(".fu-chip") && !document.getElementById("btnFuRefresh").disabled`);
  await sleep(700);
}
const shot = async (name) => {
  await sleep(450);
  const s = await Promise.race([send("Page.captureScreenshot", { format: "png" }), sleep(8000)]);
  if (s?.result?.data) writeFileSync(`${out}_${name}.png`, Buffer.from(s.result.data, "base64")); else check(`görüntü alınamadı: ${name}`, false, true);
};
const J = JSON.stringify;
const click = async (expr, waitMs = 400) => { await ev(`(${expr}).click()`); await sleep(waitMs); };
const contOf = (name) => `[...document.querySelectorAll(".fu-sec")].find(s => s.querySelector(".fu-name").textContent === ${J(name)})`;
const openCont = async (name) => { if (await ev(`(${contOf(name)})?.querySelector(".fu-fold").getAttribute("aria-expanded") === "false"`)) await click(`${contOf(name)}.querySelector(".fu-fold")`); };
const rowOf = (name) => `[...document.querySelectorAll('.fu-row[data-type^="plan"]')].find(r => r.querySelector("b").textContent === ${J(name)})`;
const rowInfo = (name) => ev(`(() => { const r = ${rowOf(name)}; if (!r) return null; return { dugme: [...r.querySelectorAll(".fu-side .btn")].map(b => b.textContent),
  etiket: [...r.querySelectorAll(".fu-tag")].map(x => x.textContent), ne: r.querySelector(".fu-what")?.textContent || "", alt: r.querySelector("small")?.textContent || "",
  ek: [...r.querySelectorAll(".fu-more .btn")].map(b => b.textContent), soluk: r.classList.contains("fu-stale") }; })()`);
const rowBtn = (name, label) => click(`[...${rowOf(name)}.querySelectorAll(".btn")].find(b => b.textContent === ${J(label)})`, 700);
const menu = async (name, item) => { await rowBtn(name, "⋯"); const items = await ev(`[...document.querySelectorAll(".pop-menu button")].map(b => b.textContent)`);
  if (item) await click(`[...document.querySelectorAll(".pop-menu button")].find(b => b.textContent === ${J(item)})`, 700); return items; };
const planTitles = () => ev(`[...document.querySelectorAll('.fu-row[data-type^="plan"]')].map(r => r.querySelector("b").textContent)`);
const toasts = () => ev(`[...document.querySelectorAll(".toast")].map(x => x.textContent)`);
const box = () => ev(`(() => { const d = document.querySelector("#dlgAsk[open]"); if (!d) return null;
  return { title: document.getElementById("askTitle").textContent, buttons: [...document.querySelectorAll("#askButtons button")].map(b => b.textContent) }; })()`);
const press = async (value) => { await ev(`document.querySelector('#dlgAsk[open] button[value="${value}"]').click()`); await sleep(900); };
const form = () => ev(`(() => { const d = document.querySelector("#dlgPlan[open]"); if (!d) return null; const vis = (id) => !document.getElementById(id).closest("[hidden]");
  return { baslik: document.getElementById("plFormTitle").textContent, tur: document.querySelector("#plKind .active")?.dataset.kind, klasor: vis("plCwd"), istem: vis("plPrompt"), model: vis("plModel"),
    tarih: vis("plDate"), ad: document.getElementById("plName").value, saat: document.getElementById("plTime").value, tekrar: document.getElementById("plRepeat").value,
    ipucu: document.getElementById("plHint").textContent.length > 20, hata: document.getElementById("plErr").textContent,
    tasma: d.scrollWidth - d.clientWidth }; })()`);
const setVal = (id, v) => ev(`(() => { const e = document.getElementById(${J(id)}); e.value = ${J(v)}; e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
const measure = () => ev(`(() => { const de = document.documentElement, rows = [...document.querySelectorAll(".fu-row")], phone = matchMedia("(max-width: 640px)").matches;
  const over = rows.filter(r => { const b = r.getBoundingClientRect(); return [...r.querySelectorAll("b, small, .fu-what, .btn, .fu-tag, .fu-kind, .fu-tog")].some(e => { const q = e.getBoundingClientRect(); return q.width && (q.right > b.right + 1 || q.left < b.left - 1); }); }).length;
  const btns = [...document.querySelectorAll(".fu-row .btn")].filter(b => b.offsetWidth && (b.scrollWidth > b.clientWidth + 1 || b.getBoundingClientRect().right > innerWidth + 1)).map(b => b.textContent.trim().slice(0, 30));
  const small = phone ? [...document.querySelectorAll(".fu-tog, .fu-row .btn")].filter(e => e.offsetWidth && e.getBoundingClientRect().height < 44).map(e => e.className + ":" + e.textContent.trim()) : [];
  const overlap = rows.filter(r => { const m = [...r.querySelectorAll(".fu-title > *")].map(e => e.getBoundingClientRect()).filter(q => q.width);
    return m.some((a, i) => m.some((b, k) => k > i && a.right > b.left + 1 && b.right > a.left + 1 && a.bottom > b.top + 1 && b.bottom > a.top + 1)); }).length;
  return { yatayTasma: de.scrollWidth - de.clientWidth, tasanSatir: over, kirpilanDugme: btns, kucukDokunmaHedefi: small, cakisanEtiket: overlap }; })()`);
const CLEAN = { yatayTasma: 0, tasanSatir: 0, kirpilanDugme: [], kucukDokunmaHedefi: [], cakisanEtiket: 0 };
const SEC = "Zamanlanmış işler", LONG = "Çok uzun adlı bir planlı iş: yıl sonu raporu için tüm projelerdeki açık maddeleri topla ve sırala";
const openAllRows = () => ev(`(async () => { for (const b of document.querySelectorAll('.fu-row:not(.fu-open) .fu-tog')) b.click(); })()`);

// ================= satırlar =================
await open(1280);
await ev(`localStorage.removeItem("panel.follow")`);
await open(1280);
await click(`document.querySelector('.fu-mode[data-mode="type"]')`);
await openCont(SEC);
check("sıra: kontrol bekleyen önde, 'Planlı işler' satırı planların sonunda", await planTitles(), ["Bağımlılık güncellemesi", "Sabah özeti", "Kota ısıtma", LONG, "Planlı işler"]);
let r = await rowInfo("Bağımlılık güncellemesi");
check("kontrol bekleyen: etiketler, İncele + ⋯, değişen dosya", [r.etiket, r.dugme, r.alt.endsWith("A\tplan.txt") || r.alt.endsWith("A plan.txt")], [["Kontrolüme bırak", "Her gün", "kontrolünü bekliyor"], ["İncele", "⋯"], true]);
check("kontrol bekleyen: özet = son yanıt, işaret satırı gösterilmez", r.ne, "- plan.txt yazıldı ve commit edildi");
r = await rowInfo("Sabah özeti");
check("biten oturum işi: sonraki zaman + bitti, yalnız ⋯", [r.etiket, /^Sonraki: .+ · ✓ Bitti /.test(r.ne), r.dugme], [["Oturum aç", "Hafta içi"], true, ["⋯"]]);
r = await rowInfo("Kota ısıtma");
check("kota ısıtma: açıklama alt satırda", [r.etiket, r.alt.startsWith("Haiku ile")], [["Kotayı ısıt", "Hafta içi"], true]);
r = await rowInfo("Planlı işler");
check("'Planla' satırı: düğme + uyanık tutma notu", [r.dugme, r.alt.includes("12 saat kala")], [["Planla"], true]);
const c = await ev(`Object.fromEntries([...document.querySelectorAll(".fu-chip")].map(c => [c.dataset.filter, Number(c.querySelector("span").textContent)]))`);
check("rozete yalnız dikkat isteyen (kontrol bekleyen) girer", [c.all, await ev(`document.getElementById("navFollow").textContent`)], [1, "1"]);
await openAllRows();
await sleep(400);
check("açılan ayrıntıda kontrol bekleyene Özet + At, bitene Özet", [(await rowInfo("Bağımlılık güncellemesi")).ek, (await rowInfo("Sabah özeti")).ek], [["Özet", "At"], ["Özet", "Ertele (yarına)", "Gizle"]]);
check("1280 koyu, satırlar açık: taşma yok", await measure(), CLEAN);
await ev(`(async () => { for (const b of document.querySelectorAll('.fu-row.fu-open .fu-tog')) b.click(); })()`);
await ev(`document.getElementById("fu-sched").scrollIntoView()`);
await shot("1280");

// ================= Planla formu =================
await rowBtn("Planlı işler", "Planla");
let f = await form();
check("form: yeni, oturum türü, bir kez + tarih görünür", [f.baslik, f.tur, f.klasor, f.istem, f.model, f.tekrar, f.tarih, f.saat, f.ipucu], ["Planlı iş", "session", true, true, true, "once", true, "07:00", true]);
await click(`document.querySelector('#plKind [data-kind="warmup"]')`);
f = await form();
check("kota ısıtma seçilince klasör / model / istem gizli", [f.klasor, f.model, f.istem], [false, false, false]);
await click(`document.querySelector('#plKind [data-kind="session"]')`);
await setVal("plRepeat", "daily");
check("her gün seçilince tarih gizli", (await form()).tarih, false);
await setVal("plCwd", showRoot + "\\Notlar");
await setVal("plTime", "21:15");
await click(`document.getElementById("plSave")`, 800);
check("istem boşken: hata formda, pencere açık", (await form())?.hata, "Görevi yazın");
check("ipucu: geç çalışma payı 3 saat", await ev(`document.getElementById("plHint").textContent.includes("3 saat içinde")`), true);
await shot("form_1280");
await setVal("plName", "Akşam yedeği");
await setVal("plPrompt", "Günün değişikliklerini commit et");
await click(`document.getElementById("plSave")`, 1200);
check("kaydedildi: pencere kapandı, bildirim, satır geldi", [await form(), (await toasts()).some(x => x.startsWith("Akşam yedeği kaydedildi. Sonraki: ")), (await planTitles()).includes("Akşam yedeği")], [null, true, true]);

// ================= ⋯ menüsü =================
check("⋯ menüsü", await menu("Akşam yedeği", "Düzenle"), ["Düzenle", "Şimdi çalıştır", "Kapat", "Sil"]);
f = await form();
check("Düzenle: form kayıtla dolu", [f.baslik, f.ad, f.saat, f.tekrar, f.tarih], ["Planlı işi düzenle", "Akşam yedeği", "21:15", "daily", false]);
await click(`document.getElementById("plCancel")`);
await menu("Akşam yedeği", "Kapat");
r = await rowInfo("Akşam yedeği");
check("Kapat: 'kapalı' etiketi, soluk, sonraki zaman yok", [r.etiket.includes("kapalı"), r.soluk, r.ne.includes("Sonraki")], [true, true, false]);
check("kontrol beklerken menüde 'Şimdi çalıştır' yok", await menu("Bağımlılık güncellemesi"), ["Düzenle", "Kapat", "Sil"]);
await ev(`document.body.click()`);
await menu("Akşam yedeği", "Sil");
check("Sil: panelin onay penceresi", await box(), { title: "Akşam yedeği silinsin mi?", buttons: ["Vazgeç", "Sil"] });
await press("yes");
check("silindi", (await planTitles()).includes("Akşam yedeği"), false);

// ================= İncele → Birleştir =================
await rowBtn("Bağımlılık güncellemesi", "İncele");
const diff = await ev(`(() => { const d = document.querySelector("#dlgDiff[open]"); if (!d) return null; return { baslik: document.getElementById("diffTitle").textContent,
  bilgi: document.getElementById("diffInfo").textContent, dosya: document.getElementById("diffText").textContent.includes("plan.txt"), odak: document.activeElement.value,
  dugme: [...d.querySelectorAll(".row.end button")].map(b => b.textContent), tasma: d.scrollWidth - d.clientWidth }; })()`);
check("fark penceresi", diff && [diff.baslik, /^Dal panel\/.+ · 1 commit · 1 dosya\.$/.test(diff.bilgi), diff.dosya, diff.odak, diff.dugme, diff.tasma],
  ["Bağımlılık güncellemesi: yapılan değişiklik", true, true, "close", ["At", "Kapat", "Birleştir"], 0]);
await shot("diff_1280");
await click(`document.querySelector('#dlgDiff button[value="merge"]')`, 600);
check("Birleştir onayı", (await box())?.buttons, ["Vazgeç", "Birleştir"]);
await press("yes");
await sleep(800);
r = await rowInfo("Bağımlılık güncellemesi");
check("birleştirildi: bildirim, satır bilgiye döndü", [(await toasts()).includes("Bağımlılık güncellemesi birleştirildi"), r.etiket, r.dugme, /Birleştirildi/.test(r.ne)], [true, ["Kontrolüme bırak", "Her gün"], ["⋯"], true]);

// ================= açık tema, telefon, İngilizce =================
await open(1280, { light: true });
await openCont(SEC);
await openAllRows(); await sleep(400);
check("1280 açık tema: taşma yok", await measure(), CLEAN);
await open(390);
await openCont(SEC);
await openAllRows(); await sleep(400);
check("telefon 390 px, satırlar açık: taşma yok, dokunma hedefleri ≥ 44 px", await measure(), CLEAN);
await ev(`(async () => { for (const b of document.querySelectorAll('.fu-row.fu-open .fu-tog')) b.click(); })()`);
await ev(`document.getElementById("fu-sched").scrollIntoView()`);
await shot("390_telefon");
await rowBtn("Planlı işler", "Planla");
f = await form();
check("telefon: form taşmıyor, türler alt alta", [f.tasma, await ev(`getComputedStyle(document.getElementById("plKind")).gridTemplateColumns.split(" ").length`)], [0, 1]);
await shot("form_390");
await click(`document.getElementById("plCancel")`);
await open(1280, { lang: "en" });
await openCont("Scheduled work");
await openAllRows(); await sleep(400);
check("İngilizce: çevrilmemiş anahtar yok", await ev(`[...document.querySelectorAll("#viewFollow *, #dlgPlan *, #dlgDiff *")].filter(e => !e.children.length && /^(fu|pl|err_)[A-Za-z_]+$/.test(e.textContent.trim())).map(e => e.textContent)`), []);
check("İngilizce: satır ve düğme", [(await rowInfo("Planned jobs"))?.dugme, (await rowInfo("Sabah özeti"))?.etiket], [["Plan"], ["Open a session", "Weekdays"]]);
check("İngilizce: taşma yok", await measure(), CLEAN);

await tally();
check("tarayıcının confirm / alert / prompt penceresi hiç açılmadı", native, { confirm: 0, alert: 0, prompt: 0 });
check("sayfada betik hatası yok", errors, []);
console.log(`\n${pass} geçti, ${fail} kaldı`);
ws.close();
process.exit(fail ? 1 : 0);
