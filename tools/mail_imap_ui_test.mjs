// Mail ve takvim: adım adım hesap ekleme sihirbazı (Gmail IMAP + uygulama şifresi + iCal) tarayıcı testi.
// Kapsam: adım durumları/tamamlandı işaretleri, alan adı denetimi (Google değil → desteklenmiyor), "Uygulama şifresi oluştur" /
// "İki adımlı doğrulama" / "Takvim adresini al" düğmelerinin DOĞRU adresi açtırması (sunucu kaydı: gerçek tarayıcı açılmaz),
// boşluklu şifrenin anında temizlenmesi + 16 harf uyarısı, yanlış şifre (Workspace notlu), "Bağlan ve dene" kanıtı (okunmamış sayısı),
// iCal biçim uyarısı + "Dene" (etkinlik sayısı), hesap satırı durumu + Yeniden dene / Şifreyi değiştir / Takvim adresi / Kaldır (onaylı),
// iki hesap, Workspace yönetici kısıtlarının hesap satırında ve Takip'te ayrı mesajları, telefondan sihirbazın gizli olması,
// 1280 / 390 taşma + dokunma hedefi ölçümü, TR/EN. Tarayıcı confirm/alert/prompt YOK. Gerçek Google KULLANILMAZ.
// Kullanım: node mail_imap_ui_test.mjs <debugPort> <url> <çıktıÖneki> <geçici klasör>
import { writeFileSync, readFileSync } from "node:fs";
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
const KISI = "test.kul@ornek.com", SIRK = "ali.veli@sirket.com.tr";
const PW1 = "qwertyuiopasdfgh", PW2 = "zxcvbnmlkjhgfdsa";
const ICAL_PORT = process.env.ICAL_PORT;

const INJECT = (lang, light, remote) => `(() => {
  localStorage.setItem("panel.settings", JSON.stringify({ lang: "${lang}", light: ${light}, notify: false, sound: false }));
  window.__n = { confirm: 0, alert: 0, prompt: 0 };
  for (const k of ["confirm", "alert", "prompt"]) window[k] = () => { window.__n[k]++; return k === "confirm" ? false : null; };
  window.addEventListener("error", e => (window.__errors ||= []).push(String(e.message)));
  window.addEventListener("unhandledrejection", e => (window.__errors ||= []).push(String(e.reason)));
  if (${remote}) new MutationObserver(() => document.querySelector('meta[name="panel-remote"]')?.setAttribute("content", "1")).observe(document, { childList: true, subtree: true });
})();`;

await send("Page.enable");
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
const box = () => ev(`(() => { const d = document.querySelector("#dlgAsk[open]"); if (!d) return null;
  return { title: document.getElementById("askTitle").textContent, buttons: [...document.querySelectorAll("#askButtons button")].map(b => b.textContent) }; })()`);
const press = async (value) => { await ev(`document.querySelector('#dlgAsk[open] button[value="${value}"]').click()`); await sleep(500); };
const mailApi = () => ev(`fetch("/api/mail").then(r => r.json())`);
const settingsOpen = async () => { await click(`document.getElementById("btnSettings")`, 900); await until(`!!document.querySelector("#dlgSettings[open]")`); };
const settingsClose = async () => { await ev(`document.getElementById("dlgSettings").close()`); await sleep(400); };
const toWiz = async () => { await ev(`document.getElementById("mailBox").scrollIntoView({ block: "start" })`); await sleep(250); };
const typeIn = (id, v) => ev(`(() => { const e = document.getElementById(${J(id)}); e.focus(); e.value = ${J(v)}; e.dispatchEvent(new Event("input", { bubbles: true })); })()`);
const txt = (id) => ev(`document.getElementById(${J(id)}).textContent`);
const states = () => ev(`[1, 2, 3, 4].map(i => document.getElementById("mwS" + i).dataset.state)`);
const marks = () => ev(`[1, 2, 3, 4].map(i => document.getElementById("mwM" + i).textContent)`);
const dis = (...ids) => ev(`${J(ids)}.map(i => document.getElementById(i).disabled)`);
const opened = () => readFileSync(join(tmpRoot, "acilan.txt"), "utf8").split("\n").filter(Boolean);
const acct = () => ev(`[...document.querySelectorAll("#smAccounts .mail-acct")].map(li => ({ ad: li.querySelector("b").textContent, durum: li.querySelector("small").textContent,
  dugme: [...li.querySelectorAll(".btn")].map(b => b.textContent) }))`);
