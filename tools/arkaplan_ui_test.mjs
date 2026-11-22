// Arka plan işi görünürlüğü arayüzü: kartta "arka planda: N alt ajan" rozeti (boşta/bekleyen kartta da), çekmece başlığı, alt bilgideki tek gösterge
// ("arka plan işi yok" / sayı), bayat iş uyarısı, Yeniden başlat ve Kapat uyarı pencereleri (iş listesi; "İşler bitince yeniden başlat" /
// "Yine de şimdi"; telefonda yalnız bekle), bekleme notu + İptal, iş bitince panelin kendisi yeniden başlaması (gerçek), TR/EN, 1280/390 ölçüm.
// Tarayıcı confirm/alert/prompt YOK. Konuşma kaydı UYDURMA (arkaplan_kayit.py).
// Kullanım: node arkaplan_ui_test.mjs <debugPort> <url> <çıktıÖneki> <geçici klasör> <arkaplan_kayit.py>
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [port, url, out, tmpRoot, kayitPy] = process.argv.slice(2);
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
const J = JSON.stringify;
const base = url.replace(/\/$/, "");
const version = async () => { try { return await (await fetch(base + "/api/version")).json(); } catch { return null; } };
const state = async () => { try { return await (await fetch(base + "/api/state")).json(); } catch { return null; } };

const INJECT = (lang, light, remote) => `(() => {
  localStorage.setItem("panel.settings", JSON.stringify({ lang: "${lang}", light: ${light}, notify: false, sound: false }));
  window.__n = { confirm: 0, alert: 0, prompt: 0 };
  for (const k of ["confirm", "alert", "prompt"]) window[k] = () => { window.__n[k]++; return k === "confirm" ? false : null; };
  window.addEventListener("error", e => (window.__errors ||= []).push(String(e.message)));
  window.addEventListener("unhandledrejection", e => (window.__errors ||= []).push(String(e.reason)));
  if (${remote}) new MutationObserver(() => document.querySelector('meta[name="panel-remote"]')?.setAttribute("content", "1")).observe(document, { childList: true, subtree: true });
})();`;
await send("Page.enable");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
let injected = null;
const native = { confirm: 0, alert: 0, prompt: 0 }, errors = [];
async function tally() {
  try { const n = await ev(`window.__n`); for (const k in native) native[k] += n[k]; errors.push(...await ev(`window.__errors || []`)); } catch { /* sayfa yenilenirken */ }
}
async function open(width, { lang = "tr", light = false, remote = false } = {}) {
  if (injected) { await tally(); await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected }); }
  injected = (await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT(lang, light, remote) })).result.identifier;
  await send("Emulation.setDeviceMetricsOverride", { width, height: width < 500 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 500 });
  await send("Page.navigate", { url: url + "?view=sessions" });
  await until(`!!document.querySelector(".card")`, 20000);
  await sleep(600);
}
const shot = async (name) => {
  await sleep(450);
  for (let i = 0; i < 3; i++) {
    const s = await Promise.race([send("Page.captureScreenshot", { format: "png" }), sleep(8000)]);
    if (s?.result?.data) { writeFileSync(`${out}_${name}.png`, Buffer.from(s.result.data, "base64")); return; }
  }
  check(`görüntü alınamadı: ${name}`, false, true);
};
const click = async (expr, waitMs = 400) => { await ev(`(${expr}).click()`); await sleep(waitMs); };
const dlg = `document.getElementById("dlgAsk")`;
const dlgInfo = () => ev(`(() => { const d = ${dlg}; return d.open ? { title: document.getElementById("askTitle").textContent,
  text: document.getElementById("askText").textContent, list: [...document.querySelectorAll("#askList li")].map(l => l.textContent),
  buttons: [...document.querySelectorAll("#askButtons .btn")].map(b => b.textContent) } : null; })()`);
