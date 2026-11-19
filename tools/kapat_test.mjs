// Paneli kapat / yeniden açılış sayfa testi (tools/kapat_test.sh kurar).
// Kip "yenile": sayfa açılır, işaret konur; betik sunucuyu kapatıp aynı portta yenisini açar; sayfa kendini yenilemeli (işaret silinir).
// Kip "kapat": Paneli kapat düğmesi → onay → sunucu kapanır; başsız tarayıcı window.close()'u reddeder → "Panel kapandı" yazısı.
// Kullanım: node kapat_test.mjs <debugPort> <url> <kip> [bekleme dosyası]
import { existsSync } from "node:fs";
const [port, url, mode, flag] = process.argv.slice(2);
const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const wait = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const until = async (e, ms = 15000) => { for (let i = 0; i < ms / 250; i++) { if (await ev(e)) return true; await sleep(250); } return false; };
let fail = 0;
const check = (name, got, want) => { const ok = got === want; if (!ok) fail = 1; console.log(`${ok ? "GEÇTİ " : "KALDI "} ${name}${ok ? "" : ` (beklenen ${want}, gelen ${got})`}`); };

await send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("panel.settings", JSON.stringify({ lang: "tr", notify: false, sound: false }));
  for (const k of ["confirm", "alert", "prompt"]) window[k] = () => { throw new Error("yerleşik pencere: " + k); };
  window.addEventListener("error", e => (window.__errors ||= []).push(String(e.message)));
  window.addEventListener("unhandledrejection", e => (window.__errors ||= []).push(String(e.reason)));` });
await send("Page.navigate", { url });
check("sayfa açıldı", await until(`!!document.querySelector("#ver") && document.querySelector("#ver").textContent.startsWith("v")`), true);

if (mode === "yenile") {
  await sleep(2500); // en az bir yoklama: sayfa ilk açılış kimliğini öğrensin
  await ev(`window.__eski = 1`);
  console.log("HAZIR"); // betik sunucuyu yeniden açar, sonra dosyayı yazar
  for (let i = 0; i < 120 && !existsSync(flag); i++) await sleep(250);
  check("sunucu yeniden açılınca sayfa kendini yeniledi", await until(`window.__eski === undefined && !!document.querySelector("#ver")`, 20000), true);
} else {
  await ev(`document.getElementById("btnQuit").click()`);
  // Panelde oturum yokken onay sorulmaz; varsa panelin kendi penceresi çıkar → onayla.
  await sleep(600);
  await ev(`(() => { const b = document.querySelector("dialog[open] .btn.danger, dialog[open] .btn.primary"); if (b) b.click(); })()`);
  // Tarayıcı window.close()'u kabul ederse sayfa kapanır (istenen); reddederse "Panel kapandı" yazısı çıkmalı.
  let closed = false, shown = false;
  for (let i = 0; i < 32 && !closed && !shown; i++) {
    await sleep(250);
    closed = !(await (await fetch(`http://127.0.0.1:${port}/json`)).json()).some(t => t.id === page.id);
    if (!closed) shown = !!(await ev(`document.querySelector(".quit-done")?.textContent === I18N[document.documentElement.lang].quitDone`));
  }
  check("sayfa kapandı ya da kapanış yazısı göründü", closed || shown, true);
  console.log(`       (${closed ? "tarayıcı pencereyi kapattı" : "pencere kapanmadı, yazı gösterildi"})`);
  if (!closed) {
    await sleep(3000); // birkaç yoklama turu: kapanmış sunucuya istek hata atmasın
    check("kapanıştan sonra sayfa hatası yok", await ev(`(window.__errors || []).length`), 0);
  }
}
process.exit(fail);
