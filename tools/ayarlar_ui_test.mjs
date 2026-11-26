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
const NAV_ALL = ["setAccounts", "setWorkers", "setRouting", "setGeneral", "setNotify", "setNight", "setMail", "setPhone", "setGoogle", "setAdvanced", "setAbout"];
const navShown = await ev(`[...document.querySelectorAll("#setNav button")].filter(b => !b.hidden).map(b => b.dataset.sec)`);
check("bölüm menüsü: görünen her satırın bölümü var ve sıra doğru",
  [navShown.every(s => NAV_ALL.includes(s)), JSON.stringify(navShown) === JSON.stringify(NAV_ALL.filter(s => navShown.includes(s))),
    await ev(`[...document.querySelectorAll("#setNav button")].filter(b => !b.hidden).every(b => { const s = document.getElementById(b.dataset.sec); return s && !s.hidden && s.querySelector("h2"); })`)],
  [true, true, true]);
for (const need of ["setGeneral", "setNotify", "setNight", "setMail", "setPhone", "setAdvanced", "setAbout"]) check(`bölüm var: ${need}`, navShown.includes(need), true);
check("ayarlar bölümlerine dağılmış", await ev(`(() => { const sec = (id) => document.getElementById(id).closest(".set-sec")?.id;
  return [sec("sLight"), sec("sLang"), sec("sGithub"), sec("tqBox"), sec("sNotify"), sec("sSound"), sec("nEnabled"), sec("mailBox"), sec("remoteBox"), sec("btnResetTabs"), sec("btnRestart"), sec("btnQuit")]; })()`),
  ["setGeneral", "setGeneral", "setGeneral", "setGeneral", "setNotify", "setNotify", "setNight", "setMail", "setPhone", "setAdvanced", "setAdvanced", "setAdvanced"]);

// ---- (b) Hesaplar: Claude hesap kartları ve diğer bağlantılar ----
await until(`document.querySelectorAll("#setClaude .set-card").length === 2`);
const cards = await ev(`[...document.querySelectorAll("#setClaude .set-card")].map(c => ({ id: c.dataset.acct, name: c.querySelector(".set-name").textContent, who: c.querySelector(".set-who").textContent,
  state: c.querySelector(".set-state").textContent, cls: c.querySelector(".set-state").className.replace("set-state ", ""), meter: Math.round(parseFloat(c.querySelector(".set-meter i").style.width)),
  meta: [...c.querySelectorAll(".set-meta span")].map(s => s.textContent.replace(/: .*$/, "")), five: c.querySelectorAll(".set-meta span")[1].textContent,
  uses: c.querySelector(".set-uses").textContent, projects: [...c.querySelectorAll(".set-proj li")].map(l => l.textContent.split("\\\\").pop()) }))`);
check("kişisel hesap kartı: ad, klasör, haftalık %1 kırmızı, çubuk %99, 5 saat, varsayılan", cards[0],
  { id: "claude", name: "Kişisel", who: "Varsayılan hesap · claude", state: "Haftalık %1 kaldı", cls: "crit", meter: 99, meta: ["Haftalık sıfırlanma", "5 saat"], five: "5 saat: %88 kaldı",
    uses: "Varsayılan: başka hesaba kayıtlı olmayan tüm projeler", projects: [] });
check("şirket hesap kartı: ad, haftalık %92 yeşil, çubuk %8, kayıtlı proje (diskteki yazımıyla)", cards[1],
  { id: "claude-is", name: "Örnek Şirket A.Ş.", who: "claude-is", state: "Haftalık %92 kaldı", cls: "ok", meter: 8, meta: ["Haftalık sıfırlanma", "5 saat"], five: "5 saat: %24 kaldı",
    uses: "Varsayılan: Muhasebe Projesi", projects: ["Muhasebe Projesi"] });
check("sıfırlanma tarihi yazıyor", await ev(`/Haftalık sıfırlanma: \\d{2} \\S+ \\d{2}:\\d{2}/.test(document.querySelector("#setClaude .set-meta span").textContent)`), true);
check("hesap ekle kartı yalnız yönlendirme notu (düğme yok)", await ev(`(() => { const a = document.querySelector("#setClaude .set-add");
  return [a.querySelector("b").textContent, a.textContent.includes("CLAUDE_CONFIG_DIR"), a.querySelectorAll("button, input").length]; })()`), ["+ Claude hesabı ekle", true, 0]);
