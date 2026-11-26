// Ayarlar sekmesi: sol bölüm menüsü (geniş ekranda yapışkan, dar ekranda yatay şerit), bölümler arası gezinme ve
// "Hesaplar" bölümü (Claude hesap kartları: kota, sıfırlanma, varsayılan projeler; Google ve GitHub bağlantı kartları).
// Öteki bölümlerin içeriği: eski Ayarlar penceresinin ayarları index.html'de (app.js, settings-mail.js, restart.js doldurur).
window.PanelSettingsHub = function (d) {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const nav = $("setNav"), view = $("viewSettings");
  const buttons = () => [...nav.querySelectorAll("button[data-sec]")];
  const sections = () => buttons().map(b => $(b.dataset.sec)).filter(s => s && !s.hidden);

  // Sayfayı kaydıran öğe: düzene göre body ya da belge kökü (app.css: html overflow-x clip, body overflow-x hidden).
  const scroller = () => document.body.scrollHeight > document.body.clientHeight + 1 ? document.body : document.scrollingElement;

  /** Yapışkan başlığın altında kalmasın: menünün ve bölüm başlıklarının üst boşluğu başlık yüksekliğine göre. */
  function measure() {
    const top = document.querySelector("header.top");
    const sticky = top && getComputedStyle(top).position === "sticky" ? top.offsetHeight : 0;
    view.style.setProperty("--set-top", sticky + 14 + "px");
    view.style.setProperty("--set-top-narrow", sticky + 10 + "px");
  }

  function mark(id) {
    buttons().forEach(b => {
      const on = b.dataset.sec === id;
      b.classList.toggle("active", on);
      // Yatay şeritte etkin satır görünür kalsın. scrollIntoView kullanılmaz: sayfayı da dikeyde menüye geri kaydırıyordu.
      if (on && nav.scrollWidth > nav.clientWidth) {
        const left = b.offsetLeft - nav.offsetLeft;
        if (left < nav.scrollLeft || left + b.offsetWidth > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = Math.max(0, left - 12);
      }
    });
  }

  // Menüden seçilen bölüm, kullanıcı sayfayı kendisi kaydırana dek etkin kalır: sayfa sonundaki kısa bölümler üst çizgiye
  // ulaşamaz, kaydırma konumundan hesaplanan bölüm seçileni ezmesin.
  let pinned = null;
  ["wheel", "touchmove", "keydown"].forEach(n => addEventListener(n, () => { pinned = null; }, { passive: true }));

  /** Ekranın üstüne en yakın (başlığın altından geçmiş son) bölüm etkin görünür. */
  function onScroll() {
    if (view.hidden) return;
    if (pinned) { mark(pinned); return; }
    const line = (parseInt(view.style.getPropertyValue("--set-top"), 10) || 14) + 30;
    const secs = sections();
    let cur = secs[0];
    for (const s of secs) if (s.getBoundingClientRect().top <= line) cur = s;
    // Sayfanın sonunda son bölüm kısa kalıp üst çizgiye hiç ulaşamayabilir
    const sc = scroller();
    if (sc.scrollTop > 0 && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) cur = secs[secs.length - 1];
    if (cur) mark(cur.id);
  }

  function go(id) {
    const s = $(id);
    if (!s || s.hidden) return;
    measure();
    pinned = id;
    s.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    mark(id);
  }

  /** Bölümü olmayan (gizli) menü satırı gösterilmez. */
  function syncNav() { buttons().forEach(b => { const s = $(b.dataset.sec); b.hidden = !s || s.hidden; }); }

  function open(top) {
    syncNav(); measure();
    if (top) { pinned = null; document.body.scrollTop = 0; document.scrollingElement.scrollTop = 0; }
    onScroll();
  }

  // ---- Hesaplar: Claude hesapları (/api/hub) ve diğer bağlantılar (Google: /api/mail, GitHub: /api/github) ----
  const { t, api, getJson, esc, accountName, lang } = d;
  const clamp = (n) => Math.max(0, Math.min(100, n));
  const level = (left) => left < 15 ? "crit" : left < 40 ? "warn" : "ok";
  const when = (iso) => {
    const at = iso ? new Date(iso) : null;
    return at && !isNaN(at) ? at.toLocaleString(lang(), { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : null;
  };
  const folderName = (p) => (p || "").split(/[\\/]/).filter(Boolean).pop() || p || "";
  let hub = null, mail = null, github = null, ghNote = "";
  // Düzenlenen hesap kartları: kimlik → { name: yazılan ad, msg, kind }. Yeniden çizimde yazılan metin kaybolmasın.
  const editing = new Map();
  const baseName = (a) => a.orgLabel || (a.isDefault ? t("acctPersonal") : a.id.replace(/^\.claude-?/, "") || a.id);

  function claudeCard(a, i) {
    const week = a.usage?.seven_day?.used, five = a.usage?.five_hour?.used;
    const left = week == null ? null : Math.round(clamp(100 - week));
    const state = left == null ? `<span class="set-state off">${esc(t("setAccNoQuota"))}</span>`
      : `<span class="set-state ${level(left)}">${esc(t("setAccWeekLeft", left))}</span>`;
    const meter = left == null ? "" : `<div class="set-meter ${level(left)}"><i data-w="${clamp(week)}"></i></div>`;
    const reset = when(a.usage?.seven_day?.resetsAt);
    const meta = [reset ? t("setAccWeekReset", reset) : "", five == null ? "" : t("setAcc5h", Math.round(clamp(100 - five)))];
    const names = (a.projects || []).map(folderName);
    const uses = a.isDefault ? t("setAccDefaultAll") : names.length ? t("setAccProjects", names.join(", ")) : t("setAccNoProjects");
    const list = names.length ? `<details class="set-proj"><summary>${esc(t("setAccProjectsBtn", names.length))}</summary>
      <ul>${a.projects.map(p => `<li>${esc(p)}</li>`).join("")}</ul></details>` : "";
    const ed = editing.get(a.id);
    return `<div class="set-card" data-acct="${esc(a.id)}">
      <div class="set-card-top"><span class="set-logo set-logo-${i % 2 ? "b" : "a"}">C</span>
        <div class="set-card-id"><div class="set-name">${esc(accountName(a))}</div><div class="set-who">${esc(t(a.isDefault ? "setAccWhoDefault" : "setAccWho", a.id))}</div></div>${state}</div>
      ${meter}<div class="set-meta"><span>${esc(meta[0])}</span><span>${esc(meta[1])}</span></div>
      <div class="set-uses">${esc(uses)}</div>${ed ? editForm(a, ed) : list +
        `<div class="set-btns"><button type="button" class="btn small" data-act="acct-edit">${esc(t("setAccEdit"))}</button></div>`}</div>`;
  }

  /** Hesap düzenleme: görünen ad (boş = Claude'daki ad) ve hesaba kayıtlı projeler (her biri hesaptan çıkarılabilir). */
  function editForm(a, ed) {
    const id = "accName-" + a.id.replace(/[^\w-]/g, "_");
    const projects = a.isDefault ? `<p class="set-uses">${esc(t("setAccEditDefaultProj"))}</p>`
      : (a.projects || []).length ? `<ul class="acct-edit-proj">${a.projects.map(p => `<li><span class="acct-edit-path"><b>${esc(folderName(p))}</b><small>${esc(p)}</small></span>
          <button type="button" class="btn small" data-act="acct-proj-rm" data-path="${esc(p)}">${esc(t("setAccProjRemove"))}</button></li>`).join("")}</ul>`
      : `<p class="set-uses">${esc(t("setAccNoProjects"))}</p>`;
    return `<div class="acct-edit">
      <label for="${id}">${esc(t("setAccNameLabel"))}</label>
      <input id="${id}" type="text" data-act="acct-name" maxlength="40" autocomplete="off" spellcheck="false" value="${esc(ed.name)}" placeholder="${esc(baseName(a))}">
      <small class="set-uses">${esc(t("setAccNameHint", baseName(a)))}</small>
      <div class="acct-edit-h">${esc(t("setAccProjTitle"))}</div>${projects}
      <div class="set-btns"><button type="button" class="btn small primary" data-act="acct-save">${esc(t("setAccSave"))}</button>
        <button type="button" class="btn small" data-act="acct-cancel">${esc(t("cancel"))}</button></div>
      <p class="set-msg" role="status" data-kind="${esc(ed.kind || "")}">${esc(ed.msg || "")}</p></div>`;
  }

  const acctOf = (el) => (hub?.accounts || []).find(a => a.id === el.closest("[data-acct]")?.dataset.acct);
  const focusName = (id) => setTimeout(() => { const i = document.querySelector(`#setClaude [data-acct="${CSS.escape(id)}"] [data-act=acct-name]`); if (i) { i.focus(); i.select(); } }, 0);

  async function accountAction(btn) {
    const a = acctOf(btn); if (!a) return;
    const act = btn.dataset.act;
    if (act === "acct-edit") { editing.set(a.id, { name: a.custom ? a.label : "" }); render(); return focusName(a.id); }
    if (act === "acct-cancel") { editing.delete(a.id); return render(); }
    const ed = editing.get(a.id); if (!ed) return;
    btn.disabled = true;
    const r = act === "acct-save" ? await api("/api/hub/account/name", { id: a.id, name: ed.name })
      : await api("/api/hub/account/project-remove", { id: a.id, project: btn.dataset.path });
    btn.disabled = false;
    if (!r.ok) { ed.msg = t(r.data?.error === "name" ? "setAccNameBad" : "setAccSaveFail"); ed.kind = "warn"; return render(); }
    hub.accounts = r.data.accounts;
    if (act === "acct-save") { editing.delete(a.id); d.toast?.(t("setAccSaved")); }
    else { ed.msg = t("setAccProjRemoved", folderName(btn.dataset.path)); ed.kind = "ok"; }
    render();
  }

  // Google kartı yalnız kişisel hesabı gösterir: panelde bağlı Gmail hesabı (Google girişi ya da gmail adresli IMAP).
  const isGmail = (a) => a.provider === "google" || /@(gmail|googlemail)\.com$/i.test(a.email || "");
  const maskMail = (e) => { const [u, dom] = String(e).split("@"); return (u.length > 5 ? u.slice(0, 5) + "…" : u) + "@" + (dom || ""); };

  function googleCard() {
    const acct = (mail?.accounts || []).find(isGmail);
    return `<div class="set-card" data-conn="google">
      <div class="set-card-top"><span class="set-logo">G</span>
        <div class="set-card-id"><div class="set-name">Google <span class="set-tag">${esc(t("setConnPersonal"))}</span></div>
          <div class="set-who">${esc(acct ? maskMail(acct.email) : t("setGoogleOnly"))}</div></div>
        <span class="set-state ${acct ? "ok" : "off"}">${esc(t(acct ? "setConnOn" : "setConnOff"))}</span></div>
      <div class="set-uses">${esc(t(acct ? "setGoogleUse" : "setGoogleNone"))}</div>
      <div class="set-btns"><button type="button" class="btn small" data-go="setMail">${esc(t(acct ? "setGoogleDetail" : "setGoogleConnect"))}</button></div></div>`;
  }

  function githubCard() {
    const g = github;
    const st = !g ? ["off", "setConnOff"] : !g.enabled ? ["off", "setConnClosed"] : g.state === "nogh" ? ["warn", "setGhNoCli"]
      : g.state === "noauth" ? ["warn", "setGhNoAuth"] : g.login ? ["ok", "setConnOn"] : ["off", "setGhWaiting"];
    const who = g?.enabled && g.login ? t("setGhWho", g.login) : "gh CLI";
    const uses = !g?.enabled ? t("setGhClosedHint") : g.state === "nogh" ? t("fuGhNoCli") : g.state === "noauth" ? t("fuGhNoAuth") : t("setGhUse");
    const btn = !g?.enabled ? `<button type="button" class="btn small" data-go="setGeneral">${esc(t("setGhOpenGeneral"))}</button>`
      : `<button type="button" class="btn small" data-act="gh-try">${esc(t("setGhTry"))}</button>`;
    return `<div class="set-card" data-conn="github">
      <div class="set-card-top"><span class="set-logo">⌘</span>
        <div class="set-card-id"><div class="set-name">GitHub</div><div class="set-who">${esc(who)}</div></div>
        <span class="set-state ${st[0]}">${esc(t(st[1]))}</span></div>
      <div class="set-uses">${esc(uses)}</div>
      <div class="set-btns">${btn}</div><p class="set-msg" role="status">${esc(ghNote)}</p></div>`;
  }

  // Ek bağlantı kartları (anahtar bağlama: settings-keys.js) kendi kabına çizilir; her çizimden sonra aboneler çağrılır.
  const subs = [];

  function render() {
    if (!hub) return;
    const accts = hub.accounts || [];
    $("setClaude").innerHTML = accts.map(claudeCard).join("") +
      `<div class="set-add"><b>${esc(t("setAccAdd"))}</b><small>${esc(t("setAccAddNote"))}</small></div>`;
    $("setClaude").querySelectorAll(".set-meter i").forEach(i => { i.style.width = i.dataset.w + "%"; }); // stil özniteliği yok (içerik güvenlik kuralı)
    $("setConns").innerHTML = googleCard() + githubCard();
    const low = accts.filter(a => a.usage?.seven_day?.used != null && 100 - a.usage.seven_day.used < 15);
    $("setDotAccounts").hidden = !low.length;
    $("setDotAccounts").title = low.length ? t("setDotLow", low.map(accountName).join(", ")) : "";
    subs.forEach(f => f(hub));
  }

  async function load() {
    const get = (p) => getJson(p).catch(() => null);
    const [h, m, g] = await Promise.all([get("/api/hub"), get("/api/mail"), get("/api/github")]);
    if (h) hub = h;
    mail = m || mail; github = g || github; ghNote = "";
    render();
  }

  async function tryGithub() {
    ghNote = t("setKeyTesting"); render();
    await api("/api/github/refresh", {});
    // Denetim arka planda sürer: sonuç birkaç saniye içinde durum ucuna yansır
    await new Promise(r => setTimeout(r, 2500));
    github = await getJson("/api/github").catch(() => null) || github;
    ghNote = github?.enabled && github.login && github.state !== "nogh" && github.state !== "noauth" ? t("setGhOk", github.login) : "";
    render();
  }

  view.addEventListener("click", (e) => {
    const goBtn = e.target.closest("[data-go]");
    if (goBtn) return go(goBtn.dataset.go);
    const ab = e.target.closest("#setClaude button[data-act^=acct-]");
    if (ab) return accountAction(ab);
    if (e.target.closest("[data-act=gh-try]")) tryGithub();
  });
  $("setClaude").addEventListener("input", (e) => {
    if (e.target.dataset.act !== "acct-name") return;
    const ed = editing.get(e.target.closest("[data-acct]")?.dataset.acct); if (ed) { ed.name = e.target.value; ed.msg = ""; }
  });
  $("setClaude").addEventListener("keydown", (e) => {
    if (e.target.dataset.act !== "acct-name") return;
    const card = e.target.closest("[data-acct]");
    if (e.key === "Enter") { e.preventDefault(); card.querySelector("[data-act=acct-save]")?.click(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); card.querySelector("[data-act=acct-cancel]")?.click(); }
  });
  // GitHub takibi Genel'den açılıp kapanınca kart da yenilensin
  $("sGithub").addEventListener("change", () => setTimeout(load, 800));

  nav.addEventListener("click", (e) => { const b = e.target.closest("button[data-sec]"); if (b) go(b.dataset.sec); });
  document.addEventListener("scroll", onScroll, { passive: true, capture: true });
  addEventListener("resize", () => { if (!view.hidden) { measure(); onScroll(); } });

  return { open, go, syncNav, load, render, data: () => hub, onRender: (f) => subs.push(f), clamp, level };
};
