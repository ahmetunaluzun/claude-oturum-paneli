// Onay penceresi testi (0.11.1): panelde tarayıcının yerleşik confirm/alert/prompt penceresi HİÇ çağrılmamalı; her soru
// panelin kendi penceresiyle (confirmBox) sorulmalı ve seçilen düğme doğru sonucu vermeli.
// Uydurma veri sayfaya fetch sarmalayıcısıyla verilir (terminal oturumu, panel oturumu, eşleşmiş cihaz); gerçek claude
// çalışmaz, test kopyasında oturum açılmaz. EN SONDA "Paneli kapat" gerçekten onaylanır: test kopyası kapanmalı.
// Çalıştıran: tools/confirm_test.sh (ortamı kurar). Doğrudan: node confirm_test.mjs <debugPort> <url> <çıktıÖneki>
import { writeFileSync } from "node:fs";
const [port, url, out] = process.argv.slice(2);
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

// Sayfa açılmadan önce: yerleşik pencereleri sayaçla sarmala, sunucu yanıtlarına uydurma veri ekle.
const INJECT = (lang, light) => `(() => {
  localStorage.clear();
  localStorage.setItem("panel.settings", JSON.stringify({ lang: "${lang}", light: ${light}, notify: false, sound: false }));
  window.__n = { confirm: 0, alert: 0, prompt: 0 };
  for (const k of ["confirm", "alert", "prompt"]) window[k] = () => { window.__n[k]++; return k === "confirm" ? false : null; };
  window.__calls = [];
  window.__mock = { quit: "swallow", devices: [{ id: "d1", name: "Demo Telefon", lastSeen: Date.now() - 3600000 }] };
  window.addEventListener("error", e => (window.__errors ||= []).push(String(e.message)));
  window.addEventListener("unhandledrejection", e => (window.__errors ||= []).push(String(e.reason)));
  const real = window.fetch.bind(window);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  window.fetch = async (u, init = {}) => {
    u = String(u);
    if ((init.method || "GET").toUpperCase() === "POST") window.__calls.push(u);
    if (u === "/api/state") {
      const st = await (await real(u, init)).json();
      const s = (n, pid, name) => ({ sessionId: "t-" + n, kind: "interactive", pid, cwd: "C:\\\\Demo\\\\" + name, status: "idle", statusSince: st.now - 60000, startedAt: st.now - 600000 });
      st.sessions = [...(st.sessions || []), s(1, 91001, "Örnek API"), s(2, 91002, "Demo Mağaza")];
      st.hosted = [...(st.hosted || []), { key: "k1", sessionId: "h-1", name: "Rapor Aracı", cwd: "C:\\\\Demo\\\\Rapor Aracı", status: "idle", statusSince: st.now - 30000, startedAt: st.now - 900000, costUsd: 0 }];
      return json(st);
    }
    if (u === "/api/remote" || u.startsWith("/api/remote/revoke/")) {
      if (u !== "/api/remote") window.__mock.devices = [];
      const st = await (await real("/api/remote", { cache: "no-store" })).json();
      return json({ ...st, devices: window.__mock.devices });
    }
    if (u.startsWith("/api/adopt/")) return json({ key: "kx" });
    if (u === "/api/remote/forget") return json({});
    if (u.startsWith("/api/quit") && window.__mock.quit !== "real") {
      return window.__mock.quit === "409" && !u.includes("force") ? json({ error: "busy" }, 409) : json({});
    }
    return real(u, init);
  };
})();`;