check("menüde Hesaplar noktası (haftalık kotası azalan hesap)", await ev(`[document.getElementById("setDotAccounts").hidden, document.getElementById("setDotAccounts").title]`), [false, "Haftalık kotası azalan hesap: Kişisel"]);
const conn = (id) => ev(`(() => { const c = document.querySelector('#setConns [data-conn="${id}"]'); if (!c) return null;
  return { state: c.querySelector(".set-state").textContent, who: c.querySelector(".set-who").textContent, btns: [...c.querySelectorAll("button")].map(b => b.textContent), msg: c.querySelector(".set-msg")?.textContent || "" }; })()`);
check("Google kartı: bağlı değil, yalnız kişisel, Mail ve takvime götürür", await conn("google"),
  { state: "Bağlı değil", who: "Yalnız kişisel Google hesabı", btns: ["Mail ve takvime git"], msg: "" });
check("Higgsfield ve Slack kartı yok", await ev(`/higgsfield|slack/i.test(document.getElementById("setConns").textContent)`), false);
await until(`fetch("/api/github").then(r => r.json()).then(d => d.state === "ok")`, 9000);
await ev(`document.getElementById("btnSettings").click()`); await sleep(900);
check("GitHub kartı: sahte gh hesabıyla bağlı", await conn("github"), { state: "Bağlı", who: "gh CLI · testkul", btns: ["Dene"], msg: "" });
await ev(`document.querySelector('#setConns [data-act="gh-try"]').click()`);
await until(`document.querySelector('#setConns [data-conn="github"] .set-msg').textContent.startsWith("✓")`, 8000);
check("GitHub Dene: sonuç kartta yazar", (await conn("github")).msg, "✓ Bağlantı çalışıyor: testkul");
await ev(`document.querySelector('#setConns [data-conn="google"] button').click()`); await sleep(200); await settle();
check("Google kartındaki düğme Mail ve takvim bölümüne götürür", await ev(`document.querySelector("#setNav button.active")?.dataset.sec`), "setMail");
await ev(`document.getElementById("sGithub").click()`); await sleep(1800);
check("GitHub takibi kapatılınca kart 'Kapalı' ve Genel'e yönlendirir", await conn("github"), { state: "Kapalı", who: "gh CLI", btns: ["Genel'e git"], msg: "" });
await ev(`document.getElementById("sGithub").click()`); await sleep(1500);
for (const need of ["setAccounts"]) check(`bölüm var: ${need}`, navShown.includes(need), true);

// ---- (c) Anahtar bağlama: Bağlan → gizli kutu → Dene ve kaydet (sahte deneme sunucusu) ----
const key = (id) => ev(`(() => { const c = document.querySelector('#setConns [data-key="${id}"]'); if (!c) return null;
  const vis = (e) => !!e && !e.closest("[hidden]") && getComputedStyle(e).display !== "none";
  return { state: c.querySelector(".set-state").textContent, uses: c.querySelector(".set-uses").textContent,
    btns: [...c.querySelectorAll("button")].filter(vis).map(b => b.textContent), box: vis(c.querySelector(".set-keybox")),
    msg: c.querySelector(".set-msg").textContent, kind: c.querySelector(".set-msg").dataset.kind || "" }; })()`);
const keyBtn = (id, label) => ev(`[...document.querySelectorAll('#setConns [data-key="${id}"] button')].find(b => b.textContent === ${JSON.stringify(label)} && b.offsetWidth)?.click()`);
const keyType = (id, v) => ev(`document.querySelector('#setConns [data-key="${id}"] .set-keyinput').value = ${JSON.stringify(v)}`);
check("üç anahtar kartı sırayla (Google ve GitHub'dan sonra)", await ev(`[...document.querySelectorAll("#setConns .set-card")].map(c => c.dataset.conn || c.dataset.key)`),
  ["google", "github", "elevenlabs", "openrouter", "gemini"]);
check("OpenRouter: bağlı değil, Bağlan düğmesi, gizli kutu kapalı", await key("openrouter"),
  { state: "Bağlı değil", uses: "Anahtar sayfasını açar, yapıştırırsınız, panel bir deneme isteğiyle doğrular.", btns: ["Bağlan"], box: false, msg: "", kind: "" });
