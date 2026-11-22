// Telefonda ağ kopması arayüz testi (ortamı tools/err_offline_test.sh kurar): 390 px, çekmecede mesaj yazılır, ağ kesilir
// (CDP Network.emulateNetworkConditions offline), Gönder'e gerçek fare olayıyla basılır → "Bağlantı koptu" uyarısı, metin
// kutuda, kutu odakta, sahte "gönderildi" balonu yok. Ağ gelince aynı düğmeyle gönderilir → kutu boşalır, kutu yine odakta.
// Tarayıcı confirm/alert/prompt YOK. Kullanım: node err_offline_test.mjs <debugPort> <url> <çıktıÖneki>
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
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${out}_${name}.png`, Buffer.from(r.result.data, "base64"));
};
// Gönder düğmesine gerçek fare olayı (mousedown → click): dSend'in mousedown'da odağı almaması bu yolla sınanır.
const tapSend = async () => {
  const c = await ev(`(() => { const b = document.getElementById("dSend").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
};
const offline = (on) => send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

const TEXT = "kopma denemesi";
await send("Page.enable");
await send("Network.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
  localStorage.setItem("panel.settings", JSON.stringify({ lang: "tr", light: false, notify: false, sound: false }));
  window.__n = { confirm: 0, alert: 0, prompt: 0 };
  for (const k of ["confirm", "alert", "prompt"]) window[k] = () => { window.__n[k]++; return k === "confirm" ? false : null; };
  window.addEventListener("error", e => (window.__errors ||= []).push(String(e.message)));
})();` });
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send("Page.navigate", { url });
await sleep(500);
check("kart göründü", await until(`document.querySelectorAll(".card").length === 1`), true);
await ev(`[...document.querySelectorAll(".card .card-actions .btn")].find(b => b.textContent === "Konuşma").click()`);
check("çekmece açıldı, yazma kutusu açık", await until(`document.body.classList.contains("drawer-open") && !document.getElementById("dInput").disabled`), true);
await sleep(600);
await ev(`(() => { const el = document.getElementById("dInput"); el.focus(); el.value = ${JSON.stringify(TEXT)}; el.dispatchEvent(new Event("input")); })()`);

// ---- ağ kesik ----
await offline(true);
await tapSend();
check("uyarı: Bağlantı koptu", await until(`[...document.querySelectorAll(".toast")].some(x => x.textContent.startsWith("Bağlantı koptu"))`, 5000), true);
check("uyarı türü warn", await ev(`[...document.querySelectorAll(".toast")].find(x => x.textContent.startsWith("Bağlantı koptu"))?.classList.contains("warn")`), true);
// DOM'da olması yetmez: çekmecenin altında kalan uyarı telefonda görünmüyordu (z-index). Ortasındaki nokta uyarının kendisi mi?
check("uyarı ekranda görünüyor (çekmecenin altında değil)", await ev(`(() => { const x = [...document.querySelectorAll(".toast")].find(x => x.textContent.startsWith("Bağlantı koptu")); const b = x.getBoundingClientRect();
  const box = x.parentElement; box.style.pointerEvents = "auto"; x.style.pointerEvents = "auto"; // .toasts tıklamayı geçirir; ölçüm anında aç
  const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); box.style.pointerEvents = x.style.pointerEvents = ""; return !!hit && x.contains(hit) && b.top >= 0 && b.bottom <= innerHeight; })()`), true);
check("uyarı yazma kutusunu ve Gönder'i örtmüyor", await ev(`(() => { const b = [...document.querySelectorAll(".toast")].find(x => x.textContent.startsWith("Bağlantı koptu")).getBoundingClientRect();
  return ["dInput", "dSend"].every(i => { const q = document.getElementById(i).getBoundingClientRect(); return b.bottom <= q.top || b.top >= q.bottom; }); })()`), true);
check("metin kutuda duruyor", await ev(`document.getElementById("dInput").value`), TEXT);
check("kutu odakta (klavye kapanmadı)", await ev(`document.activeElement?.id`), "dInput");
check("sahte 'gönderildi' balonu yok", await ev(`document.querySelectorAll("#dMessages .pending").length`), 0);
check("Gönder düğmesi yeniden basılabilir", await ev(`!document.getElementById("dSend").disabled`), true);
check("390 px: yatay taşma yok", await ev(`document.documentElement.scrollWidth <= innerWidth`), true);
await shot("390_kesik");

// ---- ağ geri geldi ----
await offline(false);
await sleep(300);
await tapSend();
check("ağ gelince gönderildi: kutu boşaldı", await until(`document.getElementById("dInput").value === ""`, 5000), true);
// Bu ortamda sahte claude döküm yazmaz (döküm boş). Gönderilen mesajın yankı balonu (.pending) döküm boşken yapılan
// yenilemelerde (1,5 sn'de bir) silinmemeli: eskiden loadTranscript kutuyu sıfırlıyor, mesaj "—" ile kayboluyordu.
check("gönderilen mesaj konuşmada", await until(`[...document.querySelectorAll("#dMessages .msg.user")].some(e => e.textContent.includes(${JSON.stringify(TEXT)}))`, 8000), true);
await sleep(4000);
check("döküm boşken birkaç yenilemeden sonra da mesaj duruyor", await ev(`[...document.querySelectorAll("#dMessages .msg.user.pending")].some(e => e.textContent.includes(${JSON.stringify(TEXT)}))`), true);
check("gönderdikten sonra da kutu odakta", await ev(`document.activeElement?.id`), "dInput");
await sleep(800);
await shot("390_gonderildi");

check("tarayıcının confirm / alert / prompt penceresi hiç açılmadı", await ev(`window.__n`), { confirm: 0, alert: 0, prompt: 0 });
check("sayfada betik hatası yok", await ev(`window.__errors || []`), []);
console.log(`\n${pass} geçti, ${fail} kaldı`);
ws.close();
process.exit(fail ? 1 : 0);
