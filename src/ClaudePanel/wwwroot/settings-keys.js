// Ayarlar → Hesaplar: dış servis anahtarı kartları (ElevenLabs, OpenRouter, Gemini API; sunucu ApiKeys.cs, /api/hub/key/*).
// Akış: "Bağlan" anahtar sayfasını seçili Chrome profilinde açtırır → kullanıcı anahtarı gizli kutuya yapıştırır →
// "Dene ve kaydet" sunucuya gönderir; sunucu ücretsiz bir deneme isteği atar, geçerse şifreli kasaya yazar.
// Anahtar tarayıcıda saklanmaz, sunucudan geri okunamaz: kart yalnız "bağlı, son 4 karakter" ve denemeden gelen bilgiyi gösterir.
// Bağlama yalnız bilgisayardan; telefonda kartlar durum gösterir, düğme çıkmaz.
window.PanelSettingsKeys = function (d) {
  "use strict";
  const { t, api, esc, confirmBox, REMOTE, lang, hub } = d;
  const $ = (id) => document.getElementById(id);
  const META = {
    elevenlabs: { logo: "♪", who: "setElWho" },
    openrouter: { logo: "◐", who: "setOrWho" },
    gemini: { logo: "✦", who: "setGemWho", personal: true }
  };
  const cards = {};     // sağlayıcı → kart öğesi (yeniden çizimde aynı öğe taşınır: yazılmakta olan anahtar silinmesin)
  const ui = {};        // sağlayıcı → { open, busy, msg, kind }
  let keys = [];
  const num = (n) => Number(n).toLocaleString(lang());
  const money = (n) => Number(n).toLocaleString(lang(), { maximumFractionDigits: 2 });

  function infoLine(k) {
    if (k.id === "elevenlabs" && k.limit != null) return t("setElLeft", num(k.remaining), num(k.limit));
    if (k.id === "openrouter") return k.noLimit ? t("setOrNoLimit") : k.balance != null ? t("setOrLeft", money(k.balance)) : "";
    if (k.id === "gemini" && k.models != null) return t("setGemModels", k.models);
    return "";
  }

  function paint(k) {
    const m = META[k.id], st = ui[k.id] ||= { open: false, busy: false, msg: "", kind: "" };
    let card = cards[k.id];
    if (!card) {
      card = cards[k.id] = document.createElement("div");
      card.className = "set-card set-key";
      card.dataset.key = k.id;
      card.innerHTML = `<div class="set-card-top"><span class="set-logo">${m.logo}</span>
          <div class="set-card-id"><div class="set-name"></div><div class="set-who"></div></div><span class="set-state"></span></div>
        <div class="set-meter" hidden><i></i></div><div class="set-uses"></div>
        <div class="set-btns local-only"></div>
        <div class="set-keybox local-only" hidden>
          <label><span class="set-keylabel"></span><input type="password" class="set-keyinput" autocomplete="new-password" autocapitalize="off" spellcheck="false"></label>
          <div class="set-btns"><button type="button" class="btn small" data-key-act="reopen"></button>
            <button type="button" class="btn small primary" data-key-act="save"></button><button type="button" class="btn small" data-key-act="cancel"></button></div>
        </div>
        <p class="set-msg" role="status"></p><p class="set-uses remote-only"></p>`;
      card.addEventListener("click", (e) => { const b = e.target.closest("[data-key-act]"); if (b && !b.disabled) act(k.id, b.dataset.keyAct); });
      card.querySelector(".set-keyinput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); act(k.id, "save"); } });
    }
    const q = (s) => card.querySelector(s);
    q(".set-name").innerHTML = esc(k.name) + (m.personal ? ` <span class="set-tag">${esc(t("setConnPersonal"))}</span>` : "");
    q(".set-who").textContent = t(m.who) + (k.connected && k.tier ? " · " + k.tier : "");
    q(".set-state").className = "set-state " + (k.connected ? "ok" : "off");
    q(".set-state").textContent = t(k.connected ? "setKeyValid" : "setConnOff");
    const meter = q(".set-meter");
    meter.hidden = !(k.connected && k.id === "elevenlabs" && k.limit > 0);
    if (!meter.hidden) {
      const left = hub.clamp(100 * k.remaining / k.limit);
      meter.className = "set-meter " + hub.level(left);
      meter.firstElementChild.style.width = (100 - left) + "%"; // Claude kartlarıyla aynı: çubuk kullanılanı, renk kalanı gösterir
    }
    const when = k.at ? new Date(k.at).toLocaleString(lang(), { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
    q(".set-uses").textContent = k.connected ? [infoLine(k), t("setKeyLast4", k.last4, when)].filter(Boolean).join(" · ") : t("setKeyIntro");
    const btns = k.connected
      ? [["open", "setKeyChange", ""], ["check", "setKeyRecheck", ""], ["remove", "setKeyRemove", "danger"]]
      : [["open", "setKeyConnect", "primary"]];
    q(".set-btns").hidden = st.open;
    q(".set-btns").innerHTML = btns.map(([a, key, cls]) => `<button type="button" class="btn small ${cls}" data-key-act="${a}"${st.busy ? " disabled" : ""}>${esc(t(key))}</button>`).join("");
    const box = q(".set-keybox");
    box.hidden = !st.open;
    q(".set-keylabel").textContent = t("setKeyLabel", k.name);
    q(".set-keyinput").placeholder = t("setKeyPh");
    q(".set-keyinput").disabled = st.busy;
    box.querySelectorAll("[data-key-act]").forEach(b => { b.textContent = t({ reopen: "setKeyReopen", save: "setKeySave", cancel: "cancel" }[b.dataset.keyAct]); b.disabled = st.busy; });
    const msg = q(".set-msg");
    msg.textContent = st.msg; msg.dataset.kind = st.kind;
    q(".set-uses.remote-only").textContent = t("setKeyRemoteNote");
    return card;
  }

  function render(data) {
    keys = data?.keys || keys;
    const grid = $("setConns");
    keys.filter(k => META[k.id]).forEach(k => grid.appendChild(paint(k)));
    renderProfiles(data?.chrome);
  }

  const say = (id, msg, kind = "") => { Object.assign(ui[id], { msg, kind }); };
  const repaint = (id) => { const k = keys.find(x => x.id === id); if (k) paint(k); };

  async function openPage(id) {
    const r = await api("/api/hub/key/open", { provider: id });
    if (r.ok && r.data?.opened) say(id, t("setKeyOpened"));
    else say(id, r.data?.url ? t("setKeyOpenFail", r.data.url) : t("err_" + (r.data?.error || "generic")), "warn");
  }

  function failText(r) {
    const e = r.data?.error;
    if (r.status === 403) return t("setKeyRemoteNote");
    if (e === "http") return t("setKeyErr_http", r.data.status ?? "?");
    return ["badkey", "noperm", "nobalance", "network", "store"].includes(e) ? t("setKeyErr_" + e) : t(e === "offline" ? "err_offline" : "err_generic");
  }

  async function act(id, what) {
    const st = ui[id], card = cards[id], input = card.querySelector(".set-keyinput");
    const name = keys.find(k => k.id === id)?.name || id;
    if (what === "open") {
      st.open = true; say(id, ""); repaint(id);
      await openPage(id); repaint(id);
      input.focus();
    } else if (what === "reopen") {
      await openPage(id); repaint(id);
    } else if (what === "cancel") {
      input.value = ""; st.open = false; say(id, ""); repaint(id);
    } else if (what === "save") {
      const key = input.value.trim();
      if (!key) { say(id, t("setKeyErr_empty"), "warn"); repaint(id); input.focus(); return; }
      st.busy = true; say(id, t("setKeyTesting")); repaint(id);
      const r = await api("/api/hub/key/save", { provider: id, key });
      st.busy = false;
      if (r.ok) {
        input.value = ""; st.open = false; say(id, t("setKeyOk"), "ok");
        keys = r.data.keys; repaint(id); changed();
      } else { say(id, failText(r), "warn"); repaint(id); input.focus(); input.select(); }
    } else if (what === "check") {
      st.busy = true; say(id, t("setKeyTesting")); repaint(id);
      const r = await api("/api/hub/key/check", { provider: id });
      st.busy = false;
      if (r.ok) { keys = r.data.keys; say(id, t("setKeyStillOk"), "ok"); } else say(id, failText(r), "warn");
      repaint(id);
    } else if (what === "remove") {
      if (!await confirmBox({ title: t("setKeyRemoveTitle", name), text: t("setKeyRemoveText"), okText: t("setKeyRemove"), danger: true })) return;
      const r = await api("/api/hub/key/remove", { provider: id });
      if (r.ok) { keys = r.data.keys; say(id, t("setKeyRemoved")); changed(); } else say(id, failText(r), "warn");
      repaint(id);
    }
  }

  // ---- Anahtar sayfalarının açılacağı Chrome profili ----
  function renderProfiles(chrome) {
    const row = $("setProfileRow"), sel = $("setKeyProfile");
    const list = chrome?.profiles || [];
    row.hidden = REMOTE || !list.length;
    if (row.hidden || document.activeElement === sel) return;
    sel.innerHTML = `<option value="">${esc(t("setProfDefault"))}</option>` +
      list.map(p => `<option value="${esc(p.dir)}">${esc(p.email ? `${p.name} (${p.email})` : p.name)}</option>`).join("");
    sel.value = chrome.selected || "";
  }
  $("setKeyProfile").addEventListener("change", async (e) => {
    const r = await api("/api/hub/chrome-profile", { dir: e.target.value });
    if (r.ok) renderProfiles(r.data); else d.toast(t("err_generic"), "warn");
  });

  // Anahtar bağlanınca/kaldırılınca bağlı olan başka bölümler (iş yönlendirme) yenilensin
  const subs = [];
  const changed = () => subs.forEach(f => f(keys));

  hub.onRender(render);
  return { keys: () => keys, onChange: (f) => subs.push(f) };
};
