// Mail ve takvim tarayıcı testi. Ayarlar → "Mail ve takvim": istemci yok (yönerge + "İstemci dosyasını seç"), yanlış türde dosya,
// doğru dosya (şifreli kaydedildi; içerik arayüzde yok), "Hesap ekle" (panelin kendi soru penceresi, bekleme kutusu, iptal, giriş
// tamamlanınca hesap satırı), kaynak kutuları, süzgeç (kutu ve metin; Enter Ayarlar'ı kapatmaz), Kaldır (onay penceresi).
// Takip → Mail ve Takvim bölümleri, çipler, satır içeriği (konu, gönderen, bekleme süresi, kural etiketleri, Gmail'de aç; etkinlikte
// saat, yer, Katıl, Takvimde aç), Ertele/Gizle, projeye göre gruplama, ağ hatasında son liste + not. 1280 koyu/açık, 390 telefon
// (telefondan açılmış gibi: hesap değiştirme düğmeleri yok), İngilizce; taşma ve dokunma hedefi ölçümü; Ayarlar'daki diğer satırlar
// ezilmedi (§BB). Tarayıcı confirm/alert/prompt YOK. Bağlantılara BASILMAZ (sekme açar); yalnız adresleri ölçülür.
// Gerçek Google KULLANILMAZ: giriş, yetki adresi bu betikten (Node fetch) çağrılarak tamamlanır; sahte sunucu loopback'e yönlendirir.
// Kullanım: node mail_ui_test.mjs <debugPort> <url> <çıktıÖneki> <geçici klasör>
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const [port, url, out, tmpRoot] = process.argv.slice(2);
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
const until = async (expr, ms = 20000) => { for (let i = 0; i < ms / 250; i++) { if (await ev(expr)) return true; await sleep(250); } return false; };
const J = JSON.stringify;

// Yetki adresi: "Hesap ekle" yanıtından yakalanır (gerçekte tarayıcı açar; testte Node çağırır).
const INJECT = (lang, light, remote) => `(() => {
  localStorage.setItem("panel.settings", JSON.stringify({ lang: "${lang}", light: ${light}, notify: false, sound: false }));
  window.__n = { confirm: 0, alert: 0, prompt: 0 };
  for (const k of ["confirm", "alert", "prompt"]) window[k] = () => { window.__n[k]++; return k === "confirm" ? false : null; };
  window.addEventListener("error", e => (window.__errors ||= []).push(String(e.message)));
  window.addEventListener("unhandledrejection", e => (window.__errors ||= []).push(String(e.reason)));
  if (${remote}) new MutationObserver(() => document.querySelector('meta[name="panel-remote"]')?.setAttribute("content", "1")).observe(document, { childList: true, subtree: true });
  const real = window.fetch.bind(window);
  window.fetch = async (u, init) => { const r = await real(u, init);
    if (String(u) === "/api/mail/accounts/add") { try { window.__authUrl = (await r.clone().json()).url; } catch {} }
    return r; };
})();`;

await send("Page.enable");
await send("DOM.enable");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
let injected = null;
const native = { confirm: 0, alert: 0, prompt: 0 }, errors = [];
async function tally() {
  const n = await ev(`window.__n`);
  for (const k in native) native[k] += n[k];
  errors.push(...await ev(`window.__errors || []`));
}
async function open(width, { lang = "tr", light = false, remote = false, view = "follow" } = {}) {
  if (injected) { await tally(); await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected }); }
  injected = (await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT(lang, light, remote) })).result.identifier;
  await send("Emulation.setDeviceMetricsOverride", { width, height: width < 500 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 500 });
  await send("Page.navigate", { url: url + "?view=" + view });
  await until(`document.querySelector(".fu-chip") && !document.getElementById("btnFuRefresh").disabled`);
  await sleep(700);
}
const shot = async (name) => {
  await sleep(450);
  for (let i = 0; i < 3; i++) {
    const s = await Promise.race([send("Page.captureScreenshot", { format: "png" }), sleep(8000)]);
    if (s?.result?.data) { writeFileSync(`${out}_${name}.png`, Buffer.from(s.result.data, "base64")); return; }
  }
  check(`görüntü alınamadı: ${name}`, false, true);
};
const click = async (expr, waitMs = 350) => { await ev(`(${expr}).click()`); await sleep(waitMs); };
const toasts = () => ev(`[...document.querySelectorAll(".toast")].map(x => x.textContent)`);
const lastToast = async () => (await toasts()).pop() || "";
const box = () => ev(`(() => { const d = document.querySelector("#dlgAsk[open]"); if (!d) return null;
  return { title: document.getElementById("askTitle").textContent, buttons: [...document.querySelectorAll("#askButtons button")].map(b => b.textContent) }; })()`);
