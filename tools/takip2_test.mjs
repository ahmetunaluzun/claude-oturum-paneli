// Takip 2. aşama tarayıcı testi (0.12.0): açılır-kapanır bölümler + kalıcı durum, depo başına tek düğme, Gönder ön denetimi,
// gizli commit işi (kart yok), oturumdaki projenin gizlenmesi, "bu projede zaten oturum açık" seçenek penceresi, çakışma rozeti.
// Görüntüler: <önek>_1280_koyu.png, _1280_acik.png, _390_telefon.png, _1280_secenek.png, _390_secenek.png (taşma ölçümüyle).
// Uydurma ortam + sahte claude ile çalışan test kopyasında kullanılır (tools/takip2_test.sh kurar). Geçici klasör yolu
// (kullanıcı adını içerir) sayfaya giden her yanıtta <gösterilecek kök> ile değiştirilir, isteklerde geri çevrilir.
// Kullanım: node takip2_test.mjs <debugPort> <url> <çıktıÖneki> <gizlenecek kök> [gösterilecek kök]
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
async function open(width, { lang = "tr", light = false, view = "follow", height } = {}) {
  if (injected) { await tally(); await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected }); }
  injected = (await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT(lang, light) })).result.identifier;
  await send("Emulation.setDeviceMetricsOverride", { width, height: height || (width < 500 ? 844 : 900), deviceScaleFactor: 1, mobile: width < 500 });
  await send("Page.navigate", { url: url + "?view=" + view });
  await until(`document.querySelectorAll(".fu-sec").length >= 4 && !document.getElementById("btnFuRefresh").disabled`);
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
const secs = () => ev(`[...document.querySelectorAll(".fu-sec")].map(s => s.id.slice(3) + ":" + (s.querySelector(".fu-fold").getAttribute("aria-expanded") === "true" ? "açık" : "kapalı"))`);
const rowOf = (name, sec = "") => `[...document.querySelectorAll("${sec ? "#fu-" + sec + " " : ""}.fu-row")].find(r => r.querySelector("b").textContent === ${JSON.stringify(name)})`;
const rowInfo = (name, sec) => ev(`(() => { const r = ${rowOf(name, sec)}; if (!r) return null; return { dugme: [...r.querySelectorAll(".fu-side .btn")].map(b => b.textContent),
  is: r.querySelector(".fu-job")?.textContent || "", etiket: [...r.querySelectorAll(".fu-tag")].map(x => x.textContent) }; })()`);
const click = async (expr, waitMs = 400) => { await ev(`(${expr}).click()`); await sleep(waitMs); };
const fold = (id) => click(`document.querySelector("#fu-${id} .fu-fold")`);
const box = () => ev(`(() => { const d = document.querySelector("#dlgAsk[open]"); if (!d) return null; const r = d.getBoundingClientRect();
  return { title: document.getElementById("askTitle").textContent, list: [...document.querySelectorAll("#askList li")].map(x => x.textContent),
    buttons: [...document.querySelectorAll("#askButtons button")].map(b => b.textContent + "|" + b.value), focus: document.activeElement?.value || "",
    icinde: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, sayfaTasma: document.documentElement.scrollWidth - innerWidth,
    dugmeDisarida: [...document.querySelectorAll("#askButtons button")].filter(b => { const q = b.getBoundingClientRect(); return q.left < r.left || q.right > r.right || b.scrollWidth > b.clientWidth + 1; }).length }; })()`);
const press = async (value) => { await ev(`document.querySelector('#dlgAsk[open] button[value="${value}"]').click()`); await sleep(400); };
const api = (path, body) => ev(`fetch(${JSON.stringify(path)}, { method: "POST", headers: { "X-Panel-Token": document.querySelector('meta[name="panel-token"]').content, "Content-Type": "application/json" }, body: JSON.stringify(${JSON.stringify(body)}) }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }))`);
const state = (expr) => ev(`fetch("/api/state", { cache: "no-store" }).then(r => r.json()).then(d => ${expr})`);
const measure = () => ev(`(() => { const de = document.documentElement, rows = [...document.querySelectorAll(".fu-row")];
  const over = rows.filter(r => { const b = r.getBoundingClientRect(); return [...r.querySelectorAll("b, small, .fu-what, .fu-job, .btn, .fu-tag")].some(e => { const q = e.getBoundingClientRect(); return q.width && (q.right > b.right + 1 || q.left < b.left - 1); }); }).length;
  const heads = [...document.querySelectorAll(".fu-fold")].filter(h => h.scrollWidth > h.clientWidth + 1 || h.getBoundingClientRect().right > innerWidth).length;
  const btns = [...document.querySelectorAll(".fu-row .btn, .fu-allbar .btn, .fu-head .btn")].filter(b => b.scrollWidth > b.clientWidth + 1).length;
  const small = matchMedia("(max-width: 640px)").matches ? [...document.querySelectorAll(".fu-fold, .fu-insess")].filter(e => e.getBoundingClientRect().height < 44).length : 0;
  return { yatayTasma: de.scrollWidth - de.clientWidth, satir: rows.length, tasanSatir: over, tasanBaslik: heads, kirpilanDugme: btns, kucukDokunmaHedefi: small }; })()`);
