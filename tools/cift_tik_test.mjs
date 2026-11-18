// "Yeni oturum" penceresinde Başlat'a art arda 3 tık → sunucuya tek istek gitmeli; istek sürerken düğme kilitli ve
// "Başlatılıyor…" yazmalı. Yanıt tarayıcıda 1,5 sn geciktirilir (yavaş süreç açılışını taklit eder).
// Test kopyası sahte claude ile çalışmalı (CLAUDE_PANEL_CLAUDE_EXE): gerçek oturum açılmaz.
// Kullanım: node cift_tik_test.mjs <debugPort> <url> <var olan klasör>   → çıktı: JSON
const [port, url, cwd] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const wait = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true })).result?.result?.value;
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  localStorage.clear(); localStorage.setItem("panel.settings", JSON.stringify({ lang: "tr", notify: false, sound: false }));
  window.__starts = 0;
  const realFetch = window.fetch;
  window.fetch = async (u, o) => {
    if (o && o.method === "POST" && (String(u) === "/api/hosted" || String(u) === "/api/sessions")) { window.__starts++; await new Promise(r => setTimeout(r, 1500)); }
    return realFetch(u, o);
  };` });
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
await sleep(3000);
await ev(`(() => { document.getElementById("btnNew").click(); document.getElementById("fCwd").value = ${JSON.stringify(cwd)};
  document.getElementById("fCwd").dispatchEvent(new Event("input")); document.getElementById("fPrompt").value = "çift tık denemesi"; })()`);
await sleep(600);
await ev(`(async () => { const b = document.getElementById("btnStart"); for (let i = 0; i < 3; i++) { b.click(); await new Promise(r => setTimeout(r, 60)); } })()`);
const during = await ev(`JSON.stringify({ kilitli: document.getElementById("btnStart").disabled, metin: document.getElementById("btnStart").textContent })`);
await sleep(3500);
const after = await ev(`JSON.stringify({ istek: window.__starts, kilitli: document.getElementById("btnStart").disabled, metin: document.getElementById("btnStart").textContent,
  pencereAcik: document.getElementById("dlgNew").open, hata: document.getElementById("newErr").textContent })`);
console.log(JSON.stringify({ sirasinda: JSON.parse(during), sonra: JSON.parse(after) }));
ws.close();