const press = async (value) => { await ev(`document.querySelector('#dlgAsk[open] button[value="${value}"]').click()`); await sleep(500); };
const mailApi = () => ev(`fetch("/api/mail").then(r => r.json())`);
const fu = () => ev(`fetch("/api/followup").then(r => r.json())`);
const settingsOpen = async () => { await click(`document.getElementById("btnSettings")`, 900); await until(`!!document.querySelector("#viewSettings:not([hidden])")`); };
const settingsClose = async () => { await ev(`document.querySelector('#nav button[data-view="follow"]').click()`); await sleep(400); };
const toMail = async () => { await ev(`document.getElementById("mailBox").scrollIntoView({ block: "start" })`); await sleep(250); };
const setFile = async (path) => {
  const root = (await send("DOM.getDocument", { depth: 0 })).result.root.nodeId;
  const node = (await send("DOM.querySelector", { nodeId: root, selector: "#smClientFile" })).result.nodeId;
  await send("DOM.setFileInputFiles", { nodeId: node, files: [path] });
  await sleep(900);
};
const acct = () => ev(`[...document.querySelectorAll("#smAccounts .mail-acct")].map(li => ({ ad: li.querySelector("b").textContent, durum: li.querySelector("small").textContent,
  kutu: [...li.querySelectorAll("input[data-src]")].map(i => [i.dataset.src, i.checked, i.disabled]), dugme: [...li.querySelectorAll(".btn")].map(b => b.textContent) }))`);
const vis = (id) => ev(`(() => { const e = document.getElementById(${J(id)}); return !!e && !!e.offsetWidth; })()`);
const visible = (sel) => ev(`!!document.querySelector(${J(sel)})?.offsetWidth`);
// Ayarlar ölçümü: mail kutusundan dışarı taşan öğe, kırpılan düğme; Ayarlar'daki TÜM onay satırları ezilmemiş (§BB); telefonda ≥ 44 px.
const measureSet = () => ev(`(() => { const d = document.querySelector("#viewSettings"), r = document.getElementById("mailBox").getBoundingClientRect(), phone = matchMedia("(max-width: 640px)").matches;
  const out = [...document.querySelectorAll("#mailBox *")].filter(e => e.offsetWidth && (e.getBoundingClientRect().right > r.right + 1 || e.getBoundingClientRect().left < r.left - 1)).slice(0, 4).map(e => e.tagName + "." + e.className);
  const clipped = [...document.querySelectorAll("#mailBox .btn")].filter(b => b.offsetWidth && b.scrollWidth > b.clientWidth + 1).map(b => b.textContent);
  const squeezed = [...document.querySelectorAll("#viewSettings label.check")].filter(l => l.offsetWidth && l.getBoundingClientRect().height < 18).map(l => l.textContent.trim().slice(0, 25));
  const small = phone ? [...document.querySelectorAll("#mailBox .btn")].filter(b => b.offsetWidth && b.getBoundingClientRect().height < 44).map(b => b.textContent) : [];
  return { tasan: out, kirpilan: clipped, ezilenSatir: squeezed, kucukHedef: small, yatay: d.scrollWidth - d.clientWidth }; })()`);
