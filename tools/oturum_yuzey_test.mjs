// Issue #1 madde 4-7 arayüz testi (ortamı tools/oturum_yuzey_test.sh kurar): kart rozeti (Masaüstü uygulaması / VS Code /
// Terminal), soru bekleyen oturum bekleyenler şeridinde ve "cevap bekliyor", masaüstü uygulamasında birincil düğme
// "Uygulamaya git" (Panele al yalnız ⋯ menüsünde), VS Code'da "VS Code'a git", sanal masaüstü rozeti (/api/state yanıtına
// desktops eklenerek; bu makinede tek masaüstü var), çekmece notu, İngilizce, 390 px taşma. Tarayıcı confirm/alert/prompt YOK.
// Kullanım: node oturum_yuzey_test.mjs <debugPort> <url> <çıktıÖneki> <pidMasaüstü> <pidVSCode> <pidSoru>
import { writeFileSync } from "node:fs";
const [port, url, out, pDesk, pCode, pSoru] = process.argv.slice(2);
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

// desk: VS Code oturumu "Masaüstü 2" (adsız), masaüstü uygulaması oturumu "İş" adlı 3. masaüstünde gibi gösterilir.
const INJECT = (lang, light) => `(() => {
  localStorage.setItem("panel.settings", JSON.stringify({ lang: "${lang}", light: ${light}, notify: false, sound: false }));
  window.__n = { confirm: 0, alert: 0, prompt: 0 };
  for (const k of ["confirm", "alert", "prompt"]) window[k] = () => { window.__n[k]++; return k === "confirm" ? false : null; };
  window.addEventListener("error", e => (window.__errors ||= []).push(String(e.message)));
  const real = window.fetch.bind(window);
  window.fetch = async (u, init = {}) => {
    const r = await real(u, init);
    if (String(u) !== "/api/state") return r;
    const d = await r.json();
    d.desktops = { ...d.desktops, "${pCode}": { number: 2, name: null }, "${pDesk}": { number: 3, name: "İş" } };
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
  await until(`document.querySelectorAll(".card").length === 3`);
}
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${out}_${name}.png`, Buffer.from(r.result.data, "base64"));
};
const card = (name) => `[...document.querySelectorAll(".card")].find(c => c.querySelector(".name").textContent === ${JSON.stringify(name)})`;
const info = (name) => ev(`(() => { const c = ${card(name)}; if (!c) return null;
  return { lane: c.closest(".lane")?.dataset.lane, badge: c.querySelector(".kind-badge").textContent,
    reason: c.querySelector(".reason").textContent, primary: c.querySelector(".card-actions .btn:not(.more)")?.textContent ?? null }; })()`);

await load("tr", false);
check("3 kart", await ev(`document.querySelectorAll(".card").length`), 3);
check("masaüstü uygulaması kartı", await info("Masaustu Projesi"),
  { lane: "idle", badge: "Masaüstü uygulaması · İş", reason: "", primary: "Uygulamaya git" });
check("VS Code kartı", await info("Kod Projesi"), { lane: "idle", badge: "VS Code · Masaüstü 2", reason: "", primary: "Panele al" });
check("soru bekleyen kart bekleyenlerde", await info("Soru Projesi"),
  { lane: "idle", badge: "Terminal", reason: "cevap bekliyor", primary: "Sekmeye git" });

// ⋯ menüleri
const menuOf = async (name) => {
  await ev(`${card(name)}.querySelector(".more").click()`);
  await sleep(150);
  const items = await ev(`[...document.querySelectorAll(".pop-menu [role=menuitem], .pop-menu button")].map(b => b.textContent)`);
  await ev(`document.body.click()`); await sleep(100);
  return items;
};
const mDesk = await menuOf("Masaustu Projesi");
check("masaüstü uygulaması ⋯: Uygulamaya git + Panele al", [mDesk.includes("Uygulamaya git"), mDesk.includes("Panele al")], [true, true]);
const mSoru = await menuOf("Soru Projesi");
check("soru bekleyen ⋯: Panele al YOK", mSoru.includes("Panele al"), false);
const mCode = await menuOf("Kod Projesi");
check("VS Code ⋯: VS Code'a git", mCode.includes("VS Code'a git"), true);

