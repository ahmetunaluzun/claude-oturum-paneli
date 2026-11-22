// Proje maliyeti + açılış yükü arayüz testi (ortamı tools/maliyet_ui_test.sh kurar; sahte ağaç tools/maliyet_ortam.py).
// Oturumlar: açık oturumun projesi (Alfa) özet satırı, döküm, dönem seçimi kalıcı, katlama kalıcı. Son oturumlar: tüm projeler.
// Skill kütüphanesi: açılış yükü özeti, dağılım, fark satırı, /context atfı, proje seçimi, aramada gizlenir. İngilizce.
// 1280 koyu + 390 telefon görüntüleri; telefonda yatay taşma yok. Tarayıcı confirm/alert/prompt YOK.
// Kullanım: node maliyet_ui_test.mjs <debugPort> <url> <çıktıÖneki>
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

// keep: true → localStorage korunur (kalıcılık testi); yoksa her yüklemede yalnız panel ayarı yazılır.
const INJECT = (lang, keep) => `(() => {
  ${keep ? "" : `localStorage.removeItem("panel.cost"); localStorage.removeItem("panel.load");`}
  localStorage.setItem("panel.settings", JSON.stringify({ lang: "${lang}", light: false, notify: false, sound: false }));
  window.__n = { confirm: 0, alert: 0, prompt: 0 };
  for (const k of ["confirm", "alert", "prompt"]) window[k] = () => { window.__n[k]++; return k === "confirm" ? false : null; };
  window.addEventListener("error", e => (window.__errors ||= []).push(String(e.message)));
})();`;

await send("Page.enable");
let injected = null;
async function load(lang, w = 1280, h = 900, keep = false) {
  if (injected) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected });
  injected = (await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT(lang, keep) })).result.identifier;
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
  await send("Page.navigate", { url });
  await sleep(500);
  await until(`document.querySelectorAll(".card").length === 1`);
}
const shot = async (name, full = false) => {
  await sleep(450);
  let clip;
  if (full) {
    const m = (await send("Page.getLayoutMetrics")).result.cssContentSize;
    clip = { x: 0, y: 0, width: m.width, height: Math.min(m.height, 3000), scale: 1 };
  }
  const r = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip, captureBeyondViewport: true } : {}) });
  writeFileSync(`${out}_${name}.png`, Buffer.from(r.result.data, "base64"));
};
const setView = (v) => ev(`document.querySelector('#nav button[data-view="${v}"]').click()`);
const rows = (box) => ev(`[...document.querySelectorAll("#${box} .cost-row")].map(r => r.querySelector("b").textContent + " | " + r.querySelector(".cost-sum").textContent)`);
const noOverflow = (w) => ev(`document.documentElement.scrollWidth <= ${w} && [...document.querySelectorAll(".cost-item, .cost-head > *, .load-box, .ld-group summary, .ld-items li, .ld-total div")]
  .filter(e => e.getClientRects().length).every(e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= ${w} + 0.5; })`);

// ---- 1. Oturumlar (TR, 1280 koyu) ----
await load("tr");
await until(`document.querySelectorAll("#costSessions .cost-row").length === 1`);
check("Oturumlar: açık oturumun projesi, kısa özet", await rows("costSessions"), ["Alfa Projesi | 5 dk · 249,1 k token · ~$0,29"]);
check("başlık, dönem ve etiket", await ev(`[document.querySelector("#costSessions .cost-fold").textContent.trim(),
  [...document.querySelectorAll("#costSessions .cost-chips button")].map(b => b.textContent + (b.classList.contains("active") ? "*" : "")).join(","),
  document.querySelector("#costSessions .cost-label").textContent]`), ["▾Proje maliyeti", "7 gün*,30 gün,Tümü", "API fiyatıyla karşılığı (tahmini)"]);
await ev(`document.querySelector("#costSessions .cost-row").click()`);
await until(`!!document.querySelector("#costSessions .cost-detail")`);
check("döküm: dönem kalemleri", await ev(`[...document.querySelectorAll("#costSessions .cost-stat")].map(s => s.querySelector("small").textContent + "=" + s.querySelector("b").textContent)`),
  ["Çalışma süresi=5 dk", "Oturum=2", "Girdi=2,1 k", "Çıktı=2 k", "Önbellekten okuma=220 k", "Önbelleğe yazma=25 k", "Tutar (tahmini)=~$0,29"]);
check("döküm: modele göre", await ev(`[...document.querySelectorAll("#costSessions .cost-model")].map(m => m.querySelector("b").textContent + " " + m.querySelector(".cost-m-usd").textContent)`),
  ["claude-opus-5-5 ~$0,29", "claude-haiku-5-5 <$0,01"]);
check("döküm: Max notu, 5 dk kuralı, kaynak bağlantısı", await ev(`(() => { const f = document.querySelector("#costSessions .cost-foot");
  return [f.textContent.includes("Max planında token başına ödeme yapılmaz"), f.textContent.includes("5 dakikadan uzunsa"), f.querySelector("a").href]; })()`),
  [true, true, "https://platform.claude.com/docs/en/about-claude/pricing"]);