await send("Page.enable");
await send("Emulation.setFocusEmulationEnabled", { enabled: true }); // yeniden açılan sayfada da :focus eşleşsin (odak çerçevesi görüntüde)
let injected = null;
const native = { confirm: 0, alert: 0, prompt: 0 }, errors = []; // sayfa her yeniden açıldığında toplanır
async function tally() {
  const n = await ev(`window.__n`);
  for (const k in native) native[k] += n[k];
  errors.push(...await ev(`window.__errors || []`));
}
async function open(width, lang = "tr", light = false) {
  if (injected) await tally();
  if (injected) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected });
  injected = (await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT(lang, light) })).result.identifier;
  await send("Emulation.setDeviceMetricsOverride", { width, height: width < 500 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 500 });
  await send("Page.navigate", { url });
  await sleep(3500);
}
const shot = async (name) => {
  await sleep(450); // açılış animasyonu bitsin
  // Başsız Chrome'da görüntü isteği ara sıra yanıtsız kalıyor (ekran boyutu değişiminden sonra): süre sınırı + yeniden deneme.
  for (let i = 0; i < 3; i++) {
    const s = await Promise.race([send("Page.captureScreenshot", { format: "png" }), sleep(8000)]);
    if (s?.result?.data) { writeFileSync(`${out}_${name}.png`, Buffer.from(s.result.data, "base64")); return; }
  }
  check(`görüntü alınamadı: ${name}`, false, true);
};
// Açık onay penceresinin durumu (yoksa null).
const box = () => ev(`(() => { const d = document.querySelector("#dlgAsk[open]"); if (!d) return null;
  const r = d.getBoundingClientRect(), a = document.activeElement;
  return { title: document.getElementById("askTitle").textContent, text: document.getElementById("askText").textContent,
    list: [...document.querySelectorAll("#askList li")].map(x => x.textContent),
    buttons: [...document.querySelectorAll("#askButtons button")].map(b => b.textContent + "|" + b.value + "|" + b.className.replace("btn", "").trim()),
    focus: a?.closest("#askButtons") ? a.value : "", cbox: d.classList.contains("cbox"),
    dx: Math.round(r.left + r.width / 2 - innerWidth / 2), dy: Math.round(r.top + r.height / 2 - innerHeight / 2),
    inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    overflowX: d.scrollWidth - d.clientWidth, pageOverflowX: document.documentElement.scrollWidth - innerWidth,
    btnOut: [...document.querySelectorAll("#askButtons button")].filter(b => { const q = b.getBoundingClientRect(); return q.left < r.left || q.right > r.right; }).length }; })()`);
const press = async (value) => { await ev(`document.querySelector('#dlgAsk[open] button[value="${value}"]').click()`); await sleep(350); };
const key = async (k, code) => {
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: code, text: type === "keyDown" && k === "Enter" ? "\r" : undefined });
  await sleep(350);
};
const click = async (expr) => { await ev(`(${expr}).click()`); await sleep(400); };
const calls = (part) => ev(`window.__calls.filter(u => u.includes(${JSON.stringify(part)})).length`);
const alive = async () => { try { return (await fetch(url + "api/state")).status; } catch { return 0; } };
const cardBtn = (name, label) => `[...document.querySelectorAll(".card")].find(c => c.querySelector(".name").textContent === ${JSON.stringify(name)}).querySelector(".card-actions").querySelectorAll("button").values().find(b => b.textContent === ${JSON.stringify(label)})`;
const geometry = (b, w) => ({ cbox: b.cbox, ortada: Math.abs(b.dx) <= 1 && Math.abs(b.dy) <= 1, icinde: b.inside, tasma: b.overflowX, sayfaTasma: b.pageOverflowX, dugmeDisarida: b.btnOut });
const GEO_OK = { cbox: true, ortada: true, icinde: true, tasma: 0, sayfaTasma: 0, dugmeDisarida: 0 };

// ================= 1280 px, koyu, Türkçe =================
await open(1280);
check("uydurma oturumlar göründü (2 terminal + 1 panel)", await ev(`document.querySelectorAll(".card").length`), 3);

// ---- Panele al (olağan işlem: odak onay düğmesinde, Enter onaylar) ----
await click(cardBtn("Örnek API", "Panele al"));
let b = await box();
check("Panele al: başlık", b?.title, "Oturum panele alınsın mı?");
check("Panele al: metin oturum adını içerir", b?.text.startsWith("Örnek API terminalde kapatılıp"), true);
check("Panele al: düğmeler", b?.buttons, ["Vazgeç|cancel|", "Panele al|yes|primary"]);
check("Panele al: odak onay düğmesinde", b?.focus, "yes");
check("Panele al: yerleşim", geometry(b), GEO_OK);
await shot("1280_koyu_panele_al");
await press("cancel");
check("Panele al → Vazgeç: pencere kapandı", await box(), null);
check("Panele al → Vazgeç: istek gitmedi", await calls("/api/adopt/"), 0);
await click(cardBtn("Örnek API", "Panele al"));
await key("Escape", 27);
check("Panele al → Esc: pencere kapandı, istek gitmedi", [await box(), await calls("/api/adopt/")], [null, 0]);
await click(cardBtn("Örnek API", "Panele al"));
await key("Enter", 13);
check("Panele al → Enter: pencere kapandı, istek gitti", [await box(), await calls("/api/adopt/91001")], [null, 1]);