const rowBtn = (email, label) => `[...document.querySelectorAll("#smAccounts .mail-acct")].find(li => li.querySelector("b").textContent === ${J(email)}).querySelectorAll(".btn")` +
  `.item([...[...document.querySelectorAll("#smAccounts .mail-acct")].find(li => li.querySelector("b").textContent === ${J(email)}).querySelectorAll(".btn")].findIndex(b => b.textContent === ${J(label)}))`;
const sen = (sirkMod, sirkIcalDurum = 200, sirkIcalIcerik = "sirket") => writeFileSync(join(tmpRoot, "senaryo.json"), J({
  hesaplar: { [KISI]: { parola: PW1, mod: "ok", set: "kisisel" }, [SIRK]: { parola: PW2, mod: sirkMod, set: "sirket" } },
  ical: { "kisisel-ICALGIZLI1": { durum: 200, icerik: "kisisel" }, "sirket-ICALGIZLI2": { durum: sirkIcalDurum, icerik: sirkIcalIcerik } } }));
const measureSet = () => ev(`(() => { const d = document.querySelector("#dlgSettings form"), r = document.getElementById("mailBox").getBoundingClientRect(), phone = matchMedia("(max-width: 640px)").matches;
  const out = [...document.querySelectorAll("#mailBox *")].filter(e => e.offsetWidth && (e.getBoundingClientRect().right > r.right + 1 || e.getBoundingClientRect().left < r.left - 1)).slice(0, 4).map(e => e.tagName + "." + e.className);
  const clipped = [...document.querySelectorAll("#mailBox .btn")].filter(b => b.offsetWidth && b.scrollWidth > b.clientWidth + 1).map(b => b.textContent);
  const squeezed = [...document.querySelectorAll("#dlgSettings label.check")].filter(l => l.offsetWidth && l.getBoundingClientRect().height < 18).map(l => l.textContent.trim().slice(0, 25));
  const small = phone ? [...document.querySelectorAll("#mailBox .btn, #mailBox summary")].filter(b => b.offsetWidth && b.getBoundingClientRect().height < 44).map(b => b.textContent.trim()) : [];
  const inputs = [...document.querySelectorAll("#mwWizard input")].filter(i => i.offsetWidth && i.getBoundingClientRect().right > r.right).map(i => i.id);
  return { tasan: out, kirpilan: clipped, ezilenSatir: squeezed, kucukHedef: small, girisTasan: inputs, yatay: d.scrollWidth - d.clientWidth }; })()`);
const SET_CLEAN = { tasan: [], kirpilan: [], ezilenSatir: [], kucukHedef: [], girisTasan: [], yatay: 0 };
const contOf = (sid) => `document.getElementById(${J(sid)})`;
const openCont = async (sid) => { if (await ev(`${contOf(sid)}?.querySelector(".fu-fold").getAttribute("aria-expanded") === "false"`)) await click(`${contOf(sid)}.querySelector(".fu-fold")`); };
const mode = (m) => click(`document.querySelector('.fu-mode[data-mode="${m}"]')`);
const chips = () => ev(`Object.fromEntries([...document.querySelectorAll(".fu-chip")].map(c => [c.dataset.filter, Number(c.querySelector("span").textContent)]))`);

// ================= 1. Başlangıç =================
await open(1280);
await settingsOpen(); await toWiz();
check("başlangıç: adım 1 etkin, 2-4 kilitli; işaretler 1..4", [await states(), await marks()], [["active", "locked", "locked", "locked"], ["1", "2", "3", "4"]]);
check("kilitli adımların düğmeleri devre dışı", await dis("btnMwApp", "btnMwTwosv", "mwPass", "btnMwConnect", "btnMwCal", "mwIcal", "btnMwIcal"), [true, true, true, true, true, true, true]);
check("gelişmiş (Google girişi) kapalı bir ayrıntı, başlığı", await ev(`[document.getElementById("mwAdv").open, document.querySelector("#mwAdv summary").textContent]`), [false, "Google girişi (gelişmiş)"]);
check("sihirbaz başlıkları ve tek cümle yönerge", await ev(`[...document.querySelectorAll(".mw-title")].map(x => x.textContent).concat(document.querySelector("#mwS2 .mw-hint").textContent)`),
  ["1. E-posta adresinizi yazın", "2. Uygulama şifresi oluşturun", "3. Şifreyi yapıştırın", "4. Takvim (isteğe bağlı)", "Ad verip Oluştur'a basın, 16 haneli şifreyi kopyalayın."]);