// Panel her yoklamada yeniden çizer: açık döküm kapanmamalı
await sleep(3500);
check("yoklama dökümü kapatmaz", await ev(`!!document.querySelector("#costSessions .cost-detail")`), true);
await shot("1280_oturumlar", true);

await ev(`document.querySelector('#costSessions .cost-chips button[data-p="30"]').click()`);
check("30 gün: fiyatı bilinmeyen model → +", await rows("costSessions"), ["Alfa Projesi | 6 dk · 329,2 k token · ~$0,29+"]);
check("30 gün: eksik model ipucu", await ev(`document.querySelector("#costSessions .cost-row").title`), "Şu modellerin fiyatı tabloda yok, tutara katılmadı: claude-3-opus-20240229");
check("dönem kalıcı (localStorage)", await ev(`JSON.parse(localStorage.getItem("panel.cost")).period`), "30");
await load("tr", 1280, 900, true);
await until(`document.querySelectorAll("#costSessions .cost-row").length === 1`);
check("yeniden açılışta dönem 30 gün", await ev(`document.querySelector("#costSessions .cost-chips .active").dataset.p`), "30");
await ev(`document.querySelector("#costSessions .cost-fold").click()`);
check("katlama: liste gizlenir", await ev(`[!!document.querySelector("#costSessions .cost-list"), document.querySelector("#costSessions .cost-fold").getAttribute("aria-expanded")]`), [false, "false"]);
await load("tr", 1280, 900, true);
await until(`!!document.querySelector("#costSessions .cost-head")`);
check("katlama kalıcı", await ev(`!!document.querySelector("#costSessions .cost-list")`), false);

// ---- 2. Son oturumlar ----
await load("tr");
await setView("recent");
await until(`document.querySelectorAll("#costRecent .cost-row").length === 1`);
await ev(`document.querySelector('#costRecent .cost-chips button[data-p="all"]').click()`);
check("Son oturumlar, tümü: iki proje (tutara göre)", await rows("costRecent"),
  ["Alfa Projesi | 6 dk · 329,2 k token · ~$0,29+", "Beta | 2 dk · 100,1 k token · ~$0,04"]);
check("toplam satırı", await ev(`document.querySelector("#costRecent .cost-total").textContent`), "Toplam 7 dk · 429,3 k token · ~$0,32+");
check("liste ve maliyet ayrı (oturum satırları duruyor)", await until(`document.querySelectorAll("#recentList .recent-item").length > 0`), true);
await ev(`document.querySelectorAll("#costRecent .cost-row")[1].click()`);
await shot("1280_son");

// ---- 3. Açılış yükü ----
await setView("skills");
await until(`!!document.querySelector("#loadBox .ld-sum") && !document.querySelector("#loadBox .ld-sum").textContent.includes("Yükleniyor")`);
check("özet: en az / medyan / en çok", await ev(`document.querySelector("#loadBox .ld-sum").textContent`),
  "Son 4 oturumun ilk yanıtında bağlam: en az 80,1 k · medyan 110 k · en çok 120 k token");
check("varsayılan kapalı", await ev(`!!document.querySelector("#loadBox .ld-body")`), false);
await ev(`document.querySelector("#loadBox .ld-head").click()`);
await until(`!!document.querySelector("#loadBox .ld-body")`);
const groups = () => ev(`[...document.querySelectorAll("#loadBox .ld-group summary")].map(s => s.querySelector(".ld-label").textContent + " = " + s.querySelector(".ld-val").textContent)`);
check("dağılım (tahmini etiketli, MCP ölçülemedi)", await groups(), [
  "Genel CLAUDE.md = ~2 k · %1,8 tahmini", "Kurallar (rules/) = ~1,2 k · %1,1 tahmini", "Üst klasör CLAUDE.md = ~100 · %0,1 tahmini",
  "Proje CLAUDE.md = ~500 · %0,5 tahmini", "Proje hafızası = ~100 · %0,1 tahmini", "Skill açıklamaları (2 etkin) = ~70 · %0,1 tahmini",
  "MCP sunucuları (4) = ölçülemedi"]);
await ev(`document.querySelector('#loadBox .ld-group[data-kind="rule"] summary').click()`);
check("kurallar dosya dosya + not", await ev(`(() => { const g = document.querySelector('#loadBox .ld-group[data-kind="rule"]');
  return [[...g.querySelectorAll(".ld-items li")].map(l => l.querySelector("b").textContent + " " + l.querySelector(".ld-val").textContent),
    g.querySelector(".ld-note").textContent]; })()`),
  [["buyuk-kural.md ~1 k", "kucuk.md ~200"], "rules/ altındaki dosya her oturumda yüklenir; göreve özel ise rules-lib/'e taşınabilir."]);
await ev(`document.querySelector('#loadBox .ld-group[data-kind="mcp"] summary').click()`);
check("MCP adları ve kaynakları", await ev(`[...document.querySelectorAll('#loadBox .ld-group[data-kind="mcp"] li')].map(l =>
  [l.querySelector("b").textContent, l.querySelector("small").textContent, l.querySelector(".ld-val").textContent].join(" "))`),
  ["figma .mcp.json ölçülemedi", "gmail .claude.json ölçülemedi", "postgres settings.json ölçülemedi", "proje-mcp .claude.json ölçülemedi"]);