const press = (value, waitMs) => click(`[...document.querySelectorAll("#askButtons .btn")].find(b => b.value === ${J(value)})`, waitMs);
const toasts = () => ev(`[...document.querySelectorAll(".toast")].map(x => x.textContent)`);
const kayit = (file, ...args) => execFileSync("py", ["-3.13", kayitPy, file, ...args], { stdio: "pipe" });
const apiPost = (path, body) => ev(`fetch(${J(path)}, { method: "POST", headers: { "X-Panel-Token": document.querySelector('meta[name="panel-token"]').content,
  "Content-Type": "application/json" }, body: ${J(body ? JSON.stringify(body) : null)} }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }))`);
const cardOf = `[...document.querySelectorAll(".card")].find(c => c.querySelector(".name").textContent === "Deneme oturumu")`;
const chip = () => ev(`(() => { const c = ${cardOf}; if (!c) return null; const e = c.querySelector(".abj-chip"); return { gorunur: !e.hidden && !!e.offsetWidth, metin: e.textContent, bayat: e.dataset.stale, ipucu: e.title, serit: c.dataset.lane }; })()`);
const foot = () => ev(`(() => { const e = document.getElementById("abjFoot"), w = document.getElementById("abjWait"); return { metin: e.textContent, var: e.dataset.has,
  bekle: !w.hidden && !!w.offsetWidth, bekleMetin: w.hidden ? "" : w.textContent }; })()`);

// ================= Hazırlık: boşta bir panel oturumu =================
await open(1280);
const cwd = `${tmpRoot}\\proje`;
const hs = await apiPost("/api/hosted", { cwd, prompt: "merhaba", name: "Deneme oturumu" });
check("panel oturumu açıldı", hs.status, 200);
check("oturum boşta", await until(`fetch("/api/state").then(r => r.json()).then(s => s.hosted.length === 1 && s.hosted[0].status === "idle" && s.hosted[0].sessionId)`, 20000), true);
let sid = (await state()).hosted[0].sessionId;
let file = `${tmpRoot}\\claude\\projects\\proje\\${sid}.jsonl`;
await open(1280);

// ================= 1. İş yok =================
check("iş yokken kartta rozet yok (boşta kart)", await chip(), { gorunur: false, metin: "", bayat: "0", ipucu: "", serit: "idle" });
check("alt bilgi: 'arka plan işi yok'", (await foot()).metin + "|" + (await foot()).var, "arka plan işi yok|0");

// ================= 2. Alt ajan: boşta kartta rozet, çekmece, alt bilgi =================
kayit(file, "agent", "aUI000001", "Uzun araştırma");
check("alt ajan başlayınca boşta (bekleyen) kartta rozet çıkar", await until(`(() => { const c = ${cardOf}; return c && !c.querySelector(".abj-chip").hidden; })()`, 15000), true);
let c1 = await chip();
check("rozet: 'arka planda: 1 alt ajan', ipucunda etiket, kart hâlâ boşta", [c1.gorunur, c1.metin, c1.ipucu, c1.serit, c1.bayat], [true, "arka planda: 1 alt ajan", "alt ajan: Uzun araştırma", "idle", "0"]);
check("alt bilgi: 'arka planda 1 iş'", (await foot()).metin, "arka planda 1 iş");
await click(cardOf, 700);
check("çekmece başlığında aynı bilgi", await ev(`document.getElementById("dMeta").textContent.includes("arka planda: 1 alt ajan")`), true);
await ev(`document.getElementById("dClose").click()`); await sleep(400);
kayit(file, "bash", "bUI000002", "Derleme izleyici");
check("komut eklenince rozet: alt ajan + komut", await until(`(() => { const c = ${cardOf}; return c && c.querySelector(".abj-chip").textContent === "arka planda: 1 alt ajan, 1 komut"; })()`, 15000), true);
check("alt bilgi: 2 iş", (await foot()).metin, "arka planda 2 iş");
await shot("1280_kart");

