// Telefondan yol indirme arayüz testi (ortamı tools/indir_ui_test.sh kurar; bir panel oturumu: "Indir").
// Ana sayfa CDP Fetch ile telefon görünümüne çevrilir (panel-remote=1); döküm sahte içerikle yanıtlanır.
// Beklenen (390 px): kök altındaki dosya bağlantı olur ("Dosyayı indir"), .env ve klasör bağlantı olmaz; dokununca
// "İndiriliyor…" bildirimi ve dosya indirme klasörüne aynı içerikle iner; silinmiş dosyada "Bu yol artık yok".
// Kullanım: node indir_ui_test.mjs <debugPort> <url> <görüntü klasörü> <izinli dosya> <.env dosyası> <klasör> <indirme klasörü>
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
const [port, url, shotDir, okFile, envFile, folder, dlDir] = process.argv.slice(2);
const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const wait = new Map(); const events = [];
const now = new Date().toISOString();
const TEXT = `Rapor hazır: ${okFile}. Gizli: ${envFile} ve klasör ${folder} burada.`;
const BODY = Buffer.from(JSON.stringify({ title: "Indir", items: [
  { id: "u1", kind: "user", text: "raporu ver", ts: now },
  { id: "a1", kind: "assistant", text: TEXT, ts: now },
] })).toString("base64");
const b64 = (s) => Buffer.from(s).toString("base64");
ws.onmessage = async (m) => {
  const d = JSON.parse(m.data);
  if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); return; }
  if (d.method) events.push(d);
  if (d.method !== "Fetch.requestPaused") return;
  const p = d.params;
  if (p.request.url.includes("/api/transcript/"))
    return send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json; charset=utf-8" }], body: BODY });
  // Ana sayfa: yanıt aşamasında panel-remote 0 → 1 (telefon görünümü; uçlar yerelden açık, süzgeç aynı).
  const r = await send("Fetch.getResponseBody", { requestId: p.requestId });
  const html = (r.result.base64Encoded ? Buffer.from(r.result.body, "base64").toString() : r.result.body)
    .replace('name="panel-remote" content="0"', 'name="panel-remote" content="1"');
  send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: b64(html) });
};
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ev = async (expr) => {
  const r = (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })).result;
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r?.result?.value;
};
let fail = 0, passed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++; else passed++;
  console.log(`${ok ? "GEÇTİ " : "KALDI "} ${name}${ok ? "" : ` (beklenen ${JSON.stringify(want)}, gelen ${JSON.stringify(got)})`}`);
};
const until = async (expr, ms = 15000) => { for (let i = 0; i < ms / 250; i++) { if (await ev(expr)) return true; await sleep(250); } return false; };
const tap = async (sel) => {
  const r = await ev(`(() => { const e = ${sel}; e.scrollIntoView({ block: "center" }); const b = e.getClientRects()[0]; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  await sleep(150);
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
  await sleep(250);
};
const LINKS = `[...document.querySelectorAll("#dMessages a.path-link")]`;

await send("Page.enable");
await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/transcript/*" }, { urlPattern: new URL(url).origin + "/", requestStage: "Response" }] });
await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dlDir, eventsEnabled: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
  if (!localStorage.getItem("panel.settings")) localStorage.setItem("panel.settings", JSON.stringify({ lang: "tr", light: false, notify: false, sound: false }));
  for (const k of ["confirm", "alert", "prompt"]) window[k] = () => { throw new Error("yerleşik pencere: " + k); };
  window.addEventListener("error", e => (window.__errors ||= []).push(String(e.message)));
})();` });
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send("Page.navigate", { url });
check("telefon görünümü (html.remote)", await until(`document.documentElement.classList.contains("remote")`), true);
check("kart göründü", await until(`document.querySelectorAll(".card").length === 1`), true);
await ev(`[...document.querySelector(".card .card-actions").querySelectorAll(".btn")].find(b => b.textContent === "Konuşma").click()`);
check("döküm geldi", await until(`document.querySelectorAll("#dMessages .msg.assistant").length === 1`), true);
check("bağlantılar işlendi", await until(`${LINKS}.length > 0`), true);
await sleep(300);
check("yalnız izinli dosya bağlantı oldu", await ev(`${LINKS}.map(a => a.dataset.path)`), [okFile]);
check("bağlantı başlığı 'Dosyayı indir'", await ev(`${LINKS}[0].title`), "Dosyayı indir");
check(".env ve klasör düz metin kaldı", await ev(`(() => { const t = document.querySelector("#dMessages .msg.assistant").textContent; return t.includes(${JSON.stringify(envFile)}) && t.includes(${JSON.stringify(folder)}); })()`), true);
// Uzun yol satıra kırılır: dokunma noktası ilk satır parçasının ortası (dış kutunun ortası boşluk olabilir).
const FIRST = (sel) => `(() => { const e = ${sel}; e.scrollIntoView({ block: "center" }); const b = e.getClientRects()[0]; return { e, b, x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`;
const g = await ev(`(() => { const { e, b, x, y } = ${FIRST(`${LINKS}[0]`)}; const top = document.elementFromPoint(x, y);
  return { inView: b.left >= 0 && b.right <= innerWidth + 1, onTop: e.contains(top) || (top && (top.id || top.className)) }; })()`);
check("bağlantı görünür ve üstte", g, { inView: true, onTop: true });

await tap(`${LINKS}[0]`);
check("'İndiriliyor…' bildirimi", await until(`[...document.querySelectorAll(".toast")].some(t => t.textContent.includes("İndiriliyor"))`, 3000), true);
let done = false;
for (let i = 0; i < 60 && !done; i++) { done = events.some(e => e.method === "Browser.downloadProgress" && e.params.state === "completed"); if (!done) await sleep(250); }
check("indirme tamamlandı", done, true);
const name = okFile.split(/[\\/]/).pop();
check("inen dosyanın adı ve içeriği", existsSync(join(dlDir, name)) && readFileSync(join(dlDir, name), "utf8"), "merhaba dünya");
check("uyarı bildirimi yok", await ev(`[...document.querySelectorAll(".toast")].some(t => t.textContent.includes("artık yok"))`), false);

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(shotDir, "indir_390.png"), Buffer.from(shot.result.data, "base64"));

unlinkSync(okFile); // dosya sonradan silinmiş: indirme yerine uyarı
await tap(`${LINKS}[0]`);
check("silinmiş dosyada 'Bu yol artık yok'", await until(`[...document.querySelectorAll(".toast")].some(t => t.textContent.includes("artık yok"))`, 4000), true);
check("sayfa hatası yok", await ev(`(window.__errors || []).length`), 0);
console.log(`${passed} geçti, ${fail} kaldı`);
process.exit(fail ? 1 : 0);