check("toplamlar, fark satırı ve /context atfı", await ev(`[[...document.querySelectorAll("#loadBox .ld-total div")].map(d => [...d.children].map(c => c.textContent).join(" ")),
  document.querySelector("#loadBox .ld-foot").textContent.includes("/context")]`),
  [["Tahmin edilen kalemler ~4 k", "Sistem istemi, araç tanımları ve ölçülemeyen kalemler ~106 k", "Ölçülen (medyan) 110 k"], true]);
check("oran çubuğu: ölçülen 6 grup görünür (CSP'ye takılmadan)", await ev(`[...document.querySelectorAll("#loadBox .ld-bar span")]
  .map(s => s.getBoundingClientRect().width > 0 && getComputedStyle(s).backgroundColor !== "rgba(0, 0, 0, 0)")`), [true, true, true, true, true, true]);
check("açık durum kalıcı", await ev(`JSON.parse(localStorage.getItem("panel.load")).open`), true);
await shot("1280_acilis", true);
// Proje seçimi: Beta'da proje CLAUDE.md ve hafıza yok
await ev(`(() => { const s = document.querySelector("#ldCwd"); s.value = [...s.options].find(o => o.value.endsWith("Beta")).value; s.dispatchEvent(new Event("change")); })()`);
await until(`!document.querySelector('#loadBox .ld-group[data-kind="projectMd"]')`);
check("Beta seçilince proje kalemleri düşer", await ev(`[...document.querySelectorAll("#loadBox .ld-group")].map(g => g.dataset.kind)`),
  ["global", "rule", "parentMd", "skill", "mcp"]);
await ev(`(() => { const s = document.querySelector("#ldCwd"); s.value = [...s.options].find(o => o.value.endsWith("Alfa Projesi")).value; s.dispatchEvent(new Event("change")); })()`);
await until(`!!document.querySelector('#loadBox .ld-group[data-kind="projectMd"]')`);
await ev(`(() => { const i = document.querySelector("#skillSearch"); i.value = "rapor"; i.dispatchEvent(new Event("input")); })()`);
check("aramada açılış yükü gizlenir", await ev(`document.querySelector("#loadBox").hidden`), true);
await ev(`(() => { const i = document.querySelector("#skillSearch"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
check("arama temizlenince geri gelir", await ev(`document.querySelector("#loadBox").hidden`), false);

// ---- 4. Telefon 390 ----
await load("tr", 390, 844, true);
await until(`document.querySelectorAll("#costSessions .cost-head").length === 1`);
await ev(`(() => { const f = document.querySelector("#costSessions .cost-fold"); if (f.getAttribute("aria-expanded") === "false") f.click(); })()`);
await until(`document.querySelectorAll("#costSessions .cost-row").length === 1`);
await ev(`document.querySelector("#costSessions .cost-row").click()`);
await ev(`document.querySelector("#costSessions").scrollIntoView()`);
check("390 Oturumlar: taşma yok", await noOverflow(390), true);
await shot("390_oturumlar");
await setView("recent");
await until(`document.querySelectorAll("#costRecent .cost-row").length >= 1`);
await ev(`document.querySelector("#costRecent .cost-row").click()`);
check("390 Son oturumlar: taşma yok", await noOverflow(390), true);
await shot("390_son");
await setView("skills");
await until(`!!document.querySelector("#loadBox .ld-body")`);
await ev(`document.querySelectorAll("#loadBox .ld-group").forEach(g => g.open = true); document.querySelector("#loadBox").scrollIntoView()`);
check("390 Açılış yükü: taşma yok", await noOverflow(390), true);
await shot("390_acilis");

// ---- 5. İngilizce ----
await load("en");
await until(`document.querySelectorAll("#costSessions .cost-row").length === 1`);
check("EN: özet", await rows("costSessions"), ["Alfa Projesi | 5 min · 249.1 k tokens · ~$0.29"]);
check("EN: başlık", await ev(`[document.querySelector("#costSessions .cost-fold").textContent.trim(), document.querySelector("#costSessions .cost-label").textContent]`),
  ["▾Project cost", "API-price equivalent (estimate)"]);
await setView("skills");
await until(`!!document.querySelector("#loadBox .ld-sum") && /median/.test(document.querySelector("#loadBox .ld-sum").textContent)`);
check("EN: açılış yükü özeti", await ev(`document.querySelector("#loadBox .ld-sum").textContent`),
  "Context in the first response of the last 4 sessions: min 80.1 k · median 110 k · max 120 k tokens");

check("tarayıcı penceresi açılmadı (confirm/alert/prompt)", await ev(`window.__n`), { confirm: 0, alert: 0, prompt: 0 });
check("sayfa hatası yok", await ev(`window.__errors || []`), []);
console.log(`Maliyet arayüz: ${pass} geçti, ${fail} kaldı`);
ws.close();
process.exit(fail ? 1 : 0);