const SET_CLEAN = { tasan: [], kirpilan: [], ezilenSatir: [], kucukHedef: [], yatay: 0 };
// Takip ölçümü (github_ui_test.mjs ile aynı ölçütler)
const measure = () => ev(`(() => { const de = document.documentElement, rows = [...document.querySelectorAll(".fu-row")], phone = matchMedia("(max-width: 640px)").matches;
  const over = rows.filter(r => { const b = r.getBoundingClientRect(); return [...r.querySelectorAll("b, small, .fu-what, .btn, .fu-tag, .fu-kind, .fu-tog")].some(e => { const q = e.getBoundingClientRect(); return q.width && (q.right > b.right + 1 || q.left < b.left - 1); }); }).length;
  const btns = [...document.querySelectorAll(".fu-row .btn, .fu-chip, .fu-mode")].filter(b => b.offsetWidth && (b.scrollWidth > b.clientWidth + 1 || b.getBoundingClientRect().right > innerWidth + 1)).map(b => b.textContent.trim().slice(0, 30));
  const small = phone ? [...document.querySelectorAll(".fu-fold, .fu-chip, .fu-mode, .fu-tog, .fu-row .btn")].filter(e => e.offsetWidth && e.getBoundingClientRect().height < 44).map(e => e.className + ":" + e.textContent.trim()) : [];
  const overlap = rows.filter(r => { const m = [...r.querySelectorAll(".fu-title > *")].map(e => e.getBoundingClientRect()).filter(q => q.width);
    return m.some((a, i) => m.some((b, k) => k > i && a.right > b.left + 1 && b.right > a.left + 1 && a.bottom > b.top + 1 && b.bottom > a.top + 1)); }).length;
  return { yatayTasma: de.scrollWidth - de.clientWidth, tasanSatir: over, kirpilanDugme: btns, kucukDokunmaHedefi: small, cakisanEtiket: overlap }; })()`);
const CLEAN = { yatayTasma: 0, tasanSatir: 0, kirpilanDugme: [], kucukDokunmaHedefi: [], cakisanEtiket: 0 };
const chips = () => ev(`Object.fromEntries([...document.querySelectorAll(".fu-chip")].map(c => [c.dataset.filter, Number(c.querySelector("span").textContent)]))`);
const chip = (f) => click(`document.querySelector('.fu-chip[data-filter="${f}"]')`);
const mode = (m) => click(`document.querySelector('.fu-mode[data-mode="${m}"]')`);
const contOf = (sid) => `document.getElementById(${J(sid)})`;
const openCont = async (sid) => { if (await ev(`${contOf(sid)}?.querySelector(".fu-fold").getAttribute("aria-expanded") === "false"`)) await click(`${contOf(sid)}.querySelector(".fu-fold")`); };
const rowOf = (type, name) => `[...document.querySelectorAll('.fu-row[data-type="${type}"]')].find(r => r.querySelector("b").textContent === ${J(name)})`;
const rowInfo = (type, name) => ev(`(() => { const r = ${rowOf(type, name)}; if (!r) return null; return { dugme: [...r.querySelectorAll(".fu-side .btn")].map(b => b.textContent),
  etiket: [...r.querySelectorAll(".fu-tag")].map(x => x.textContent), ne: r.querySelector(".fu-what")?.textContent || "", yan: [...r.querySelectorAll(".fu-side small")].map(x => x.textContent),
  ek: [...r.querySelectorAll(".fu-more .btn")].map(b => b.textContent), adres: [...r.querySelectorAll(".fu-side a")].map(a => [a.href, a.target, a.rel]) }; })()`);
const titles = (sel) => ev(`[...document.querySelectorAll(${J(sel)})].map(r => r.querySelector("b").textContent)`);
const notes = (sid) => ev(`[...document.querySelectorAll("#${sid} .fu-clean")].map(p => p.textContent)`);
const openAllRows = () => ev(`(async () => { for (const b of document.querySelectorAll('.fu-row:not(.fu-open) .fu-tog')) b.click(); })()`);
const refresh = async () => { await click(`document.getElementById("btnFuRefresh")`, 600); await until(`!document.getElementById("btnFuRefresh").disabled`); await sleep(600); };
const SG = join(import.meta.dirname, "sahte_google.py");
const senaryo = (ad) => execFileSync("py", ["-3.13", SG, "--senaryo", ad, join(tmpRoot, "google.json")], { env: { ...process.env, PYTHONUTF8: "1" } });
const ME = "test.kul@ornek.com";

// ================= Ayarlar: istemci yok =================
await open(1280);
await ev(`localStorage.removeItem("panel.follow")`);
check("hesap yokken Takip'te Mail/Takvim çipi yok", Object.keys(await chips()).filter(k => k === "mail" || k === "cal"), []);
await settingsOpen(); await toMail();
check("istemci yok: 4 adımlı yönerge, seç düğmesi (birincil), Hesap ekle gizli", [await ev(`document.querySelectorAll("#smSteps li").length`), await vis("smSteps"),
  await ev(`[document.getElementById("btnSmClient").textContent, document.getElementById("btnSmClient").classList.contains("primary")]`), await vis("btnSmAdd"), await vis("smClientOk")],
  [4, true, ["İstemci dosyasını seç", true], false, false]);