const CLEAN = (n) => ({ yatayTasma: 0, satir: n, tasanSatir: 0, tasanBaslik: 0, kirpilanDugme: 0, kucukDokunmaHedefi: 0 });
const P = (name) => showRoot + "\\" + name;

// ================= 1280 px, koyu, Türkçe =================
await open(1280);
await ev(`localStorage.removeItem("panel.follow")`);
await open(1280);
check("varsayılan: karar bekleyenler açık, ötekiler kapalı", await secs(), ["decisions:açık", "git:kapalı", "next:kapalı", "updates:kapalı"]);
check("kapalı bölümde satır çizilmez", await ev(`document.querySelectorAll("#fu-git .fu-row, #fu-next .fu-row").length`), 0);
check("kapalı başlık tek satır: ad + sayı + proje adları", await ev(`(() => { const h = document.querySelector("#fu-git .fu-fold"); return [h.querySelector(".fu-name").textContent, h.querySelector(".count").textContent, h.querySelector(".fu-sum").textContent, h.getBoundingClientRect().height <= 44]; })()`),
  ["Git", "5", "Demo Mağaza, Gizli Depo, Kirli Uzak, Örnek API, Rapor Aracı", true]);
check("sekme rozeti = bölüm sayılarının toplamı", await ev(`[document.getElementById("navFollow").textContent === String([...document.querySelectorAll(".fu-fold .count")].reduce((n, c) => n + Number(c.textContent), 0)), Number(document.getElementById("navFollow").textContent) >= 8]`), [true, true]);
check("üstte 'Tümünü aç'", await ev(`document.getElementById("btnFuFold").textContent`), "Tümünü aç");

await fold("git");
check("başlığa tıkla: Git açıldı", await secs(), ["decisions:açık", "git:açık", "next:kapalı", "updates:kapalı"]);
check("durum localStorage'da (panel.follow)", await ev(`JSON.parse(localStorage.getItem("panel.follow")).collapsed.git`), false);
await open(1280);
check("yeniden yüklemede durum kalıyor", await secs(), ["decisions:açık", "git:açık", "next:kapalı", "updates:kapalı"]);

// ---- depo başına TEK düğme ----
check("commit'lenmemiş + gönderilmemiş → tek düğme 'Commit et ve gönder'", (await rowInfo("Kirli Uzak")).dugme, ["Commit et ve gönder"]);
check("yalnız commit'lenmemiş → 'Commit et'", (await rowInfo("Demo Mağaza")).dugme, ["Commit et"]);
check("yalnız gönderilmemiş → 'Gönder'", (await rowInfo("Örnek API")).dugme, ["Gönder"]);
check("uzak dalı yok → 'Gönder'", (await rowInfo("Rapor Aracı")).dugme, ["Gönder"]);
check("her depo satırında tam bir düğme", await ev(`[...document.querySelectorAll("#fu-git .fu-row")].map(r => r.querySelectorAll(".fu-side .btn").length)`), [1, 1, 1, 1, 1]);
check("bölüm başında 'Tümünü commit et ve gönder'", await ev(`[...document.querySelectorAll("#fu-git .fu-allbar .btn")].map(b => b.textContent)`), ["Tümünü commit et ve gönder"]);

// ---- Tümünü aç / kapat ----
await click(`document.getElementById("btnFuFold")`);
check("Tümünü aç: hepsi açık, düğme 'Tümünü kapat'", [await secs(), await ev(`document.getElementById("btnFuFold").textContent`)],
  [["decisions:açık", "git:açık", "next:açık", "updates:açık"], "Tümünü kapat"]);