// ---- Toplu "Panele al" ----
await click(`document.getElementById("btnBulk")`);
await click(`[...document.querySelectorAll(".pop-menu button")].find(x => x.textContent === "Tümünü seç")`);
await click(`document.querySelector('#bulkBar button[data-bulk="adopt"]')`);
b = await box();
check("Toplu panele al: başlık + liste", [b?.title, b?.list], ["2 oturum panele alınsın mı?", ["Örnek API", "Demo Mağaza"]]);
check("Toplu panele al: düğmeler", b?.buttons, ["Vazgeç|cancel|", "Panele al|yes|primary"]);
await press("cancel");
check("Toplu panele al → Vazgeç: istek gitmedi", await calls("/api/adopt/"), 1);
await click(`document.querySelector('#bulkBar button[data-bulk="adopt"]')`);
await press("yes");
await sleep(600);
check("Toplu panele al → Panele al: iki istek gitti", await calls("/api/adopt/"), 3);

// ---- Ayarlar: terminalde kota (mevcut durum satırı değişimi) ----
await click(`document.getElementById("btnSettings")`);
await sleep(1200);
await click(`document.getElementById("tqEnabled")`);
await sleep(500);
b = await box();
check("Kota satırı: başlık", b?.title, "Durum satırı değiştirilsin mi?");
check("Kota satırı: mevcut satır listede", b?.list.length === 1 && b.list[0].includes("eski"), true);
check("Kota satırı: düğmeler + odak", [b?.buttons, b?.focus], [["Vazgeç|cancel|", "Değiştir|yes|primary"], "yes"]);
check("Kota satırı: yerleşim", geometry(b), GEO_OK);
await shot("1280_koyu_kota_satiri");
await press("cancel");
check("Kota satırı → Vazgeç: kutu işaretsiz, istek gitmedi", [await ev(`document.getElementById("tqEnabled").checked`), await calls("/api/terminal-quota")], [false, 0]);
await click(`document.getElementById("tqEnabled")`);
await sleep(500);
await press("yes");
await sleep(1200);
check("Kota satırı → Değiştir: kutu işaretli, istek gitti", [await ev(`document.getElementById("tqEnabled").checked`), await calls("/api/terminal-quota")], [true, 1]);
await click(`document.getElementById("tqEnabled")`); // geri kapat: soru sorulmaz
await sleep(1000);
check("Kota kapatılırken soru yok", [await box(), await ev(`document.getElementById("tqEnabled").checked`)], [null, false]);

// ---- Ayarlar: cihaz kaldır (tehlikeli: kırmızı düğme, odak Vazgeç'te) ----
check("uydurma cihaz listede", await ev(`document.querySelectorAll("#rDevices li").length`), 1);
await click(`document.querySelector("#rDevices li button")`);
b = await box();
check("Cihaz kaldır: başlık + metin", [b?.title, b?.text], ["Demo Telefon kaldırılsın mı?", "Bu cihaz paneli bir daha açamaz."]);
check("Cihaz kaldır: düğmeler + odak Vazgeç'te", [b?.buttons, b?.focus], [["Vazgeç|cancel|", "Kaldır|yes|cbox-danger"], "cancel"]);
await key("Enter", 13); // odak Vazgeç'te: Enter vazgeçer
check("Cihaz kaldır → Enter (odak Vazgeç'te): kaldırılmadı", [await box(), await calls("/api/remote/revoke/"), await ev(`document.querySelectorAll("#rDevices li").length`)], [null, 0, 1]);
await click(`document.querySelector("#rDevices li button")`);
await press("yes");
await sleep(600);
check("Cihaz kaldır → Kaldır: istek gitti, liste boş", [await calls("/api/remote/revoke/d1"), await ev(`document.querySelectorAll("#rDevices li").length`)], [1, 0]);

// ---- Paneli kapat ----
await click(`document.getElementById("btnQuit")`);
b = await box();
check("Paneli kapat: başlık + metin", [b?.title, b?.text], ["Panel kapatılsın mı?", "Panelde açık oturumlar kapanır; konuşmalar kayıtlı kalır."]);
check("Paneli kapat: düğmeler + odak Vazgeç'te", [b?.buttons, b?.focus], [["Vazgeç|cancel|", "Paneli kapat|yes|cbox-danger"], "cancel"]);
check("Paneli kapat: yerleşim", geometry(b), GEO_OK);
check("Paneli kapat: kırmızı düğme dolu", await ev(`getComputedStyle(document.querySelector('#askButtons .cbox-danger')).backgroundColor`), "rgb(229, 83, 75)");
await shot("1280_koyu_paneli_kapat");
await press("cancel");
check("Paneli kapat → Vazgeç: istek gitmedi, panel AÇIK", [await calls("/api/quit"), await alive()], [0, 200]);
await click(`document.getElementById("btnQuit")`);
await key("Escape", 27);
check("Paneli kapat → Esc: istek gitmedi, panel AÇIK", [await box(), await calls("/api/quit"), await alive()], [null, 0, 200]);