check("bölüm başlığı ve gizlilik notu", await ev(`[document.querySelector("#mailBox legend").textContent, document.querySelector("#mailBox .mail-note").textContent.includes("içeriği okunmaz ve hiçbir yere gönderilmez")]`), ["Mail ve takvim", true]);
check("Ayarlar 1280: taşma yok, diğer satırlar ezilmedi", await measureSet(), SET_CLEAN);
await shot("ayar_istemci_yok");
await setFile(join(tmpRoot, "istemci_web.json"));
check("web türü dosya: anlaşılır uyarı, kaydedilmedi", [await lastToast(), (await mailApi()).client], ["Bu dosya web uygulaması türünde. Google Cloud Console'da \"Masaüstü uygulaması\" türünde istemci oluşturun.", false]);
await setFile(join(tmpRoot, "istemci.json"));
await until(`document.getElementById("btnSmClient").textContent === "İstemci dosyasını değiştir"`, 6000);
check("doğru dosya: kaydedildi; yönerge gizlendi, Hesap ekle göründü", [await lastToast(), await vis("smSteps"), await vis("smClientOk"), await vis("btnSmAdd"), await ev(`document.querySelector("#smAccounts").textContent`)],
  ["İstemci dosyası kaydedildi", false, true, true, "Henüz hesap yok."]);
check("istemci içeriği sayfada yok", await ev(`document.documentElement.innerHTML.includes("ISTEMCI-SIRRI-UI") || document.documentElement.innerHTML.includes("123456789-test")`), false);

// ================= Hesap ekle =================
await click(`document.getElementById("btnSmAdd")`, 500);
let b = await box();
check("Hesap ekle: panelin soru penceresi, üç seçenek", b, { title: "Hangi kaynaklar okunsun?", buttons: ["Vazgeç", "Takvim ve mail", "Yalnız takvim", "Yalnız mail"] });
await press("cancel");
check("vazgeç: giriş başlamadı", [await vis("smLogin"), (await mailApi()).login], [false, null]);
await click(`document.getElementById("btnSmAdd")`, 500);
await press("both");
await until(`!!window.__authUrl && !document.getElementById("smLogin").hidden`, 6000);
check("giriş bekleniyor: bekleme kutusu + iptal, Hesap ekle kilitli", [await vis("smLogin"), await ev(`document.getElementById("btnSmAdd").disabled`), await ev(`document.getElementById("btnSmCancel").textContent`)], [true, true, "Girişi iptal et"]);
await toMail();
await shot("ayar_bekliyor");
await click(`document.getElementById("btnSmCancel")`, 600);
check("iptal: kutu kapandı, Hesap ekle açıldı", [await vis("smLogin"), await ev(`document.getElementById("btnSmAdd").disabled`), (await mailApi()).login.state], [false, false, "cancelled"]);
await ev(`window.__authUrl = null`);
await click(`document.getElementById("btnSmAdd")`, 500);
await press("both");
await until(`!!window.__authUrl`, 6000);
const authUrl = await ev(`window.__authUrl`);
const page1 = await (await fetch(authUrl, { redirect: "follow" })).text(); // tarayıcının yaptığı: yetki → loopback dönüşü
check("giriş sayfası: tamamlandı", page1.includes("Giriş tamamlandı"), true);
await until(`document.querySelectorAll("#smAccounts .mail-acct").length === 1 && document.getElementById("smLogin").hidden`, 8000);
check("giriş bitince bildirim", (await toasts()).includes(`${ME} eklendi`), true);
await until(`fetch("/api/mail").then(r => r.json()).then(d => d.accounts[0].state === "ok")`, 10000);
await settingsClose(); await settingsOpen(); await toMail();
let a = await acct();
check("hesap satırı: adres girişten, durum, iki kaynak kutusu açık, Kaldır", a, [{ ad: ME, durum: "okunuyor", kutu: [["cal", true, false], ["mail", true, false]], dugme: ["Kaldır"] }]);
check("süzgeç varsayılanı: Kime + cevap bekleyen", await ev(`["smDirect", "smCc", "smAwaiting"].map(i => document.getElementById(i).checked)`), [true, false, true]);
check("Ayarlar hesaplı: taşma yok", await measureSet(), SET_CLEAN);
await shot("ayar_hesap");

