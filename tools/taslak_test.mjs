// Gönderilmemiş taslak arayüz testi (ortamı tools/taslak_test.sh kurar; iki panel oturumu: "Taslak A", "Taslak B").
// A'ya yazılır, çekmece ✕ ile kapanır → B boş açılır, B'ye yazılır → A'ya dönünce A'nın taslağı geri gelir; sayfa yenilenince
// (panel yeniden açılışı) B'nin taslağı durur; gönderilen mesajın taslağı silinir. Tarayıcı confirm/alert/prompt YOK.
// Kullanım: node taslak_test.mjs <debugPort> <url>
const [port, url] = process.argv.slice(2);
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
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail = 1;
  console.log(`${ok ? "GEÇTİ " : "KALDI "} ${name}${ok ? "" : ` (beklenen ${JSON.stringify(want)}, gelen ${JSON.stringify(got)})`}`);
};
const until = async (expr, ms = 15000) => { for (let i = 0; i < ms / 250; i++) { if (await ev(expr)) return true; await sleep(250); } return false; };

const open = async (name) => {
  await ev(`[...document.querySelectorAll(".card")].find(c => c.querySelector(".name").textContent === ${JSON.stringify(name)})
    .querySelector(".card-actions").querySelectorAll(".btn")
    .forEach(b => { if (b.textContent === "Konuşma") b.click(); })`);
  await until(`document.body.classList.contains("drawer-open") && !document.getElementById("dInput").disabled`);
  await sleep(300);
};
const close = async () => { await ev(`document.getElementById("dClose").click()`); await sleep(300); };
const type = (text) => ev(`(() => { const el = document.getElementById("dInput"); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event("input")); })()`);
const value = () => ev(`document.getElementById("dInput").value`);

await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
  if (!localStorage.getItem("panel.settings")) localStorage.setItem("panel.settings", JSON.stringify({ lang: "tr", light: false, notify: false, sound: false }));
  for (const k of ["confirm", "alert", "prompt"]) window[k] = () => { throw new Error("yerleşik pencere: " + k); };
  window.addEventListener("error", e => (window.__errors ||= []).push(String(e.message)));
})();` });
await send("Page.navigate", { url });
check("iki kart göründü", await until(`document.querySelectorAll(".card").length === 2`), true);

await open("Taslak A");
check("A ilk açılışta boş", await value(), "");
await type("A için yarım kalan\nikinci satır");
await close();
await open("Taslak B");
check("B, A'nın taslağını göstermiyor", await value(), "");
await type("B taslağı");
await close();
await open("Taslak A");
check("A'ya dönünce taslak geri geldi (satır sonu dahil)", await value(), "A için yarım kalan\nikinci satır");
check("taslak varken Gönder soluk değil", await ev(`document.getElementById("dSend").classList.contains("send-empty")`), false);
await close();

await send("Page.reload");
await sleep(500);
check("yenilemeden sonra kartlar", await until(`document.querySelectorAll(".card").length === 2`), true);
await open("Taslak B");
check("panel yeniden açılınca B'nin taslağı duruyor", await value(), "B taslağı");
await type("   ");
await close();
check("yalnız boşluk kalan taslak silindi", await ev(`Object.keys(JSON.parse(localStorage.getItem("panel.drafts") || "{}")).length`), 1);

await open("Taslak A");
await ev(`document.getElementById("dSend").click()`);
check("gönderince kutu boşaldı", await until(`document.getElementById("dInput").value === ""`, 8000), true);
await close();
check("gönderilen taslak kayıttan silindi", await ev(`localStorage.getItem("panel.drafts")`), "{}");
await open("Taslak A");
check("A yeniden açılınca boş", await value(), "");
await close();

check("sayfa hatası yok", await ev(`(window.__errors || []).length`), 0);
process.exit(fail);
