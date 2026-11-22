// Gizli bilgi engelinin arayüzü (0.18.0, followup-pushguard.js): bulgu listesi (dosya:satır, kural, maskeli ipucu), "Claude'a
// incelet", yalnız kalıp bulgularında "Test verisi, yine de gönder" + onay penceresi, dosya bulgusunda yalnız inceletme,
// 1280 koyu + 390 telefon görüntüsü ve taşma ölçümü, İngilizce. tools/gizli_ortam.sh ortamı + sahte claude ile çalışan
// test kopyasında kullanılır (tools/gizli_ui_test.sh kurar). Geçici klasör yolu sayfaya giden yanıtlarda <gösterilecek kök> olur.
// Kullanım: node gizli_ui_test.mjs <debugPort> <url> <çıktıÖneki> <gizlenecek kök> [gösterilecek kök]
import { writeFileSync } from "node:fs";
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
const esc = (s) => JSON.stringify(s).slice(1, -1);
const INJECT = (lang) => `(() => {
  localStorage.setItem("panel.settings", JSON.stringify({ lang: "${lang}", light: false, notify: false, sound: false }));
  localStorage.setItem("panel.follow", JSON.stringify({ mode: "type" }));
  window.__n = { confirm: 0, alert: 0, prompt: 0 };
  for (const k of ["confirm", "alert", "prompt"]) window[k] = () => { window.__n[k]++; return k === "confirm" ? false : null; };
  window.addEventListener("error", e => (window.__errors ||= []).push(String(e.message)));
  window.addEventListener("unhandledrejection", e => (window.__errors ||= []).push(String(e.reason)));
  const real = window.fetch.bind(window), hide = ${JSON.stringify(esc(hideRoot))}, show = ${JSON.stringify(esc(showRoot))};
  window.__posts = [];
  window.fetch = async (u, init = {}) => {
    if (typeof init.body === "string") { window.__posts.push(String(u)); init = { ...init, body: init.body.split(show).join(hide) }; }
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
async function open(width, lang = "tr") {
  if (injected) { await tally(); await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected }); }
  injected = (await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT(lang) })).result.identifier;
  await send("Emulation.setDeviceMetricsOverride", { width, height: width < 500 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 500 });
  await send("Page.navigate", { url: url + "?view=follow" });
  await until(`document.querySelector(".fu-chip") && !document.getElementById("btnFuRefresh").disabled`);
  await sleep(700);
  await openCont("Git");
}
const shot = async (name) => {
  await sleep(450);
  for (let i = 0; i < 3; i++) {
    const s = await Promise.race([send("Page.captureScreenshot", { format: "png" }), sleep(8000)]);
    if (s?.result?.data) { writeFileSync(`${out}_${name}.png`, Buffer.from(s.result.data, "base64")); return; }
  }
  check(`görüntü alınamadı: ${name}`, false, true);
};
const J = JSON.stringify;
const click = async (expr, waitMs = 350) => { await ev(`(${expr}).click()`); await sleep(waitMs); };
const contOf = (name) => `[...document.querySelectorAll(".fu-sec")].find(s => s.querySelector(".fu-name").textContent === ${J(name)})`;
const openCont = async (name) => { if (await ev(`(${contOf(name)})?.querySelector(".fu-fold").getAttribute("aria-expanded") === "false"`)) await click(`${contOf(name)}.querySelector(".fu-fold")`); };
const rowOf = (name) => `[...document.querySelectorAll(".fu-row")].find(r => r.querySelector("b").textContent === ${J(name)})`;
const rowInfo = (name) => ev(`(() => { const r = ${rowOf(name)}; if (!r) return null; return { dugme: [...r.querySelectorAll(".fu-side .btn")].map(b => b.textContent),
  is: r.querySelector(".fu-job")?.textContent || "", bulgu: [...r.querySelectorAll(".fu-secret-list li")].map(l => l.textContent),
  not: r.querySelector(".fu-secret-note")?.textContent || "" }; })()`);
const rowBtn = (name, label) => click(`[...${rowOf(name)}.querySelectorAll(".btn")].find(b => b.textContent === ${J(label)})`);
const box = () => ev(`(() => { const d = document.querySelector("#dlgAsk[open]"); if (!d) return null;
  return { title: document.getElementById("askTitle").textContent, list: [...document.querySelectorAll("#askList li")].map(x => x.textContent),
    buttons: [...document.querySelectorAll("#askButtons button")].map(b => b.textContent + (b.classList.contains("cbox-danger") ? " [tehlikeli]" : "")).sort(),
    focus: document.activeElement?.textContent || "" }; })()`);
const press = async (value) => { await ev(`document.querySelector('#dlgAsk[open] button[value="${value}"]').click()`); await sleep(400); };
const toasts = () => ev(`[...document.querySelectorAll(".toast")].map(x => x.textContent)`);
const blockedOf = async (name) => {
  await rowBtn(name, "Gönder");
  return until(`(${rowOf(name)})?.querySelector(".fu-secret-list")`);
};
// Bulgu listesi ve düğmeler satırın içinde mi, görünür mü (DOM'da var ≠ ekranda görünür: elementFromPoint).
const layout = (name) => ev(`(() => { const r = ${rowOf(name)}; r.scrollIntoView({ block: "center" }); const b = r.getBoundingClientRect();
  const parts = [...r.querySelectorAll(".fu-secret-list li, .fu-secret-note, .fu-side .btn")];
  const outside = parts.filter(e => { const q = e.getBoundingClientRect(); return q.right > b.right + 1 || q.left < b.left - 1 || q.right > innerWidth; }).length;
  const hidden = parts.filter(e => { const q = e.getBoundingClientRect(); const hit = document.elementFromPoint(q.left + Math.min(8, q.width / 2), q.top + q.height / 2); return !hit || !(e === hit || e.contains(hit)); }).length;
  const cut = [...r.querySelectorAll(".fu-side .btn")].filter(x => x.scrollWidth > x.clientWidth + 1).length;
  return { disarida: outside, gorunmeyen: hidden, kirpilan: cut, yatayTasma: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
const CLEAN = { disarida: 0, gorunmeyen: 0, kirpilan: 0, yatayTasma: 0 };

// ================= 1280 px, koyu, Türkçe =================
await open(1280);
check("üç depo, her birinde tek Gönder", [await rowInfo("Test Kimlik"), await rowInfo("Env Depo")].map(x => x?.dugme), [["Gönder"], ["Gönder"]]);
check("Test Kimlik engellendi: bulgu listesi geldi", await blockedOf("Test Kimlik"), true);
const tk = await rowInfo("Test Kimlik");
check("engel metni + bulgular (dosya:satır, kural, maskeli ipucu)", [tk.is, tk.bulgu],
  ["Gönderilmedi: gönderilecek commit'lerde depoya girmemesi gereken içerik var",
    ["test/kimlik.test.ts:2 parola/anahtar ataması pass***", "test/kimlik.test.ts:3 parola/anahtar ataması api_***"]]);
check("yalnız kalıp bulgusu: incelet (öne çıkan) + yine de gönder; aynı nedenle düşecek Gönder yok", [tk.dugme,
  await ev(`[...${rowOf("Test Kimlik")}.querySelectorAll(".fu-side .btn")].map(b => b.classList.contains("primary"))`)],
  [["Claude'a incelet", "Test verisi, yine de gönder"], [true, false]]);
check("Env Depo engellendi", await blockedOf("Env Depo"), true);
const ed = await rowInfo("Env Depo");
check(".env bulgusu: yalnız Claude'a incelet + açıklama", [ed.dugme, ed.bulgu, ed.not.startsWith("Bu tür dosya hiçbir zaman gönderilmez")],
  [["Claude'a incelet"], [".env .env dosyası", "ayar.py:1 parola/anahtar ataması secr***"], true]);
check("değerler sayfada yok", await ev(`/p@ss1234test|zz9988776655aa/.test(document.body.innerText)`), false);
check("1280: satırlar taşmıyor, her şey görünür", [await layout("Test Kimlik"), await layout("Env Depo")], [CLEAN, CLEAN]);
await ev(`window.scrollTo(0, 0); document.querySelector("main, #viewFollow")?.scrollTo?.(0, 0)`);
await shot("1280");

// ---- Test verisi, yine de gönder: onay penceresi; Vazgeç → istek yok ----
const before = await ev(`window.__posts.length`);
await rowBtn("Test Kimlik", "Test verisi, yine de gönder");
check("onay penceresi: başlık, bulgular, tehlikeli düğme, odak Vazgeç'te", await box(), {
  title: "Test Kimlik: bulgular test verisi mi?",
  list: ["test/kimlik.test.ts:2 — parola/anahtar ataması (pass***)", "test/kimlik.test.ts:3 — parola/anahtar ataması (api_***)"],
  buttons: ["Vazgeç", "Yine de gönder [tehlikeli]"],
  focus: "Vazgeç" });
check("onay metninde 'başka bulgu çıkarsa yine durur' notu", await ev(`/Başka bir bulgu çıkarsa gönderim yine durur/.test(document.getElementById("askText").textContent)`), true);
await shot("1280_onay");
await press("cancel");
check("Vazgeç: istek gitmedi, düğmeler duruyor", [await ev(`window.__posts.length`) - before, (await rowInfo("Test Kimlik")).dugme], [0, ["Claude'a incelet", "Test verisi, yine de gönder"]]);

// ---- onayla → izin + gönderim ----
await rowBtn("Test Kimlik", "Test verisi, yine de gönder");
await press("yes");
check("onay: push-allow isteği gitti", await ev(`window.__posts.filter(u => u === "/api/follow/push-allow").length`), 1);
check("gönderildi (satırda sonuç)", await until(`/1 commit gönderildi/.test((${rowOf("Test Kimlik")})?.textContent || "")`), true);

// ---- Claude'a incelet (.env deposu): o depoda panel oturumu, Oturumlar sekmesi ----
await rowBtn("Env Depo", "Claude'a incelet", 600);
check("incelet: oturum açıldı, Oturumlar sekmesine geçildi", [await until(`fetch("/api/state").then(r => r.json()).then(d => d.hosted.some(h => /Gizli bilgi incelemesi: Env Depo/.test(h.name || "")))`),
  await ev(`!document.getElementById("viewFollow") || document.getElementById("viewFollow").hidden`)], [true, true]);

// İnceleme oturumunu kapat: projesinde açık oturum olan depo Takip'te gizlenir; telefonda .env satırını da ölçeceğiz.
await ev(`fetch("/api/state").then(r => r.json()).then(d => Promise.all(d.hosted.map(h => fetch("/api/hosted/" + h.key + "/stop", { method: "POST",
  headers: { "X-Panel-Token": document.querySelector('meta[name="panel-token"]').content } }))))`);
await sleep(3000);

// ================= 390 px telefon =================
await open(390);
check("telefon: Env Depo yeniden listede", await until(`!!(${rowOf("Env Depo")})`, 15000), true);
check("telefon: Telefon Depo engellendi", await blockedOf("Telefon Depo"), true);
check("telefon: bulgu + düğmeler", await rowInfo("Telefon Depo").then(x => [x.bulgu, x.dugme]), [["ornek.py:1 parola/anahtar ataması auth***"], ["Claude'a incelet", "Test verisi, yine de gönder"]]);
check("390: satırlar taşmıyor, her şey görünür, düğmeler ≥ 44 px", [await layout("Telefon Depo"), await layout("Env Depo"),
  await ev(`[...document.querySelectorAll(".fu-row .fu-side .btn")].filter(b => b.offsetWidth && b.getBoundingClientRect().height < 44).length`)], [CLEAN, CLEAN, 0]);
await ev(`${rowOf("Telefon Depo")}.scrollIntoView({ block: "center" })`);
await shot("390");
await rowBtn("Telefon Depo", "Test verisi, yine de gönder");
check("390: onay penceresi ekranda, taşmıyor", await ev(`(() => { const r = document.querySelector("#dlgAsk[open] .cbox, #dlgAsk[open]").getBoundingClientRect();
  return [r.left >= 0, r.right <= innerWidth, r.bottom <= innerHeight, document.documentElement.scrollWidth - innerWidth]; })()`), [true, true, true, 0]);
await shot("390_onay");
await press("cancel");

// ================= İngilizce =================
await open(1280, "en");
await until(`(${rowOf("Telefon Depo")})?.querySelector(".fu-secret-list")`);
check("İngilizce: bulgu, düğmeler, not", await rowInfo("Telefon Depo").then(x => [x.bulgu, x.dugme]).then(async a => [...a, (await rowInfo("Env Depo")).not.slice(0, 33)]),
  [["ornek.py:1 password/key assignment auth***"], ["Ask Claude to check", "Test data, push anyway"], "This kind of file is never pushed"]);
check("İngilizce: çevrilmemiş anahtar yok", await ev(`[...document.querySelectorAll("#viewFollow *")].filter(e => !e.children.length && /^(fu|pc|err_)[A-Za-z_]+$/.test(e.textContent.trim())).map(e => e.textContent)`), []);

await tally();
check("yerleşik confirm/alert/prompt hiç çağrılmadı", native, { confirm: 0, alert: 0, prompt: 0 });
check("sayfada betik hatası yok", errors, []);
console.log(`\n${pass} geçti, ${fail} kaldı`);
ws.close();
process.exit(fail ? 1 : 0);