// ---- süzgeç ----
await click(`document.getElementById("smCc")`, 700);
check("kutu değişince anında kaydedildi", [await lastToast(), (await mailApi()).filter.cc], ["Süzgeç kaydedildi", true]);
await ev(`(() => { const i = document.getElementById("smKeywords"); i.focus(); i.value = "rapor,  fatura ,"; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); })()`);
await sleep(800);
check("metin + Enter: kaydedildi, Ayarlar açık kaldı", [(await mailApi()).filter.keywords, await ev(`!document.getElementById("viewSettings").hidden`)], [["rapor", "fatura"], true]);
await ev(`document.getElementById("smCc").focus()`); await sleep(300);
check("kutu temiz değerle yeniden yazıldı", await ev(`document.getElementById("smKeywords").value`), "rapor, fatura");
await click(`document.getElementById("smCc")`, 700);
await ev(`(() => { const i = document.getElementById("smKeywords"); i.value = ""; i.dispatchEvent(new Event("change")); })()`); await sleep(700);
check("süzgeç geri alındı", [(await mailApi()).filter.cc, (await mailApi()).filter.keywords], [false, []]);
await settingsClose();

// ================= Takip: Mail + Takvim =================
await open(1280);
await until(`!!document.querySelector('.fu-chip[data-filter="mail"]')`, 8000);
let c = await chips();
check("çipler: Mail 4, Takvim 3; sıra", [c.mail, c.cal, Object.keys(c)], [4, 3, ["all", "git", "next", "drive", "sched", "mail", "cal", "decisions"]]);
check("sekme rozeti = Tümü (cevap bekleyen 3 mail dahil)", await ev(`document.getElementById("navFollow").textContent`), String(c.all));
await mode("type");
await openCont("fu-mail"); await openCont("fu-cal");
check("Mail: cevap bekleyenler önce", await titles("#fu-mail .fu-row"), ["Teklif revizyonu", "Haftalık rapor", "Destek kaydı #42 güncellendi", "Sözleşme taslağı"]);
let r = await rowInfo("mail", "Teklif revizyonu");
check("cevap bekleyen mail: etiketler, gönderen, bekleme süresi, Gmail'de aç", [r.etiket, r.ne, /^.+ bekliyor$/.test(r.yan[0] || ""), r.dugme, r.adres],
  [["cevap bekliyor", "Kime"], "Ali Kaya <ali@musteri.com>", true, ["Gmail'de aç"], [["https://mail.google.com/mail/?authuser=test.kul%40ornek.com#all/t1", "_blank", "noopener"]]]);
r = await rowInfo("mail", "Haftalık rapor");
check("CC'li mail: cevap bekliyor (kural etiketi yalnız açık kurallardan)", [r.etiket, r.ne], [["cevap bekliyor"], "Veli <veli@firma.com>"]);
r = await rowInfo("mail", "Sözleşme taslağı");
check("cevapladığım konuşma: sakin, 'önce'", [r.etiket, /önce$/.test(r.yan[0] || "")], [["Kime"], true]);
check("Mail notu", /^.+ önce denetlendi \(10 dakikada bir\)$/.test((await notes("fu-mail"))[0] || ""), true);
check("Takvim: sıralı, iptal edilen ve 24 saat sonrası yok", await titles("#fu-cal .fu-row"), ["Bayram tatili", "Proje toplantısı", "Müşteri görüşmesi"]);
r = await rowInfo("cal", "Proje toplantısı");
check("etkinlik: saat aralığı + yer, Katıl (birincil) + Takvimde aç", [/^\d\d:\d\d–\d\d:\d\d · Toplantı odası 2$/.test(r.ne), /sonra$/.test(r.yan[0] || ""), r.dugme, r.adres.map(x => x[0]),
  await ev(`${rowOf("cal", "Proje toplantısı")}.querySelector(".fu-side a").classList.contains("primary")`)],
  [true, true, ["Katıl", "Takvimde aç"], ["https://meet.google.com/abc-defg-hij", "https://www.google.com/calendar/event?eid=e1"], true]);
