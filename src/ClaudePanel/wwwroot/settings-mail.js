// Ayarlar → "Mail ve takvim" (sunucu: Mail/MailEndpoints.cs). İKİ YOL:
//  1) VARSAYILAN, adım adım sihirbaz (Gmail / Google Workspace, IMAP + uygulama şifresi, isteğe bağlı iCal takvim adresi):
//     e-posta → uygulama şifresi sayfasını aç → şifreyi yapıştır, bağlan ve dene → takvim adresi (isteğe bağlı). Her adımın yanında tamamlandı işareti.
//     Şifre ve iCal adresi yalnız sunucuya gider (şifreli saklanır); arayüze geri yazılmaz, hesap satırında yalnız durum görünür.
//  2) "Google girişi (gelişmiş)": OAuth istemci dosyası + tarayıcıda Google girişi (eski yol, açılır-kapanır).
// Hesap listesi (çok hesap; adres girişten/forma yazılandan gelir), kaynak kutuları, kalıcı süzgeç (genel, hesap başına değil).
// Telefondan hesap/kaynak/istemci değiştirilemez (sunucu da 403 verir); süzgeç ve okuma açık. Tarayıcının yerleşik confirm/alert/prompt
// pencereleri kullanılmaz: sorular ask()/confirmBox() ile.
window.PanelSettingsMail = function (c) {
  "use strict";
  const { t, api, getJson, toast, ask, confirmBox, esc, REMOTE, reload } = c; // reload: Takip'i yeniden çiz (hesap/kaynak/süzgeç değişti)
  const $ = (id) => document.getElementById(id);
  const LOGIN_POLL_MS = 1500, TYPE_MS = 450;
  const EMAIL_RX = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
  const ICAL_RX = /^https:\/\/calendar\.google\.com\/calendar\/ical\/[^\s/]+\/private-[^\s/]+\/basic\.ics$/;
  let st = null, pollTimer = null, typeTimer = null, provSeq = 0;
  // Sihirbaz durumu: ok1 = e-posta Google hesabı; opened = 2. adım açıldı; connected = 3. adım bağlandı; icalOk = 4. adım denendi
  const wiz = { ok1: false, opened: false, connected: false, icalOk: false, busy: false };

  const errText = (code) => { const k = "smErr_" + (code || "generic"); const s = t(k); return s === k ? t("smErr_generic") : s; };
  const split = (s) => String(s || "").split(",").map(x => x.trim()).filter(Boolean);
  const hm = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const msg = (id, text, kind) => { const e = $(id); e.textContent = text || ""; if (kind) e.dataset.kind = kind; else delete e.dataset.kind; };
  const email = () => $("mwEmail").value.trim();

  // ---------- Sihirbaz ----------

  /** Adım durumları: done (✓) | active | locked. Kilitli adımın denetimleri devre dışı. */
  function steps() {
    const states = [
      wiz.ok1 ? "done" : "active",
      !wiz.ok1 ? "locked" : wiz.opened || wiz.connected ? "done" : "active",
      !wiz.ok1 ? "locked" : wiz.connected ? "done" : "active",
      !wiz.connected ? "locked" : wiz.icalOk ? "done" : "active"
    ];
    states.forEach((s, i) => { $("mwS" + (i + 1)).dataset.state = s; $("mwM" + (i + 1)).textContent = s === "done" ? "✓" : String(i + 1); });
    const busy = wiz.busy;
    $("btnMwApp").disabled = !wiz.ok1 || busy;
    $("btnMwTwosv").disabled = !wiz.ok1 || busy;
    $("mwPass").disabled = !wiz.ok1 || busy;
    $("btnMwConnect").disabled = !wiz.ok1 || busy || !passValid();
    $("btnMwCal").disabled = !wiz.connected || busy;
    $("mwIcal").disabled = !wiz.connected || busy;
    $("btnMwIcal").disabled = !wiz.connected || busy || !$("mwIcal").value.trim();
  }

  function resetFrom(step) {
    if (step <= 2) wiz.opened = false;
    if (step <= 3) { wiz.connected = false; msg("mwMsg3", ""); $("mwPass").value = ""; msg("mwMsg3a", ""); }
    if (step <= 4) { wiz.icalOk = false; msg("mwMsg4", ""); msg("mwMsg4a", ""); $("mwIcal").value = ""; }
    msg("mwMsg2", "");
  }

  /** 1. adım: adres yazılır; alan adı Google mı sunucuda denetlenir (gmail.com ya da MX'i Google). */
  async function checkEmail() {
    const e = email();
    const seq = ++provSeq;
    wiz.ok1 = false;
    resetFrom(2);
    if (!e) { msg("mwMsg1", ""); steps(); return; }
    if (!EMAIL_RX.test(e)) { msg("mwMsg1", t("mwEmailBad"), "warn"); steps(); return; }
    msg("mwMsg1", t("mwProvChecking"));
    steps();
    const r = await api("/api/mail/imap/provider", { email: e });
    if (seq !== provSeq) return; // araya yeni yazı girdi
    const p = r.ok ? r.data?.provider : null;
    wiz.ok1 = p === "google" || p === "unknown";
    msg("mwMsg1", p === "google" ? t("mwProvGoogle") : p === "unknown" ? t("mwProvUnknown") : p === "other" ? t("mwProvOther") : errText(r.data?.error), p === "google" ? "ok" : "warn");
    steps();
  }
  $("mwEmail").addEventListener("input", () => {
    wiz.ok1 = false; steps();
    clearTimeout(typeTimer);
    typeTimer = setTimeout(checkEmail, TYPE_MS);
  });
  $("mwEmail").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(typeTimer); checkEmail(); } });

  /** Google'ın sabit sayfasını sunucu açar (adres istemciden gelmez: hedef adı + e-posta). Açılamazsa bağlantı yazılır. */
  async function openGoogle(target, msgId) {
    const r = await api("/api/mail/open", { target, email: email() });
    if (!r.ok) { msg(msgId, errText(r.data?.error), "warn"); return false; }
    msg(msgId, r.data.opened ? t("mwS2Opened") : `${t("mwS2Link")} ${r.data.url}`, r.data.opened ? "ok" : "warn");
    return true;
  }
  $("btnMwApp").addEventListener("click", async () => { if (await openGoogle("apppasswords", "mwMsg2")) { wiz.opened = true; steps(); } });
  $("btnMwTwosv").addEventListener("click", () => openGoogle("twosv", "mwMsg2"));
  $("btnMwCal").addEventListener("click", () => openGoogle("calendar", "mwMsg4a"));

  // 3. adım: yapıştırılan şifrede boşluklar anında atılır; 16 harf değilse hemen uyarı.
  const cleanPass = () => $("mwPass").value.replace(/\s+/g, "");
  const passValid = () => /^[A-Za-z]{16}$/.test(cleanPass());
  $("mwPass").addEventListener("input", () => {
    const v = cleanPass();
    if ($("mwPass").value !== v) $("mwPass").value = v;
    msg("mwMsg3", "");
    if (!v) msg("mwMsg3a", "");
    else if (!/^[A-Za-z]*$/.test(v) || v.length > 16) msg("mwMsg3a", t("mwPassBad"), "warn");
    else if (v.length < 16) msg("mwMsg3a", t("mwPassCount", v.length));
    else msg("mwMsg3a", t("mwPassOk"), "ok");
    steps();
  });
  $("mwPass").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (!$("btnMwConnect").disabled) connect(); } });

  async function connect() {
    wiz.busy = true; steps();
    $("btnMwConnect").textContent = t("mwConnecting");
    const r = await api("/api/mail/imap/add", { email: email(), password: cleanPass() });
    wiz.busy = false;
    $("btnMwConnect").textContent = t("mwConnect");
    if (!applyBrief(r, "mwMsg3")) { steps(); return; }
    wiz.connected = true;
    $("mwPass").value = ""; msg("mwMsg3a", "");        // şifre kutuda bekletilmez
    const n = r.data.result?.unseen;
    msg("mwMsg3", n == null ? t("mwConnectedNoCount") : t("mwConnected", n), "ok");
    toast(t("smAdded", email()));
    steps();
  }
  $("btnMwConnect").addEventListener("click", connect);

  // 4. adım: adres yapıştırılınca biçim denetlenir (geçerli sunucu kararıdır; uyarı engellemez).
  $("mwIcal").addEventListener("input", () => {
    const v = $("mwIcal").value.trim();
    msg("mwMsg4", "");
    if (!v) msg("mwMsg4a", "");
    else if (ICAL_RX.test(v)) msg("mwMsg4a", t("mwIcalFormatOk"), "ok");
    else msg("mwMsg4a", t("mwIcalFormatBad"), "warn");
    steps();
  });
  async function tryIcal() {
    if (!wiz.connected) { msg("mwMsg4", t("mwNeedConnect"), "warn"); return; }
    wiz.busy = true; steps();
    $("btnMwIcal").textContent = t("mwIcalTrying");
    const r = await api("/api/mail/imap/add", { email: email(), password: "", ical: $("mwIcal").value.trim() });
    wiz.busy = false;
    $("btnMwIcal").textContent = t("mwIcalTry");
    if (!applyBrief(r, "mwMsg4")) { steps(); return; }
    wiz.icalOk = true;
    $("mwIcal").value = ""; msg("mwMsg4a", "");
    msg("mwMsg4", t("mwIcalFound", r.data.result?.events ?? 0), "ok");
    steps();
  }
  $("btnMwIcal").addEventListener("click", tryIcal);
  $("mwIcal").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (!$("btnMwIcal").disabled) tryIcal(); } });

  /** Sunucu yanıtı tamam mı: hesap listesini yeniler, Takip'i yeniden çizer; değilse hata metnini ilgili satıra yazar. */
  function applyBrief(r, msgId) {
    if (r.ok && r.data?.accounts) { st = r.data; render(); reload(); return true; }
    msg(msgId, errText(r.data?.error), "warn");
    return false;
  }

  /** Listedeki hesabı sihirbaza yükler (şifreyi değiştir / takvim adresi): 1. adım hazır, hedef adıma odaklanır. */
  function editAccount(a, focus) {
    $("mwEmail").value = a.email;
    resetFrom(2);
    wiz.ok1 = true; wiz.connected = focus === "ical";
    msg("mwMsg1", t("mwProvGoogle"), "ok");
    steps();
    const target = $(focus === "ical" ? "mwIcal" : "mwPass");
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.focus();
  }

  // ---------- Hesap listesi ----------

  function render() {
    if (!st) return;
    $("smSteps").hidden = st.client;
    $("smClientOk").hidden = !st.client;
    $("btnSmClient").textContent = t(st.client ? "smClientChange" : "smClientPick");
    $("btnSmClient").classList.toggle("primary", !st.client);
    $("btnSmAdd").hidden = !st.client;
    const waiting = st.login?.state === "waiting";
    $("smLogin").hidden = !waiting;
    $("btnSmAdd").disabled = waiting;
    if (waiting) $("mwAdv").open = true;
    const ul = $("smAccounts");
    ul.replaceChildren();
    if (!st.accounts.length) ul.innerHTML = `<li class="mail-none">${esc(t("smNoAccounts"))}</li>`;
    for (const a of st.accounts) ul.appendChild(account(a, waiting));
    const f = st.filter;
    $("smDirect").checked = f.direct; $("smCc").checked = f.cc; $("smAwaiting").checked = f.awaiting;
    for (const [id, list] of [["smSenders", f.senders], ["smKeywords", f.keywords], ["smLabels", f.labels]])
      if (document.activeElement !== $(id)) $(id).value = list.join(", ");
  }

  /** Durum satırı: bağlı (son kontrol saati) ya da hatanın anlaşılır nedeni. */
  function stateOf(a) {
    const imap = a.provider === "imap";
    const key = (imap ? "smStateI_" : "smState_") + a.state;
    if (a.state === "ok") return [imap && a.okAt ? t("mwStateOk", hm(a.okAt)) : t(key), "ok"];
    return [t(key), a.state === "pending" ? "" : "warn"];
  }

  function account(a, waiting) {
    const imap = a.provider === "imap";
    const li = document.createElement("li");
    li.className = "mail-acct";
    li.dataset.id = a.id;
    const [text, kind] = stateOf(a);
    li.innerHTML = `<div class="mail-acct-head"><b>${esc(a.email)}</b><small class="${kind === "warn" ? "mail-warn" : kind === "ok" ? "mail-ok" : ""}">${esc(text)}</small></div>`;
    const row = li.appendChild(document.createElement("div"));
    row.className = "mail-acct-src";
    for (const [src, label] of [["cal", "smSrcCal"], ["mail", "smSrcMail"]]) {
      const l = row.appendChild(document.createElement("label"));
      l.className = "check";
      l.innerHTML = `<input type="checkbox" data-src="${src}"> <span>${esc(t(label))}</span>`;
      const box = l.querySelector("input");
      box.checked = a[src];
      box.disabled = REMOTE || waiting;
      box.addEventListener("change", () => setSources(a, box));
    }
    if (!REMOTE) {
      if (imap) {
        row.appendChild(btn(t("mwRetry"), (e) => retry(a, e.currentTarget)));
        row.appendChild(btn(t("mwEdit"), () => editAccount(a, "pass"), a.state === "reauth" ? "primary" : ""));
        row.appendChild(btn(t("mwEditCal"), () => editAccount(a, "ical")));
      } else if (a.state === "reauth") row.appendChild(btn(t("smReauth"), () => startLogin({ id: a.id, mail: a.mail || a.mailGranted, cal: a.cal || a.calGranted }), "primary"));
      row.appendChild(btn(t("smRemove"), () => remove(a), "danger"));
    }
    return li;
  }

  function btn(label, fn, cls = "") {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn small " + cls;
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  }

  /** "Yeniden dene": şimdi denetletir, sonucu (durum satırı) birkaç saniye izler. */
  async function retry(a, b) {
    b.disabled = true; b.textContent = t("mwRetrying");
    const before = a.triedAt || 0;
    await api("/api/mail/refresh", {});
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 800));
      let fresh;
      try { fresh = await getJson("/api/mail"); } catch { continue; }
      if (fresh.accounts.find(x => x.id === a.id)?.triedAt > before) break;
    }
    await load();
    reload();
  }

  async function load() {
    try { st = await getJson("/api/mail"); } catch { return; }
    render();
    steps();
    if (st.login?.state === "waiting") poll();
  }

  /** Sunucu yanıtı (Brief) gelince durumu güncelle; hata metnini göster. */
  function apply(r) {
    if (r.ok && (r.data?.accounts || r.data?.state)) { st = r.data.accounts ? r.data : r.data.state; render(); reload(); return true; }
    toast(errText(r.data?.error), "warn");
    return false;
  }

  // ---------- Gelişmiş: OAuth istemci dosyası ----------
  $("btnSmClient").addEventListener("click", () => $("smClientFile").click());
  $("smClientFile").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const b = $("btnSmClient");
    b.disabled = true;
    b.textContent = t("smClientReading");
    let json = "";
    try { json = file.size <= 20_000 ? await file.text() : ""; } catch { /* aşağıda geçersiz dosya */ }
    const r = await api("/api/mail/client", { json });
    b.disabled = false;
    if (apply(r)) toast(t("smClientSaved")); else render();
  });

  // ---------- Gelişmiş: Google girişi (OAuth) ----------
  $("btnSmAdd").addEventListener("click", async () => {
    const v = await ask(t("smAddTitle"), t("smAddText"), null, [
      { value: "both", label: t("smAddBoth"), cls: "primary" }, { value: "cal", label: t("smAddCal"), cls: "" }, { value: "mail", label: t("smAddMail"), cls: "" }
    ], { focus: "both" });
    if (v === "cancel") return;
    startLogin({ mail: v !== "cal", cal: v !== "mail" });
  });

  async function startLogin(body) {
    $("btnSmAdd").disabled = true;
    const r = await api("/api/mail/accounts/add", body);
    if (!apply(r)) { $("btnSmAdd").disabled = false; return; }
    poll();
  }

  /** Giriş sürerken durumu izler; bitince sonucu bildirir. */
  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      try { st = await getJson("/api/mail"); } catch { poll(); return; }
      render();
      const l = st.login;
      if (l?.state === "waiting") { poll(); return; }
      if (l?.state === "done") { toast(t("smAdded", l.email)); reload(); }
      else if (l?.state === "failed") toast(t(l.error === "denied" || l.error === "timeout" ? "smLoginFail_" + l.error : "smLoginFail"), "warn");
    }, LOGIN_POLL_MS);
  }

  $("btnSmCancel").addEventListener("click", async () => {
    clearTimeout(pollTimer);
    apply(await api("/api/mail/accounts/cancel", {}));
  });

  // ---------- Kaynaklar / kaldır ----------
  async function setSources(a, box) {
    const want = { mail: a.mail, cal: a.cal, [box.dataset.src]: box.checked };
    box.disabled = true;
    const r = await api("/api/mail/accounts/sources", { id: a.id, ...want });
    box.disabled = false;
    if (r.status === 409 && r.data?.error === "needauth") {
      box.checked = false;
      if (a.provider === "imap") { toast(t("smNeedCalAddr"), "warn"); editAccount(a, "ical"); return; } // IMAP hesabında izin = iCal adresi
      if (await confirmBox({ title: t("smNeedAuthTitle"), text: t("smNeedAuthText"), okText: t("smNeedAuthGo") })) startLogin({ id: a.id, ...want });
      return;
    }
    if (!apply(r)) box.checked = !box.checked;
  }

  async function remove(a) {
    if (!await confirmBox({ title: t("smRemoveTitle", a.email), text: t("smRemoveText"), okText: t("smRemove"), danger: true })) return;
    if (apply(await api("/api/mail/accounts/remove", { id: a.id }))) toast(t("smRemoved", a.email));
  }

  // ---------- Süzgeç: kutu değişince ya da metin kutusundan çıkınca kaydedilir ----------
  async function saveFilter() {
    const body = { direct: $("smDirect").checked, cc: $("smCc").checked, awaiting: $("smAwaiting").checked,
      senders: split($("smSenders").value), keywords: split($("smKeywords").value), labels: split($("smLabels").value) };
    const same = st && JSON.stringify(body) === JSON.stringify({ direct: st.filter.direct, cc: st.filter.cc, awaiting: st.filter.awaiting,
      senders: st.filter.senders, keywords: st.filter.keywords, labels: st.filter.labels });
    if (same) return;
    if (!apply(await api("/api/mail/filter", body))) return;
    // Sunucunun temizlediği değer (boşluk, yinelenen) odaktaki kutuya da yazılır.
    for (const [id, list] of [["smSenders", st.filter.senders], ["smKeywords", st.filter.keywords], ["smLabels", st.filter.labels]]) $(id).value = list.join(", ");
    toast(t("smFilterSaved"));
  }
  for (const id of ["smDirect", "smCc", "smAwaiting"]) $(id).addEventListener("change", saveFilter);
  for (const id of ["smSenders", "smKeywords", "smLabels"]) {
    $(id).addEventListener("change", saveFilter);
    // Enter, yöntemi "dialog" olan formu gönderip Ayarlar'ı kapatmasın: kaydet ve kutuda kal.
    $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveFilter(); } });
  }

  steps();
  $("btnSettings").addEventListener("click", load);
  return { load };
};