check("Chrome profil seçimi: varsayılan + iki uydurma profil", await ev(`[!document.getElementById("setProfileRow").hidden, [...document.querySelectorAll("#setKeyProfile option")].map(o => o.textContent), document.getElementById("setKeyProfile").value]`),
  [true, ["Varsayılan tarayıcı", "İş (is@ornek.com.tr)", "Kişisel (kisi@ornek.com)"], ""]);
await ev(`(() => { const s = document.getElementById("setKeyProfile"); s.value = "Profile 1"; s.dispatchEvent(new Event("change")); })()`); await sleep(500);
check("profil seçimi kalıcı (sunucuda)", await ev(`fetch("/api/hub").then(r => r.json()).then(d => d.chrome.selected)`), "Profile 1");
await keyBtn("openrouter", "Bağlan"); await sleep(600);
check("Bağlan: gizli kutu açık, sayfa açıldı notu, kutu parola türünde ve odakta", [await key("openrouter"), await ev(`(() => { const i = document.querySelector('[data-key="openrouter"] .set-keyinput'); return [i.type, document.activeElement === i]; })()`)],
  [{ state: "Bağlı değil", uses: "Anahtar sayfasını açar, yapıştırırsınız, panel bir deneme isteğiyle doğrular.", btns: ["Sayfayı yeniden aç", "Dene ve kaydet", "Vazgeç"], box: true,
    msg: "Anahtar sayfası tarayıcıda açıldı. Anahtarı oluşturup aşağıya yapıştırın.", kind: "" }, ["password", true]]);
check("gizli kutu ekranda görünür", await seen('#setConns [data-key="openrouter"] .set-keyinput'), "görünür");
await keyBtn("openrouter", "Dene ve kaydet"); await sleep(300);
check("boş kutu: önce yapıştırın", (await key("openrouter")).msg, "Önce anahtarı yapıştırın.");
await keyType("openrouter", "sahte-kotu-anahtar-9991"); await keyBtn("openrouter", "Dene ve kaydet");
await until(`document.querySelector('[data-key="openrouter"] .set-msg').dataset.kind === "warn"`);
check("yanlış anahtar: nedeni yazar, kutu açık kalır", await key("openrouter"), { state: "Bağlı değil", uses: "Anahtar sayfasını açar, yapıştırırsınız, panel bir deneme isteğiyle doğrular.",
  btns: ["Sayfayı yeniden aç", "Dene ve kaydet", "Vazgeç"], box: true, msg: "Anahtar yanlış ya da geçersiz. Kopyalarken eksik kalmış olabilir.", kind: "warn" });
await keyType("openrouter", "sahte-bos-anahtar-9996"); await keyBtn("openrouter", "Dene ve kaydet");
await until(`document.querySelector('[data-key="openrouter"] .set-msg').textContent.includes("bakiye")`);
check("bakiye yok: ayrı neden", (await key("openrouter")).msg, "Anahtar çalışıyor ama bakiye ya da kota kalmamış.");
await keyType("openrouter", "sahte-iyi-openrouter-0002-ASDF"); await keyBtn("openrouter", "Dene ve kaydet");
await until(`document.querySelector('[data-key="openrouter"] .set-msg').dataset.kind === "ok"`);
const orOk = await key("openrouter");
check("geçerli anahtar: bağlı, kalan limit, son 4, kutu kapandı", [orOk.state, /^Anahtarın sınırından kalan: 7,5 \$ · son 4: …ASDF · denendi /.test(orOk.uses), orOk.btns, orOk.box, orOk.msg],
  ["Anahtar geçerli", true, ["Anahtarı değiştir", "Yeniden dene", "Kaldır"], false, "✓ Anahtar çalışıyor · şifreli kaydedildi"]);
