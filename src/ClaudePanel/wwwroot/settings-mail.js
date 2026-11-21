// Ayarlar → "Mail ve takvim" (sunucu: Mail/MailEndpoints.cs). Hesap listesi (çok hesap; adres girişten gelir, elle yazılmaz),
// "Hesap ekle" (Google girişi tarayıcıda; yalnız seçilen kaynağın okuma izni), hesap başına Takvim / Mail kutusu ve Kaldır,
// OAuth istemci dosyası (yoksa kısa yönerge + "İstemci dosyasını seç"; içerik sunucuda şifreli saklanır, arayüze yazılmaz),
// kalıcı süzgeç (kural değişince anında kaydedilir). Telefondan hesap/kaynak/istemci değiştirilemez (sunucu da 403 verir); süzgeç
// ve okuma açık. Tarayıcının yerleşik confirm/alert/prompt pencereleri kullanılmaz: sorular ask()/confirmBox() ile.
window.PanelSettingsMail = function (c) {
  "use strict";
  const { t, api, getJson, toast, ask, confirmBox, esc, REMOTE, reload } = c; // reload: Takip'i yeniden çiz (hesap/kaynak/süzgeç değişti)
  const $ = (id) => document.getElementById(id);
  const LOGIN_POLL_MS = 1500;
  let st = null, pollTimer = null;

  const errText = (code) => { const k = "smErr_" + (code || "generic"); const s = t(k); return s === k ? t("smErr_generic") : s; };
  const split = (s) => String(s || "").split(",").map(x => x.trim()).filter(Boolean);

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
    const ul = $("smAccounts");
    ul.replaceChildren();
    if (!st.accounts.length && st.client) ul.innerHTML = `<li class="mail-none">${esc(t("smNoAccounts"))}</li>`;
    for (const a of st.accounts) ul.appendChild(account(a, waiting));
    const f = st.filter;
    $("smDirect").checked = f.direct; $("smCc").checked = f.cc; $("smAwaiting").checked = f.awaiting;
    for (const [id, list] of [["smSenders", f.senders], ["smKeywords", f.keywords], ["smLabels", f.labels]])
      if (document.activeElement !== $(id)) $(id).value = list.join(", ");
  }

  function account(a, waiting) {
    const li = document.createElement("li");
    li.className = "mail-acct";
    li.dataset.id = a.id;
    const warn = a.state === "reauth" || a.state === "net" || a.state === "noclient";
    li.innerHTML = `<div class="mail-acct-head"><b>${esc(a.email)}</b><small class="${warn ? "mail-warn" : ""}">${esc(t("smState_" + a.state))}</small></div>`;
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
      if (a.state === "reauth") row.appendChild(btn(t("smReauth"), () => startLogin({ id: a.id, mail: a.mail || a.mailGranted, cal: a.cal || a.calGranted }), "primary"));
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

  async function load() {
    try { st = await getJson("/api/mail"); } catch { return; }
    render();
    if (st.login?.state === "waiting") poll();
  }

  /** Sunucu yanıtı (Brief) gelince durumu güncelle; hata metnini göster. */
  function apply(r) {
    if (r.ok && (r.data?.accounts || r.data?.state)) { st = r.data.accounts ? r.data : r.data.state; render(); reload(); return true; }
    toast(errText(r.data?.error), "warn");
    return false;
  }

  // ---- İstemci dosyası ----
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

  // ---- Hesap ekle / giriş ----
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

  // ---- Kaynaklar / kaldır ----
  async function setSources(a, box) {
    const want = { mail: a.mail, cal: a.cal, [box.dataset.src]: box.checked };
    box.disabled = true;
    const r = await api("/api/mail/accounts/sources", { id: a.id, ...want });
    box.disabled = false;
    if (r.status === 409 && r.data?.error === "needauth") {
      box.checked = false;
      if (await confirmBox({ title: t("smNeedAuthTitle"), text: t("smNeedAuthText"), okText: t("smNeedAuthGo") })) startLogin({ id: a.id, ...want });
      return;
    }
    if (!apply(r)) box.checked = !box.checked;
  }

  async function remove(a) {
    if (!await confirmBox({ title: t("smRemoveTitle", a.email), text: t("smRemoveText"), okText: t("smRemove"), danger: true })) return;
    if (apply(await api("/api/mail/accounts/remove", { id: a.id }))) toast(t("smRemoved", a.email));
  }

  // ---- Süzgeç: kutu değişince ya da metin kutusundan çıkınca kaydedilir ----
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

  $("btnSettings").addEventListener("click", load);
  return { load };
};
