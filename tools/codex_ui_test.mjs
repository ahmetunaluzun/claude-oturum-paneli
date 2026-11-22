// Codex oturumları arayüz testi (ortamı tools/codex_ui_test.sh kurar). Önce Codex yok → hiçbir Codex öğesi; sonra sahte ağaç
// (tools/codex_ortam.py kur): Codex şeridi (çalışan + açık; biten yok), rozet, düğmeler, sayaçlar Claude'u sayar, Klasörü aç
// (klasör yok → uyarı, pencere açılmaz), okuma görünümü (ortam metni/developer yok, yazma kapalı, devam komutu panoya),
// Son oturumlar'da Codex satırları + arama, kota (Go 30 gün, Plus 5 saat + hafta, yenilenmiş), İngilizce, 1280 koyu/açık +
// 390 telefon görüntüleri. Tarayıcı confirm/alert/prompt YOK; pano taklit edilir.
// Kullanım: node codex_ui_test.mjs <debugPort> <url> <çıktıÖneki> <codexKökü>
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [port, url, out, home] = process.argv.slice(2);
const BITTI = "019a2b3c-0000-7000-8000-0000000b1771";
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
const ortam = (...a) => execFileSync("py", ["-3.13", "-I", "tools/codex_ortam.py", home, ...a]);

const INJECT = (lang, light) => `(() => {
  localStorage.setItem("panel.settings", JSON.stringify({ lang: "${lang}", light: ${light}, notify: false, sound: false }));
  window.__n = { confirm: 0, alert: 0, prompt: 0 };
  for (const k of ["confirm", "alert", "prompt"]) window[k] = () => { window.__n[k]++; return k === "confirm" ? false : null; };
  window.addEventListener("error", e => (window.__errors ||= []).push(String(e.message)));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (x) => { window.__clip = x; } } });
  // Claude kota halkaları da görünsün (üst çubukta Codex göstergesiyle birlikte sığıyor mu): /api/state'e kullanım eklenir.
  const real = window.fetch.bind(window);
  window.fetch = async (u, init = {}) => {
    const r = await real(u, init);
    if (String(u) !== "/api/state") return r;
    const d = await r.json(), h = 3600_000;
    d.usage = { five_hour: { used: 42, resetsAt: new Date(Date.now() + 2 * h).toISOString() },
      seven_day: { used: 18, resetsAt: new Date(Date.now() + 80 * h).toISOString() } };
    return new Response(JSON.stringify(d), { status: r.status, headers: { "Content-Type": "application/json" } });
  };
})();`;