check("anahtar sayfada yok (kutu boşaltıldı, DOM'da metin yok)", await ev(`[document.querySelector('[data-key="openrouter"] .set-keyinput').value, document.documentElement.outerHTML.includes("sahte-iyi-openrouter")]`), ["", false]);
await keyBtn("elevenlabs", "Bağlan"); await sleep(400);
await keyType("elevenlabs", "sahte-iyi-elevenlabs-0001-QWER");
await ev(`document.querySelector('[data-key="elevenlabs"] .set-keyinput').dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
await until(`document.querySelector('[data-key="elevenlabs"] .set-msg').dataset.kind === "ok"`);
check("ElevenLabs Enter ile kaydedildi: paket, kalan karakter, çubuk kullanılanı gösterir", await ev(`(() => { const c = document.querySelector('[data-key="elevenlabs"]');
  return [c.querySelector(".set-who").textContent, c.querySelector(".set-uses").textContent.split(" · ")[0], Math.round(parseFloat(c.querySelector(".set-meter i").style.width)), c.querySelector(".set-meter").hidden]; })()`),
  ["Seslendirme (eğitim ve tanıtım videoları) · creator", "Bu ay 186.000 / 300.000 karakter kaldı", 38, false]);
await keyBtn("openrouter", "Kaldır"); await until(`document.querySelector("#dlgAsk[open]")`);
check("Kaldır: panelin kendi onay penceresi", await ev(`document.getElementById("askTitle").textContent`), "OpenRouter anahtarı kaldırılsın mı?");
await ev(`document.querySelector('#askButtons button[value="yes"]').click()`);
await until(`document.querySelector('[data-key="openrouter"] .set-state').textContent === "Bağlı değil"`);
check("kaldırıldı: bağlı değil, Bağlan düğmesi geri geldi", [(await key("openrouter")).btns, (await key("openrouter")).msg], [["Bağlan"], "Anahtar kaldırıldı."]);
check("anahtar akış anlatımı görünür", await seen("#setAccounts .key-flow"), "görünür");

// ---- (d) Yapay zekâ işçileri ve iş yönlendirme ----
const worker = (id) => ev(`(() => { const c = document.querySelector('#wkCards [data-worker="${id}"]'); if (!c) return null;
  return { who: c.querySelector(".set-who").textContent, on: c.querySelector(".wk-switch").getAttribute("aria-checked"), role: c.querySelector(".wk-switch").getAttribute("role") }; })()`);
await until(`document.querySelector('#wkCards [data-worker="gemini"] .set-who')?.textContent.includes("0.1.7")`, 8000);
check("Codex kartı: plan, CLI sürümü, açık", await worker("codex"), { who: "go · codex CLI 0.171.0", on: "true", role: "switch" });
check("Gemini kartı: CLI sürümü (sahte betik), kapalı", await worker("gemini"), { who: "gemini CLI 0.1.7", on: "false", role: "switch" });
const route = (job) => ev(`(() => { const c = document.querySelector('#rtList [data-job="${job}"]'); if (!c) return null;
  return { now: c.querySelector(".rt-now").textContent, chips: [...c.querySelectorAll(".rt-chip")].map(x => (x.querySelector(".rt-label")?.textContent || x.textContent) + (x.querySelector(".rt-st") ? " [" + x.querySelector(".rt-st").textContent + "]" : "") + (x.classList.contains("use") ? " *" : "")) }; })()`);
check("iş türleri taslaktaki sırada", await ev(`[...document.querySelectorAll("#rtList .rt-card")].map(c => c.querySelector(".rt-name").textContent)`),
  ["Görsel üretme", "Video", "Uzun belge, kayıt özeti", "Çeviri, toplu metin işleme", "Kod incelemesi (ikinci göz)"]);
check("görsel: hepsi kapalı/bağlı değil → Claude'un kendi yolu", await route("image"), { now: "Şu an: Claude'un kendi yolu",
  chips: ["Gemini (Nano Banana) [kapalı · kişisel]", "OpenRouter [bağlı değil]", "Higgsfield [bağlı değil · kişisel]", "Claude: SVG / HTML çizim *"] });
check("özet: Codex açık → Şu an Codex", await route("summary"), { now: "Şu an: Codex", chips: ["Gemini CLI [kapalı · kişisel]", "Codex [açık] *", "Claude okur (bağlam ve kota harcar)"] });
check("inceleme: Codex salt okuma, sıra düğmesi yok (tek araç)", [await route("review"), await ev(`!!document.querySelector('#rtList [data-job="review"] [data-rt-edit]')`)],
  [{ now: "Şu an: Codex", chips: ["Codex [açık · salt okuma] *", "Claude inceleme alt ajanı"] }, false]);
await ev(`document.querySelector('#wkCards [data-wk="gemini"]').click()`);
await until(`document.querySelector('#rtList [data-job="image"] .rt-now').textContent.includes("Gemini")`);
check("Gemini açılınca: kart açık, görsel ve özet Gemini'ye geçer", [(await worker("gemini")).on, (await route("image")).now, (await route("summary")).now],
  ["true", "Şu an: Gemini (Nano Banana)", "Şu an: Gemini CLI"]);
check("işçi ayarı sunucuda", await ev(`fetch("/api/workers").then(r => r.json()).then(d => [d.codex.enabled, d.gemini.enabled])`), [true, true]);
await ev(`document.querySelector('#rtList [data-job="summary"] [data-rt-edit]').click()`); await sleep(200);
check("Sırayı değiştir: çipler alt alta, yukarı/aşağı düğmeleri, ilkinde yukarı kapalı", await ev(`(() => { const c = document.querySelector('#rtList [data-job="summary"]');
  return [getComputedStyle(c.querySelector(".rt-chain")).flexDirection, [...c.querySelectorAll("[data-rt-move]")].map(b => b.textContent + (b.disabled ? "-" : "+")), c.querySelector("[data-rt-edit]").textContent]; })()`),
  ["column", ["↑-", "↓+", "↑+", "↓-"], "Bitti"]);
check("sıra düğmesi parmakla basılacak boyda (≥ 36 px)", await ev(`Math.min(...[...document.querySelectorAll('#rtList [data-rt-move]')].map(b => b.getBoundingClientRect().height)) >= 36`), true);
await ev(`document.querySelector('#rtList [data-job="summary"] [data-rt-move="1"][data-i="0"]').click()`);
await until(`document.querySelector('#rtList [data-job="summary"] .rt-now').textContent === "Şu an: Codex"`);
check("Gemini aşağı: Codex öne geçti ve seçildi, düzenleme açık kalır", [(await route("summary")).chips.map(c => c.split(" [")[0]), await ev(`!!document.querySelector('#rtList [data-job="summary"] .rt-editing')`)],
  [["Codex", "Gemini CLI", "Claude okur (bağlam ve kota harcar)"], true]);
check("sıra sunucuda kalıcı", await ev(`fetch("/api/routing").then(r => r.json()).then(d => d.jobs.find(j => j.id === "summary").chain.map(c => c.tool))`), ["codex", "gemini"]);
await ev(`document.querySelector('#rtList [data-job="summary"] [data-rt-edit]').click()`); await sleep(200);
check("Bitti: zincir yeniden yatay", await ev(`getComputedStyle(document.querySelector('#rtList [data-job="summary"] .rt-chain')).flexDirection`), "row");
check("şirket işi notu ve üstü çizili örnek", await ev(`(() => { const s = document.querySelector("#setRouting .rt-example .rt-chip.skip .rt-label");
  return [document.querySelector("#setRouting .rt-company .set-tag").textContent, getComputedStyle(s).textDecorationLine]; })()`), ["Şirket işi", "line-through"]);

const CARDS = ["#setAbout .about-card .set-name", "#abVer", "#abData", "#abOpenData", "#abNew li", "#setAbout .about-links a", "#setClaude .set-card[data-acct='claude'] .set-state", "#setClaude .set-card[data-acct='claude-is'] .set-proj summary", "#setClaude .set-add b",
  "#setConns [data-conn='google'] button", "#setConns [data-conn='github'] button", "#setConns [data-key='elevenlabs'] .set-state", "#setConns [data-key='gemini'] button", "#setKeyProfile",
  "#wkCards [data-wk='codex']", "#wkCards [data-wk='gemini']", "#rtList [data-job='image'] [data-rt-edit]", "#rtList [data-job='review'] .rt-now b", "#setRouting .rt-example .rt-chip.skip", "#setGoogle .gg-table tbody tr:nth-child(6) td:last-child"];

// ---- (e) Google ile neler yapılır: statik tablo, ücret/sınır rakamı yok ----
check("Google tablosu: altı iş, araçlar, rakam yok, kişisel notu", await ev(`(() => { const tb = document.querySelector("#setGoogle .gg-table");
  return [[...tb.querySelectorAll("tbody tr")].map(r => r.cells[1].textContent), /\\d/.test(tb.textContent), document.querySelector("#setGoogle .gg-foot .set-tag").textContent]; })()`),
  [["Gemini (Nano Banana), Imagen", "Veo", "Gemini CLI / API", "Gemini Flash", "Gemini TTS", "Doğrudan Google API"], false, "Kişisel"]);
// ---- (f) Hakkında: sürüm ve derleme, sistem, veri klasörü, bu sürümün yenilikleri (gömülü CHANGELOG), bağlantılar ----
await until(`document.getElementById("abVer").textContent !== ""`);
const ab = await ev(`(() => ({ ver: document.getElementById("abVer").textContent, footer: document.getElementById("ver").textContent,
    os: document.getElementById("abOs").textContent, rt: document.getElementById("abRuntime").textContent, data: document.getElementById("abData").textContent,
    news: [...document.querySelectorAll("#abNew li")].map(l => l.textContent), newsShown: !document.getElementById("abNewWrap").hidden,
    feats: document.querySelectorAll("#setAbout .about-list:not(#abNew) li").length,
    links: [...document.querySelectorAll("#setAbout a")].map(a => [a.textContent, a.target, a.href.replace("https://github.com/ahmetunaluzun/claude-oturum-paneli", "R")]) }))()`);
check("Hakkında: sürüm alt bilgiyle aynı", ab.ver.split(" · ")[0], ab.footer);
check("Hakkında: sistem, .NET ve veri klasörü dolu", [ab.os.length > 3, /^\.NET /.test(ab.rt), /data$/i.test(ab.data)], [true, true, true]);
check("Hakkında: bu sürümün yenilikleri CHANGELOG'dan", [ab.newsShown, ab.news.length >= 1, ab.news.every(n => n.length > 3 && !n.includes("**"))], [true, true, true]);
check("Hakkında: 8 özellik satırı dolu", ab.feats, 8);
check("Hakkında: bağlantılar yeni pencerede, depoya", ab.links, [["MIT", "_blank", "R/blob/main/LICENSE"], ["Kaynak kod", "_blank", "R"], ["Sürümler", "_blank", "R/releases"], ["Değişiklik günlüğü", "_blank", "R/blob/main/CHANGELOG.md"]]);
await ev(`(() => { const s = JSON.parse(localStorage.getItem("panel.settings")||"{}"); document.getElementById("sLang").value = "en"; document.getElementById("sLang").dispatchEvent(new Event("change")); })()`); await sleep(300);
check("Hakkında: İngilizce", await ev(`[document.querySelector('#setNav button[data-sec="setAbout"]').textContent, document.querySelector("#setAbout .about-card .set-name").textContent, document.querySelector("#setAbout .about-links a").textContent]`), ["About", "Claude Session Panel", "Source code"]);
await ev(`document.getElementById("sLang").value = "tr"; document.getElementById("sLang").dispatchEvent(new Event("change"))`); await sleep(300);

const cardLayout = () => ev(`(() => { const clipped = [...document.querySelectorAll("#setAccounts .set-state, #setAccounts .btn, #setAccounts .set-name, #setWorkers .btn, #setWorkers .set-name, #setRouting .btn, #setRouting .rt-chip, #setRouting .rt-name, #setAbout .btn, #setAbout .set-name")].filter(e => e.offsetWidth && e.scrollWidth > e.clientWidth + 1).map(e => e.textContent);
  const out = [...document.querySelectorAll("#setAccounts .set-card *, #setWorkers .set-card *, #setRouting .rt-card *, #setAbout .about-card *")].filter(e => { if (!e.offsetWidth) return false; const c = e.closest(".set-card, .rt-card").getBoundingClientRect(), b = e.getBoundingClientRect(); return b.right > c.right + 1 || b.left < c.left - 1; }).length;
  return { clipped, out }; })()`);

for (const [light, tn] of [[false, "koyu"], [true, "acik"]]) {
  if (light) { await theme(true); await openSettings(); }
  for (const [w, h, mob, n] of [[1280, 900, false, "genis"], [500, 900, true, "telefon"]]) {
    await size(w, h, mob);
    await scrollTop(0);
    const bad = [];
    for (const sel of LEGACY) { const r = await seen(sel); if (r !== "görünür") bad.push(`${sel}: ${r}`); }
    check(`${tn} ${n}: eski ayarların hepsi ekranda görünür (${LEGACY.length})`, bad, []);
    const hid = [];
    for (const sel of CARDS) { const r = await seen(sel); if (r !== "görünür") hid.push(`${sel}: ${r}`); }
    check(`${tn} ${n}: hesap ve bağlantı kartları ekranda görünür`, hid, []);
    check(`${tn} ${n}: kartlarda kesik metin ve taşan öğe yok`, await cardLayout(), { clipped: [], out: 0 });
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
      // Hesaplar bölümünün sonunu geçecek kadar (bölüm boyu içeriğe göre değişir)
      await scrollTop(await ev(`Math.round(document.getElementById("setNotify").getBoundingClientRect().top + ${SC}.scrollTop - 200)`));
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
