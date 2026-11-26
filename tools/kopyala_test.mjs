// Konuşmada Kopyala simgeleri arayüz testi (ortamı tools/kopyala_test.sh kurar; bir panel oturumu: "Kopya").
// Döküm isteği (/api/transcript) CDP Fetch ile sahte içerikle yanıtlanır: kod bloklu mail mesajı + alıntı/başlık/tablolu mesaj.
// 1280 ve 390 px'te: simgeler görünür ve en az 40 px; kod bloğu simgesi yalnız bloğun içini, mesaj simgesi markdown işaretsiz
// düz metni panoya koyar (pano sayfa içinde okunur); navigator.clipboard reddedince textarea + execCommand yedeği çalışır;
// basınca ✓, 1,5 sn sonra geri; çekmece kabuğu seçilemez, mesaj metni seçilebilir. Görüntü: <klasör>\kopyala_<genişlik>.png
// Kullanım: node kopyala_test.mjs <debugPort> <url> <görüntü klasörü>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const [port, url, shotDir] = process.argv.slice(2);
const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const wait = new Map();
const CODE = "Konu: Toplantı talebi\n\nMerhaba Bayram Bey,\n**yıldız** ve `ters tırnak` aynen kalır.\n> bu satır kodun içinde\nSaygılarımla";
const MSG1 = "Mail metni aşağıda:\n\n```text\n" + CODE + "\n```\n\nGönderebilirsiniz.";
const PLAIN1 = "Mail metni aşağıda:\n\n" + CODE + "\n\nGönderebilirsiniz.";
const MSG2 = "> **Önemli:** `C` sürümü\n## Başlık\n- madde bir\n| a | b |\n|---|---|\n| 1 | 2 |";
const PLAIN2 = "Önemli: C sürümü\nBaşlık\n- madde bir\n| a | b |\n| 1 | 2 |";
const now = new Date().toISOString();
const BODY = Buffer.from(JSON.stringify({ title: "Kopya", items: [
  { id: "u1", kind: "user", text: "mail yaz", ts: now },
  { id: "a1", kind: "assistant", text: MSG1, ts: now },
  { id: "a2", kind: "assistant", text: MSG2, ts: now },
] })).toString("base64");
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); }
  if (d.method === "Fetch.requestPaused") send("Fetch.fulfillRequest", { requestId: d.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "application/json; charset=utf-8" }], body: BODY });
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
// Gerçek dokunuş/tıklama: öğe ortaya kaydırılır, merkezine fare olayı gönderilir (kullanıcı etkinliği sayılır).
const tap = async (sel) => {
  const r = await ev(`(() => { const e = ${sel}; e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  await sleep(150);
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
  await sleep(250);
};
// Windows panosu satır sonunu CRLF'ye çevirir; içerik karşılaştırması LF ile.
const clip = async () => (await ev(`navigator.clipboard.readText()`)).replace(/\r\n/g, "\n");
const reset = () => ev(`navigator.clipboard.writeText("-")`);
const CODEBTN = `document.querySelector("#dMessages .msg.assistant .msg-copy-code .msg-copy-btn")`;
const MSGBTN = (n) => `document.querySelectorAll("#dMessages .msg.assistant > .msg-copy-bar .msg-copy-btn")[${n}]`;

await send("Page.enable");
await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/transcript/*" }] });
await send("Browser.grantPermissions", { origin: new URL(url).origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
  if (!localStorage.getItem("panel.settings")) localStorage.setItem("panel.settings", JSON.stringify({ lang: "tr", light: false, notify: false, sound: false }));
  for (const k of ["confirm", "alert", "prompt"]) window[k] = () => { throw new Error("yerleşik pencere: " + k); };
  window.addEventListener("error", e => (window.__errors ||= []).push(String(e.message)));
})();` });