// ---- Sıra: iki soru üst üste gelirse ikincisi birincinin kapanmasını bekler ----
await ev(`document.getElementById("btnQuit").click(); document.getElementById("btnForget").click()`);
await sleep(400);
check("Sıra: önce ilk soru", (await box())?.title, "Panel kapatılsın mı?");
await press("cancel");
b = await box();
check("Sıra: sonra ikinci soru (Bu cihazı unut)", [b?.title, b?.text, b?.buttons], ["Bu cihazın eşleşmesi silinsin mi?", "Yeniden açmak için bilgisayardan yeni kod gerekir.", ["Vazgeç|cancel|", "Bu cihazı unut|yes|cbox-danger"]]);
await press("cancel");
check("Sıra: ikisi de vazgeçildi, istek yok", [await box(), await calls("/api/quit"), await calls("/api/remote/forget")], [null, 0, 0]);

// ---- Paneli kapat: çalışan oturum var (409) → ikinci soru ----
await ev(`window.__mock.quit = "409"`);
await click(`document.getElementById("btnQuit")`);
await press("yes");
await sleep(500);
b = await box();
check("Çalışan oturum: ikinci soru", [b?.title, b?.buttons, b?.focus], ["Panelde çalışan oturum var", ["Vazgeç|cancel|", "Yine de kapat|yes|cbox-danger"], "cancel"]);
await press("cancel");
check("Çalışan oturum → Vazgeç: zorla kapatma gitmedi", [await calls("/api/quit"), await calls("force=1")], [1, 0]);
await click(`document.getElementById("btnQuit")`);
await press("yes");
await sleep(500);
await press("yes");
await sleep(500);
check("Çalışan oturum → Yine de kapat: zorla kapatma gitti", await calls("force=1"), 1);
check("panel hâlâ AÇIK (kapatma istekleri testte tutuldu)", await alive(), 200);
await ev(`window.__mock.quit = "swallow"`);

// ================= 1280 px, açık tema =================
await open(1280, "tr", true);
await click(`document.getElementById("btnSettings")`);
await click(`document.getElementById("btnQuit")`);
b = await box();
check("Açık tema: pencere + yerleşim + odak Vazgeç'te", [b?.title, geometry(b), b?.focus], ["Panel kapatılsın mı?", GEO_OK, "cancel"]);
await shot("1280_acik_paneli_kapat");
await press("cancel");

// ================= 390 px telefon =================
await open(390);
await click(`document.getElementById("btnSettings")`);
await click(`document.getElementById("btnQuit")`);
b = await box();
check("390 px: Paneli kapat yerleşim (taşma yok, ortada)", geometry(b), GEO_OK);
await shot("390_paneli_kapat");
await press("cancel");
await sleep(800);
await click(`document.getElementById("tqEnabled")`);
await sleep(500);
b = await box();
check("390 px: Kota satırı yerleşim (uzun satır taşmıyor)", [b?.title, geometry(b)], ["Durum satırı değiştirilsin mi?", GEO_OK]);
await shot("390_kota_satiri");
await press("cancel");
// Bu cihazı unut → onayla: istek gider, sayfa eşleştirmeye yönlenir.
await click(`document.getElementById("btnForget")`);
await press("yes");
await sleep(1500);
check("Bu cihazı unut → onay: sayfa /pair'e gitti", await ev(`location.pathname`), "/pair");

// ================= İngilizce =================
await open(1280, "en");
await click(`document.getElementById("btnQuit")`);
b = await box();
check("EN: Paneli kapat", [b?.title, b?.buttons], ["Quit the panel?", ["Cancel|cancel|", "Quit panel|yes|cbox-danger"]]);
await shot("1280_en_paneli_kapat");
await press("cancel");
await click(cardBtn("Örnek API", "Move here"));
b = await box();
check("EN: Panele al", [b?.title, b?.buttons], ["Move this session here?", ["Cancel|cancel|", "Move here|yes|primary"]]);
await press("cancel");

// ================= Sayaçlar + en son: gerçekten kapat =================
await tally();
check("yerleşik confirm/alert/prompt çağrısı (tüm sayfa açılışları toplamı): 0", native, { confirm: 0, alert: 0, prompt: 0 });
check("sayfada yakalanmamış hata yok", errors, []);
await ev(`window.__mock.quit = "real"`);
await click(`document.getElementById("btnQuit")`);
await press("yes");
let st = 200;
for (let i = 0; i < 30 && st; i++) { await sleep(300); st = await alive(); }
check("Paneli kapat → Paneli kapat: test kopyası KAPANDI", st, 0);

console.log(`\n${pass} geçti, ${fail} kaldı`);
ws.close();
process.exit(fail ? 1 : 0);