// ================= 3. Bayat iş =================
kayit(file, "agent", "aUI000003", "Takılmış ajan", "7");
check("bayat iş: rozette 'takılmış olabilir' + uyarı rengi", await until(`(() => { const c = ${cardOf}; const e = c && c.querySelector(".abj-chip"); return e && e.dataset.stale === "1" && e.textContent.includes("takılmış olabilir"); })()`, 15000), true);
check("alt bilgi: sayı + takılmış olabilir", (await foot()).metin, "arka planda 3 iş · 1 tanesi takılmış olabilir");

// ================= 4. Yeniden başlat: uyarı penceresi =================
await click(`document.getElementById("btnSettings")`, 800);
await click(`document.getElementById("btnRestart")`, 700);
await press("yes", 900);
await until(`${dlg}.open && document.getElementById("askTitle").textContent === "Arka planda iş sürüyor"`, 10000);
const d1 = await dlgInfo();
check("uyarı: başlık, oturum boşta olduğu için arka plan metni", [d1?.title, d1?.text.startsWith("Oturumlar cevabını bitirmiş görünüyor")], ["Arka planda iş sürüyor", true]);
check("uyarı: üç iş de listede", [d1?.list.length, d1?.list.some(x => x.includes("Uzun araştırma")), d1?.list.some(x => x.includes("Derleme izleyici") && x.includes("komut")),
  d1?.list.some(x => x.includes("Takılmış ajan") && x.includes("(takılmış olabilir)"))], [3, true, true, true]);
check("uyarı: düğmeler Vazgeç / İşler bitince yeniden başlat / Yine de şimdi", d1?.buttons, ["Vazgeç", "İşler bitince yeniden başlat", "Yine de şimdi"]);
check("uyarı: 1280'de üç düğme tek satırda", await ev(`new Set([...document.querySelectorAll("#askButtons .btn")].map(b => Math.round(b.getBoundingClientRect().top))).size`), 1);
await shot("1280_onay");
const pid0 = (await version()).pid;
await press("cancel");
check("Vazgeç: panel yeniden başlamadı, bekleme yok", [(await version()).pid === pid0, (await state()).restartWaiting], [true, false]);

// ================= 5. Kapat: yalnız uyarı + "Yine de kapat" =================
await ev(`document.getElementById("dlgSettings").close()`); await sleep(300);
await click(`document.getElementById("btnSettings")`, 800);
await click(`document.getElementById("btnQuit")`, 700);
let q = await dlgInfo();
check("Kapat: önce genel onay (panel oturumu açık)", q?.title, "Panel kapatılsın mı?");
await press("yes", 900);
await until(`${dlg}.open && document.getElementById("askTitle").textContent === "Arka planda iş sürüyor"`, 10000);
q = await dlgInfo();
check("Kapat: arka plan uyarısı, iş listesi, yalnız Vazgeç / Yine de kapat (bekle yok)", [q?.title, q?.list.length, q?.buttons], ["Arka planda iş sürüyor", 3, ["Vazgeç", "Yine de kapat"]]);
await shot("1280_kapat");
await press("cancel");
check("Kapat'tan vazgeçince panel açık", (await version())?.pid === pid0, true);
await ev(`document.getElementById("dlgSettings").close()`); await sleep(300);

// ================= 6. Telefon: yalnız "İşler bitince yeniden başlat" =================
await open(390, { remote: true });
await click(`document.getElementById("btnSettings")`, 800);
await click(`document.getElementById("btnRestart")`, 700);
await press("yes", 900);
await until(`${dlg}.open && document.getElementById("askTitle").textContent === "Arka planda iş sürüyor"`, 10000);
const dp = await dlgInfo();
check("telefon: 'Yine de şimdi' yok (zorlama yalnız bilgisayardan)", dp?.buttons, ["Vazgeç", "İşler bitince yeniden başlat"]);
await shot("390_onay");
check("telefon: uyarı penceresi taşmıyor", await ev(`(() => { const d = ${dlg}; const r = d.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && d.scrollWidth <= d.clientWidth + 1; })()`), true);
await press("cancel");
await ev(`document.getElementById("dlgSettings").close()`); await sleep(300);
check("390 px: rozet ve alt bilgi taşmıyor", await ev(`(() => { const f = document.querySelector("footer.bottom"), c = ${cardOf}, e = c.querySelector(".abj-chip");
  return [f.scrollWidth <= f.clientWidth + 1, e.getBoundingClientRect().right <= c.getBoundingClientRect().right + 1, document.documentElement.scrollWidth <= innerWidth]; })()`), [true, true, true]);