await click(`document.getElementById("btnFuFold")`);
check("Tümünü kapat: hepsi kapalı", await secs(), ["decisions:kapalı", "git:kapalı", "next:kapalı", "updates:kapalı"]);
await open(1280);
check("yeniden yüklemede hepsi kapalı kalıyor", await secs(), ["decisions:kapalı", "git:kapalı", "next:kapalı", "updates:kapalı"]);
await click(`document.getElementById("btnFuFold")`);

// ---- "Tümünü commit et ve gönder" onayı (Vazgeç: iş başlamaz) ----
await click(`document.querySelector("#fu-git .fu-allbar .btn")`);
let b = await box();
check("toplu iş onayı: başlık ve depo başına yapılacak", [b?.title, b?.list], ["5 depo sırayla işlensin mi?",
  ["Demo Mağaza — commit", "Gizli Depo — gönder", "Kirli Uzak — commit + gönder", "Örnek API — gönder", "Rapor Aracı — gönder"]]);
await press("cancel");
check("Vazgeç: iş başlamadı", await ev(`fetch("/api/follow/jobs").then(r => r.json()).then(j => j.length)`), 0);

// ---- Gönder: ön denetim reddi satırda ----
await click(`${rowOf("Gizli Depo")}.querySelector(".fu-side .btn")`);
await until(`(${rowOf("Gizli Depo")})?.querySelector(".fu-job.warn")`);
const gizli = await rowInfo("Gizli Depo");
check("Gönder reddedildi, neden satırda (dosya + kalıp adı)", gizli.is,
  "Gönderilmedi: gönderilecek commit'lerde depoya girmemesi gereken içerik var: .claude/settings.local.json (Claude Code izin dosyası); ayar.txt (GitHub belirteci)");
check("belirteç değeri sayfada yok", await ev(`/gh[pousr]_[A-Za-z0-9]{20,}/.test(document.body.innerText)`), false);
check("reddedilen depoda düğme duruyor (düzeltip yeniden denenebilir)", gizli.dugme, ["Gönder"]);

// ---- Gönder: başarılı, oturum açılmaz ----
await click(`${rowOf("Örnek API")}.querySelector(".fu-side .btn")`);
await until(`(${rowOf("Örnek API")})?.querySelector(".fu-job.ok")`);
check("iş bitti, depo yeniden taranana kadar eski düğme gösterilmez", (await rowInfo("Örnek API", "git")).dugme.includes("Gönder"), false);
await until(`[...((${rowOf("Örnek API", "git")})?.querySelectorAll(".btn") || [])].some(b => b.textContent === "Tamam")`);
check("Gönder: sonuç satırda, 'Tamam' ile kapanır", await rowInfo("Örnek API", "git"), { dugme: ["Tamam"], is: "✓ 2 commit gönderildi", etiket: [] });
check("Gönder oturum açmadı", await state(`d.hosted.length`), 0);
await click(`${rowOf("Örnek API", "git")}.querySelector(".fu-side .btn")`);
check("'Tamam': sonuç satırı kalktı", await rowInfo("Örnek API", "git"), null);

// ---- Commit et ve gönder: gizli iş, kart yok ----
await click(`${rowOf("Kirli Uzak")}.querySelector(".fu-side .btn")`);
await until(`(${rowOf("Kirli Uzak")})?.querySelector(".fu-job.run")?.textContent === "Commit ediliyor…"`);
check("iş sürerken satırda ilerleme, düğme yok", await rowInfo("Kirli Uzak"), { dugme: [], is: "Commit ediliyor…", etiket: ["main"] });
await sleep(2700); // oturum listesi 2,5 sn'de bir yenilenir
check("gizli iş oturum kartı olarak görünmez", [await ev(`document.querySelectorAll("#cardsIdle .card, #cardsBusy .card").length`), await ev(`document.getElementById("navCount").textContent`), await state(`d.hosted.length`)], [0, "0", 0]);
await shot("1280_koyu");
const n1 = await ev(`document.querySelectorAll(".fu-row").length`);
check("1280 koyu: satırlar çizildi, taşma yok", [n1 >= 7, await measure()], [true, CLEAN(n1)]);
await until(`[...((${rowOf("Kirli Uzak")})?.querySelectorAll(".btn") || [])].some(b => b.textContent === "Tamam")`, 40000);
check("iş bitti: sonuç + özet satırda", await rowInfo("Kirli Uzak"), { dugme: ["Özet", "Tamam"], is: "✓ 1 commit yapıldı, 2 commit gönderildi", etiket: [] });
await click(`${rowOf("Kirli Uzak")}.querySelector(".fu-side .btn")`);
b = await box();
check("Özet penceresi: commit oturumunun yanıtı", [b?.title, await ev(`document.getElementById("askText").textContent`)], ["Kirli Uzak: commit özeti", "Değişiklikler commit edildi."]);
await press("ok");
check("iş bitince de oturum kartı yok", await state(`d.hosted.length`), 0);