for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
  console.log(`--- ${w} px ---`);
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await send("Page.navigate", { url });
  check(`${w}: kart göründü`, await until(`document.querySelectorAll(".card").length === 1`), true);
  await ev(`[...document.querySelector(".card .card-actions").querySelectorAll(".btn")].find(b => b.textContent === "Konuşma").click()`);
  check(`${w}: döküm geldi`, await until(`document.querySelectorAll("#dMessages .msg.assistant").length === 2`), true);
  await sleep(400);
  check(`${w}: kod bloğu başına bir simge`, await ev(`document.querySelectorAll("#dMessages .msg-copy-code .msg-copy-btn").length`), 1);
  check(`${w}: asistan mesajı başına bir simge`, await ev(`document.querySelectorAll("#dMessages .msg.assistant > .msg-copy-bar .msg-copy-btn").length`), 2);
  check(`${w}: kullanıcı mesajında simge yok`, await ev(`document.querySelectorAll("#dMessages .msg.user .msg-copy-btn").length`), 0);
  check(`${w}: simge metinsiz, aria-label/title Kopyala`, await ev(`[...document.querySelectorAll("#dMessages .msg-copy-btn")].every(b => b.textContent.trim() === "" && b.getAttribute("aria-label") === "Kopyala" && b.title === "Kopyala")`), true);
  // Görünürlük + dokunma alanı + konum (kod: bloğun sağ üstü; mesaj: mesajın altı, saatin üstünde)
  for (const [name, sel] of [["kod simgesi", CODEBTN], ["mesaj simgesi", MSGBTN(0)]]) {
    const g = await ev(`(() => { const e = ${sel}; e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); const s = getComputedStyle(e);
      const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return { w: b.width >= 40, h: b.height >= 40, inView: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight,
        shown: s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0", onTop: e.contains(top) }; })()`);
    check(`${w}: ${name} görünür, en az 40x40, üstte`, g, { w: true, h: true, inView: true, shown: true, onTop: true });
  }
  check(`${w}: kod simgesi bloğun sağ üstünde`, await ev(`(() => { const b = ${CODEBTN}.getBoundingClientRect(), p = document.querySelector("#dMessages .msg-copy-code pre").getBoundingClientRect();
    return Math.abs(b.right - p.right) <= 4 && Math.abs(b.top - p.top) <= 4; })()`), true);
  check(`${w}: mesaj simgesi metnin altında, saatin üstünde`, await ev(`(() => { const m = document.querySelectorAll("#dMessages .msg.assistant")[0], bar = m.querySelector(":scope > .msg-copy-bar");
    const t = m.querySelector(":scope > .msg-time"); return bar.previousElementSibling.tagName === "P" && (!t || bar.nextElementSibling === t); })()`), true);

  // Pano (güvenli bağlam: navigator.clipboard)
  await reset(); await tap(CODEBTN);
  check(`${w}: kod simgesi yalnız bloğun içini kopyaladı`, await clip(), CODE);
  check(`${w}: basınca ✓ (done)`, await ev(`${CODEBTN}.classList.contains("done") && ${CODEBTN}.getAttribute("aria-label") === "Kopyalandı"`), true);
  await sleep(1700);
  check(`${w}: 1,5 sn sonra simge geri geldi`, await ev(`!${CODEBTN}.classList.contains("done") && ${CODEBTN}.getAttribute("aria-label") === "Kopyala"`), true);
  await reset(); await tap(MSGBTN(0));
  check(`${w}: mesaj simgesi düz metni kopyaladı (\`\`\` yok)`, await clip(), PLAIN1);
  await reset(); await tap(MSGBTN(1));
  check(`${w}: alıntı/başlık/** /\` işaretleri atıldı`, await clip(), PLAIN2);

  // Yedek yol: clipboard reddediyor (HTTP/izin yok) → textarea + execCommand, seçilen metin doğrulanır
  await ev(`(() => { window.__origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = () => Promise.reject(new Error("izin yok"));
    const orig = document.execCommand.bind(document);
    document.execCommand = (c, ...r) => { const a = document.activeElement; window.__sel = a && "value" in a ? a.value.slice(a.selectionStart, a.selectionEnd) : null; return orig(c, ...r); };
  })()`);
  await ev(`window.__origWrite("-")`);
  await tap(CODEBTN);
  check(`${w}: yedek yol yalnız kod bloğunu seçti`, await ev(`window.__sel`), CODE);
  check(`${w}: yedek yol panoya koydu`, await clip(), CODE);
  check(`${w}: yedek textarea kaldırıldı`, await ev(`document.querySelectorAll(".msg-copy-ta").length`), 0);

  // Seçim: kabuk seçilemez, mesaj seçilebilir
  check(`${w}: çekmece başlığı seçilemez`, await ev(`getComputedStyle(document.querySelector(".drawer-head")).userSelect`), "none");
  check(`${w}: asistan mesajı seçilebilir`, await ev(`getComputedStyle(document.querySelector("#dMessages .msg.assistant p")).userSelect`), "text");
  check(`${w}: kod bloğu seçilebilir`, await ev(`getComputedStyle(document.querySelector("#dMessages pre code")).userSelect`), "text");
  check(`${w}: yazı kutusu seçilebilir`, await ev(`getComputedStyle(document.getElementById("dInput")).userSelect`), "text");

  await ev(`document.querySelector("#dMessages .msg.assistant").scrollIntoView({ block: "start" })`);
  await sleep(1700); // ✓ geri dönsün: görüntüde kopyala simgesi görünsün
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(shotDir, `kopyala_${w}.png`), Buffer.from(shot.result.data, "base64"));
  check(`${w}: sayfa hatası yok`, await ev(`(window.__errors || []).length`), 0);
}
console.log(`${passed} geçti, ${fail} kaldı`);
process.exit(fail ? 1 : 0);