check("hesap yokken Takip'te mail çipi yok", Object.keys(await chips()).filter(k => k === "mail" || k === "cal"), []);
check("Ayarlar 1280: taşma yok", await measureSet(), SET_CLEAN);
await shot("1280_baslangic");

// ================= 2. Adım 1: e-posta =================
await typeIn("mwEmail", "abc");
await until(`document.getElementById("mwMsg1").textContent.length > 0`, 3000);
check("geçersiz adres: uyarı, adımlar kilitli", [await txt("mwMsg1"), (await states())[1]], ["Geçerli bir e-posta adresi yazın.", "locked"]);
await typeIn("mwEmail", "biri@diger.net");
await until(`document.getElementById("mwMsg1").textContent.includes("desteklenmiyor")`, 4000);
check("Google olmayan alan adı: 'şimdilik desteklenmiyor', ilerlenmez", [await txt("mwMsg1"), await states()],
  ["Bu sağlayıcı şimdilik desteklenmiyor. Yalnız Gmail ve Google Workspace hesapları eklenebilir.", ["active", "locked", "locked", "locked"]]);
check("desteklenmeyende uyarı rengi", await ev(`document.getElementById("mwMsg1").dataset.kind`), "warn");
await typeIn("mwEmail", KISI);
await until(`document.getElementById("mwS1").dataset.state === "done"`, 4000);
check("Google alan adı: adım 1 ✓, 2 ve 3 etkin, 4 kilitli", [await states(), await marks(), await txt("mwMsg1")],
  [["done", "active", "active", "locked"], ["✓", "2", "3", "4"], "Google hesabı olarak tanındı (Gmail / Google Workspace)."]);
check("2. adım düğmeleri açıldı, bağlan şifre bekliyor", await dis("btnMwApp", "btnMwTwosv", "mwPass", "btnMwConnect", "btnMwCal"), [false, false, false, true, true]);

// ================= 3. Adım 2: Google sayfalarını açtır =================
await click(`document.getElementById("btnMwApp")`, 700);
check("Uygulama şifresi oluştur: sunucu doğru sayfayı açtı (kayıt), adım 2 ✓", [opened(), await states(), await txt("mwMsg2")],
  [[`https://myaccount.google.com/apppasswords?authuser=${encodeURIComponent(KISI)}`], ["done", "done", "active", "locked"], "Google sayfası tarayıcıda açıldı."]);
await ev(`document.querySelector("#mwS2 details").open = true`);
await click(`document.getElementById("btnMwTwosv")`, 700);
check("ayrıntı: iki adımlı doğrulama sayfası + şirket notu", [opened().pop(), await ev(`document.querySelector("#mwS2 details .mw-hint:last-child").textContent`)],
  [`https://myaccount.google.com/signinoptions/twosv?authuser=${encodeURIComponent(KISI)}`, "Şirket (Google Workspace) hesabında yönetici uygulama şifrelerini ya da IMAP'i kapatmış olabilir. BT'ye sorun ya da aşağıdaki \"Google girişi (gelişmiş)\" yolunu deneyin."]);
await ev(`document.querySelector("#mwS2 details").open = false`);
check("sayfalar yalnız bu e-postayla açıldı (kayıtta 2 satır)", opened().length, 2);

