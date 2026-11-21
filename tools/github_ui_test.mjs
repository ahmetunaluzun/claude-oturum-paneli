// Takip → GitHub tarayıcı testi: bölüm ve "GitHub" çipi, satır sırası (cevap bekleyen öne), satır içeriği (depo, #no, başlık, açan,
// yorum sayısı, son hareket, tür), düğmeler (Oturumda ele al yalnız yerel klasörü bilinen depoda; GitHub'da aç), gizlenen satırın
// yeni yorumla geri gelmesi, Oturumda ele al (deponun klasöründe oturum + yazma yasağı taşıyan istem; aynı projede oturum varken
// panelin çakışma penceresi), projeye göre gruplama, ağ hatası / giriş yok notları, Ayarlar'daki aç/kapat anahtarı (kalıcı),
// 1280 koyu/açık + 390 telefon + İngilizce taşma ve dokunma hedefi ölçümü. Tarayıcı confirm/alert/prompt YOK.
// Gerçek gh ve GitHub KULLANILMAZ: sahte gh (tools/sahte_gh.py), senaryo dosyası bu betikten değiştirilir. Uydurma ortamı
// tools/github_ui_test.sh kurar. "GitHub'da aç" bağlantısına BASILMAZ (tarayıcı sekmesi açar); yalnız adresi ölçülür.
// Kullanım: node github_ui_test.mjs <debugPort> <url> <çıktıÖneki> <geçici klasör> [gösterilecek kök]
import { writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
const SEC = "GitHub", SGH = join(import.meta.dirname, "sahte_gh.py");
const senaryo = (ad) => execFileSync("py", ["-3.13", SGH, "--senaryo", ad, join(tmpRoot, "gh.json")], { env: { ...process.env, PYTHONUTF8: "1" } });
const openAllRows = () => ev(`(async () => { for (const b of document.querySelectorAll('.fu-row:not(.fu-open) .fu-tog')) b.click(); })()`);
const ghNote = () => ev(`[...document.querySelectorAll("#fu-github .fu-clean")].map(p => p.textContent)`);
// Yenile: GitHub da şimdi denetlenir; deneme zamanı değişene kadar beklenir.
const ghRefresh = async () => {
  const before = await ev(`fetch("/api/followup").then(r => r.json()).then(d => d.github.triedAt)`);
  await click(`document.getElementById("btnFuRefresh")`, 400);
  await until(`fetch("/api/followup").then(r => r.json()).then(d => d.github.triedAt !== ${before} && !d.github.fetching && !d.scanning)`);
  await refresh();
};
const T1 = "#1 Gece modu koruması için birkaç öneri", T2 = "#2 Sepet toplamı indirimde yanlış", T5 = "#5 Türkçe çeviri düzeltmesi", T7 = "#7 Sürüm notlarını yaz",
  T9 = "#9 Ödeme sayfası & <b>kaçış</b> denemesi";

// ================= bölüm, çip, sıra (Türe göre) =================
await open(1280);
await ev(`localStorage.removeItem("panel.follow")`);
await until(`fetch("/api/followup").then(r => r.json()).then(d => d.github.state === "ok" && !d.github.fetching)`);
await open(1280);
let c = await chips();
check("GitHub çipi: 5 öğe; çip sırası", [c.github, Object.keys(c)], [5, ["all", "git", "next", "drive", "sched", "github", "decisions"]]);
const allWith = c.all;
check("sekme rozeti = Tümü", await ev(`document.getElementById("navFollow").textContent`), String(c.all));
await mode("type");
check("Türe göre: GitHub bölümü var, kapalı; Sıradaki işler'den sonra", [(await conts()).includes(SEC + ":kapalı"), await ev(`document.getElementById("fu-github").previousElementSibling.id`)], [true, "fu-next"]);
check("kapalı bölüm başlığındaki sayı", await ev(`${contOf(SEC)}.querySelector(".count").textContent`), "5");
await openCont(SEC);
check("sıra: cevap bekleyenler önce (en yeni hareket üstte), sonra sakin satırlar", await titles("#fu-github .fu-row"), [T5, T9, T1, T2, T7]);
check("bölüm notu: hesap + denetim zamanı", /^testkul · .+ önce denetlendi \(15 dakikada bir\)$/.test((await ghNote())[0] || ""), true);

// ---- satırlar ----
let r = await rowInfo("gh", T1);
check("cevap bekleyen issue (yerel klasörü var): tür + durum etiketi, depo · açan · yorum, iki düğme", [r.etiket, r.ne, r.dugme, /önce$/.test(r.yan[0] || "")],
  [["issue", "cevap bekliyor"], "testkul/demo-magaza · açan misafir1 · yorum yok", ["Oturumda ele al", "GitHub'da aç"], true]);
check("Oturumda ele al birincil düğme; GitHub'da aç yeni sekmede issue adresi", await ev(`(() => { const r = ${rowOf("gh", T1)}, a = r.querySelector(".fu-side a"), b = r.querySelector(".fu-side button.btn");
  return [b.classList.contains("primary"), a.href, a.target, a.rel]; })()`), [true, "https://github.com/testkul/demo-magaza/issues/1", "_blank", "noopener"]);
r = await rowInfo("gh", T5);
check("cevap bekleyen PR (yerel klasörü yok): Oturumda ele al gizli; son yazan görünür", [r.etiket, r.ne, r.dugme],
  [["PR", "cevap bekliyor"], "testkul/ornek-kitaplik · açan misafir3 · 2 yorum · son yazan misafir3", ["GitHub'da aç"]]);
r = await rowInfo("gh", T2);
check("sakin satır (son söz kullanıcıda): uyarı etiketi yok, tek düğme", [r.etiket, r.ne, r.dugme], [["issue"], "testkul/demo-magaza · açan misafir2 · 3 yorum · son yazan testkul", ["GitHub'da aç"]]);
r = await rowInfo("gh", T7);
check("kendi açtığı yorumsuz issue: sakin", [r.etiket, r.ne, r.dugme], [["issue"], "testkul/Temiz-Kutuphane · açan testkul · yorum yok", ["GitHub'da aç"]]);
r = await rowInfo("gh", T9);
check("kendi issue'su, son yorum başkasında: cevap bekliyor; başlık metin olarak (HTML değil)", [r.etiket, r.dugme, await ev(`${rowOf("gh", T9)}.querySelector("b b") === null`)],
  [["issue", "cevap bekliyor"], ["Oturumda ele al", "GitHub'da aç"], true]);
await toggleRow("gh", T2);
check("sakin satırın ayrıntısı: Oturumda ele al + Ertele + Gizle", (await rowInfo("gh", T2)).ek, ["Oturumda ele al", "Ertele (yarına)", "Gizle"]);
await toggleRow("gh", T5);
check("yerel klasörü olmayan satırın ayrıntısı: yalnız Ertele + Gizle", (await rowInfo("gh", T5)).ek, ["Ertele (yarına)", "Gizle"]);
await openAllRows(); await sleep(300);
check("1280 koyu, tüm satırlar açık: taşma yok", await measure(), CLEAN);
await shot("1280");

// ---- gizle → yeni yorumla geri gelir ----
await click(`[...${rowOf("gh", T2)}.querySelectorAll(".fu-more .btn")].find(b => b.textContent === "Gizle")`);
c = await chips();
check("gizlenen sakin satır listeden çıktı; Tümü değişmedi (bilgi satırıydı)", [(await titles("#fu-github .fu-row")).includes(T2), c.github, c.all], [false, 4, allWith]);
senaryo("yeniyorum");
await ghRefresh();
c = await chips();
r = await rowInfo("gh", T2);
check("yeni yorum gelince gizlenen satır geri geldi, cevap bekliyor", [r?.etiket, r?.ne, c.github, c.all],
  [["issue", "cevap bekliyor"], "testkul/demo-magaza · açan misafir2 · 4 yorum · son yazan misafir2", 5, allWith + 1]);
check("en yeni hareket en üstte", (await titles("#fu-github .fu-row"))[0], T2);
check("sekme rozeti güncellendi", await ev(`document.getElementById("navFollow").textContent`), String(c.all));

// ---- Oturumda ele al ----
const startedAt = Date.now();
await rowBtn("gh", T1, "Oturumda ele al");
await until(`document.getElementById("viewFollow").hidden`, 8000);
check("Oturumda ele al: Oturumlar sekmesine geçti", await ev(`[document.getElementById("viewFollow").hidden, document.getElementById("viewSessions").hidden]`), [true, false]);
await until(`fetch("/api/state").then(r => r.json()).then(d => d.hosted.length === 1)`, 8000);
const st = await ev(`fetch("/api/state").then(r => r.json()).then(d => d.hosted.map(h => [h.name, h.cwd.split(/[\\\\/]/).pop()]))`);
check("oturum deponun yerel klasöründe açıldı", st, [["GitHub #1", "Demo Mağaza"]]);
await sleep(1500);
const msgs = readFileSync(join(tmpRoot, "sahte.log"), "utf8").split("\n").filter(l => l.startsWith("MESAJ"));
check("istem: issue bağlantısı + GitHub'a yazma yasağı; tek mesaj", [msgs.length, msgs[0]?.includes("https://github.com/testkul/demo-magaza/issues/1"), msgs[0]?.includes("GitHub'a hiçbir şey yazma"), msgs[0]?.includes("gönderme kararı kullanıcının")], [1, true, true, true]);
await open(1280);
await openCont(SEC);
check("projesinde oturum açıkken de GitHub satırı görünür", (await rowInfo("gh", T1)).dugme, ["Oturumda ele al", "GitHub'da aç"]);
await sleep(Math.max(0, 21000 - (Date.now() - startedAt))); // sunucu aynı isteği 20 sn içinde yineleme sayar (StartOnce): onun dışında deneriz
await rowBtn("gh", T1, "Oturumda ele al");
await until(`!!document.querySelector("#dlgAsk[open]")`, 6000);
let b = await box();
check("aynı projede oturum varken: panelin kendi çakışma penceresi (ikinci oturum açılmaz)", [b?.title, b?.buttons.includes("Yine de aç")], ["Bu projede zaten oturum açık", true]);
await press("cancel");
check("vazgeçince oturum sayısı değişmedi", await ev(`fetch("/api/state").then(r => r.json()).then(d => d.hosted.length)`), 1);

// ---- projeye göre ----
await mode("project");
check("Projeye göre: yerel klasörlü öğe projesinin grubunda, klasörsüz depo kendi adıyla", await ev(`(() => { const g = (n) => [...document.querySelectorAll(".fu-group")].find(s => s.querySelector(".fu-name").textContent === n);
  return [!!g("ornek-kitaplik"), !!g("Temiz Kütüphane"), g("ornek-kitaplik")?.querySelector(".fu-sum").textContent]; })()`), [true, true, "GitHub"]);
await chip("github");
check("GitHub süzgeci: yalnız GitHub grupları", await ev(`[...document.querySelectorAll(".fu-group .fu-name")].map(x => x.textContent).sort()`), ["Demo Mağaza", "Temiz Kütüphane", "ornek-kitaplik"]);
await ev(`(async () => { for (const h of document.querySelectorAll('.fu-group .fu-fold[aria-expanded="false"]')) h.click(); })()`); await sleep(300);
check("grup satırında tür adı", await ev(`[...new Set([...document.querySelectorAll('.fu-row[data-type="gh"] .fu-kind')].map(x => x.textContent))]`), ["GitHub"]);
await mode("type");

// ---- ağ hatası / giriş yok ----
senaryo("ag");
await ghRefresh();
await openCont(SEC);
check("ağ hatası: son liste duruyor + 'güncellenemedi' notu", [(await titles("#fu-github .fu-row")).length, /^GitHub güncellenemedi; liste .+ önceki durumu gösteriyor\.$/.test((await ghNote())[0] || "")], [5, true]);
senaryo("giris");
await ghRefresh();
await openCont(SEC);
check("giriş yok: satır yok, kısa ipucu (hata bildirimi değil)", [(await titles("#fu-github .fu-row")).length, await ghNote(), (await toasts()).length],
  [0, ["GitHub CLI'da giriş yapılmamış. Terminalde gh auth login ile giriş yapın."], 0]);
senaryo("yeniyorum");
await ghRefresh();

// ---- Ayarlar: aç/kapat ----
const before = (await chips()).all;
await click(`document.getElementById("btnSettings")`, 700);
check("Ayarlar: anahtar açık, hesap adı yazıyor", await ev(`[document.getElementById("sGithub").checked, document.getElementById("sGithubState").textContent]`),
  [true, "testkul hesabının depoları 15 dakikada bir denetlenir. Panel yalnız okur, GitHub'a hiçbir şey yazmaz."]);
await ev(`document.getElementById("sGithub").scrollIntoView({ block: "center" })`);
await shot("ayarlar");
await click(`document.getElementById("sGithub")`, 900);
check("kapatınca durum metni", await ev(`[document.getElementById("sGithub").checked, document.getElementById("sGithubState").textContent]`), [false, "Kapalı: GitHub'a bağlanılmaz."]);
await ev(`document.getElementById("dlgSettings").close()`);
await until(`!document.getElementById("fu-github")`, 6000);
c = await chips();
check("kapalıyken: bölüm ve çip yok, Tümü'nden bekleyenler düştü", [await ev(`!!document.getElementById("fu-github")`), "github" in c, c.all], [false, false, before - 4]);
await open(1280);
check("sayfa yenilenince kapalı kaldı (sunucuda kalıcı)", [await ev(`!!document.getElementById("fu-github")`), await ev(`fetch("/api/github").then(r => r.json()).then(d => d.enabled)`)], [false, false]);
await click(`document.getElementById("btnSettings")`, 700);
check("Ayarlar yeniden açılınca anahtar kapalı görünür", await ev(`document.getElementById("sGithub").checked`), false);
await click(`document.getElementById("sGithub")`, 900);
await ev(`document.getElementById("dlgSettings").close()`);
await until(`fetch("/api/followup").then(r => r.json()).then(d => d.github.state === "ok" && !d.github.fetching)`);
await until(`!!document.getElementById("fu-github")`, 6000);
check("yeniden açınca bölüm geri geldi", (await chips()).github, 5);

// ---- açık tema, telefon, İngilizce ----
await open(1280, { light: true });
await openCont(SEC); await openAllRows(); await sleep(300);
check("1280 açık tema: taşma yok", await measure(), CLEAN);
await shot("1280_acik");
await open(390);
await openCont(SEC);
check("telefon 390 px, satırlar kapalı: taşma yok, dokunma hedefleri ≥ 44 px", await measure(), CLEAN);
check("telefon: çipler arasında GitHub", (await chips()).github, 5);
await ev(`document.getElementById("fu-github").scrollIntoView({ block: "start" })`);
await shot("390_telefon");
await openAllRows(); await sleep(300);
check("telefon 390 px, tüm satırlar açık: taşma yok", await measure(), CLEAN);
r = await rowInfo("gh", T9);
check("telefonda da iki düğme", r.dugme, ["Oturumda ele al", "GitHub'da aç"]);
await ev(`${rowOf("gh", T9)}.scrollIntoView({ block: "center" })`);
await shot("390_telefon_acik");
await open(1280, { lang: "en" });
await openCont(SEC); await openAllRows(); await sleep(300);
r = await rowInfo("gh", T9);
check("İngilizce: etiket ve düğmeler", [r.etiket, r.dugme, r.ek], [["issue", "needs reply"], ["Handle in a session", "Open on GitHub"], ["Snooze (tomorrow)", "Hide"]]);
check("İngilizce: çevrilmemiş anahtar yok", await ev(`[...document.querySelectorAll("#viewFollow *")].filter(e => !e.children.length && /^(fu|pc|err_|sG)[A-Za-z_]+$/.test(e.textContent.trim())).map(e => e.textContent.trim())`), []);
check("İngilizce: taşma yok", await measure(), CLEAN);
await shot("1280_en");

await tally();
check("tarayıcının confirm / alert / prompt penceresi hiç açılmadı", native, { confirm: 0, alert: 0, prompt: 0 });
check("sayfada betik hatası yok", errors, []);
console.log(`\n${pass} geçti, ${fail} kaldı`);
ws.close();
process.exit(fail ? 1 : 0);