await send("Page.enable");
let injected = null;
async function load(lang, light, w = 1280, h = 860) {
  if (injected) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected });
  injected = (await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT(lang, light) })).result.identifier;
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
  await send("Page.navigate", { url });
  await sleep(500);
  await until(`document.querySelectorAll(".card:not(.codex-card)").length === 1`);
}
const shot = async (name) => {
  await sleep(450); // giriş animasyonları bitsin
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${out}_${name}.png`, Buffer.from(r.result.data, "base64"));
};
const visible = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || e.closest("[hidden]")) return false;
  const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`;
const cards = () => ev(`[...document.querySelectorAll(".codex-card")].map(c => ({ name: c.querySelector(".name").textContent,
  lane: c.dataset.lane, badge: c.querySelector(".codex-badge").textContent, state: c.querySelector(".codex-state").textContent,
  ask: c.querySelector(".codex-ask").hidden ? null : c.querySelector(".codex-ask").textContent,
  last: c.querySelector(".last").hidden ? null : c.querySelector(".last").textContent,
  actions: [...c.querySelectorAll(".card-actions > *")].map(b => b.textContent) }))`);
const msgs = () => ev(`[...document.querySelectorAll("#dMessages .msg")].map(m => m.className.split(" ")[1] + ":" +
  [...m.childNodes].filter(n => !n.classList?.contains("msg-time")).map(n => n.textContent).join("").trim())`);
const drawerActions = () => ev(`[...document.querySelectorAll("#dActions button")].map(b => b.textContent)`);
const quota = () => ev(`(() => { const q = document.querySelector("#codexQuota"); if (!q || q.hidden) return null;
  const g = (s) => { const e = q.querySelector(s); return e && getComputedStyle(e).display !== "none" ? e.textContent : null; };
  return { left: g("b"), name: g(".codex-q-name"), reset: g(".codex-q-reset")?.split(":")[0] ?? null, sec: g(".codex-q-sec"),
    level: q.querySelector(".ring").className.replace("ring codex-ring ", "") }; })()`);
const setView = (v) => ev(`document.querySelector('#nav button[data-view="${v}"]').click()`);

// ---- 1. Codex yok: hiçbir öğe ----
await load("tr", false);
await sleep(5600); // en az bir Codex yoklaması
const summary0 = await ev(`document.querySelector("#summary").textContent`);
check("Codex yok: şerit gizli", await ev(visible("#codexLane")), false);
check("Codex yok: kota gizli", await ev(visible("#codexQuota")), false);
check("Codex yok: sayfada 'Codex' yazısı yok", await ev(`document.body.innerText.includes("Codex")`), false);
await setView("recent"); await sleep(600);
check("Codex yok: Son oturumlar'da Codex yok", await ev(`document.querySelectorAll(".codex-recent").length`), 0);
await setView("sessions");

// ---- 2. Sahte ağaç: çalışan + açık + biten ----
ortam("kur");
check("Codex kartları geldi", await until(`document.querySelectorAll(".codex-card").length === 2`), true);
check("kartlar: çalışan önce, açık sonra; biten yok", await cards(), [
  { name: "Codex Calisan (yok)", lane: "busy", badge: "Codex", state: "çalışıyor", ask: "Ödeme ekranındaki çift tıklama hatasını düzelt",
    last: null, actions: ["Konuşma", "Klasörü aç", "Oturum açık · devam komutu kapanınca"] },
  { name: "Codex Acik", lane: "idle", badge: "Codex", state: "açık", ask: "README'yi güncelle",
    last: "README güncellendi; kurulum adımlarına Windows notu eklendi.", actions: ["Konuşma", "Klasörü aç", "Oturum açık · devam komutu kapanınca"] }]);
check("Codex şeridi sayısı", await ev(`document.querySelector("#countCodex").textContent`), "2");
check("üst özet ve sekme sayısı yalnız Claude", await ev(`[document.querySelector("#summary").textContent, document.querySelector("#navCount").textContent]`), [summary0, "1"]);
check("model rozeti", await ev(`document.querySelector(".codex-card .model .long")?.textContent`), "gpt-6-luna");
check("kota: Go 30 gün", await quota(), { left: "%97 kaldı", name: "Codex Go · 30 gün", reset: "Yenilenme", sec: null, level: "ok" });
check("kart son yazma zamanı", await ev(`/^son yazma \\d+ (sn|dk) önce$/.test(document.querySelector(".codex-card .codex-age").textContent)`), true);
await shot("1280_koyu");

// Klasörü aç: çalışan oturumun klasörü yok → uyarı, pencere açılmaz
await ev(`[...document.querySelectorAll(".codex-card")][0].querySelector(".card-actions button:nth-child(2)").click()`);
check("klasör yok uyarısı", await until(`[...document.querySelectorAll(".toast")].some(x => x.textContent === "Klasör bu bilgisayarda bulunamadı")`, 4000), true);

// Okuma görünümü: çalışan oturum
await ev(`document.querySelector(".codex-card").click()`);
await until(`document.querySelectorAll("#dMessages .msg").length > 0`);
check("çalışan: mesajlar (ortam metni yok)", await msgs(), ["user:Ödeme ekranındaki çift tıklama hatasını düzelt", "assistant:Düğmeyi işlem sürerken kilitliyorum."]);
check("çalışan: devam komutu yok", await drawerActions(), ["Klasörü aç"]);
check("çalışan: yazma kapalı + not", await ev(`[document.querySelector("#dInput").disabled, document.querySelector("#dSend").disabled, document.querySelector("#dNote").textContent]`),
  [true, true, "Codex oturumu terminalde açık; burada yalnız okunur."]);
check("çekmece Codex rozeti + başlık", await ev(`[document.querySelector("#dModel .codex-badge")?.textContent, document.querySelector("#dTitle").textContent]`),
  ["Codex", "Ödeme ekranındaki çift tıklama hatasını düzelt"]);
await ev(`document.querySelector("#dClose").click()`); await sleep(300);

// ---- 3. Son oturumlar ----
await setView("recent");
await until(`document.querySelectorAll(".codex-recent").length === 3`);
check("Son oturumlar: 3 Codex satırı, en yeni önce", await ev(`[...document.querySelectorAll(".codex-recent")].map(r =>
  [r.querySelector("b").textContent, r.querySelector(".codex-badge").textContent, r.querySelector("em")?.textContent ?? null])`), [
  ["Ödeme ekranındaki çift tıklama hatasını düzelt", "Codex", "çalışıyor"], ["README'yi güncelle", "Codex", "açık"],
  ["Testleri çalıştır ve sonucu özetle", "Codex", null]]);
check("Codex satırında seçim kutusu yok", await ev(`[...document.querySelectorAll(".codex-recent")].every(r => !r.querySelector("input") && getComputedStyle(r.querySelector(".codex-nopick")).visibility === "hidden")`), true);
await ev(`(() => { const s = document.querySelector("#search"); s.value = "readme"; s.dispatchEvent(new Event("input")); })()`);
check("arama Codex satırını süzer", await ev(`[...document.querySelectorAll(".codex-recent b")].map(b => b.textContent)`), ["README'yi güncelle"]);
await ev(`(() => { const s = document.querySelector("#search"); s.value = ""; s.dispatchEvent(new Event("input")); })()`);
await ev(`[...document.querySelectorAll(".codex-recent .recent-row")][2].click()`);
await until(`document.querySelectorAll("#dMessages .msg").length === 4`);
check("biten: kullanıcı/asistan mesajları (developer, ortam, araç yok)", await msgs(), [
  "user:Testleri çalıştır ve sonucu özetle", "assistant:Tüm testler geçti (42/42).", "user:Teşekkürler, İyi çalışmalar", "assistant:Rica ederim."]);
check("biten: Klasörü aç + Devam komutunu kopyala", await drawerActions(), ["Klasörü aç", "Devam komutunu kopyala"]);
await ev(`[...document.querySelectorAll("#dActions button")].find(b => b.textContent === "Devam komutunu kopyala").click()`);
await sleep(300);
check("panoya codex resume <id>", await ev(`window.__clip`), `codex resume ${BITTI}`);
check("biten: not", await ev(`document.querySelector("#dNote").textContent`), "Codex oturumu; burada yalnız okunur. Sürdürmek için devam komutunu terminalde çalıştırın.");
await shot("okuma");
await ev(`document.querySelector("#dClose").click()`); await sleep(300);
await setView("sessions");

// ---- 4. Açık tema + kota: Plus 5 saat + hafta ----
await load("tr", true);
await until(`document.querySelectorAll(".codex-card").length === 2`);
ortam("kota", "plus");
check("kota: Plus 5 saat + hafta", await until(`document.querySelector("#codexQuota b")?.textContent === "%60 kaldı"`), true);
check("kota ayrıntısı (Plus)", await quota(), { left: "%60 kaldı", name: "Codex Plus · 5 saat", reset: "Yenilenme", sec: "Hafta: %25 kaldı", level: "ok" });
await shot("1280_acik");

// ---- 5. Telefon 390 ----
await load("tr", false, 390, 844);
await until(`document.querySelectorAll(".codex-card").length === 2`);
await until(`!document.querySelector("#codexQuota").hidden`);
check("390: yatay taşma yok", await ev(`document.documentElement.scrollWidth <= 390`), true);
check("390: kota ekranda ve görünür", await ev(`(() => { const r = document.querySelector("#codexQuota .ring").getBoundingClientRect();
  const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.left >= 0 && r.right <= 390 && !!e?.closest("#codexQuota"); })()`), true);
check("390: yalnız yüzde + ad", await quota(), { left: "%60 kaldı", name: "Codex Plus · 5 saat", reset: null, sec: null, level: "ok" });
check("390: kartlar ekran içinde", await ev(`[...document.querySelectorAll(".codex-card")].every(c => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= 390; })`), true);
await ev(`document.querySelector("#codexLane").scrollIntoView()`);
await shot("390");
await setView("recent");
await until(`document.querySelectorAll(".codex-recent").length === 3`);
check("390 Son oturumlar: taşma yok", await ev(`document.documentElement.scrollWidth <= 390 && [...document.querySelectorAll(".codex-recent")].every(r => r.getBoundingClientRect().right <= 390)`), true);
await shot("390_son");

// ---- 6. Kota yenilenmiş: bayat yüzde gösterilmez ----
ortam("kota", "reset");
check("kota yenilendi", await until(`document.querySelector("#codexQuota b")?.textContent === "yenilendi"`), true);
check("yenilenmiş kota ayrıntısı", await quota(), { left: "yenilendi", name: "Codex Go · 30 gün", reset: null, sec: null, level: "codex-reset" });
await setView("sessions");
await shot("390_kota_yenilendi");

// ---- 7. İngilizce ----
ortam("kota", "go");
await load("en", false);
await until(`document.querySelectorAll(".codex-card").length === 2`);
await until(`document.querySelector("#codexQuota b")?.textContent === "97% left"`);
check("EN: şerit başlığı", await ev(`[document.querySelector("#codexLane h2 [data-i18n]").textContent, document.querySelector("#codexLane .hint").textContent]`),
  ["Codex", "Codex CLI sessions · watch only, the panel doesn't send messages"]);
check("EN: kart", await ev(`[...document.querySelector(".codex-card").querySelectorAll(".codex-state, .card-actions > *")].map(e => e.textContent)`),
  ["working", "Conversation", "Open folder", "Session open · resume command once it's closed"]);
check("EN: son yazma", await ev(`/^last write \\d+ (s|min) ago$/.test(document.querySelector(".codex-card .codex-age").textContent)`), true);
check("EN: kota", await quota(), { left: "97% left", name: "Codex Go · 30 days", reset: "Resets", sec: null, level: "ok" });
await setView("recent");
await until(`document.querySelectorAll(".codex-recent").length === 3`);
await ev(`[...document.querySelectorAll(".codex-recent .recent-row")][2].click()`);
await until(`document.querySelectorAll("#dMessages .msg").length === 4`);
check("EN: okuma eylemleri + not", await ev(`[...[...document.querySelectorAll("#dActions button")].map(b => b.textContent), document.querySelector("#dNote").textContent]`),
  ["Open folder", "Copy resume command", "Codex session; read-only here. To continue, run the resume command in a terminal."]);
await ev(`document.querySelector("#dClose").click()`);

check("tarayıcı penceresi açılmadı (confirm/alert/prompt)", await ev(`window.__n`), { confirm: 0, alert: 0, prompt: 0 });
check("sayfa hatası yok", await ev(`window.__errors || []`), []);
console.log(`Codex arayüz: ${pass} geçti, ${fail} kaldı`);
ws.close();
process.exit(fail ? 1 : 0);