// ================= 4. Adım 3: şifre =================
await typeIn("mwPass", "qwer tyui opas dfgh");
check("boşluklu yapıştırma: boşluklar atıldı, 16 harf hazır, düğme açıldı", [await ev(`document.getElementById("mwPass").value`), await txt("mwMsg3a"), await dis("btnMwConnect")], [PW1, "16 harf, hazır.", [false]]);
await typeIn("mwPass", "abcd efg");
check("eksik şifre: anında sayaç, düğme kapalı", [await txt("mwMsg3a"), await dis("btnMwConnect")], ["7 / 16 harf", [true]]);
await typeIn("mwPass", "abcd1234abcd1234");
check("harf olmayan karakter: hesap şifresi uyarısı, düğme kapalı", [await txt("mwMsg3a"), await dis("btnMwConnect")], ["Uygulama şifresi yalnız harflerden oluşur (16 harf). Hesap şifreniz çalışmaz.", [true]]);
check("şifre kutusu maskeli (yazı görünmez)", await ev(`getComputedStyle(document.getElementById("mwPass")).webkitTextSecurity`), "disc");
await typeIn("mwPass", "aaaa bbbb cccc dddd");
await click(`document.getElementById("btnMwConnect")`, 100);
await until(`document.getElementById("mwMsg3").textContent.length > 0`, 6000);
check("yanlış şifre: anlaşılır neden (Workspace notlu), adım 3 tamamlanmadı", [(await txt("mwMsg3")).startsWith("Şifre kabul edilmedi."), (await txt("mwMsg3")).includes("Workspace"), (await states())[2], (await mailApi()).accounts.length], [true, true, "active", 0]);
await shot("1280_yanlis_sifre");
await typeIn("mwPass", "qwer tyui opas dfgh");
await click(`document.getElementById("btnMwConnect")`, 100);
await until(`document.getElementById("mwS3").dataset.state === "done"`, 8000);
check("doğru şifre: kanıt (okunmamış sayısı), adım 3 ✓, şifre kutusu temizlendi", [await txt("mwMsg3"), (await states())[2], await ev(`document.getElementById("mwPass").value`), await ev(`document.getElementById("mwMsg3").dataset.kind`)],
  ["Bağlandı. Gelen kutunuzda 8 okunmamış mail var.", "done", "", "ok"]);
check("adım 4 açıldı, hesap satırı geldi", [(await states())[3], (await acct()).map(a => a.ad)], ["active", [KISI]]);

// ================= 5. Adım 4: iCal =================
await click(`document.getElementById("btnMwCal")`, 700);
check("Takvim adresini al: doğru sayfa açıldı", opened().pop(), `https://calendar.google.com/calendar/r/settings?authuser=${encodeURIComponent(KISI)}`);
check("adres yokken Dene kapalı", await dis("btnMwIcal"), [true]);
await typeIn("mwIcal", "https://example.com/takvim.ics");
check("yanlış biçim: anında uyarı (Dene engellenmez, karar sunucuda)", [await txt("mwMsg4a"), await ev(`document.getElementById("mwMsg4a").dataset.kind`), await dis("btnMwIcal")],
  ["Adres calendar.google.com/calendar/ical/…/private-…/basic.ics biçiminde olmalı.", "warn", [false]]);
await click(`document.getElementById("btnMwIcal")`, 100);
await until(`document.getElementById("mwMsg4").textContent.length > 0`, 6000);
check("Google'ın olmayan adres sunucuda reddedildi, adım 4 tamamlanmadı", [(await txt("mwMsg4")).startsWith("Bu bir Google Takvim iCal adresi değil."), (await states())[3]], [true, "active"]);
await typeIn("mwIcal", "https://calendar.google.com/calendar/ical/a%40b.com/private-abc123/basic.ics");
check("doğru biçim: onay", [await txt("mwMsg4a"), await ev(`document.getElementById("mwMsg4a").dataset.kind`)], ["Adres biçimi doğru.", "ok"]);
const ICK = `http://127.0.0.1:${ICAL_PORT}/ical/kisisel-ICALGIZLI1/basic.ics`;
await typeIn("mwIcal", ICK);
await click(`document.getElementById("btnMwIcal")`, 100);
await until(`document.getElementById("mwS4").dataset.state === "done"`, 8000);
check("Dene: önümüzdeki 24 saatte 5 etkinlik, adım 4 ✓, adres kutusu temizlendi", [await txt("mwMsg4"), (await states())[3], await ev(`document.getElementById("mwIcal").value`)],
  ["Önümüzdeki 24 saatte 5 etkinlik bulundu.", "done", ""]);