r = await rowInfo("cal", "Bayram tatili");
check("tüm gün etkinliği", [r.ne, r.dugme], ["tüm gün", ["Takvimde aç"]]);
await click(`${rowOf("mail", "Sözleşme taslağı")}.querySelector(".fu-tog")`);
check("mail ayrıntısı: Ertele + Gizle", (await rowInfo("mail", "Sözleşme taslağı")).ek, ["Ertele (yarına)", "Gizle"]);
await openAllRows(); await sleep(300);
check("1280 koyu: taşma yok", await measure(), CLEAN);
await ev(`document.getElementById("fu-mail").scrollIntoView({ block: "start" })`);
await shot("takip_1280");
await click(`[...${rowOf("mail", "Sözleşme taslağı")}.querySelectorAll(".fu-more .btn")].find(b => b.textContent === "Gizle")`);
check("gizlenen sakin satır çıktı; Tümü değişmedi", [(await titles("#fu-mail .fu-row")).includes("Sözleşme taslağı"), (await chips()).mail, (await chips()).all], [false, 3, c.all]);

// ---- projeye göre ----
await mode("project");
check("Projeye göre: Mail ve Takvim grupları", await ev(`(() => { const g = (n) => [...document.querySelectorAll(".fu-group")].find(s => s.querySelector(".fu-name").textContent === n);
  return [g("Mail")?.querySelector(".fu-sum").textContent, g("Takvim")?.querySelector(".fu-sum").textContent]; })()`), ["Mail", "Takvim"]);
await chip("cal");
check("Takvim süzgeci: yalnız Takvim grubu", await ev(`[...document.querySelectorAll(".fu-group .fu-name")].map(x => x.textContent)`), ["Takvim"]);
await chip("all"); await mode("type");

// ---- ağ yok ----
senaryo("ag");
await refresh();
await until(`fetch("/api/followup").then(r => r.json()).then(d => d.mail.stale && !d.mail.fetching)`, 10000);
await open(1280); await openCont("fu-mail");
check("ağ yok: liste duruyor + yalnız 'güncellenemedi' notu (yeşil 'denetlendi' yok)", [(await titles("#fu-mail .fu-row")).length, (await notes("fu-mail")).length,
  /^test\.kul@ornek\.com: güncellenemedi; liste .+ önceki durumu gösteriyor\.$/.test((await notes("fu-mail"))[0] || "")], [3, 1, true]);
await shot("takip_agyok");
senaryo("ilk");
await refresh();
await until(`fetch("/api/followup").then(r => r.json()).then(d => !d.mail.stale && !d.mail.fetching)`, 10000);

// ---- kaynak kapat: Takvim bölümü ve çipi gider ----
await settingsOpen(); await toMail();
await click(`document.querySelector('#smAccounts input[data-src="cal"]')`, 900);
await settingsClose();
await until(`!document.getElementById("fu-cal")`, 8000);
check("takvim kapatılınca bölüm ve çip yok", ["cal" in await chips(), await ev(`!!document.getElementById("fu-cal")`)], [false, false]);
await settingsOpen(); await toMail();
await click(`document.querySelector('#smAccounts input[data-src="cal"]')`, 900);
await settingsClose();
await until(`!!document.getElementById("fu-cal")`, 8000);
check("yeniden açılınca geri geldi (izin vardı: giriş istenmedi)", [(await chips()).cal, await box()], [3, null]);

