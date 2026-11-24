// Başsız Chrome'da paneli farklı genişliklerde açar; yatay taşmayı ölçer, ekran görüntüsü alır.
// Kullanım: node kart_shot.mjs <debugPort> <url> <outDir> [genişlikler,virgüllü] [--menu] [--select]
import { writeFileSync } from "node:fs";
const [port, url, outDir, widthsArg = "390,760,980,1280", ...flags] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const wait = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true })).result?.result?.value;
for (const w of widthsArg.split(",").map(Number)) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: w < 640 ? 1500 : 1100, deviceScaleFactor: 1, mobile: w < 640 });
  await send("Page.navigate", { url });
  await sleep(1500);
  // Sabit profil önceki koşunun dil tercihini taşır (headless-browser.md): temizle, istenen dili aç.
  await ev(`localStorage.clear(); localStorage.setItem("panel.settings", JSON.stringify({ lang: "${process.env.LANG_UI || "tr"}" })); location.reload()`);
  await sleep(3500);
  if (flags.includes("--select")) { await ev(`document.querySelector(".card")?.dispatchEvent(new MouseEvent("click",{bubbles:true,ctrlKey:true}))`); await sleep(500); }
  if (flags.includes("--search")) { await ev(`(() => { const s = document.getElementById("search"); s.value = "loyal"; s.dispatchEvent(new Event("input")); })()`); await sleep(500); }
  if (flags.includes("--selflow")) {
    const st = () => ev(`JSON.stringify({ mod: document.documentElement.classList.contains("selecting"), secili: document.querySelectorAll(".card.selected").length, dugme: document.getElementById("bulkAll").textContent, sayi: document.getElementById("bulkCount").textContent })`);
    await ev(`document.querySelector(".card.can-select .sel-box").click()`); await sleep(300); console.log("kutuya tık:", await st());
    await ev(`document.getElementById("bulkAll").click()`); await sleep(300); console.log("tümünü seç:", await st());
    await ev(`document.getElementById("bulkAll").click()`); await sleep(300); console.log("seçimi kaldır:", await st());
    await ev(`document.querySelector(".card.can-select").click()`); await sleep(300); console.log("karta tık:", await st());
  }
  if (flags.includes("--bulkbar")) {
    // Tümünü seç (terminal oturumları dahil); düğmelerin durumu ve çubuğun taşması. Hiçbir düğmeye BASILMAZ.
    await ev(`document.querySelector(".card.can-select .sel-box").click()`); await sleep(200);
    await ev(`document.getElementById("bulkAll").click()`); await sleep(400);
    console.log(w, "toplu:", await ev(`(() => {
      const bar = document.getElementById("bulkBar"), r = bar.getBoundingClientRect();
      const btn = [...bar.querySelectorAll("button[data-bulk]")].map(b => b.dataset.bulk + (b.hidden ? ":gizli" : b.disabled ? ":kapalı" : ":açık") + (b.title ? "(" + b.title + ")" : ""));
      const tasan = [...bar.querySelectorAll("button, b")].filter(e => { const q = e.getBoundingClientRect(); return q.width && (q.right > r.right + 1 || q.left < r.left - 1); }).length;
      return JSON.stringify({ secilebilir: document.querySelectorAll(".card.can-select").length, kart: document.querySelectorAll(".card").length, secili: document.querySelectorAll(".card.selected").length, btn, tasan, cubuk: [Math.round(r.left), Math.round(r.right), Math.round(r.height)] });
    })()`));
  }
  if (flags.includes("--phonehelp")) {
    // "Nasıl kurulur?" rehberi: masaüstü bölümüne kaydır, görüntü al, taşma ölç.
    await ev(`document.querySelector("[data-help=phone]").click()`); await sleep(500);
    console.log(w, "rehber:", await ev(`(() => {
      const g = document.getElementById("phoneGuide"), h = [...g.querySelectorAll("h4")].find(x => x.textContent.includes("${process.env.LANG_UI === "en" ? "desktop" : "masaüstü"}"));
      if (!h) return "bölüm yok";
      g.scrollTop = h.offsetTop - g.offsetTop - 4;
      return JSON.stringify({ yatay: g.scrollWidth > g.clientWidth + 1, liste: h.parentElement.querySelectorAll("ol").length });
    })()`));
    await sleep(300);
    const sh = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${outDir}/rehber_${process.env.LANG_UI || "tr"}_${w}.png`, Buffer.from(sh.result.data, "base64"));
  }
  if (flags.includes("--settings")) {
    await ev(`document.getElementById("btnSettings").click()`); await sleep(700);
    // Ayarlar: onay kutulu satırlar kabın genişliğini kullanıyor mu, metin kutuları üst üste biniyor mu?
    console.log(w, "ayarlar:", await ev(`(() => {
      const d = document.getElementById("viewSettings"); const dw = d.getBoundingClientRect().width;
      const dar = [...d.querySelectorAll("label.check")].filter(l => l.offsetParent).map(l => ({ id: l.querySelector("input").id, w: Math.round(l.getBoundingClientRect().width), kap: Math.round(l.parentElement.getBoundingClientRect().width) })).filter(x => x.w < x.kap * 0.8);
      const els = [...d.querySelectorAll("label, legend, p, .hint, button, select, input:not([type=checkbox])")].filter(e => e.offsetParent && e.getBoundingClientRect().width);
      const cak = [];
      for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
        const a = els[i], b = els[j]; if (a.contains(b) || b.contains(a)) continue;
        const r = a.getBoundingClientRect(), q = b.getBoundingClientRect();
        if (r.left < q.right - 1 && q.left < r.right - 1 && r.top < q.bottom - 1 && q.top < r.bottom - 1) cak.push((a.id || a.tagName) + "~" + (b.id || b.tagName + ":" + b.textContent.trim().slice(0, 20)));
      }
      return JSON.stringify({ dw: Math.round(dw), dar, cakisma: cak.slice(0, 8), yatayKaydirma: d.scrollWidth > d.clientWidth + 1 });
    })()`));
    const sh1 = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${outDir}/ayar_${w}_ust.png`, Buffer.from(sh1.result.data, "base64"));
    await ev(`[...document.querySelectorAll("#viewSettings, #viewSettings *")].forEach(e => { if (e.scrollHeight > e.clientHeight + 4) e.scrollTop = e.scrollHeight; })`); await sleep(300);
    const sh2 = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${outDir}/ayar_${w}_alt.png`, Buffer.from(sh2.result.data, "base64"));
  }
  if (flags.includes("--menu")) { await ev(`document.querySelector(".card .more")?.click()`); await sleep(400); }
  const over = await ev(`(() => { const W = document.documentElement.clientWidth; const bad = [...document.querySelectorAll("body *")].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > W + 1 && getComputedStyle(e).position !== "fixed"; }).slice(0,5).map(e => e.className || e.tagName); return JSON.stringify({ W, scrollW: document.documentElement.scrollWidth, bad, err: window.__err || null }); })()`);
  console.log(w, over);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${outDir}/k_${w}${flags.join("").replace(/-/g, "")}.png`, Buffer.from(shot.result.data, "base64"));
}
ws.close();