check("dört adım da ✓", [await states(), await marks()], [["done", "done", "done", "done"], ["✓", "✓", "✓", "✓"]]);
check("sayfada şifre ve iCal adresi yok (kutular boş, hesap satırı yalnız durum)", await ev(`document.getElementById("mailBox").innerText.includes("${PW1}") || document.getElementById("mailBox").innerHTML.includes("ICALGIZLI")`), false);
await toWiz(); await shot("1280_dort_adim");

// ================= 6. Hesap satırı =================
await until(`fetch("/api/mail").then(r => r.json()).then(d => d.accounts[0].state === "ok" && d.accounts[0].okAt > 0)`, 10000);
await click(rowBtn(KISI, "Yeniden dene"), 100);
check("Yeniden dene: düğme 'Denetleniyor…' olur", (await acct())[0].dugme[0], "Denetleniyor…");
await until(`document.querySelector("#smAccounts .mail-acct small").textContent.startsWith("bağlı · son kontrol") && document.querySelector("#smAccounts .mail-acct .btn").textContent === "Yeniden dene"`, 20000);
let acc = await acct();
check("hesap satırı: bağlı · son kontrol saati; düğmeler", [acc[0].durum.replace(/\d\d:\d\d/, "SS:DD"), acc[0].dugme], ["bağlı · son kontrol SS:DD", ["Yeniden dene", "Şifreyi değiştir", "Takvim adresi", "Kaldır"]]);
await click(rowBtn(KISI, "Şifreyi değiştir"), 500);
check("Şifreyi değiştir: adres sihirbaza yüklendi, şifre kutusuna odak, adım 3 etkin", [await ev(`document.getElementById("mwEmail").value`), await ev(`document.activeElement.id`), (await states())[2]], [KISI, "mwPass", "active"]);
await click(rowBtn(KISI, "Takvim adresi"), 500);
check("Takvim adresi: adres kutusuna odak, adım 3 ✓ adım 4 etkin", [await ev(`document.activeElement.id`), await states()], ["mwIcal", ["done", "done", "done", "active"]]);

// ---- ikinci hesap: Workspace ----
await typeIn("mwEmail", SIRK);
await until(`document.getElementById("mwS1").dataset.state === "done"`, 4000);
await typeIn("mwPass", "zxcv bnml kjhg fdsa");
await click(`document.getElementById("btnMwConnect")`, 100);
await until(`document.getElementById("mwS3").dataset.state === "done"`, 8000);
check("Workspace hesabı: 3 okunmamış kanıtı", await txt("mwMsg3"), "Bağlandı. Gelen kutunuzda 3 okunmamış mail var.");
await typeIn("mwIcal", `http://127.0.0.1:${ICAL_PORT}/ical/sirket-ICALGIZLI2/basic.ics`);
await click(`document.getElementById("btnMwIcal")`, 100);
await until(`document.getElementById("mwS4").dataset.state === "done"`, 8000);
check("iki hesap listede", (await acct()).map(a => a.ad), [KISI, SIRK]);
await until(`fetch("/api/mail").then(r => r.json()).then(d => d.accounts.every(a => a.state === "ok"))`, 12000);