// ================= açık tema, telefon, uzaktan, İngilizce =================
await open(1280, { light: true });
await openCont("fu-mail"); await openCont("fu-cal"); await openAllRows(); await sleep(300);
check("1280 açık tema: taşma yok", await measure(), CLEAN);
await ev(`document.getElementById("fu-mail").scrollIntoView({ block: "start" })`);
await shot("takip_1280_acik");
await settingsOpen(); await toMail();
check("Ayarlar açık tema: taşma yok", await measureSet(), SET_CLEAN);
await shot("ayar_acik");
await settingsClose();
await open(390);
await openCont("fu-mail"); await openCont("fu-cal");
check("telefon 390: taşma yok, dokunma hedefleri ≥ 44 px", await measure(), CLEAN);
check("telefon: Mail ve Takvim çipleri", [(await chips()).mail, (await chips()).cal], [3, 3]);
await ev(`document.getElementById("fu-mail").scrollIntoView({ block: "start" })`);
await shot("takip_390");
await openAllRows(); await sleep(300);
check("telefon 390, satırlar açık: taşma yok", await measure(), CLEAN);
await settingsOpen(); await toMail();
check("Ayarlar telefon 390: taşma yok, düğmeler ≥ 44 px", await measureSet(), SET_CLEAN);
await shot("ayar_390");
await settingsClose();
await open(390, { remote: true });
await settingsOpen(); await toMail();
a = await acct();
check("telefondan (uzak): hesap görünür, kutular kilitli, Kaldır yok", a, [{ ad: ME, durum: "okunuyor", kutu: [["cal", true, true], ["mail", true, true]], dugme: [] }]);
check("telefondan: Hesap ekle ve istemci dosyası gizli, bilgisayar notu görünür", [await vis("btnSmAdd"), await vis("smClient"), await visible("#mailBox .remote-only")], [false, false, true]);
check("telefondan süzgeç değiştirilebilir", await ev(`!document.getElementById("smDirect").disabled`), true);
check("telefondan Ayarlar: taşma yok", await measureSet(), SET_CLEAN);
await shot("ayar_390_uzak");
await settingsClose();
await open(1280, { lang: "en" });
await openCont("fu-mail"); await openCont("fu-cal"); await openAllRows(); await sleep(300);
r = await rowInfo("mail", "Teklif revizyonu");
check("İngilizce: Takip etiketleri ve düğmeler", [r.etiket, /^waiting .+$/.test(r.yan[0] || ""), r.dugme, (await rowInfo("cal", "Proje toplantısı")).dugme, (await rowInfo("cal", "Bayram tatili")).ne],
  [["needs reply", "To"], true, ["Open in Gmail"], ["Join", "Open in Calendar"], "all day"]);
check("İngilizce: çevrilmemiş anahtar yok (Takip)", await ev(`[...document.querySelectorAll("#viewFollow *")].filter(e => !e.children.length && /^(fu|sm)[A-Za-z_]+$/.test(e.textContent.trim())).map(e => e.textContent.trim())`), []);
check("İngilizce: taşma yok", await measure(), CLEAN);
await ev(`document.getElementById("fu-mail").scrollIntoView({ block: "start" })`);
await shot("takip_en");
await settingsOpen(); await toMail();
check("İngilizce Ayarlar: başlık, düğme, hesap durumu", await ev(`[document.querySelector("#mailBox legend").textContent, document.getElementById("btnSmAdd").textContent, document.querySelector("#smAccounts small").textContent, document.getElementById("btnSmClient").textContent]`),
  ["Mail and calendar", "Add account", "reading", "Change client file"]);
check("İngilizce Ayarlar: çevrilmemiş anahtar yok", await ev(`[...document.querySelectorAll("#mailBox *")].filter(e => !e.children.length && /^(fu|sm)[A-Za-z_]+$/.test(e.textContent.trim())).map(e => e.textContent.trim())`), []);
check("İngilizce Ayarlar: taşma yok", await measureSet(), SET_CLEAN);
await shot("ayar_en");
await settingsClose();

// ================= Kaldır =================
await open(1280);
await settingsOpen(); await toMail();
await click(`[...document.querySelectorAll("#smAccounts .btn")].find(b => b.textContent === "Kaldır")`, 500);
b = await box();
check("Kaldır: onay penceresi (tehlikeli; odak Vazgeç'te)", [b?.title, b?.buttons, await ev(`document.activeElement?.value`)], [`${ME} kaldırılsın mı?`, ["Vazgeç", "Kaldır"], "cancel"]);
await press("yes");
await until(`document.querySelectorAll("#smAccounts .mail-acct").length === 0`, 6000);
check("kaldırıldı: bildirim, liste boş", [(await toasts()).includes(`${ME} kaldırıldı`), await ev(`document.querySelector("#smAccounts").textContent`)], [true, "Henüz hesap yok."]);
await settingsClose();
await open(1280);
check("kaldırınca Takip'te Mail/Takvim yok", [Object.keys(await chips()).filter(k => k === "mail" || k === "cal"), await ev(`!!document.getElementById("fu-mail")`)], [[], false]);

await tally();
check("tarayıcının confirm / alert / prompt penceresi hiç açılmadı", native, { confirm: 0, alert: 0, prompt: 0 });
check("sayfada betik hatası yok", errors, []);
console.log(`\n${pass} geçti, ${fail} kaldı`);
ws.close();
process.exit(fail ? 1 : 0);
