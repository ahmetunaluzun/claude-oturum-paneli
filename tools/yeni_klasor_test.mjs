// Yeni oturum → Klasörler → "Yeni klasör" arayüz testi (0.23.0). Kullanım: node yeni_klasor_test.mjs <debugPort> <url> <başlangıç klasörü>
const [port, url, base] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const wait = new Map();
const jsErrors = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.method === "Runtime.exceptionThrown") jsErrors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true })).result?.result?.value;
let fail = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "GEÇTİ" : "KALDI"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) fail++; };
const key = (k) => ev(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "${k}", bubbles: true, cancelable: true }))`);
const typeNew = (v) => ev(`(() => { const s = document.getElementById("dirNewName"); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event("input")); s.focus(); })()`);
const cwd = () => ev(`document.getElementById("fCwd").value`);
const err = () => ev(`document.getElementById("dirNewErr")?.textContent || ""`);
const shot = async (file) => { const r = await send("Page.captureScreenshot", { format: "png" }); (await import("node:fs")).writeFileSync(file, Buffer.from(r.result.data, "base64")); };

for (const [w, h, label] of [[1200, 900, "geniş"], [390, 844, "telefon"]]) {
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
  await send("Page.navigate", { url }); await sleep(2500);
  await ev(`document.getElementById("btnNew").click()`); await sleep(800);
  await ev(`(() => { const f = document.getElementById("fCwd"); f.value = ${JSON.stringify(base + "\\yok")}; })()`);
  await ev(`document.querySelector('#projTabs [data-tab="browse"]').click()`); await sleep(1000);
  // Gezgin son gezilen klasörü hatırlar: başlangıç klasörüne dön
  await ev(`(() => { const b = [...document.querySelectorAll("#dirCrumbs button")].find(x => x.textContent === ${JSON.stringify(base.split("\\").pop())}); b?.click(); })()`);
  await sleep(800);
  check(`[${label}] Yeni klasör düğmesi görünür`, await ev(`(() => { const b = document.getElementById("dirNew"); const r = b.getBoundingClientRect(); return !b.hidden && r.width > 0 && r.right <= innerWidth && document.elementFromPoint(r.x + r.width/2, r.y + r.height/2)?.closest("#dirNew") === b; })()`));
  await ev(`document.getElementById("dirNew").click()`); await sleep(300);
  check(`[${label}] ad kutusu açıldı ve odakta`, await ev(`document.activeElement?.id === "dirNewName"`));
  // Esc: yalnız satır kapanır, pencere açık kalır
  await key("Escape"); await sleep(300);
  check(`[${label}] Esc satırı kapattı`, await ev(`!document.getElementById("dirNewName")`));
  check(`[${label}] Esc pencereyi kapatmadı`, await ev(`document.getElementById("dlgNew").open`));
  // Geçersiz ad
  await ev(`document.getElementById("dirNew").click()`); await sleep(300);
  await typeNew("a:b"); await key("Enter"); await sleep(600);
  check(`[${label}] geçersiz ad uyarısı`, (await err()).includes(":"), await err());
  // Boş ad
  await typeNew("   "); await ev(`document.getElementById("dirNewOk").click()`); await sleep(400);
  check(`[${label}] boş ad uyarısı`, (await err()).length > 0, await err());
  // Var olan ad
  await typeNew("Var Olan"); await key("Enter"); await sleep(600);
  check(`[${label}] var olan ad uyarısı`, /zaten var|already exists/.test(await err()), await err());
  check(`[${label}] form gönderilmedi (pencere açık)`, await ev(`document.getElementById("dlgNew").open`));
  if (label === "telefon") await shot(process.env.SHOT_DIR + "\\yeni_klasor_hata_telefon.png");
  // Yeni ad → oluşturulur, içine girilir, seçilir
  const name = label === "geniş" ? "Yeni Proje İşi" : "Telefon Projesi";
  await typeNew(name); await key("Enter"); await sleep(1200);
  const c = await cwd();
  check(`[${label}] oluşturulan klasör seçildi`, c === base + "\\" + name, c);
  check(`[${label}] klasörün içine girildi`, (await ev(`[...document.querySelectorAll("#dirCrumbs button")].pop()?.textContent`)) === name);
  check(`[${label}] 'Bu klasörü seç' etkin`, await ev(`!!document.querySelector("#projList .dir-row.self.active")`));
  check(`[${label}] ad satırı kapandı`, await ev(`!document.getElementById("dirNewName")`));
  check(`[${label}] odak mesaj kutusunda`, await ev(`document.activeElement?.id === "fPrompt"`));
  if (label === "geniş") await shot(process.env.SHOT_DIR + "\\yeni_klasor_sonra_genis.png");
  await ev(`document.getElementById("dlgNew").close()`);
}
// Kök ("Bu bilgisayar") görünümünde düğme gizli
await ev(`document.getElementById("btnNew").click()`); await sleep(800);
await ev(`document.querySelector('#projTabs [data-tab="browse"]').click()`); await sleep(800);
await ev(`document.querySelector('#dirCrumbs button')?.click()`);
// Sürücü listesi bağlı olmayan ağ sürücülerinde 30 sn sürebilir (DriveInfo.IsReady)
for (let i = 0; i < 240 && !(await ev(`document.getElementById("dirUp").disabled`)); i++) await sleep(250);
check("sürücü listesinde Yeni klasör gizli", await ev(`document.getElementById("dirNew").hidden`), await ev(`JSON.stringify({crumbs: document.getElementById("dirCrumbs").textContent, tab: document.querySelector("#projTabs .active")?.dataset.tab, open: document.getElementById("dlgNew").open})`));
check("sayfada JS hatası yok", jsErrors.length === 0, jsErrors.join(" | ").slice(0, 400));
ws.close();
console.log(fail ? `${fail} kontrol KALDI` : "hepsi geçti");
process.exit(fail ? 1 : 0);