// ================= 7. Workspace yönetici kısıtları =================
const retry = async (email, wantRx) => {
  await click(rowBtn(email, "Yeniden dene"), 100);
  await until(`new RegExp(${J(wantRx)}).test([...document.querySelectorAll("#smAccounts .mail-acct")].find(li => li.querySelector("b").textContent === ${J(email)}).querySelector("small").textContent)`, 20000);
  return (await acct()).find(a => a.ad === email).durum;
};
sen("auth");
check("hesap satırı: şifre kabul edilmedi (kişisel etkilenmez)", [await retry(SIRK, "şifre kabul edilmedi"), (await acct())[0].durum.startsWith("bağlı")], ["şifre kabul edilmedi", true]);
check("uyarı rengi ve 'Şifreyi değiştir' öne çıktı", await ev(`(() => { const li = [...document.querySelectorAll("#smAccounts .mail-acct")][1]; return [li.querySelector("small").className, [...li.querySelectorAll(".btn")].find(b => b.textContent === "Şifreyi değiştir").classList.contains("primary")]; })()`), ["mail-warn", true]);
sen("domain");
check("hesap satırı: yönetici IMAP'i kapatmış", await retry(SIRK, "yönetici IMAP"), "yönetici IMAP'i kapatmış");
sen("disabled");
check("hesap satırı: IMAP kapalı", await retry(SIRK, "IMAP kapalı"), "IMAP kapalı");
sen("ok", 404);
check("hesap satırı: takvim adresi okunamadı", await retry(SIRK, "takvim adresi okunamadı"), "takvim adresi okunamadı");
await settingsClose();
await open(1280);
await sleep(500);
const fuNotes = await ev(`[...document.querySelectorAll(".fu-clean")].map(p => p.textContent)`);
check("Takip: Workspace takvim adresi notu hesap adıyla (ayrı, anlaşılır Türkçe)", fuNotes.some(n => n.startsWith(`${SIRK}: takvim adresi okunamadı`) && n.includes("dışa paylaşımı kapatmış olabilir")), true);
sen("auth");
await click(`document.getElementById("btnFuRefresh")`, 600);
await until(`[...document.querySelectorAll(".fu-clean")].some(p => p.textContent.includes("kabul edilmedi"))`, 15000);
const n2 = await ev(`[...document.querySelectorAll(".fu-clean")].map(p => p.textContent)`);
check("Takip: şifre kabul edilmedi notu (şirket hesabı uyarısıyla)", n2.some(n => n.startsWith(`${SIRK}: uygulama şifresi kabul edilmedi`) && n.includes("yönetici uygulama şifrelerini kapatmış olabilir")), true);
sen("domain");
await click(`document.getElementById("btnFuRefresh")`, 600);
await until(`[...document.querySelectorAll(".fu-clean")].some(p => p.textContent.includes("yöneticisi IMAP'i kapatmış"))`, 15000);
check("Takip: yönetici IMAP'i kapatmış notu", (await ev(`[...document.querySelectorAll(".fu-clean")].map(p => p.textContent)`)).some(n => n.startsWith(`${SIRK}: şirket yöneticisi IMAP'i kapatmış olabilir`)), true);
sen("ok");
await click(`document.getElementById("btnFuRefresh")`, 600);
await until(`![...document.querySelectorAll(".fu-clean")].some(p => p.textContent.includes("yöneticisi") || p.textContent.includes("kabul edilmedi"))`, 15000);
await sleep(800);

// ================= 8. Takip: iki hesabın satırları =================
await mode("type"); await openCont("fu-mail"); await openCont("fu-cal");
await ev(`(async () => { for (const b of document.querySelectorAll('.fu-row:not(.fu-open) .fu-tog')) b.click(); })()`); await sleep(300);
const mailRows = await ev(`[...document.querySelectorAll('.fu-row[data-type="mail"]')].map(r => ({ konu: r.querySelector("b").textContent, ne: r.querySelector(".fu-what")?.textContent || "", adres: [...r.querySelectorAll(".fu-side a")].map(a => a.href) }))`);
check("Takip: iki hesaptan satırlar, hangi hesaptan geldiği görünür", [mailRows.some(r => r.ne.includes(KISI)), mailRows.some(r => r.ne.includes(SIRK))], [true, true]);
check("Gmail'de aç: her satır kendi hesabıyla (authuser)", [
  mailRows.find(r => r.konu === "Bütçe onayı")?.adres[0], mailRows.find(r => r.konu === "Teklif revizyonu")?.adres[0]],
  [`https://mail.google.com/mail/?authuser=${encodeURIComponent(SIRK)}#all/1b59`, `https://mail.google.com/mail/?authuser=${encodeURIComponent(KISI)}#all/1771`]);
check("RFC 2047 konu Takip'te okunur", mailRows.some(r => r.konu === "Türkçe başlık: çğıöşü"), true);
await shot("1280_takip");

// ================= 8b. Benim adreslerim / gruplarım =================
const aliasBox = (email = SIRK) => `[...document.querySelectorAll("#smAccounts .mail-acct")].find(l => l.querySelector("b").textContent === ${J(email)}).querySelector(".mail-alias")`;
const aliasInfo = () => ev(`(() => { const d = ${aliasBox()}; return { acik: d.open, ozet: d.querySelector("summary").textContent.trim(), deger: d.querySelector("input").value,
  oneri: [...d.querySelectorAll(".mail-alias-add")].map(b => b.textContent) }; })()`);