// ---- projede oturum varsa Takip'te gizlenir ----
check("Stok Sayım'da oturum aç (çalışır kalır)", (await api("/api/hosted", { cwd: P("Stok Sayım"), prompt: "BEKLE uzun iş" })).status, 200);
await until(`document.querySelector("#fu-next .fu-insess")`);
check("oturumdaki projenin planı gizlendi", [await rowInfo("Stok Sayım"), await ev(`document.querySelector("#fu-next .fu-insess").textContent`)], [null, "1 proje şu an oturumda açık, gösterilmiyor"]);
check("öteki plan görünüyor", (await rowInfo("Örnek API", "next"))?.dugme, ["Devam et"]);
await click(`document.querySelector("#fu-next .fu-insess")`);
check("satıra tıkla: gizlenen proje bilgi olarak görünür, düğmesiz", await rowInfo("Stok Sayım", "next"), { dugme: [], is: "", etiket: ["eski plan", "oturumda açık"] });
await click(`document.querySelector("#fu-next .fu-insess")`);

// ---- seçenek penceresi (409): Yeni oturum → aynı proje ----
const newSession = async (cwd, prompt) => {
  await ev(`(() => { document.getElementById("btnNew").click(); document.getElementById("fCwd").value = ${JSON.stringify(cwd)};
    document.getElementById("fCwd").dispatchEvent(new Event("input")); document.getElementById("fPrompt").value = ${JSON.stringify(prompt)}; })()`);
  await sleep(600);
  await click(`document.getElementById("btnStart")`, 900);
};
await newSession(P("Stok Sayım"), "ikinci iş");
b = await box();
check("aynı projeye yeni oturum: seçenek penceresi", [b?.title, b?.list], ["Bu projede zaten oturum açık", ["Stok Sayım — çalışıyor"]]);
check("seçenekler (çalışan oturum, depo değil)", b?.buttons, ["Vazgeç|cancel", "İş bitince gönder|later", "Yine de aç|force"]);
check("odak güvenli seçenekte", b?.focus, "later");
check("pencere ekranda, düğmeler içinde", [b?.icinde, b?.sayfaTasma, b?.dugmeDisarida], [true, 0, 0]);
await shot("1280_secenek");
await press("cancel");
check("Vazgeç: oturum açılmadı, hata yazısı yok, pencere açık kaldı", [await state(`d.hosted.length`), await ev(`document.getElementById("newErr").textContent`), await ev(`document.getElementById("dlgNew").open`)], [1, "", true]);
await click(`document.getElementById("btnStart")`, 900);
await press("later");
check("'İş bitince gönder': ikinci oturum açılmadı, mesaj sırada", [await state(`d.hosted.length`), await state(`d.hosted[0].task`), await ev(`document.getElementById("dlgNew").open`)], [1, "continuing", false]);
check("bildirim: sıraya alındı", await ev(`[...document.querySelectorAll(".toast")].some(x => x.textContent.startsWith("Mesaj sıraya alındı"))`), true);
await ev(`document.getElementById("dClose").click()`);

// Depoda (git) seçenekler: ayrı çalışma kopyası da sunulur
check("Demo Mağaza'da oturum aç", (await api("/api/hosted", { cwd: P("Demo Mağaza"), prompt: "merhaba" })).status, 200);
await until(`fetch("/api/state").then(r => r.json()).then(d => d.hosted.filter(h => h.status === "idle").length === 1)`);
await newSession(P("Demo Mağaza") + "\\src", "alt klasörden iş");
b = await box();
check("alt klasör aynı proje; boştaki oturumda seçenekler", b?.buttons, ["Vazgeç|cancel", "Mevcut oturuma gönder|send", "Ayrı çalışma kopyasında aç|worktree", "Yine de aç|force"]);
check("odak 'Mevcut oturuma gönder'de", b?.focus, "send");
await press("force");
await sleep(600);
check("'Yine de aç': ikinci oturum açıldı", await state(`d.hosted.length`), 3);
await ev(`document.getElementById("dClose").click()`);