// Çekmece notu
await ev(`[...${card("Masaustu Projesi")}.querySelectorAll(".card-actions .btn:not(.more)")].at(-1).click()`); // Konuşmayı aç
await until(`!document.getElementById("dNote").hidden`, 5000);
check("çekmece notu: uygulamada arşivleyin", await ev(`document.getElementById("dNote").textContent.includes("uygulamada arşivleyin")`), true);
await shot("cekmece");
await ev(`document.querySelector("#drawer .close, #dClose")?.click()`); await sleep(200);

// Çakışma penceresi: aynı projede yeni oturum açılmak istenince. Masaüstü uygulaması oturumu "Panele al" diye önerilmez,
// listede "(Masaüstü uygulaması)" yazar; VS Code oturumu önerilir, "(VS Code)" yazar.
const conflictFor = async (name) => {
  const cwd = await ev(`fetch("/api/state").then(r => r.json()).then(d => d.sessions.find(s => s.name === ${JSON.stringify(name)}).cwd)`);
  await ev(`(() => { document.getElementById("btnNew").click(); const f = document.getElementById("fCwd"); f.value = ${JSON.stringify(cwd)}; f.dispatchEvent(new Event("input"));
    const p = document.getElementById("fPrompt"); if (p) p.value = "deneme"; })()`);
  await sleep(500);
  await ev(`document.getElementById("btnStart").click()`);
  if (!(await until(`!!document.querySelector("#dlgAsk[open]")`, 5000)))
    console.log("ÇAKIŞMA PENCERESİ YOK:", await ev(`JSON.stringify({ err: document.getElementById("newErr")?.textContent, newOpen: document.getElementById("dlgNew").open, cwd: document.getElementById("fCwd").value, toasts: [...document.querySelectorAll(".toast")].map(x => x.textContent), sessions: document.querySelectorAll(".card").length })`));
  const b = await ev(`({ list: [...document.querySelectorAll("#askList li")].map(x => x.textContent), buttons: [...document.querySelectorAll("#askButtons button")].map(b => b.value) })`);
  await ev(`document.querySelector('#dlgAsk[open] button[value="cancel"]').click()`); await sleep(300);
  await ev(`document.getElementById("dlgNew").close()`); await sleep(200);
  return b;
};
let cf = await conflictFor("masaustu");
check("çakışma: masaüstü uygulaması oturumu etiketli, Panele al önerilmiyor", [cf.list, cf.buttons.includes("adopt")], [["Masaustu Projesi — bekliyor (Masaüstü uygulaması)"], false]);
cf = await conflictFor("kod");
check("çakışma: VS Code oturumu etiketli, Panele al önerilir", [cf.list, cf.buttons.filter(v => v !== "cancel")[0]], [["Kod Projesi — bekliyor (VS Code)"], "adopt"]);

await shot("1280_koyu");
await load("tr", false, 390, 844);
const over = await ev(`[...document.querySelectorAll(".card")].filter(c => c.scrollWidth > c.clientWidth + 1).length`);
check("390 px: kartta yatay taşma yok", over, 0);
const badgeFit = await ev(`[...document.querySelectorAll(".kind-badge")].every(b => b.getBoundingClientRect().right <= b.closest(".card").getBoundingClientRect().right + 0.5)`);
check("390 px: rozet kartın içinde", badgeFit, true);
await shot("390");

await load("en", true);
check("EN masaüstü kartı", await info("Masaustu Projesi"), { lane: "idle", badge: "Desktop app · İş", reason: "", primary: "Go to app" });
check("EN soru bekleyen", (await info("Soru Projesi")).reason, "waiting for your answer");
await shot("1280_acik_en");

check("tarayıcı confirm/alert/prompt yok", await ev(`window.__n`), { confirm: 0, alert: 0, prompt: 0 });
check("sayfa hatası yok", await ev(`window.__errors || []`), []);
console.log(`${pass} geçti, ${fail} kaldı`);
ws.close();
process.exit(fail ? 1 : 0);