const fuRules = (thread) => ev(`fetch("/api/followup").then(r => r.json()).then(d => d.mail.mails.find(m => m.threadId === ${J(thread)})?.rules ?? null)`);
await settingsOpen(); await toWiz();
check("adres bölümü kapalı gelir; öneri = kendi alan adındaki adres + sayı (kişi/grup ayrımı sizde)", await aliasInfo(), { acik: false, ozet: "Benim adreslerim / gruplarım", deger: "", oneri: ["herkes@sirket.com.tr · 1 mail"] });
check("kişisel Gmail hesabında öneri yok (genel alan adı/kendi alan adı adresi yok)", await ev(`${aliasBox(KISI)}.querySelectorAll(".mail-alias-add").length`), 0);
check("grup adresi eklenmeden: 'Yıllık izin planı' (Kime'de herkes@, bana CC) yalnız bekleyen", await fuRules("1b5a"), ["awaiting"]);
await click(`${aliasBox()}.querySelector("summary")`, 300);
await shot("1280_adresler_acik");
await click(`${aliasBox()}.querySelector(".mail-alias-add")`, 900);
check("öneri tek tıkla eklendi: bölüm açık kaldı, kutuda adres, özet sayı, öneri kalktı, bildirim", [await aliasInfo(), (await toasts()).includes("Adresler kaydedildi")],
  [{ acik: true, ozet: "Benim adreslerim / gruplarım (1)", deger: "herkes@sirket.com.tr", oneri: [] }, true]);
check("sunucuda kalıcı", (await mailApi()).accounts.find(a => a.email === SIRK).aliases, ["herkes@sirket.com.tr"]);
check("eklenince hemen yeniden tarandı: grup adresi Kime'de sayılır (direct + bekleyen)", await until(`fetch("/api/followup").then(r => r.json()).then(d => (d.mail.mails.find(m => m.threadId === "1b5a")?.rules || []).includes("direct"))`, 15000) && await fuRules("1b5a"), ["awaiting", "direct"]);
await ev(`(() => { const i = ${aliasBox()}.querySelector("input"); i.focus(); i.value = "herkes@sirket.com.tr, ekip@sirket.com.tr, bozuk adres, ${SIRK}"; i.dispatchEvent(new Event("change", { bubbles: true })); })()`);
await sleep(900);
check("elle yazılan liste: kötü adres ve kendi adresim atılır, kutu temizlenmiş değeri gösterir", (await aliasInfo()).deger, "herkes@sirket.com.tr, ekip@sirket.com.tr");
await settingsClose();
await open(1280);
await settingsOpen(); await toWiz();
check("sayfa yenilenince adresler duruyor (yükle/kaydet/yeniden aç)", (await aliasInfo()).deger, "herkes@sirket.com.tr, ekip@sirket.com.tr");
await click(`${aliasBox()}.querySelector("summary")`, 300);
await shot("1280_adresler");
await settingsClose();

// Çok fazla ileti: Takip'te not
writeFileSync(join(tmpRoot, "senaryo.json"), J({ hesaplar: { [KISI]: { parola: PW1, mod: "ok", set: "kisisel" }, [SIRK]: { parola: PW2, mod: "ok", set: "cok" } },
  ical: { "kisisel-ICALGIZLI1": { durum: 200, icerik: "kisisel" }, "sirket-ICALGIZLI2": { durum: 200, icerik: "sirket" } } }));
await open(1280);
await click(`document.getElementById("btnFuRefresh")`, 600);
check("1100 ileti: Takip'te 'son 14 günde çok fazla ileti, yalnız en yeni 1000' notu hesap adıyla", await until(`[...document.querySelectorAll(".fu-clean")].some(p => p.textContent.includes("yalnız en yeni 1000 iletiye bakıldı"))`, 40000)
  && await ev(`[...document.querySelectorAll(".fu-clean")].some(p => p.textContent.startsWith(${J(SIRK + ": son 14 günde çok fazla ileti var")}))`), true);