// ---- çakışma rozeti (Oturumlar) ve Takip satırı ----
await sleep(2700);
check("kartlarda 'Bu projede 2 oturum açık'", await ev(`[...document.querySelectorAll(".card .proj-multi")].filter(p => !p.hidden).map(p => p.textContent)`), ["Bu projede 2 oturum açık", "Bu projede 2 oturum açık"]);
check("tek oturumlu projede rozet yok", await ev(`[...document.querySelectorAll(".card")].find(c => c.querySelector(".name").textContent === "Stok Sayım").querySelector(".proj-multi").hidden`), true);
await ev(`document.querySelector('#nav button[data-view="follow"]').click()`);
await until(`document.querySelector("#fu-conflicts")`);
check("Takip'te 'Çakışma riski' bölümü açık gelir", (await secs())[1], "conflicts:açık");
check("çakışma satırı", await ev(`(() => { const r = document.querySelector("#fu-conflicts .fu-row"); return [r.querySelector("b").textContent, r.querySelector(".fu-what").textContent, [...r.querySelectorAll(".btn")].map(x => x.textContent)]; })()`),
  ["Demo Mağaza", "2 oturum aynı projede: Demo Mağaza, src", ["Oturumları göster"]]);
check("oturumdaki depo Git'te gizli", [await rowInfo("Kirli Uzak") !== null, await ev(`document.querySelector("#fu-git .fu-insess")?.textContent`)], [true, "1 proje şu an oturumda açık, gösterilmiyor"]);

// ================= 1280 px, açık tema =================
await open(1280, { light: true });
check("açık tema: bölümler ve durum aynı", (await secs()).length, 5);
await shot("1280_acik");
const rows = await ev(`document.querySelectorAll(".fu-row").length`);
check("1280 açık: taşma yok", await measure(), CLEAN(rows));

// ================= 390 px telefon =================
await open(390, { height: 1700 });
await shot("390_telefon");
check("390 telefon: taşma yok, dokunma hedefleri ≥ 44 px", await measure(), CLEAN(rows));
await fold("git"); await fold("git");
check("telefonda başlığa dokununca kapanıp açılıyor", (await secs()).includes("git:açık"), true);
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
// Gerçek telefon yüksekliğinde sona kaydırınca yüzen + düğmesi (görünür hâlde) son düğmeleri örtmemeli.
await sleep(300);
await ev(`(document.scrollingElement || document.body).scrollTo(0, 1e6); document.body.scrollTo(0, 1e6)`); await sleep(500);
await ev(`document.getElementById("btnNew").classList.remove("away")`); await sleep(300);
check("390x844 sona kaydırınca + düğmesi hiçbir düğmeyi örtmüyor", await ev(`(() => { const f = document.getElementById("btnNew").getBoundingClientRect();
  const sc = [document.scrollingElement, document.body].find(e => e && e.scrollTop > 0);
  if (!sc || sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2) return "sona kaydırılamadı";
  return [...document.querySelectorAll("#viewFollow button, #viewFollow a")].filter(e => { const r = e.getBoundingClientRect();
    return r.width && r.right > f.left && r.left < f.right && r.bottom > f.top && r.top < f.bottom; }).map(e => e.textContent.trim()); })()`), []);
await ev(`document.querySelector('#nav button[data-view="sessions"]').click()`);
await newSession(P("Demo Mağaza"), "telefondan iş");
b = await box();
check("390: seçenek penceresi ekranda, düğmeler sığıyor", [b?.title, b?.buttons.length, b?.icinde, b?.sayfaTasma, b?.dugmeDisarida], ["Bu projede zaten oturum açık", 4, true, 0, 0]);
await shot("390_secenek");
await press("cancel");
await ev(`document.getElementById("dlgNew").close()`);

// ================= İngilizce =================
await open(1280, { lang: "en" });
check("İngilizce: çevrilmemiş anahtar yok", await ev(`[...document.querySelectorAll("#viewFollow *")].filter(e => !e.children.length && /^(fu|pc|err_)[A-Za-z_]+$/.test(e.textContent.trim())).map(e => e.textContent)`), []);
check("İngilizce: başlık ve toplu düğme", await ev(`[document.querySelector("#fu-conflicts .fu-name").textContent, document.getElementById("btnFuFold").textContent]`), ["Conflict risk", "Collapse all"]);

await tally();
check("yerleşik confirm/alert/prompt hiç çağrılmadı", native, { confirm: 0, alert: 0, prompt: 0 });
check("sayfada betik hatası yok", errors, []);
console.log(`\n${pass} geçti, ${fail} kaldı`);
ws.close();
process.exit(fail ? 1 : 0);
