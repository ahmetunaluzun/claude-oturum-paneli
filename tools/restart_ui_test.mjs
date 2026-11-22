// Paneli yeniden başlat arayüzü (restart.js): Ayarlar düğmesi + "Yeni sürüm hazır" notu, onay penceresi, çalışan oturum
// penceresi (adlarıyla), Takip → Güncellemeler'deki "Yeni sürüm hazır" satırı, tam ekran "Yeniden başlatılıyor…" katmanı,
// yeni süreç gelince sayfanın kendini yenilemesi, hata katmanı + "Yeniden dene". 1280 + 390 görüntüleri.
// tools/restart_ui_test.sh kurar: ClaudePanel.old.exe (bu sürüm) çalışır, yanında daha yeni ClaudePanel.exe durur.
// Kullanım: node restart_ui_test.mjs <debugPort> <url> <çıktıÖneki> <yeniSürüm> <işaretKlasörü>
import { existsSync, writeFileSync } from "node:fs";
const [port, url, out, newVer, flags] = process.argv.slice(2);
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
const until = async (expr, ms = 20000) => { for (let i = 0; i < ms / 200; i++) { try { if (await ev(expr)) return true; } catch { /* sayfa yenileniyor */ } await sleep(200); } return false; };
const J = JSON.stringify;
const INJECT = `(() => {
  localStorage.setItem("panel.settings", JSON.stringify({ lang: "tr", light: false, notify: false, sound: false }));
  localStorage.setItem("panel.follow", JSON.stringify({ mode: "type" }));
  sessionStorage.setItem("__loads", String(Number(sessionStorage.getItem("__loads") || 0) + 1));
  window.__n = { confirm: 0, alert: 0, prompt: 0 };
  for (const k of ["confirm", "alert", "prompt"]) window[k] = () => { window.__n[k]++; return k === "confirm" ? false : null; };
  window.addEventListener("error", e => (window.__errors ||= []).push(String(e.message)));
  window.addEventListener("unhandledrejection", e => (window.__errors ||= []).push(String(e.reason)));
})();`;
await send("Page.enable");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT });
const native = { confirm: 0, alert: 0, prompt: 0 }, errors = [];
async function tally() {
  const n = await ev(`window.__n`);
  for (const k in native) native[k] += n[k];
  errors.push(...await ev(`window.__errors || []`));
}
async function size(width) {
  await send("Emulation.setDeviceMetricsOverride", { width, height: width < 500 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 500 });
}
async function open(width, view) {
  await size(width);
  await send("Page.navigate", { url: url + (view ? "?view=" + view : "") });
  await until(`document.getElementById("ver")?.textContent.startsWith("v")`);
  await sleep(900);
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
const press = (value) => click(`[...document.querySelectorAll("#askButtons .btn")].find(b => b.value === ${J(value)})`);
// Öğe görünür mü: üstünde başka bir şey yok (elementFromPoint), ekranın içinde.
const visible = (sel) => ev(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return false; const r = e.getBoundingClientRect();
  if (!r.width || r.bottom > innerHeight || r.right > innerWidth || r.top < 0) return false;
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!top && (e === top || e.contains(top)); })()`);
const token = () => ev(`document.querySelector('meta[name="panel-token"]').content`);
const apiPost = (path, body) => ev(`fetch(${J(path)}, { method: "POST", headers: { "X-Panel-Token": document.querySelector('meta[name="panel-token"]').content,
  "Content-Type": "application/json" }, body: ${J(body ? JSON.stringify(body) : null)} }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }))`);
const waitFlag = async (name) => { for (let i = 0; i < 240 && !existsSync(`${flags}/${name}`); i++) await sleep(250); return existsSync(`${flags}/${name}`); };

// ================= 1280: Ayarlar, onay, Takip satırı =================
await open(1280);
const v0 = await ev(`document.getElementById("ver").textContent`);
await click(`document.getElementById("btnSettings")`, 900);
check("Ayarlar: yeni sürüm notu görünür", await until(`!document.getElementById("rsReady").hidden`, 8000), true);
check("Ayarlar: not metni", await ev(`document.getElementById("rsReady").textContent`), `Yeni sürüm hazır (v${newVer}). Yeniden başlatınca açılır.`);
check("Ayarlar: düğme öne çıkıyor (birincil) ve metni", await ev(`[document.getElementById("btnRestart").classList.contains("primary"), document.getElementById("btnRestart").textContent]`), [true, "Yeniden başlat"]);
check("Ayarlar: Paneli kapat da yanında", await ev(`document.getElementById("btnQuit").parentElement === document.getElementById("btnRestart").parentElement`), true);
await ev(`document.getElementById("btnRestart").scrollIntoView({ block: "center" })`);
check("Ayarlar: düğme ekranda görünür", await visible("#btnRestart"), true);
await shot("1280_ayarlar");
await click(`document.getElementById("btnRestart")`, 700);
const c1 = await dlgInfo();
check("onay penceresi: başlık + iki sürüm", [c1?.title, c1?.text.includes(v0.slice(1)) && c1?.text.includes(newVer)], ["Panel yeniden başlatılsın mı?", true]);
check("onay penceresi: düğmeler", c1?.buttons, ["Vazgeç", "Paneli yeniden başlat"]);
await shot("1280_onay");
await press("cancel");
check("Vazgeç: katman yok, süreç aynı", await ev(`!document.querySelector(".rs-layer")`), true);

await open(1280, "follow");
await until(`document.querySelector(".fu-chip") && !document.getElementById("btnFuRefresh").disabled`, 15000);
await ev(`document.querySelectorAll(".fu-fold[aria-expanded=false]").forEach(b => b.click())`); // kapalı bölümleri aç
await sleep(400);
await until(`document.querySelector('.fu-row[data-id="upd:disk"]')`, 15000);
const fold = `[...document.querySelectorAll(".fu-sec")].find(s => s.querySelector('.fu-row[data-id="upd:disk"]'))`;
check("Takip: Yeni sürüm hazır satırı", await ev(`(() => { const r = document.querySelector('.fu-row[data-id="upd:disk"]'); return r && [r.querySelector(".fu-title b")?.textContent,
  [...r.querySelectorAll(".fu-side .btn")].map(b => b.textContent)]; })()`), [`Yeni sürüm hazır: v${newVer}`, ["Yeniden başlat"]]);
check("Takip: çelişen \"Panel güncel\" notu yok", await ev(`document.getElementById("viewFollow").textContent.includes("Panel güncel")`), false);
await ev(`document.querySelector('.fu-row[data-id="upd:disk"]').scrollIntoView({ block: "center" })`);
check("Takip: satırdaki düğme görünür", await visible('.fu-row[data-id="upd:disk"] .fu-side .btn'), true);
await shot("1280_takip");
await click(`document.querySelector('.fu-row[data-id="upd:disk"] .fu-side .btn')`, 700);
check("Takip düğmesi aynı onayı açar", (await dlgInfo())?.title, "Panel yeniden başlatılsın mı?");
await press("cancel");

// ================= Çalışan oturum: adlarıyla, bilgisayarda "Yine de yeniden başlat" =================
const cwd = await ev(`fetch("/api/version").then(() => "")`); // yalnız bağlantı denemesi
const hs = await apiPost("/api/hosted", { cwd: flags.replace(/\//g, "\\"), prompt: "BEKLE", name: "Uzun iş" });
check("çalışan sahte oturum açıldı", hs.status, 200);
check("oturum çalışıyor", await until(`fetch("/api/state").then(r => r.json()).then(s => s.hosted.some(h => h.status === "busy"))`, 15000), true);
await open(1280);
await click(`document.getElementById("btnSettings")`, 700);
await click(`document.getElementById("btnRestart")`, 700);
await press("yes");
await until(`${dlg}.open && document.getElementById("askTitle").textContent === "Panelde çalışan oturum var"`, 8000);
const b1 = await dlgInfo();
check("meşgul penceresi: başlık, oturum adı, düğmeler", [b1?.title, b1?.list, b1?.buttons], ["Panelde çalışan oturum var", ["Uzun iş"], ["Vazgeç", "Yine de yeniden başlat"]]);
await shot("1280_mesgul");
await press("cancel");
check("meşgul + Vazgeç: katman yok", await ev(`!document.querySelector(".rs-layer")`), true);
const st = await ev(`fetch("/api/state").then(r => r.json())`);
for (const h of st.hosted) await apiPost(`/api/hosted/${h.key}/stop`);
check("sahte oturum kapatıldı", await until(`fetch("/api/state").then(r => r.json()).then(s => !s.hosted.length)`, 10000), true);
void cwd; void token;

// ================= 390: Ayarlar, bekleme katmanı, yeni sürüme geçiş =================
await open(390);
await click(`document.getElementById("btnSettings")`, 900);
await until(`!document.getElementById("rsReady").hidden`, 8000);
await ev(`document.getElementById("btnRestart").scrollIntoView({ block: "center" })`);
check("390: düğme ekranda görünür", await visible("#btnRestart"), true);
check("390: düğme taşmıyor", await ev(`(() => { const r = document.getElementById("btnRestart").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`), true);
await shot("390_ayarlar");
await click(`document.getElementById("btnRestart")`, 700);
await shot("390_onay");
const loads0 = await ev(`Number(sessionStorage.getItem("__loads"))`);
await press("yes", 50);
check("bekleme katmanı açıldı", await until(`document.querySelector(".rs-layer .rs-box.wait")`, 3000), true);
check("katman metni", await ev(`document.querySelector(".rs-layer h2")?.textContent`), "Yeniden başlatılıyor…");
check("Ayarlar penceresi kapandı (katman üstte)", await ev(`!document.getElementById("dlgSettings").open`), true);
check("katman görünür (elementFromPoint)", await visible(".rs-layer .rs-box"), true);
await shot("390_bekliyor");
check("yeni süreç gelince sayfa kendini yeniledi", await until(`Number(sessionStorage.getItem("__loads")) > ${loads0} && document.getElementById("ver")?.textContent === "v${newVer}"`, 60000), true);
await sleep(1500);
check("yenilenen sayfada katman yok", await ev(`!document.querySelector(".rs-layer")`), true);
await click(`document.getElementById("btnSettings")`, 900);
await sleep(500);
check("güncel sürümde not gizli, düğme olağan", await ev(`[document.getElementById("rsReady").hidden, document.getElementById("btnRestart").classList.contains("primary"), document.getElementById("btnRestart").textContent]`),
  [true, false, "Paneli yeniden başlat"]);
await shot("390_guncel");
await tally();

// ================= Hata: yeni exe başlamıyor → hata katmanı + Yeniden dene =================
writeFileSync(`${flags}/boz.istek`, "1");
check("betik exe'yi bozdu", await waitFlag("boz.ok"), true);
await open(1280);
await click(`document.getElementById("btnSettings")`, 700);
await click(`document.getElementById("btnRestart")`, 700);
await press("yes", 50);
check("hata katmanı açıldı", await until(`document.querySelector(".rs-layer .rs-box.error")`, 8000), true);
check("hata metni + düğmeler", await ev(`[document.querySelector(".rs-layer h2").textContent, document.querySelector(".rs-layer p").textContent,
  [...document.querySelectorAll(".rs-layer .btn")].map(b => b.textContent)]`),
  ["Panel yeniden başlatılamadı", "Yeni panel başlatılamadı; çalışan panel açık kaldı.", ["Kapat", "Yeniden dene"]]);
await shot("1280_hata");
await click(`document.querySelector(".rs-layer .btn.primary")`, 1500);
check("Yeniden dene: yine hata (exe bozuk)", await until(`document.querySelector(".rs-layer .rs-box.error")`, 8000), true);
await click(`document.querySelector(".rs-layer .btn:not(.primary)")`);
check("Kapat: katman kalktı, panel açık", [await ev(`!document.querySelector(".rs-layer")`), await ev(`fetch("/api/ping").then(r => r.text())`)], [true, "claude-panel"]);
await size(390);
await click(`document.getElementById("btnSettings")`, 700);
await click(`document.getElementById("btnRestart")`, 700);
await press("yes", 50);
await until(`document.querySelector(".rs-layer .rs-box.error")`, 8000);
check("390: hata katmanındaki düğmeler ekranda", [await visible(".rs-layer .btn.primary"), await visible(".rs-layer .btn:not(.primary)")], [true, true]);
await shot("390_hata");
await click(`document.querySelector(".rs-layer .btn:not(.primary)")`);

await tally();
check("yerleşik confirm/alert/prompt hiç çağrılmadı", native, { confirm: 0, alert: 0, prompt: 0 });
check("sayfada betik hatası yok", errors, []);
console.log(`\n${pass} geçti, ${fail} kaldı`);
ws.close();
process.exit(fail ? 1 : 0);