await shot("1280_cok_ileti");
sen("ok");
await click(`document.getElementById("btnFuRefresh")`, 600);
check("sınır altına inince not kalkar", await until(`![...document.querySelectorAll(".fu-clean")].some(p => p.textContent.includes("yalnız en yeni"))`, 30000), true);

// 390 px: adres bölümü açık, öneriler
await open(390);
await settingsOpen(); await toWiz();
await click(`${aliasBox()}.querySelector("summary")`, 300);
await ev(`${aliasBox()}.scrollIntoView({ block: "center" })`);
check("390 px adres bölümü açık: taşma yok, tüm düğmeler ≥ 44 px", await measureSet(), SET_CLEAN);
await shot("390_adresler");
await settingsClose();
await open(1280);

// ================= 9. Kaldır (onaylı) =================
await settingsOpen(); await toWiz();
await click(rowBtn(SIRK, "Kaldır"), 500);
check("Kaldır: panelin onay penceresi (tarayıcının değil), adres başlıkta", await box(), { title: `${SIRK} kaldırılsın mı?`, buttons: ["Vazgeç", "Kaldır"] });
await press("cancel");
check("vazgeçince hesap duruyor", (await acct()).length, 2);
await click(rowBtn(SIRK, "Kaldır"), 500);
await press("yes");
await until(`document.querySelectorAll("#smAccounts .mail-acct").length === 1`, 5000);
check("onaylayınca hesap kalktı + bildirim", [(await acct()).map(a => a.ad), (await toasts()).includes(`${SIRK} kaldırıldı`)], [[KISI], true]);

// ================= 10. İngilizce + telefon =================
await settingsClose();
await open(1280, { lang: "en", light: true });
await settingsOpen(); await toWiz();
check("EN: sihirbaz başlıkları", await ev(`[...document.querySelectorAll(".mw-title")].map(x => x.textContent)`), ["1. Type your email address", "2. Create an app password", "3. Paste the password", "4. Calendar (optional)"]);
await typeIn("mwEmail", "biri@diger.net");
await until(`document.getElementById("mwMsg1").textContent.includes("supported")`, 4000);
check("EN: desteklenmeyen sağlayıcı", await txt("mwMsg1"), "This provider isn't supported yet. Only Gmail and Google Workspace accounts can be added.");
check("EN açık tema: taşma yok", await measureSet(), SET_CLEAN);
await shot("1280_en_acik");
await settingsClose();

await open(390);
await settingsOpen(); await toWiz();
check("390 px: taşma yok, tüm düğmeler ≥ 44 px", await measureSet(), SET_CLEAN);
await shot("390_sihirbaz");
await typeIn("mwEmail", KISI);
await until(`document.getElementById("mwS1").dataset.state === "done"`, 4000);
await typeIn("mwPass", "abcd");
await ev(`document.getElementById("mwS3").scrollIntoView({ block: "center" })`);
check("390 px sihirbaz ilerlemiş: taşma yok", await measureSet(), SET_CLEAN);
await shot("390_adimlar");
await ev(`document.getElementById("smAccounts").scrollIntoView({ block: "center" })`);
check("390 px hesap satırı: taşma yok", await measureSet(), SET_CLEAN);
await shot("390_hesap");
await settingsClose();

await open(390, { remote: true });
await settingsOpen(); await toWiz();
check("telefondan: sihirbaz ve gelişmiş gizli, not görünür, süzgeç açık", await ev(`[!!document.getElementById("mwWizard").offsetWidth, !!document.getElementById("mwAdv").offsetWidth, !!document.querySelector("#mailBox .remote-only").offsetWidth, !!document.getElementById("smFilter").offsetWidth]`), [false, false, true, true]);
check("telefondan hesap satırında yalnız kaynak kutuları (düğme yok)", (await acct()).map(a => a.dugme), [[]]);
await shot("390_telefon");
await settingsClose();

await tally();
check("tarayıcının yerleşik confirm/alert/prompt'u hiç çağrılmadı", native, { confirm: 0, alert: 0, prompt: 0 });
check("sayfa hatası yok", errors, []);
console.log(`${pass + fail} denetim, ${fail} hata`);
process.exit(fail ? 1 : 0);
