// Yeni oturum penceresi: aramaya yazıp listeden seçmeden başlatma engelleniyor mu, içine girilen klasör seçiliyor mu (0.8.12).
// Oturum gerçekten açılmaz: /api/hosted ve /api/sessions istekleri sayfada yakalanır.
// Kullanım: node yeni_oturum_klasor_test.mjs <debugPort> <url> <arama (son projelerde)> <alt klasör araması (Klasörler)>
const [port, url, query, deepQuery] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const wait = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true })).result?.result?.value;
let fail = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "GEÇTİ" : "KALDI"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) fail++; };

await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__starts = [];
  const of = window.fetch;
  window.fetch = (u, o) => {
    const s = String(u);
    if (/\\/api\\/(hosted|sessions)$/.test(s) && o?.method === "POST") {
      window.__starts.push(JSON.parse(o.body));
      return Promise.resolve(new Response(JSON.stringify({ key: "test" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    return of(u, o);
  };` });
await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
await sleep(3000);

const type = (elId, v) => ev(`(() => { const s = document.getElementById("${elId}"); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event("input")); })()`);
const submit = () => ev(`document.getElementById("formNew").requestSubmit()`);
const cwd = () => ev(`document.getElementById("fCwd").value`);
const starts = () => ev(`JSON.stringify(window.__starts)`);

// 1) Son kullanılanlar: aramaya yaz, seçmeden başlat → engellenmeli
await ev(`document.getElementById("btnNew").click()`);
await sleep(1200);
await ev(`document.querySelector('#projTabs [data-tab="recent"]').click()`);
await sleep(300);
const before = await cwd();
await type("projSearch", query);
await sleep(300);
await type("fPrompt", "Devam");
await submit();
await sleep(500);
check("seçmeden başlatma engellendi", (await starts()) === "[]", `önceden seçili: ${before}`);
check("uyarı yazıldı", ((await ev(`document.getElementById("newErr").textContent`)) || "").includes(before), await ev(`document.getElementById("newErr").textContent`));

// 2) Listeden tıkla → aranan klasörde başlamalı
await ev(`document.querySelector("#projList .proj").click()`);
await sleep(300);
const picked = await cwd();
await submit();
await sleep(800);
const s2 = JSON.parse(await starts());
check("listeden seçince başladı", s2.length === 1 && s2[0].cwd === picked && picked.toLowerCase().includes(query.toLowerCase()), `cwd=${s2[0]?.cwd}`);

// 3) Klasörler: kök çipi → alt klasör araması → Enter = içine gir + seç
await ev(`document.getElementById("btnNew").click()`);
await sleep(1200);
await ev(`document.querySelector('#projTabs [data-tab="browse"]').click()`);
await sleep(1000);
await ev(`document.querySelector('#dirRoots .chip')?.click()`);
await sleep(1000);
await type("projSearch", deepQuery);
await sleep(1500);
await ev(`document.getElementById("projSearch").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
await sleep(1200);
const entered = await ev(`[...document.querySelectorAll("#dirCrumbs button")].map(b => b.textContent).join("\\\\")`);
const c3 = await cwd();
check("Enter ile girilen klasör seçildi", c3.toLowerCase().includes(deepQuery.toLowerCase()) && c3.toLowerCase().endsWith(entered.split("\\").pop().toLowerCase()), `cwd=${c3} yol=${entered}`);
check("'Bu klasörü seç' satırı etkin", await ev(`!!document.querySelector("#projList .dir-row.self.active")`));
await type("fPrompt", "Devam");
await submit();
await sleep(800);
const s3 = JSON.parse(await starts());
check("girilen klasörde başladı", s3.length === 2 && s3[1].cwd === c3, `cwd=${s3[1]?.cwd}`);

ws.close();
console.log(fail ? `${fail} kontrol KALDI` : "hepsi geçti");
process.exit(fail ? 1 : 0);