await ev(`document.querySelector("footer.bottom").scrollIntoView()`);
await shot("390_kart");

// ================= 7. İngilizce =================
await open(1280, { lang: "en", light: true });
let ce = await chip();
check("EN: rozet", ce?.metin.startsWith("in background: 2 sub-agents, 1 command") && ce.metin.includes("may be stuck"), true);
check("EN: alt bilgi", (await foot()).metin, "3 in background · 1 may be stuck");
await shot("1280_en_acik");
await open(1280);

// ================= 8. "İşler bitince yeniden başlat": bekle, iptal, gerçek yeniden başlatma =================
await click(`document.getElementById("btnSettings")`, 800);
await click(`document.getElementById("btnRestart")`, 700);
await press("yes", 900);
await until(`${dlg}.open && document.getElementById("askTitle").textContent === "Arka planda iş sürüyor"`, 10000);
await press("idle", 900);
check("bekle: bildirim", (await toasts()).includes("İşler bitince panel yeniden başlatılacak."), true);
await ev(`document.getElementById("dlgSettings").close()`); await sleep(300);
check("bekle: sunucu bekliyor", (await state()).restartWaiting, true);
const f2 = await until(`!document.getElementById("abjWait").hidden`, 10000) && await foot();
check("alt bilgide 'işler bitince yeniden başlatılacak · İptal'", [f2.bekle, f2.bekleMetin], [true, "işler bitince yeniden başlatılacak · İptal"]);
await shot("1280_bekle");
await click(`document.getElementById("abjCancel")`, 900);
check("İptal: not kalktı, sunucu beklemiyor, panel aynı", [(await foot()).bekle, (await state()).restartWaiting, (await version()).pid === pid0], [false, false, true]);

// Gerçek bekleme: işler bitince panel kendisi yeniden başlar, sayfa yenilenir.
await click(`document.getElementById("btnSettings")`, 800);
await click(`document.getElementById("btnRestart")`, 700);
await press("yes", 900);
await until(`${dlg}.open && document.getElementById("askTitle").textContent === "Arka planda iş sürüyor"`, 10000);
await press("idle", 900);
await ev(`document.getElementById("dlgSettings").close()`); await sleep(300);
for (const k of ["aUI000001", "bUI000002", "aUI000003"]) kayit(file, "bitti", k, "completed");
check("işler bitince rozet ve alt bilgi temizlenir", await until(`(() => { const c = ${cardOf}; return !c || c.querySelector(".abj-chip").hidden; })()`, 15000), true);
let pid1 = pid0;
for (let i = 0; i < 160 && pid1 === pid0; i++) { await sleep(250); pid1 = (await version())?.pid ?? pid0; }
check("iş kalmayınca panel kendisi yeniden başladı (yeni PID, aynı adres)", pid1 !== pid0, true);
check("sayfa yeni sürece bağlandı ve yenilendi: oturum kartı geri geldi, 'arka plan işi yok'", await until(`!!${cardOf} && document.getElementById("abjFoot").textContent === "arka plan işi yok"`, 40000), true);
check("yeniden başlatmadan sonra bekleme yok", (await state()).restartWaiting, false);

await tally();
check("tarayıcının yerleşik confirm/alert/prompt'u hiç çağrılmadı", native, { confirm: 0, alert: 0, prompt: 0 });
check("sayfa hatası yok", errors, []);
console.log(`${pass + fail} denetim, ${fail} hata`);
process.exit(fail ? 1 : 0);
