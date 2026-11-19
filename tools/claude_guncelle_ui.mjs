// Claude Code güncellemesi tarayıcı testi (tools/claude_guncelle_test.sh kurar ve çağırır): Takip → Güncellemeler satırında
// başarısız güncellemenin hata metni, "Şimdi güncelle" düğmesi, "Güncelleniyor…" durumu, bitince satırın kalkıp
// "kuruldu, yeni oturumlarda geçerli" notunun çıkması; İngilizce metin; 1280 + 390 px taşma. Tarayıcı confirm/alert/prompt sayılır.
// Kullanım: node claude_guncelle_ui.mjs <debugPort> <url> <çıktıÖneki> <sahte claude klasörü>
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
const [port, url, out, binDir] = process.argv.slice(2);
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
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "GEÇTİ " : "KALDI "} ${name}${ok ? "" : ` (beklenen ${JSON.stringify(want)}, gelen ${JSON.stringify(got)})`}`);
};
const until = async (expr, ms = 20000) => { for (let i = 0; i < ms / 250; i++) { if (await ev(expr)) return true; await sleep(250); } return false; };
const INJECT = (lang) => `(() => {
  localStorage.setItem("panel.settings", JSON.stringify({ lang: "${lang}", light: false, notify: false, sound: false }));
  localStorage.setItem("panel.follow", JSON.stringify({ mode: "type", collapsed: { updates: false } }));
  window.__n = 0;
  for (const k of ["confirm", "alert", "prompt"]) window[k] = () => { window.__n++; return null; };
  window.addEventListener("error", e => (window.__errors ||= []).push(String(e.message)));
})();`;
await send("Page.enable"); // yoksa addScriptToEvaluateOnNewDocument uygulanmaz
let injected = null;
async function open(lang, width, height, mobile) {
  if (injected) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected });
  injected = (await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT(lang) })).result.identifier;
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
  await send("Page.navigate", { url: url + "?view=follow" });
  await until(`document.querySelector(".fu-chip") && !document.getElementById("btnFuRefresh").disabled`);
  await sleep(500);
}
const row = `document.querySelector('.fu-row[data-type="update"]')`;
const what = () => ev(`${row}?.querySelector(".fu-what")?.textContent ?? null`);
const btn = () => ev(`${row}?.querySelector(".fu-side .btn")?.textContent ?? null`);
const notes = () => ev(`[...document.querySelectorAll(".fu-clean")].map(n => n.textContent)`);
const overflow = () => ev(`document.documentElement.scrollWidth > window.innerWidth + 1`);
async function shot(name) {
  const s = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${out}_${name}.png`, Buffer.from(s.result.data, "base64"));
}

// ---- başarısız güncelleme: hata metni + Şimdi güncelle ----
await open("tr", 1280, 900, false);
const found = await until(`${row} !== null`);
if (!found) { await shot("1280_bulunamadi"); console.log(await ev(`[...document.querySelectorAll(".fu-sec")].map(s => s.id + ":" + s.textContent.slice(0, 120))`)); }
check("güncelleme satırı var", found, true);
check("satır: kurulu sürüm + hata metni", await what(), "Kurulu sürüm: 2.1.0 · Güncellenemedi: Network error: registry unreachable");
check("düğme: Şimdi güncelle", await btn(), "Şimdi güncelle");
await ev(`${row}.scrollIntoView({ block: "center" })`);
await shot("1280_hata");

// ---- Şimdi güncelle: Güncelleniyor… → kuruldu notu ----
rmSync(join(binDir, "bozuk"), { force: true });
writeFileSync(join(binDir, "yavas"), "");
await ev(`${row}.querySelector(".fu-side .btn").click()`);
check("tıklayınca: Güncelleniyor…", await until(`${row}?.querySelector(".fu-what")?.textContent.endsWith("Güncelleniyor…")`, 5000), true);
check("sürerken düğme yok", await btn(), null);
await shot("1280_suruyor");
check("bitince satır kalktı", await until(`${row} === null`, 30000), true);
check("not: kuruldu, yeni oturumlarda geçerli", (await notes()).includes("Claude Code 9.9.9 kuruldu, yeni oturumlarda geçerli"), true);
check("1280: yatay taşma yok", await overflow(), false);
if (existsSync(join(binDir, "yavas"))) rmSync(join(binDir, "yavas"));

// ---- İngilizce + telefon ----
await open("en", 390, 844, true);
check("EN not", (await notes()).includes("Claude Code 9.9.9 installed; new sessions use it"), true);
check("390: yatay taşma yok", await overflow(), false);
await ev(`[...document.querySelectorAll(".fu-clean")].pop()?.scrollIntoView({ block: "center" })`);
await shot("390_en");

check("tarayıcı confirm/alert/prompt çağrılmadı", await ev(`window.__n`), 0);
check("sayfa hatası yok", await ev(`window.__errors || []`), []);
ws.close();
process.exit(fail ? 1 : 0);
