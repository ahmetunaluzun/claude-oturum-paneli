// Ayarlar → Hesaplar → Yapay zekâ servisleri: anahtar kartları (ElevenLabs, OpenRouter, Gemini API; sunucu ApiKeys.cs, /api/hub/key/*).
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
    openrouter: { logo: "◐", who: "setOrWho", routing: true },
    gemini: { logo: "✦", who: "setGemWho", personal: true, routing: true }
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

  // Son yeniden deneme geçmediyse (ApiKeys.Recheck kaydeder) kart "geçerli" demez.
  const FAIL_KIND = { badkey: "crit", noperm: "crit", nobalance: "warn", network: "warn", http: "warn" };
  const failed = (k) => k.connected && k.failAt != null && k.failAt > (k.at || 0);
  const failShort = (k) => k.fail === "http" ? t("keyStFail_http", k.failStatus ?? "?") : t("keyStFail_" + (k.fail in FAIL_KIND ? k.fail : "network"));
  const stamp = (ms) => new Date(ms).toLocaleString(lang(), { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

  // Aşama satırı: anahtar kayıtlı → son deneme geçti/geçmedi. Panel bu anahtarlarla iş yapmaz; "son iş" yazılmaz.
  function keyStages(k) {
    const s = [["ok", t("keyStSaved", k.last4)]];
    if (failed(k)) s.push([FAIL_KIND[k.fail] === "crit" ? "no" : "warn", t("keyStFailed", stamp(k.failAt))]);
    else s.push(["ok", t("keyStOk", stamp(k.at))]);
    return s;
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
        <div class="set-meter" hidden><i></i></div><div class="key-stages"></div><div class="set-uses"></div>
        <dl class="key-facts"><div><dt class="kf-where"></dt><dd><span class="kf-where-t"></span> <button type="button" class="linkbtn" data-go="setRouting" hidden></button></dd></div>
          <div class="kf-free-row"><dt class="kf-free"></dt><dd class="kf-free-t"></dd></div></dl>
        <div class="set-btns local-only"></div>
        <ol class="key-steps local-only" hidden>
          <li data-step="1"><b class="ks-t"></b><span class="ks-note"></span><div class="set-btns"><button type="button" class="btn small" data-key-act="reopen"></button></div></li>
          <li data-step="2"><b class="ks-t"></b><span class="ks-note"></span></li>
          <li data-step="3"><b class="ks-t"></b>
            <label class="set-keybox"><span class="set-keylabel"></span><input type="password" class="set-keyinput" autocomplete="new-password" autocapitalize="off" spellcheck="false"></label>
            <div class="set-btns"><button type="button" class="btn small primary" data-key-act="save"></button><button type="button" class="btn small" data-key-act="cancel"></button></div></li>
        </ol>
        <p class="set-msg" role="status"></p><p class="set-uses remote-only"></p>`;
      card.addEventListener("click", (e) => { const b = e.target.closest("[data-key-act]"); if (b && !b.disabled) act(k.id, b.dataset.keyAct); });
      card.querySelector(".set-keyinput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); act(k.id, "save"); } });
      card.querySelector(".set-keyinput").addEventListener("input", () => steps(card, ui[k.id])); // yapıştırınca 3. adım öne çıkar
    }
    const q = (s) => card.querySelector(s);
    q(".set-name").innerHTML = esc(k.name) + (m.personal ? ` <span class="set-tag">${esc(t("setConnPersonal"))}</span>` : "");
    q(".set-who").textContent = t(m.who) + (k.connected && k.tier ? " · " + k.tier : "");
    const bad = failed(k);
    q(".set-state").className = "set-state " + (!k.connected ? "off" : bad ? FAIL_KIND[k.fail] || "warn" : "ok");
    q(".set-state").textContent = !k.connected ? t("setConnOff") : bad ? failShort(k) : t("setKeyValid");
    q(".key-stages").innerHTML = k.connected ? hub.stages(keyStages(k)) : "";
    const meter = q(".set-meter");
    meter.hidden = !(k.connected && k.id === "elevenlabs" && k.limit > 0);
    if (!meter.hidden) {
      const left = hub.clamp(100 * k.remaining / k.limit);
      meter.className = "set-meter " + hub.level(left);
      meter.firstElementChild.style.width = (100 - left) + "%"; // Claude kartlarıyla aynı: çubuk kullanılanı, renk kalanı gösterir
    }
    q(".set-uses").textContent = k.connected ? infoLine(k) : t("setKeyWhy_" + k.id); // son 4 + deneme zamanı aşama satırında
    // Ne işe yarar / panelde nerede / ücret: bağlı olmayan kartta karar vermeye yetsin. Ücret satırı bağlanınca kalkar.
    q(".kf-where").textContent = t("setKeyWhereLbl");
    q(".kf-where-t").textContent = t("setKeyWhere_" + k.id);
    const go = q("[data-go]"); go.hidden = !m.routing; go.textContent = t("setKeyGoRouting");
    q(".kf-free-row").hidden = k.connected;
    q(".kf-free").textContent = t("setKeyFreeLbl");
    q(".kf-free-t").textContent = t("setKeyFree_" + k.id);
    const btns = k.connected
      ? [["open", "setKeyChange", ""], ["check", "setKeyRecheck", ""], ["remove", "setKeyRemove", "danger"]]
      : [["open", "setKeyConnect", "primary"]];
    q(".set-btns").hidden = st.open;
    q(".set-btns").innerHTML = btns.map(([a, key, cls]) => `<button type="button" class="btn small ${cls}" data-key-act="${a}"${st.busy ? " disabled" : ""}>${esc(t(key))}</button>`).join("");
    // Bağlama adımları kartın içinde: ① sayfa açılır ② serviste ne yapılır ③ yapıştır, dene. Etkin adım vurgulu.
    const box = q(".key-steps");
    box.hidden = !st.open;
    box.querySelectorAll(".ks-t").forEach((b, i) => { b.textContent = t("setKeyStep" + (i + 1)); });
    q('[data-step="1"] .ks-note').textContent = st.page || "";
    q('[data-step="1"] .ks-note').dataset.kind = st.pageKind || "";
    q('[data-step="2"] .ks-note').textContent = t("setKeyHint_" + k.id);
    q(".set-keylabel").textContent = t("setKeyLabel", k.name);
    q(".set-keyinput").placeholder = t("setKeyPh");
    q(".set-keyinput").disabled = st.busy;
    box.querySelectorAll("[data-key-act]").forEach(b => { b.textContent = t({ reopen: "setKeyReopen", save: "setKeySave", cancel: "cancel" }[b.dataset.keyAct]); b.disabled = st.busy; });
    steps(card, st);
    const msg = q(".set-msg");
    msg.textContent = st.msg; msg.dataset.kind = st.kind;
    q(".set-uses.remote-only").textContent = t("setKeyRemoteNote");
    return card;
  }

  // Adım durumu: 1 sayfa açılınca biter; kutu boşken 2, doluyken 3 etkin.
  function steps(card, st) {
    const filled = card.querySelector(".set-keyinput").value.trim() !== "";
    const now = !st.opened ? 1 : filled ? 3 : 2;
    card.querySelectorAll(".key-steps li").forEach(li => {
      const n = +li.dataset.step;
      li.classList.toggle("now", n === now);
      li.classList.toggle("done", n < now);
    });
  }

  function render(data) {
    keys = data?.keys || keys;
    const grid = $("setKeys");
    keys.filter(k => META[k.id]).forEach(k => grid.appendChild(paint(k)));
    renderProfiles(data?.chrome);
  }

  const say = (id, msg, kind = "") => { Object.assign(ui[id], { msg, kind }); };
  const repaint = (id) => { const k = keys.find(x => x.id === id); if (k) paint(k); };

  async function openPage(id) {
    const r = await api("/api/hub/key/open", { provider: id });
    const st = ui[id];
    st.opened = true; // açılamasa da adres yazılır; kullanıcı sayfayı kendisi açıp devam edebilir
    if (r.ok && r.data?.opened) Object.assign(st, { page: t("setKeyOpened"), pageKind: "" });
    else Object.assign(st, { page: r.data?.url ? t("setKeyOpenFail", r.data.url) : t("err_" + (r.data?.error || "generic")), pageKind: "warn" });
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
      input.value = ""; Object.assign(st, { open: false, opened: false, page: "" }); say(id, ""); repaint(id);
    } else if (what === "save") {
      const key = input.value.trim();
      if (!key) { say(id, t("setKeyErr_empty"), "warn"); repaint(id); input.focus(); return; }
      st.busy = true; say(id, t("setKeyTesting")); repaint(id);
      const r = await api("/api/hub/key/save", { provider: id, key });
      st.busy = false;
      if (r.ok) {
        input.value = ""; Object.assign(st, { open: false, opened: false, page: "" }); say(id, t("setKeyOk"), "ok");
        keys = r.data.keys; repaint(id); changed();
      } else { say(id, failText(r), "warn"); repaint(id); input.focus(); input.select(); }
    } else if (what === "check") {
      st.busy = true; say(id, t("setKeyTesting")); repaint(id);
      const r = await api("/api/hub/key/check", { provider: id });
      st.busy = false;
      if (r.data?.keys) keys = r.data.keys; // geçmeyen deneme de kayda yazıldı: kart durumu yenilensin
      if (r.ok) say(id, t("setKeyStillOk"), "ok"); else say(id, failText(r), "warn");
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
    // "" = otomatik (kişisel Claude hesabının e-postasıyla eşleşen profil; HubEndpoints.AutoProfile), "-" = varsayılan tarayıcı
    const label = (p) => p.email ? `${p.name} (${p.email})` : p.name;
    const auto = list.find(p => p.dir === chrome.auto);
    sel.innerHTML = `<option value="">${esc(auto ? t("setProfAuto", label(auto)) : t("setProfAutoNone"))}</option>` +
      `<option value="-">${esc(t("setProfDefault"))}</option>` +
      list.map(p => `<option value="${esc(p.dir)}">${esc(label(p))}</option>`).join("");
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
