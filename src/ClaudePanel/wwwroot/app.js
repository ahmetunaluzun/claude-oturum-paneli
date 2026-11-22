(() => {
  "use strict";
  const TOKEN = document.querySelector('meta[name="panel-token"]').content;
  // Telefondan (Tailscale adresinden) açıldı: bilgisayarın ekranında iş yapan düğmeler gizlenir.
  const REMOTE = document.querySelector('meta[name="panel-remote"]')?.content === "1";
  // Dokunmatikte Enter yeni satırdır; ipucu metni "Enter gönderir" demesin.
  if (matchMedia("(pointer: coarse)").matches) document.getElementById("dInput").dataset.i18nPh = "typeMessageTouch";
  document.documentElement.classList.toggle("remote", REMOTE);
  if (REMOTE) document.getElementById("footText").dataset.i18n = "footerRemote";
  const POLL_MS = 2500, DRAWER_POLL_MS = 1500;
  const $ = (id) => document.getElementById(id);

  // ---- Ayarlar (tarayıcıda saklanır) ----
  const defaults = { notify: true, sound: true, light: false,
    lang: (navigator.language || "tr").toLowerCase().startsWith("tr") ? "tr" : "en", folders: [], tabMap: {}, tabIds: {} };
  const settings = Object.assign({}, defaults, JSON.parse(localStorage.getItem("panel.settings") || "{}"));
  const save = () => localStorage.setItem("panel.settings", JSON.stringify(settings));
  const t = (key, ...args) => {
    const s = (I18N[settings.lang] || I18N.tr)[key] ?? key;
    return args.reduce((acc, a, i) => acc.replace(`{${i}}`, () => a), s); // işlev: değerdeki "$&", "$'" özel sayılmasın
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const folderName = (p) => (p || "").split(/[\\/]/).filter(Boolean).pop() || p;

  function applyI18n() {
    document.documentElement.lang = settings.lang;
    document.querySelectorAll("[data-i18n]").forEach(el => el.textContent = t(el.dataset.i18n));
    document.querySelectorAll("[data-i18n-ph]").forEach(el => el.placeholder = t(el.dataset.i18nPh));
    document.querySelectorAll("[data-i18n-title]").forEach(el => el.title = t(el.dataset.i18nTitle));
    document.title = t("title");
  }
  const applyTheme = () => document.documentElement.dataset.theme = settings.light ? "light" : "dark";

  // ---- Sunucu ----
  async function api(path, body) {
    let res;
    try {
      res = await fetch(path, {
        method: "POST",
        headers: { "X-Panel-Token": TOKEN, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : null
      });
    } catch {
      // Ağ hatası (telefonda kısa kopma): fırlatmak yerine "offline" döner; çağıranlar err_offline uyarısını gösterir.
      return { ok: false, status: 0, data: { error: "offline" } };
    }
    let data = null;
    try { data = await res.json(); } catch { /* gövde yok */ }
    return { ok: res.ok, status: res.status, data };
  }
  // Oturum başlatmanın ortak yolu (Yeni oturum, Takip, Son oturumlar, kapalı oturuma yazma). Projede zaten oturum varsa
  // sunucu 409 "conflict" döner; kullanıcıya ne yapılacağı sorulur ve istek seçilen kiple yinelenir.
  // Dönen değer api() ile aynı biçimde; kullanıcı vazgeçtiyse { ok: false, cancelled: true }.
  async function startHosted(body, path = "/api/hosted") {
    let r;
    try { r = await api(path, body); } catch { return { ok: false, status: 0, data: null }; }
    if (r.status !== 409 || r.data?.error !== "conflict") return r;
    const c = r.data, opts = c.options || [], sessions = c.sessions || [];
    // Sunucunun "terminal" dediği oturum masaüstü uygulamasında ya da VS Code'da açık olabilir: yüzey kart listesinden (PID).
    const surface = (s) => (s.kind === "terminal" && s.pid ? items.find(x => x.pid === s.pid)?.surface : null) || "terminal";
    const where = (s) => ({ desktop: t("desktopApp"), vscode: "VS Code" }[surface(s)] || t("terminal"));
    const list = sessions.map(s => `${s.name} — ${t(s.kind === "job" ? "pcJob" : s.status === "busy" ? "pcBusy" : "pcIdle")}${s.kind === "terminal" ? ` (${where(s)})` : ""}`);
    const buttons = [];
    if (opts.includes("send")) buttons.push({ value: "send", label: t("pcSend"), cls: "primary" });
    if (opts.includes("later")) buttons.push({ value: "later", label: t("pcLater"), cls: buttons.length ? "" : "primary" });
    if (opts.includes("worktree")) buttons.push({ value: "worktree", label: t("pcWorktree"), cls: "" });
    // Terminalde boşta oturum varsa onu panele alıp (istem varsa) mesajı ona yazmak: ikinci oturum açılmaz.
    // Masaüstü uygulamasındaki oturum önerilmez (issue #1 madde 6: uygulamadan yönetilir; elle "Panele al" ⋯ menüsünde).
    const hasJob = sessions.some(s => s.kind === "job");
    const term = !REMOTE && !hasJob ? sessions.find(s => s.kind === "terminal" && s.status === "idle" && s.pid && surface(s) !== "desktop") : null;
    if (term) buttons.unshift({ value: "adopt", label: t(body.prompt?.trim() ? "pcAdoptSend" : "pcAdopt"), cls: "primary" });
    if (term && buttons[1]?.cls) buttons[1].cls = "";
    buttons.push({ value: "force", label: t("pcForce"), cls: "" });
    const text = hasJob ? "pcTextJob" : term ? "pcTextAdopt" : sessions.some(s => s.kind === "terminal") && !REMOTE ? "pcTextTerm" : "pcText";
    // Odak en güvenli seçenekte: gönder / iş bitince varsa o, yoksa Vazgeç ("Yine de aç" Enter ile seçilmesin).
    const v = await ask(t("pcTitle"), t(text), list, buttons, { cbox: true, focus: buttons[0].cls ? buttons[0].value : "cancel" });
    if (v === "cancel") return { ok: false, status: 409, data: { error: "cancelled" }, cancelled: true };
    if (v === "adopt") return adoptAndSend(term, body.prompt);
    let r2;
    try { r2 = await api(v === "force" ? path : "/api/hosted", { ...body, mode: v }); } catch { return { ok: false, status: 0, data: null }; }
    if (r2.ok && r2.data?.sent) toast(t("pcSent"));
    else if (r2.ok && r2.data?.queued) toast(t("pcQueued"));
    else if (r2.ok && r2.data?.worktree) toast(t("pcWorktreeOk", folderName(r2.data.worktree)));
    return r2;
  }
  // Çakışma penceresinden "Panele al (ve gönder)": terminal oturumu panele taşınır, istem varsa ona yazılır.
  // Dönen değer startHosted ile aynı biçimde (data.key = panele alınan oturum).
  async function adoptAndSend(term, prompt) {
    let r;
    try { r = await api(`/api/adopt/${term.pid}`); } catch { return { ok: false, status: 0, data: null }; }
    if (!r.ok || !r.data?.key) return r.ok ? { ok: false, status: 409, data: { error: "generic" } } : r;
    const key = r.data.key;
    if (prompt?.trim()) {
      let s;
      try { s = await api(`/api/hosted/${key}/send`, { text: prompt }); } catch { s = { ok: false }; }
      if (!s.ok) { toast(t("adopted", term.name)); return { ok: false, status: s.status || 0, data: s.data || { error: "generic" } }; }
      toast(t("pcAdoptSent", term.name));
    } else toast(t("adopted", term.name));
    return { ok: true, status: 200, data: { key, adopted: true, sent: !!prompt?.trim() } };
  }
  const getJson = async (path) => { const r = await fetch(path, { cache: "no-store" }); if (!r.ok) throw new Error(r.status); return r.json(); };

  function dur(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s} ${t("s")}`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} ${t("m")}`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} ${t("h")} ${m % 60} ${t("m")}`;
    return `${Math.floor(h / 24)} ${t("d")} ${h % 24} ${t("h")}`;
  }

  // ---- Durum ----
  // Tek oturum modeli: { id, kind: "terminal"|"bg"|"panel", sessionId, pid, key, name, cwd, lane, status, since, started, cost, error }
  let items = [];
  let serverOffset = 0;
  const prevLane = new Map();
  let firstLoad = true;
  let trayNotify = false;
  let view = "sessions";

  function normalize(st) {
    // Proje kökü (git kökü; yoksa klasör) sunucudan gelir: aynı projedeki oturumları eşlemek için. root küçük harf anahtardır.
    const rootOf = (list) => list.map(s => { const p = st.roots?.[s.cwd] || s.cwd || ""; return Object.assign(s, { rootPath: p, root: p.toLowerCase() }); });
    const hosted = (st.hosted || []).map(h => ({
      id: "h:" + h.key, kind: "panel", key: h.key, sessionId: h.sessionId, name: h.name || folderName(h.cwd),
      cwd: h.cwd, status: h.status, lane: h.status === "busy" || h.status === "starting" ? "busy" : "idle",
      since: h.statusSince, started: h.startedAt, cost: h.costUsd, error: h.lastError, model: h.model,
      task: h.task, night: h.night, stats: st.stats?.[h.sessionId], bgjobs: h.background || []
    }));
    const hostedIds = new Set(hosted.map(h => h.sessionId).filter(Boolean));
    // surface: oturum nerede açık (Claude Code'un entrypoint alanı): masaüstü uygulaması, VS Code ya da terminal.
    // status "waiting": Claude soru/izin için kullanıcıyı bekliyor → bekleyenler şeridinde, "cevap bekliyor".
    const term = (st.sessions || []).filter(s => !hostedIds.has(s.sessionId)).map(s => ({
      id: s.sessionId, kind: s.kind === "interactive" ? "terminal" : "bg", sessionId: s.sessionId, pid: s.pid,
      name: s.customName || folderName(s.cwd) || s.name, cwd: s.cwd, status: s.status,
      surface: surfaceOf(s.entrypoint), waiting: s.status === "waiting" ? (s.waitingFor || "") : null,
      desk: st.desktops?.[s.pid] || null,
      lane: s.status === "idle" || s.status === "waiting" ? "idle" : "busy", since: s.statusSince, started: s.startedAt,
      stats: st.stats?.[s.sessionId]
    }));
    return rootOf([...term, ...hosted]);
  }

  function surfaceOf(entrypoint) {
    if (["claude-desktop", "claude-desktop-3p", "local-agent"].includes(entrypoint)) return "desktop";
    return entrypoint === "claude-vscode" ? "vscode" : "terminal";
  }

  let serverBoot = null, panelQuit = false;
  async function poll() {
    if (panelQuit) return;
    try {
      const st = await getJson("/api/state");
      // Sunucu yeniden açıldı (yeni sürüm, yeniden başlatma): bu sayfanın kodu ve anahtarı eski, yenile.
      if (st.boot && serverBoot && st.boot !== serverBoot) { location.reload(); return; }
      serverBoot ||= st.boot;
      serverOffset = st.now - Date.now();
      trayNotify = !!st.trayNotify;
      const next = normalize(st);
      detectFinished(next);
      items = next;
      rememberFolders(items.map(s => s.cwd));
      render();
      renderUsage(st.usage);
      renderNightPill(st.night);
      B.paintFoot(items, st);
      refreshDrawerHeader();
      setConn(true);
    } catch {
      setConn(false);
    } finally {
      setTimeout(poll, POLL_MS);
    }
  }

  function detectFinished(list) {
    for (const s of list) {
      if (!firstLoad && prevLane.get(s.id) === "busy" && s.lane === "idle") announce(s);
      prevLane.set(s.id, s.lane);
    }
    firstLoad = false;
  }

  function announce(s) {
    flashCard(s.id);
    if (settings.sound) chime();
    // Tepsi ikonu bildirim gösteriyorsa tarayıcı bildirimi tekrar etmesin.
    if (!trayNotify && settings.notify && "Notification" in window && Notification.permission === "granted") {
      const n = new Notification(t("notifyTitle", s.name), { body: `${t("notifyBody")}\n${s.cwd}`, icon: "/assets/logo.svg", tag: s.id });
      n.onclick = () => { window.focus(); openDrawer(s); n.close(); };
    }
  }

  // ---- Oturum kartları ----
  // Arama karşılaştırması: büyük/küçük harf ve Türkçe harf farkı yok (I/İ/ı = i, ş = s, ğ = g ...). Klasör adları çoğu zaman
  // ASCII yazılır ("Ic-Isler"); Türkçe küçültme "I"yı "ı" yapıp "ic" aramasını kaçırıyordu (§AU).
  const norm = (s) => String(s || "").replace(/[İIı]/g, "i").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  const matches = (q, ...vals) => !q || vals.some(v => norm(v).includes(norm(q)));

  // Kart ve konuşma ekranı eylemleri, toplu seçim (actions.js)
  const A = window.PanelActions({ t, api, toast, ask, confirmBox, adopt, goTo, openFolder, openDrawer, REMOTE,
    items: () => items, render: () => render(), wrapAllIdle: () => wrapAllIdle(), closeAll: () => closeAll(), resumeAllIdle: () => resumeAllIdle() });
  // Arka plan işi görünürlüğü (bgjobs.js): kart rozeti, alt bilgi, yeniden başlat/kapat uyarı listesi
  const B = window.PanelBgJobs({ t, api, toast, restartError: (code) => R.errText(code) });
  // Paneli yeniden başlat (restart.js): Ayarlar düğmesi + Takip'teki "Yeni sürüm hazır" satırı
  const R = window.PanelRestart({ t, api, getJson, confirmBox, ask, REMOTE, bg: B, toast });
  // Takip sekmesi (followup.js)
  const F = window.PanelFollowUp({ t, api, getJson, toast, esc, dur, openDrawer, setView, startHosted, confirmBox, ask, REMOTE, openMenu: A.openMenu, restart: R,
    lang: () => settings.lang, items: () => items,
    now: () => Date.now() + serverOffset, isOpen: () => view === "follow" });
  // Ayarlar → Mail ve takvim (settings-mail.js)
  window.PanelSettingsMail({ t, api, getJson, toast, ask, confirmBox, esc, REMOTE, reload: () => F.load(false) });
  R.subscribe(() => F.render());
  // Codex oturumları, salt okuma (codex.js): Codex şeridi, Son oturumlar satırları, okuma görünümü, üst çubukta kota
  const C = window.PanelCodex({ t, api, getJson, toast, ask, esc, dur, REMOTE, openDrawer, matches, modelChip: A.modelChip,
    now: () => Date.now() + serverOffset, query: () => $("search").value.trim(), lang: () => settings.lang,
    onRecentChange: () => { if (view === "recent") renderRecent(); } });
  // Proje maliyeti (cost.js): Oturumlar'da açık oturumların projeleri, Son oturumlar'da tüm projeler
  const K = window.PanelCost({ t, getJson, esc, lang: () => settings.lang,
    liveCwds: () => items.filter(s => s.status !== "ended").map(s => s.cwd) });
  // Açılış yükü (load.js): Skill kütüphanesinde
  const L = window.PanelLoad({ t, getJson, esc, lang: () => settings.lang });

  function render() {
    const q = $("search").value.trim();
    const visible = items.filter(s => matches(q, s.name, s.cwd));
    const idle = visible.filter(s => s.lane === "idle").sort((a, b) => b.since - a.since);
    const busy = visible.filter(s => s.lane === "busy").sort((a, b) => a.since - b.since);
    sync($("cardsIdle"), idle);
    sync($("cardsBusy"), busy);
    // Arama kutusunda kalan yazı listeyi sessizce süzmesin: kaç oturumun gizlendiği görünür.
    const hidden = items.length - visible.length;
    $("filterNote").hidden = !q || hidden === 0;
    if (q && hidden) $("filterText").textContent = t("filterHidden", q, hidden);
    $("countIdle").textContent = idle.length;
    $("btnResumeAll").hidden = !idle.some(canWrap);
    $("btnBulk").hidden = !items.some(canClose);
    A.renderBulkBar();
    $("countBusy").textContent = busy.length;
    $("navCount").textContent = items.length;
    F.onItems();
    const allIdle = items.filter(s => s.lane === "idle").length;
    $("summary").textContent = t("summary", items.length, allIdle, items.length - allIdle);
    C.render();
    K.render();
    $("empty").hidden = items.length > 0 || C.liveCount() > 0;
    document.querySelectorAll("#viewSessions .lane:not(.codex-lane)").forEach(l => l.hidden = items.length === 0);
    tick();
  }

  function sync(container, list) {
    const existing = new Map([...container.children].filter(c => !c.classList.contains("leaving")).map(c => [c.dataset.id, c]));
    const firstRects = new Map([...existing].map(([id, el]) => [id, el.getBoundingClientRect()]));
    list.forEach((s, i) => {
      let card = existing.get(s.id);
      if (!card) {
        card = document.querySelector(`.card[data-id="${CSS.escape(s.id)}"]`) || buildCard();
        card.dataset.id = s.id;
        card.classList.remove("leaving");
        card.classList.add("entering");
        requestAnimationFrame(() => requestAnimationFrame(() => card.classList.remove("entering")));
      }
      updateCard(card, s);
      if (container.children[i] !== card) container.insertBefore(card, container.children[i] || null);
      existing.delete(s.id);
    });
    for (const [, el] of existing) {
      el.classList.add("leaving");
      setTimeout(() => el.classList.contains("leaving") && el.remove(), 350);
    }
    for (const [id, r0] of firstRects) {
      const el = container.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
      if (!el || el.classList.contains("leaving")) continue;
      const r1 = el.getBoundingClientRect();
      const dx = r0.left - r1.left, dy = r0.top - r1.top;
      if (Math.abs(dx) + Math.abs(dy) < 2) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 380, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
  }

  function buildCard() {
    const el = document.createElement("article");
    el.className = "card";
    el.tabIndex = 0;
    el.innerHTML = `
      <div class="card-top"><span class="status-dot"></span><span class="sel-box" aria-hidden="true"></span><h3 class="name"></h3><span class="model-slot"></span><span class="badge night-badge" hidden></span><span class="badge kind-badge"></span></div>
      <p class="path"></p>
      <p class="abj-chip" hidden></p>
      <button type="button" class="proj-multi" hidden></button>
      <div class="meta"><span class="state-time"></span><span class="reason"></span><span class="age"></span></div>
      <p class="last" hidden></p>
      <p class="tool" hidden></p>
      <div class="ctx" hidden><div class="ctx-bar"><span></span></div><span class="ctx-label"></span></div>
      <div class="task-chip" hidden><span></span><button type="button" class="link task-cancel"></button></div>
      <div class="card-actions"></div>`;
    const cur = () => items.find(s => s.id === el.dataset.id);
    // Seçim kipinde ya da Ctrl/⌘ ile tık seçer; değilse konuşmayı açar.
    el.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      if (A.selecting() || e.ctrlKey || e.metaKey) A.toggle(cur()); else openDrawer(cur());
    });
    el.addEventListener("keydown", (e) => {
      if (e.target !== el) return;
      if (e.key === "Enter") A.selecting() ? A.toggle(cur()) : openDrawer(cur());
      if (e.key === " " && A.selecting()) { e.preventDefault(); A.toggle(cur()); }
    });
    el.querySelector(".task-cancel").addEventListener("click", (e) => { e.stopPropagation(); A.cancelTask(cur()); });
    el.querySelector(".proj-multi").addEventListener("click", (e) => { e.stopPropagation(); projectMenu(e.currentTarget, cur()); });
    // Onay kutusu (fare kartın üstündeyken görünür) seçim kipini açar.
    el.querySelector(".sel-box").addEventListener("click", (e) => { e.stopPropagation(); A.toggle(cur()); });
    // Dokunmatikte uzun basma seçer; ardından gelen tık konuşmayı açmasın.
    let pressTimer = 0, longPressed = false;
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch" || e.target.closest("button")) return;
      longPressed = false;
      pressTimer = setTimeout(() => { longPressed = true; navigator.vibrate?.(15); A.toggle(cur()); }, 500);
    });
    for (const ev of ["pointerup", "pointercancel", "pointermove"]) el.addEventListener(ev, (e) => {
      if (ev === "pointermove" && Math.abs(e.movementX) + Math.abs(e.movementY) < 4) return;
      clearTimeout(pressTimer);
    });
    el.addEventListener("click", (e) => { if (longPressed) { e.stopImmediatePropagation(); longPressed = false; } }, true);
    el.addEventListener("contextmenu", (e) => { if (e.pointerType === "touch" || longPressed) e.preventDefault(); });
    return el;
  }

  function updateCard(card, s) {
    card.dataset.lane = s.lane;
    card.dataset.since = s.since;
    card.dataset.started = s.started;
    card.querySelector(".name").textContent = s.name;
    card.querySelector(".path").textContent = s.cwd;
    card.querySelector(".path").title = s.cwd;
    const badge = card.querySelector(".kind-badge");
    // Panel oturumu varsayılan; rozet yalnız terminal/arka plan için (uzun ad model rozetiyle kısalmasın).
    badge.textContent = kindLabel(s);
    badge.hidden = !badge.textContent;
    badge.dataset.kind = s.kind;
    // Aynı projede (git kökü) birden çok oturum: çakışma riski kartta görünür.
    const same = s.root ? items.filter(x => x.root === s.root && x.status !== "ended").length : 1;
    const pm = card.querySelector(".proj-multi");
    pm.hidden = same < 2;
    pm.textContent = same < 2 ? "" : t("projMulti", same);
    pm.title = t("projMultiHint");
    const nb = card.querySelector(".night-badge");
    nb.textContent = s.night ? t("night_" + s.night) : "";
    nb.hidden = !s.night;
    nb.dataset.night = s.night || "";
    nb.title = s.night === "decision" ? t("nightDecisionHint") : "";
    B.paintCard(card, s);
    updateCardDetails(card, s);
  }

  // Kart rozeti: nerede açık (+ birden çok sanal masaüstü varsa hangisi). Panel oturumunda rozet yok.
  function kindLabel(s) {
    if (s.kind === "panel") return "";
    if (s.kind === "bg") return t("bg");
    const where = s.surface === "desktop" ? t("desktopApp") : s.surface === "vscode" ? "VS Code"
      : settings.tabMap[s.sessionId] ? t("tabLabel", settings.tabMap[s.sessionId]) : t("terminal");
    return s.desk ? `${where} · ${s.desk.name || t("deskN", s.desk.number)}` : where;
  }

  // "Bu projede N oturum açık" rozeti: aynı projedeki oturumlardan birini kaydedip kapatma / panele alma kısayolu.
  function projectMenu(anchor, s) {
    if (!s?.root) return;
    const L = [];
    for (const x of items.filter(x => x.root === s.root && x.status !== "ended")) {
      if (x.kind === "panel" && x.key && !x.task)
        L.push({ label: t(x.lane === "busy" ? "pmLaterClose" : "pmSaveClose", x.name), run: async () => {
          const r = await api(`/api/hosted/${x.key}/wrap`, { close: true });
          r.ok ? toast(t(x.lane === "busy" ? "laterSet" : "closeSaving")) : toast(t(`err_${r.data?.error || "generic"}`), "warn");
        } });
      else if (x.kind === "terminal" && x.lane === "idle" && !REMOTE) L.push({ label: t("pmAdopt", x.name), run: () => adopt(x) });
    }
    if (L.length) L.push(null);
    for (const x of items.filter(x => x.root === s.root && x.status !== "ended"))
      L.push({ label: t("pmOpen", x.name), run: () => openDrawer(x) });
    A.openMenu(anchor, L, { alignStart: true });
  }

  // Model rozeti, son mesaj / son araç, bağlam çubuğu, bekleyen iş, eylemler, seçim.
  function updateCardDetails(card, s) {
    const model = s.stats?.model || s.model;
    const slot = card.querySelector(".model-slot");
    if (slot.dataset.model !== (model || "")) {
      slot.dataset.model = model || "";
      slot.replaceChildren(...[A.modelChip(model)].filter(Boolean));
    }
    const last = card.querySelector(".last");
    const text = s.lane === "idle" ? (s.stats?.lastText || "") : "";
    last.hidden = !text;
    last.textContent = text.replace(/[*_`#>]/g, "").trim().split("\n").filter(x => x.trim()).slice(-3).join("\n");
    last.classList.toggle("clear", A.wantsClear(s));
    const tool = card.querySelector(".tool");
    tool.textContent = s.lane === "busy" ? A.lastTool(s) : "";
    tool.hidden = !tool.textContent;
    card.querySelector(".reason").textContent = s.waiting != null ? t("reasonWaiting")
      : s.lane === "idle" && text ? (A.asked(s) ? t("reasonAsked") : "") : "";
    const c = A.ctxInfo(s), ctx = card.querySelector(".ctx");
    ctx.hidden = !c;
    if (c) {
      ctx.dataset.level = c.level;
      ctx.querySelector(".ctx-bar span").style.width = (c.pct ?? 0) + "%";
      ctx.querySelector(".ctx-bar").hidden = c.pct == null;
      ctx.querySelector(".ctx-label").textContent = A.ctxLabel(s);
      ctx.title = A.statsLine(s);
    }
    const chip = card.querySelector(".task-chip");
    chip.hidden = !s.task;
    if (s.task) {
      chip.firstChild.textContent = A.taskLabel(s);
      chip.querySelector(".task-cancel").textContent = t("cancel");
    }
    // Eylemler yalnız durum değişince yeniden kurulur (açık menü/odak kaybolmasın).
    const sig = [s.kind, s.surface, s.lane, s.status, s.task, A.wantsClear(s), c?.level, settings.lang].join("|");
    const box = card.querySelector(".card-actions");
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig;
      const conv = document.createElement("button");
      conv.type = "button";
      conv.className = "btn small";
      conv.textContent = t("openConv");
      conv.addEventListener("click", (e) => { e.stopPropagation(); openDrawer(items.find(x => x.id === card.dataset.id)); });
      A.fillActions(box, s, false, [conv]);
    }
    card.classList.toggle("selected", A.isSelected(s.id));
    card.classList.toggle("unselectable", A.selecting() && !A.selectable(s));
    card.querySelector(".sel-box").classList.toggle("on", A.isSelected(s.id));
    card.querySelector(".sel-box").title = t("selectHint");
    card.classList.toggle("can-select", A.selectable(s));
  }

  // Kotanın yenilenmesine kalan süre (sunucu saatine göre; dakikaya yuvarlanır, 1 dk altı "1 dk").
  function resetIn(at) {
    const left = at - (Date.now() + serverOffset);
    return left > 0 ? t("resetIn", dur(Math.max(60_000, Math.ceil(left / 60_000) * 60_000))) : "";
  }

  function tick() {
    const now = Date.now() + serverOffset;
    document.querySelectorAll(".reset-in").forEach(el => { el.textContent = resetIn(Number(el.dataset.at)); });
    document.querySelectorAll(".card:not(.codex-card)").forEach(card => {
      const since = Number(card.dataset.since), started = Number(card.dataset.started), lane = card.dataset.lane;
      card.querySelector(".state-time").textContent = t(lane === "busy" ? "workingFor" : "waitingFor", dur(now - since));
      card.querySelector(".age").textContent = `${t("started")}: ${t("since", dur(now - started))}`;
      card.classList.toggle("stale", lane === "idle" && now - since > 5 * 60_000);
    });
  }
  setInterval(tick, 1000);

  // Telefonda yüzen + düğmesi kartların üstüne binmesin: aşağı kaydırırken çekilir; yukarı kaydırınca, en üstte
  // ve sayfa sonunda (alt boşluk sayesinde altında içerik kalmaz) görünür. Masaüstünde .away kuralı yok.
  // Kaydıran öğe body (html overflow-x:clip olduğu için body taşmayı pencereye aktarmıyor); ikisi de dinlenir.
  let lastY = 0;
  const onScroll = (e) => {
    const el = e.target === document ? document.scrollingElement : e.target;
    if (el !== document.body && el !== document.scrollingElement) return;
    const y = el.scrollTop, atEnd = y + el.clientHeight >= el.scrollHeight - 4;
    const hide = y > lastY && y > 40 && !atEnd;
    if (Math.abs(y - lastY) > 6 || atEnd || y <= 40) { $("btnNew").classList.toggle("away", hide); lastY = y; }
  };
  document.addEventListener("scroll", onScroll, { passive: true, capture: true });

  function flashCard(id) {
    const el = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  }

  // ---- Kota ----
  // Bu hızla ne zaman biter: pencerenin başından (yenilenme anı − pencere süresi) bu yana ortalama tüketim sürerse.
  // Pencerenin ilk 15 dakikasında ya da hiç kullanım yokken tahmin yazılmaz (ölçü yetersiz).
  const WINDOW_MS = { five_hour: 5 * 3600_000, seven_day: 7 * 86400_000 };
  function pace(w, len, at) {
    if (!at || isNaN(at) || w.used <= 0) return "";
    const now = Date.now() + serverOffset, start = at.getTime() - len, elapsed = now - start;
    if (elapsed < 15 * 60_000 || now >= at.getTime()) return "";
    if (w.used >= 100) return `<small class="pace crit">${esc(t("paceOut"))}</small>`;
    const end = now + (100 - w.used) * elapsed / w.used;
    if (end >= at.getTime()) return `<small class="pace">${esc(t("paceOk"))}</small>`;
    const d = new Date(end), sameDay = d.toDateString() === new Date(now).toDateString();
    const when = d.toLocaleString(settings.lang, sameDay ? { hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    return `<small class="pace warn" title="${esc(t("paceHint"))}">${esc(t("paceEnds", when))}</small>`;
  }
  function renderUsage(u) {
    const box = $("usage");
    if (!u || (!u.five_hour && !u.seven_day)) { box.hidden = true; return; }
    box.hidden = false;
    const ring = (label, w, len) => {
      if (!w || w.used == null) return "";
      const left = Math.max(0, Math.min(100, 100 - w.used));
      const level = left < 15 ? "crit" : left < 40 ? "warn" : "ok";
      // Sıfırlanma anı her zaman tarih + saatle yazılır; geçmişteyse veri eski demektir (yenilenmesi beklenir).
      const at = w.resetsAt ? new Date(w.resetsAt) : null;
      const when = at && !isNaN(at) ? at.toLocaleString(settings.lang, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : null;
      const past = at && at.getTime() <= Date.now();
      const reset = when ? `<small class="reset${past ? " stale" : ""}">${t(past ? "resetDone" : "resetAt", when)}</small>` +
        (past ? "" : `<small class="reset-in" data-at="${at.getTime()}">${esc(resetIn(at.getTime()))}</small>`) : "";
      return `<div class="ring ${level}" data-p="${left}"><svg viewBox="0 0 36 36"><circle class="bgc" cx="18" cy="18" r="15.9"/><circle class="fg" cx="18" cy="18" r="15.9" pathLength="100"/></svg>
        <div><b>${t("left", Math.round(left))}</b><small>${label}</small>${reset}${past ? "" : pace(w, len, at)}</div></div>`;
    };
    box.innerHTML = ring(t("fiveHour"), u.five_hour, WINDOW_MS.five_hour) + ring(t("week"), u.seven_day, WINDOW_MS.seven_day);
    box.querySelectorAll(".ring").forEach(r => r.querySelector(".fg").style.strokeDasharray = `${r.dataset.p} 100`);
  }

  // ---- Eylemler ----
  async function goTo(s, tab) {
    if (!s) return;
    if (s.kind === "bg") { await api("/api/attach"); return; }
    if (s.kind !== "terminal") return;
    // Sekme kimliği (tabId) claude sekme başlığını değiştirse de aynı kalır; ad yalnız kimlik yoksa/kaybolduysa kullanılır.
    const r = await api(`/api/focus/${s.pid}`, tab ? { tab } : { tab: settings.tabMap[s.sessionId] ?? null, tabId: settings.tabIds[s.sessionId] ?? null });
    if (r.ok) {
      const d = r.data || {};
      if (d.tab && (settings.tabMap[s.sessionId] !== d.tab || settings.tabIds[s.sessionId] !== d.tabId)) {
        settings.tabMap[s.sessionId] = d.tab;
        if (d.tabId) settings.tabIds[s.sessionId] = d.tabId;
        save(); render();
      }
      return;
    }
    if (r.data?.error === "pick-tab") {
      if (settings.tabMap[s.sessionId] || settings.tabIds[s.sessionId]) { delete settings.tabMap[s.sessionId]; delete settings.tabIds[s.sessionId]; save(); }
      pickTab(s, r.data.tabs || []);
    } else toast(t("noWindow"), "warn");
  }

  function pickTab(s, tabs) {
    const list = $("tabList");
    list.innerHTML = "";
    tabs.forEach(name => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn tab-pick"; b.textContent = name;
      b.addEventListener("click", () => { settings.tabMap[s.sessionId] = name; save(); $("dlgTab").close(); goTo(s, name); render(); });
      list.appendChild(b);
    });
    $("dlgTab").showModal();
  }

  // Terminaldeki oturumu panele taşır (terminaldeki claude kapanır, konuşma panelde sürer).
  const adopting = new Set(); // sürmekte olan "Panele al" istekleri
  async function adopt(s) {
    if (!s || s.kind !== "terminal" || adopting.has(s.pid)) return;
    adopting.add(s.pid); // soru açıkken ikinci tıklama ikinci soruyu sıraya koymasın
    if (!await confirmBox({ title: t("adoptTitle"), text: t("adoptConfirm", s.name), okText: t("adopt") })) { adopting.delete(s.pid); return; }
    let r;
    try { r = await api(`/api/adopt/${s.pid}`); }
    catch { r = { ok: false, data: null }; }
    finally { adopting.delete(s.pid); }
    if (!r.ok) { toast(t(`err_${r.data?.error || "generic"}`), "warn"); return; }
    toast(t("adopted", s.name));
    if (drawer.target) { drawer.target.id = "h:" + r.data.key; drawer.target.kind = "panel"; drawer.target.key = r.data.key; }
  }

  async function openFolder(s) { if (s) await api("/api/open-folder", { path: s.cwd }); }

  function rememberFolders(list) {
    let changed = false;
    for (const f of list) if (f && !settings.folders.includes(f)) { settings.folders.unshift(f); changed = true; }
    if (changed) { settings.folders = settings.folders.slice(0, 40); save(); }
  }

  // ---- Çekmece (konuşma) ----
  const drawer = { target: null, timer: null, rendered: new Set(), sending: false };

  function openDrawer(s) {
    if (!s) return;
    drawer.target = { ...s };
    drawer.rendered.clear();
    $("dMessages").innerHTML = `<p class="muted center">${t("loading")}</p>`;
    $("dInput").value = "";
    syncComposer();
    document.body.classList.add("drawer-open");
    $("drawer").setAttribute("aria-hidden", "false");
    refreshDrawerHeader();
    loadTranscript(true);
    clearInterval(drawer.timer);
    drawer.timer = setInterval(() => loadTranscript(false), DRAWER_POLL_MS);
    setTimeout(() => { if (!$("dInput").disabled) $("dInput").focus(); }, 300);
  }

  function closeDrawer() {
    document.body.classList.remove("drawer-open");
    $("drawer").setAttribute("aria-hidden", "true");
    clearInterval(drawer.timer);
    drawer.target = null;
  }

  function liveOf(target) {
    if (!target) return null;
    return items.find(s => s.id === target.id)
      || items.find(s => target.sessionId && s.sessionId === target.sessionId)
      || null;
  }

  function refreshDrawerHeader() {
    const tg = drawer.target;
    if (!tg) return;
    if (tg.kind === "codex") { C.drawerHeader(tg); return; }
    const live = liveOf(tg);
    const prevSid = tg.sessionId;
    if (live) Object.assign(tg, live);
    // /clear sonrası oturum yeni konuşma kimliğiyle sürer: görünüm yeni konuşmaya geçer.
    if (prevSid && tg.sessionId && tg.sessionId !== prevSid) {
      tg.title = null;
      drawer.rendered.clear();
      drawer.suggestClear = false;
      $("dMessages").innerHTML = "";
      loadTranscript(true);
    }
    $("dTitle").textContent = tg.title || tg.name || folderName(tg.cwd);
    $("dPath").textContent = tg.cwd || "";
    $("dDot").dataset.lane = live ? live.lane : "closed";
    const meta = [];
    if (live) meta.push(t(live.lane === "busy" ? "workingFor" : "waitingFor", dur(Date.now() + serverOffset - live.since)));
    const stats = live ? A.statsLine(live) : "";
    if (stats) meta.push(stats);
    if (live?.cost) meta.push(t("cost", live.cost.toFixed(2)));
    if (live?.error) meta.push("⚠ " + live.error);
    if (live?.bgjobs?.length) meta.push(B.chip(live.bgjobs));
    $("dMeta").textContent = meta.join(" · ");
    const dModel = live?.stats?.model || live?.model || "";
    if ($("dModel").dataset.model !== dModel) {
      $("dModel").dataset.model = dModel;
      $("dModel").replaceChildren(...[A.modelChip(dModel)].filter(Boolean));
    }

    // Kartla aynı eylem kümesi; yalnız durum değişince yeniden kurulur.
    const actions = $("dActions");
    const sig = live ? [live.id, live.kind, live.lane, live.status, live.task, A.wantsClear(live) || drawer.suggestClear, A.ctxInfo(live)?.level, settings.lang].join("|") : "";
    if (actions.dataset.sig !== sig) {
      actions.dataset.sig = sig;
      if (live) A.fillActions(actions, live, true); else actions.innerHTML = "";
    }
    $("dTask").hidden = !live?.task;
    if (live?.task) $("dTaskText").textContent = A.taskLabel(live);

    const canType = !live || live.kind === "panel";
    $("dInput").disabled = !canType;
    $("dSend").disabled = !canType;
    const sendLabel = !live || live.status === "ended" ? t("continueHere") : t("send");
    $("dSend").textContent = sendLabel;
    $("dSend").title = sendLabel; // telefonda düğme yalnız ok simgesi, ad title/aria'da
    $("dSend").setAttribute("aria-label", sendLabel);
    $("dNote").textContent =
      live?.surface === "desktop" ? t("noteDesktop")
      : live?.kind === "terminal" || live?.kind === "bg" ? t(REMOTE ? "noteTerminalRemote" : "noteTerminal")
      : !live ? t("noteClosed")
      : live.status === "ended" ? t("noteEnded")
      : !live.sessionId ? t("noteStarting") : "";
    $("dNote").hidden = !$("dNote").textContent;
  }

  async function loadTranscript(first) {
    const tg = drawer.target;
    if (!tg) return;
    if (!tg.sessionId && tg.kind !== "codex") { if (first) $("dMessages").innerHTML = `<p class="muted center">${t("noteStarting")}</p>`; return; }
    let data;
    const url = tg.kind === "codex" ? C.transcriptUrl(tg) : `/api/transcript/${encodeURIComponent(tg.sessionId)}?limit=250`;
    try { data = await getJson(url); } catch { return; }
    if (drawer.target !== tg) return;
    if (data.title) { tg.title = data.title; $("dTitle").textContent = data.title; }
    const box = $("dMessages");
    // Döküm henüz boşken kutu sıfırlanır ama gönderilen mesajın yankı balonu (.pending) korunur; döküm gelince o siler.
    if (drawer.rendered.size === 0) box.querySelectorAll(":scope > :not(.pending)").forEach(e => e.remove());
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    let added = 0;
    const fresh = [];
    for (const it of data.items) {
      if (drawer.rendered.has(it.id)) continue;
      drawer.rendered.add(it.id);
      if (it.kind === "user") box.querySelectorAll(".msg.pending").forEach(p => p.remove());
      if (it.kind === "assistant") drawer.suggestClear = /\/clear\b/.test(it.text || "");
      fresh.push(box.appendChild(renderItem(it, !first)));
      added++;
    }
    linkPaths(fresh);
    if (!data.items.length && drawer.rendered.size === 0 && !box.querySelector(".pending")) box.innerHTML = `<p class="muted center">—</p>`;
    if (added && (first || nearBottom)) box.scrollTo({ top: box.scrollHeight, behavior: first ? "auto" : "smooth" });
    const live = liveOf(tg);
    box.classList.toggle("typing", !!live && live.lane === "busy");
    if (added) refreshDrawerHeader();
  }

  function renderItem(it, animate) {
    const el = document.createElement("div");
    el.className = `msg ${it.kind}` + (animate ? " new" : "");
    if (it.kind === "tool") {
      el.innerHTML = `<span class="tool-name">${esc(it.tool || t("tool"))}</span><span class="tool-text">${esc(it.text)}</span>`;
    } else if (it.kind === "assistant") {
      el.innerHTML = md(it.text);
    } else {
      el.textContent = it.text;
    }
    if (it.kind !== "tool" && it.ts) {
      const stamp = document.createElement("div");
      stamp.className = "msg-time";
      stamp.textContent = msgTime(it.ts);
      stamp.title = new Date(it.ts).toLocaleString(settings.lang);
      el.appendChild(stamp);
    }
    return el;
  }
  // Mesajdaki yollar (C:\…, %LOCALAPPDATA%\…, ~/…, /Users/…): sunucu bu bilgisayarda var olan en uzun ön eki söyler,
  // yalnız o kısım bağlantı olur. Tıklayınca klasör Gezgin'de açılır, dosya seçili gösterilir. Telefonda yok (uç kapalı).
  const PATH_RE = /(?:[A-Za-z]:\\|%[A-Za-z_][A-Za-z0-9_]*%[\\/]|~[\\/]|\/(?:Users|Volumes|Applications|home|opt|tmp|private)\/)(?:(?!\s(?:[A-Za-z]:\\|%[A-Za-z_]))[^\n<>"|?*`])*/g;
  async function linkPaths(els) {
    if (REMOTE || !els.length) return;
    const hits = [];
    for (const el of els) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.parentElement.closest(".msg-time, a")) continue;
        for (const m of n.nodeValue.matchAll(PATH_RE)) hits.push({ node: n, at: m.index, text: m[0] });
      }
    }
    if (!hits.length) return;
    const uniq = [...new Set(hits.map(h => h.text))].slice(0, 200);
    let lens;
    try {
      const res = await fetch("/api/path-links", { method: "POST", headers: { "X-Panel-Token": TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(uniq) });
      if (!res.ok) return;
      lens = await res.json();
    } catch { return; }
    const lenOf = new Map(uniq.map((u, i) => [u, lens[i]]));
    // Aynı düğümde sondan başa böl: öndeki konumlar kaymasın.
    for (const h of hits.sort((a, b) => b.at - a.at)) {
      const len = lenOf.get(h.text);
      if (!len || !h.node.parentNode) continue;
      const tail = h.node.splitText(h.at);
      tail.splitText(len);
      const a = document.createElement("a");
      a.className = "path-link";
      a.href = "#";
      a.dataset.path = tail.nodeValue;
      a.title = t("revealPath");
      tail.replaceWith(a);
      a.appendChild(tail);
    }
  }
  $("dMessages").addEventListener("click", async (e) => {
    const a = e.target.closest("a.path-link");
    if (!a) return;
    e.preventDefault();
    const res = await fetch("/api/reveal", { method: "POST", headers: { "X-Panel-Token": TOKEN, "Content-Type": "application/json" }, body: JSON.stringify({ path: a.dataset.path }) });
    if (!res.ok) toast(t("pathMissing"), "warn");
  });
  // Mesaj saati: bugünse yalnız saat, değilse gün.ay + saat.
  function msgTime(ts) {
    const d = new Date(ts), now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return d.toLocaleString(settings.lang, sameDay ? { hour: "2-digit", minute: "2-digit" }
      : { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  // Kaydet/temizle/kapat: panelde açık, bitmemiş ve zinciri sürmeyen oturumlar.
  function canWrap(s) { return !!s && s.kind === "panel" && s.status !== "ended" && !s.task; }

  // Seçenekli soru penceresi. buttons: [{ value, label, cls }] → seçilen value; Vazgeç/Esc → "cancel".
  // opts: { cancelLabel, focus: odaklanacak düğmenin value'su, cbox: onay penceresi görünümü }.
  // Sorular sıraya girer: biri açıkken gelen ikincisi öncekinin kapanmasını bekler (showModal açık pencerede hata verir).
  let askQueue = Promise.resolve();
  function ask(title, text, list, buttons, opts = {}) {
    const p = askQueue.then(() => new Promise(resolve => {
      const d = $("dlgAsk");
      d.classList.toggle("cbox", !!opts.cbox);
      $("askTitle").textContent = title;
      $("askText").textContent = text;
      const ul = $("askList");
      ul.innerHTML = "";
      ul.hidden = !list?.length;
      (list || []).forEach(x => { const li = document.createElement("li"); li.textContent = x; ul.appendChild(li); });
      const row = $("askButtons");
      row.innerHTML = "";
      // Yalnız "Tamam" olan bilgi penceresinde Vazgeç gösterilmez (Esc yine kapatır).
      const base = buttons.some(b => b.value === "ok") ? [] : [{ value: "cancel", label: opts.cancelLabel || t("cancel"), cls: "" }];
      [...base, ...buttons].forEach(b => {
        const el = document.createElement("button");
        el.className = `btn ${b.cls}`; el.value = b.value; el.textContent = b.label;
        row.appendChild(el);
      });
      d.returnValue = "";
      d.addEventListener("close", () => resolve(d.returnValue || "cancel"), { once: true });
      d.showModal();
      if (opts.focus) [...row.children].find(b => b.value === opts.focus)?.focus();
    }));
    askQueue = p.catch(() => {});
    return p;
  }
  // Evet/hayır onayı (tarayıcının yerleşik onay penceresi yerine; Mac uygulama penceresinde o hiç görünmüyor).
  // → true/false. Enter odaktaki düğmeyi çalıştırır: olağan işlemde odak onay düğmesinde, tehlikeli işlemde Vazgeç'te.
  async function confirmBox({ title, text, list, okText, cancelText, danger }) {
    const v = await ask(title, text || "", list, [{ value: "yes", label: okText, cls: danger ? "cbox-danger" : "primary" }],
      { cancelLabel: cancelText, focus: danger ? "cancel" : "yes", cbox: true });
    return v === "yes";
  }

  async function wrapAllIdle() {
    const idle = items.filter(s => s.lane === "idle");
    const panel = idle.filter(canWrap);
    if (!panel.length) { toast(t("wrapNone"), "warn"); return; }
    const skipped = idle.filter(s => s.kind !== "panel").map(s => t("wrapSkip", s.name));
    const v = await ask(t("wrapAllTitle"), t("wrapAllText"), [...panel.map(s => s.name), ...skipped],
      [{ value: "go", label: t("saveClear"), cls: "primary" }]);
    if (v !== "go") return;
    for (const s of panel) await api(`/api/hosted/${s.key}/wrap`, { close: false });
    toast(t("wrapStarted", panel.length));
  }

  // Kapatılabilir: panelde açık, bitmemiş, zaten kapanmakta olmayan oturum (çalışan da dahil; iş bitince kapanır).
  function canClose(s) { return !!s && s.kind === "panel" && s.status !== "ended" && s.task !== "closing"; }

  // Tüm panel oturumları durumunu kaydeder ve kapanır; çalışanlar işlerini bitirince.
  async function closeAll() {
    const panel = items.filter(canClose);
    if (!panel.length) { toast(t("wrapNone"), "warn"); return; }
    const skipped = items.filter(s => s.kind !== "panel").map(s => t("wrapSkip", s.name));
    const v = await ask(t("closeAllTitle"), t("closeAllText"),
      [...panel.map(s => s.lane === "busy" ? t("closeAllBusy", s.name) : s.name), ...skipped],
      [{ value: "go", label: t("saveCloseAll"), cls: "primary" }]);
    if (v !== "go") return;
    let ok = 0;
    for (const s of panel) if ((await api(`/api/hosted/${s.key}/wrap`, { close: true })).ok) ok++;
    toast(t("closeAllStarted", ok), ok === panel.length ? undefined : "warn");
  }

  // Bekleyen tüm panel oturumlarına tek seferde "devam" mesajı gönderir.
  async function resumeAllIdle() {
    const idle = items.filter(s => s.lane === "idle");
    const panel = idle.filter(canWrap);
    if (!panel.length) { toast(t("wrapNone"), "warn"); return; }
    const skipped = idle.filter(s => s.kind !== "panel").map(s => t("wrapSkip", s.name));
    const v = await ask(t("resumeAllTitle"), t("resumeAllText"), [...panel.map(s => s.name), ...skipped],
      [{ value: "go", label: t("resumeAll"), cls: "primary" }]);
    if (v !== "go") return;
    let ok = 0;
    for (const s of panel) if ((await api(`/api/hosted/${s.key}/send`, { text: t("resumeAllMsg") })).ok) ok++;
    toast(t("resumeStarted", ok), ok === panel.length ? undefined : "warn");
  }

  async function sendFromDrawer() {
    const tg = drawer.target;
    const text = $("dInput").value.trim();
    if (!tg || !text || drawer.sending || tg.kind === "codex") return; // Codex: yalnız okuma
    drawer.sending = true;
    try {
      const live = liveOf(tg);
      let r;
      if (live?.kind === "panel" && live.status !== "ended") {
        r = await api(`/api/hosted/${live.key}/send`, { text });
      } else {
        // Kapalı ya da sona ermiş oturumu panelde sürdür.
        if (live?.kind === "panel") await api(`/api/hosted/${live.key}/stop`);
        r = await startHosted({ cwd: tg.cwd, prompt: text, resumeId: tg.sessionId, name: null, model: null });
        if (r.ok && !r.data.sent && !r.data.queued) { tg.id = "h:" + r.data.key; tg.kind = "panel"; tg.key = r.data.key; }
        // Mesaj projedeki öteki oturuma gittiyse o oturumun konuşması açılır.
        else if (r.ok) { $("dInput").value = ""; syncComposer(); openDrawer(items.find(s => s.key === r.data.key) || tg); return; }
      }
      if (r.ok) {
        $("dInput").value = "";
        syncComposer();
        const echo = renderItem({ kind: "user", text }, true);
        echo.classList.add("pending");
        $("dMessages").appendChild(echo);
        $("dMessages").scrollTo({ top: $("dMessages").scrollHeight, behavior: "smooth" });
      } else if (!r.cancelled) toast(t(`err_${r.data?.error || "generic"}`), "warn");
    } finally {
      drawer.sending = false;
    }
  }

  // ---- Son oturumlar ----
  let recent = [];
  async function loadRecent() {
    $("recentList").innerHTML = `<p class="muted">${t("loading")}</p>`;
    try { recent = await getJson("/api/recent"); } catch { recent = []; }
    renderRecent();
  }
  // Çoklu seçim: kapalı oturumların kimlikleri; canlı olanlar seçilemez.
  const picked = new Set();
  function updateRecentBar() {
    $("recentBar").hidden = !picked.size;
    $("recentCount").textContent = t("recentPicked", picked.size);
  }
  // Seçilen kapalı oturumları panelde mesajsız (bekler durumda) açar.
  let openingPicked = false;
  async function openPicked() {
    if (openingPicked) return;
    openingPicked = true;
    $("btnRecentOpen").disabled = true;
    try { await openPickedNow(); }
    finally { openingPicked = false; $("btnRecentOpen").disabled = false; }
  }
  async function openPickedNow() {
    const liveIds = new Set(items.map(s => s.sessionId));
    const sel = recent.filter(r => picked.has(r.sessionId) && !liveIds.has(r.sessionId));
    if (!sel.length) { picked.clear(); renderRecent(); return; }
    const v = await ask(t("recentOpenTitle"), t("recentOpenText"), sel.map(r => r.title),
      [{ value: "go", label: t("recentOpen"), cls: "primary" }]);
    if (v !== "go") return;
    let ok = 0;
    const failed = [];
    for (const r of sel) {
      const res = await startHosted({ cwd: r.cwd, prompt: null, resumeId: r.sessionId, name: null, model: null });
      if (res.ok) ok++; else failed.push(`${r.title} — ${t(`err_${res.data?.error || "generic"}`)} (${r.cwd})`);
    }
    picked.clear();
    toast(t("recentOpened", ok), failed.length ? "warn" : undefined);
    if (ok) setView("sessions"); else renderRecent();
    // Açılamayanlar kaybolmasın: kısa bildirim yerine kalıcı pencerede listelenir.
    if (failed.length) await ask(t("recentFailTitle"), t("recentFailText"), failed, [{ value: "ok", label: t("ok"), cls: "primary" }]);
  }
  function renderRecent() {
    const q = $("search").value.trim();
    const liveIds = new Set(items.map(s => s.sessionId));
    for (const id of [...picked]) if (liveIds.has(id)) picked.delete(id);
    const list = [...recent, ...C.recent()].filter(r => matches(q, r.title, r.cwd)).sort((a, b) => b.updatedAt - a.updatedAt);
    const box = $("recentList");
    box.innerHTML = list.length ? "" : `<p class="muted">${t("emptyRecent")}</p>`;
    const now = Date.now() + serverOffset;
    updateRecentBar();
    list.forEach((r, i) => {
      if (r.codex) { box.appendChild(C.recentRow(r, i)); return; }
      const item = document.createElement("div");
      item.className = "recent-item";
      item.style.setProperty("--i", Math.min(i, 20));
      const isLive = liveIds.has(r.sessionId);
      const pick = document.createElement("input");
      pick.type = "checkbox";
      pick.className = "r-pick";
      pick.disabled = isLive;
      pick.checked = picked.has(r.sessionId);
      pick.title = t(isLive ? "recentPickLive" : "recentPick");
      pick.setAttribute("aria-label", `${t("recentPick")}: ${r.title}`);
      pick.addEventListener("change", () => {
        if (pick.checked) picked.add(r.sessionId); else picked.delete(r.sessionId);
        updateRecentBar();
      });
      const row = document.createElement("button");
      row.className = "recent-row";
      item.append(pick, row);
      row.innerHTML = `<span class="r-dot ${isLive ? "live" : ""}"></span>
        <span class="r-main"><b>${esc(r.title)}</b><small>${esc(r.cwd)}</small></span>
        <span class="r-side">${isLive ? `<em>${t("live")}</em>` : ""}<small>${t("since", dur(now - r.updatedAt))}</small></span>`;
      row.addEventListener("click", () => {
        const live = items.find(s => s.sessionId === r.sessionId);
        openDrawer(live ? { ...live, title: r.title } : { id: "r:" + r.sessionId, kind: "closed", sessionId: r.sessionId, cwd: r.cwd, name: r.title, title: r.title });
      });
      box.appendChild(item);
    });
  }

  // ---- Skill kütüphanesi ----
  // Türkçe arama sözcüklerini skill dünyasındaki karşılıklarına genişletir.
  const SYN = {
    sunum: ["pptx", "slide", "presentation", "deck"], slayt: ["pptx", "slide"], word: ["docx"], belge: ["docx", "document", "pdf"],
    excel: ["xlsx", "spreadsheet", "csv"], tablo: ["xlsx", "spreadsheet", "table"], pdf: ["pdf"],
    "görsel": ["image", "photo", "illustration"], resim: ["image", "photo"], video: ["video", "seedance", "animation"],
    ses: ["audio", "voice", "speech", "music"], tasarım: ["design", "ui", "frontend", "figma"], arayüz: ["ui", "frontend", "interface"],
    test: ["test", "tdd", "qa", "e2e"], "güvenlik": ["security", "vulnerability", "audit", "pentest"],
    "veritabanı": ["database", "sql", "postgres"], veri: ["data", "dataset", "analytics"], api: ["api", "rest", "openapi", "postman"],
    "araştırma": ["research", "search"], arama: ["search", "research"], mail: ["email", "mail", "gmail"], takvim: ["calendar"],
    şema: ["diagram", "chart", "mermaid"], diyagram: ["diagram", "mermaid"], grafik: ["chart", "dataviz", "graph"],
    kod: ["code", "refactor", "review"], inceleme: ["review", "audit"], hata: ["debug", "bug", "error"],
    yayın: ["deploy", "release", "publish"], git: ["git", "github", "commit"], "çeviri": ["translate", "i18n"]
  };
  function expand(q) {
    const words = norm(q).split(/\s+/).filter(Boolean);
    return words.map(w => [w, ...Object.entries(SYN).filter(([k]) => norm(k).startsWith(w) || w.startsWith(norm(k))).flatMap(([, v]) => v)]);
  }
  // Her kelime (ya da eş anlamlısı) ad, açıklama, kaynak veya kategoride geçmeli; ad eşleşmesi öne çıkar.
  function skillScore(s, groups) {
    if (!groups.length) return 1;
    const name = norm(s.name), hay = norm(`${s.description} ${s.source} ${t("cat_" + s.category)}`);
    let score = 0;
    for (const g of groups) {
      let best = 0;
      for (const w of g) {
        if (name === w) best = Math.max(best, 50);
        else if (name.includes(w)) best = Math.max(best, 20);
        else if (hay.includes(w)) best = Math.max(best, 5);
      }
      if (!best) return 0;
      score += best;
    }
    return score + (s.active ? 2 : 0);
  }

  let lib = null, skillFilter = "all", skillCat = "all";
  async function loadSkills() {
    if (!lib) {
      $("skillGrid").innerHTML = `<p class="muted">${t("loading")}</p>`;
      try { lib = await getJson("/api/skills"); } catch { lib = { skills: [], guide: [], categories: [] }; }
    }
    renderSkills();
    L.load();
    setTimeout(() => $("skillSearch").focus(), 50);
  }

  function renderCats(list) {
    const counts = {};
    list.forEach(s => counts[s.category] = (counts[s.category] || 0) + 1);
    const box = $("catList");
    box.innerHTML = "";
    const add = (key, label, n) => {
      const b = document.createElement("button");
      b.className = "cat" + (skillCat === key ? " active" : "");
      b.innerHTML = `<span>${esc(label)}</span><em>${n}</em>`;
      b.addEventListener("click", () => { skillCat = key; renderSkills(); });
      box.appendChild(b);
    };
    add("all", t("catAll"), list.length);
    lib.categories.forEach(c => add(c.key, t("cat_" + c.key), counts[c.key] || 0));
  }

  function renderSkills() {
    if (!lib) return;
    const q = $("skillSearch").value.trim();
    const groups = expand(q);
    const base = lib.skills.filter(s => skillFilter === "all" || (skillFilter === "active" ? s.active : !s.active));
    const scored = base.map(s => ({ s, score: skillScore(s, groups) })).filter(x => x.score > 0);
    renderCats(scored.map(x => x.s));
    const list = scored.filter(x => skillCat === "all" || x.s.category === skillCat)
      .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name)).map(x => x.s);
    $("skillCount").textContent = t("skillCount", list.length, lib.skills.length);

    // Rehber: arama ve kategori yokken "hangi iş → hangi skill" kartları
    const guide = $("skillGuide");
    guide.hidden = !!q || skillCat !== "all" || !lib.guide.length;
    $("loadBox").hidden = !!q || skillCat !== "all";
    if (!guide.hidden) {
      guide.innerHTML = `<h3>${t("guideTitle")}</h3><div class="guide-grid"></div>`;
      const gg = guide.querySelector(".guide-grid");
      lib.guide.forEach((g, i) => {
        const card = document.createElement("div");
        card.className = "guide-card";
        card.style.setProperty("--i", Math.min(i, 20));
        card.innerHTML = `<b>${esc(g.task)}</b><div class="g-skills">${g.skills.map(n => `<button class="g-skill">/${esc(n)}</button>`).join("")}</div>`;
        card.querySelectorAll(".g-skill").forEach((b, j) => b.addEventListener("click", () => showSkill(g.skills[j])));
        gg.appendChild(card);
      });
    }

    const grid = $("skillGrid");
    grid.innerHTML = list.length ? "" : `<p class="muted">${t("noSkill")}</p>`;
    const frag = document.createDocumentFragment();
    list.slice(0, 240).forEach((s, i) => {
      const card = document.createElement("article");
      card.className = "skill" + (s.active ? "" : " pooled");
      card.style.setProperty("--i", Math.min(i, 24));
      card.innerHTML = `<div class="sk-top"><b class="sk-name">/${esc(s.name)}</b><span class="badge">${esc(srcLabel(s))}</span></div>
        <p>${esc(s.summary || s.description || "—")}</p><span class="sk-cat">${esc(t("cat_" + s.category))}</span>`;
      card.addEventListener("click", () => showSkill(s.name));
      frag.appendChild(card);
    });
    grid.appendChild(frag);
  }
  const srcLabel = (s) => s.source === "command" ? t("srcCommand") : s.source === "user" ? t("fActive") : s.source === "pool" ? t("fPool") : s.source.replace("plugin:", "");

  let shownSkill = null;
  function showSkill(name) {
    const s = lib.skills.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!s) { toast(t("skillMissing", name), "warn"); return; }
    shownSkill = s;
    $("skTitle").textContent = "/" + s.name;
    $("skMeta").textContent = `${t("cat_" + s.category)} · ${srcLabel(s)}${s.active ? "" : " · " + t("poolNote")}`;
    $("skDesc").textContent = s.description || "—";
    $("skPath").textContent = s.path;
    $("dlgSkill").showModal();
  }
  $("skCopy").addEventListener("click", async () => {
    if (!shownSkill) return;
    try { await navigator.clipboard.writeText("/" + shownSkill.name); toast(t("copied", "/" + shownSkill.name)); }
    catch { toast(t("err_generic"), "warn"); }
  });
  $("skillSearch").addEventListener("input", () => { skillCat = "all"; renderSkills(); });

  // ---- Görünüm geçişi ----
  function setView(v) {
    view = v;
    document.querySelectorAll("#nav button").forEach(b => b.classList.toggle("active", b.dataset.view === v));
    $("viewSessions").hidden = v !== "sessions";
    $("viewRecent").hidden = v !== "recent";
    $("viewSkills").hidden = v !== "skills";
    $("viewFollow").hidden = v !== "follow";
    $("search").hidden = v === "skills" || v === "follow";
    if (v === "recent") loadRecent();
    if (v === "skills") loadSkills();
    if (v === "follow") F.open();
  }
  document.querySelectorAll("#nav button").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
  document.querySelectorAll("#skillChips button").forEach(b => b.addEventListener("click", () => {
    skillFilter = b.dataset.f;
    document.querySelectorAll("#skillChips button").forEach(x => x.classList.toggle("active", x === b));
    renderSkills();
  }));
  $("search").addEventListener("input", () => { if (view === "sessions") render(); else if (view === "recent") renderRecent(); });
  function clearSearch() { $("search").value = ""; if (view === "sessions") render(); else if (view === "recent") renderRecent(); }
  $("filterClear").addEventListener("click", clearSearch);
  $("search").addEventListener("keydown", (e) => { if (e.key === "Escape" && $("search").value) { e.stopPropagation(); clearSearch(); } });

  // ---- Küçük yardımcılar ----
  function toast(msg, kind = "ok") {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $("toasts").appendChild(el);
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 400); }, 3200);
  }
  function setConn(ok) {
    const c = $("conn");
    c.className = `conn ${ok ? "ok" : "bad"}`;
    c.title = ok ? "" : t("disconnected");
    if (!ok && !c.dataset.warned) { toast(t("disconnected"), "warn"); c.dataset.warned = "1"; }
    if (ok) delete c.dataset.warned;
  }
  let audio;
  function chime() {
    try {
      audio = audio || new AudioContext();
      [660, 880].forEach((f, i) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = f; o.type = "sine";
        const t0 = audio.currentTime + i * 0.16;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
        o.connect(g).connect(audio.destination);
        o.start(t0); o.stop(t0 + 0.4);
      });
    } catch { /* ses kapalı olabilir */ }
  }

  // ---- Yeni oturum ----
  let where = "panel";
  document.querySelectorAll("#fWhere button").forEach(b => b.addEventListener("click", () => {
    where = b.dataset.where;
    document.querySelectorAll("#fWhere button").forEach(x => x.classList.toggle("active", x === b));
  }));
  // Proje seçimi: Claude'un çalıştığı tüm klasörler (en son kullanılan üstte), arama + Gözat.
  let projects = [];
  // Klasör gezgini: yol çubuğu + alt klasörler. Tık = seç, ›/çift tık = içine gir. Son gezilen klasör hatırlanır.
  const dirView = { tab: "recent", path: null, data: null };
  // Aramaya yazıp listeden seçmeden göndermek eski klasörde oturum açıyordu (bir proje yerine önceki projenin klasörü, 18.11.2026).
  let searchPending = false;
  function pickCwd(p) { $("fCwd").value = p; searchPending = false; renderProjects(); }
  // pick: kullanıcı klasörün içine girdiyse (›, çift tık, Enter) o klasör seçilmiş olur.
  async function openDir(path, pick = false) {
    const r = await api("/api/dirs", { path: path || "" });
    if (!r.ok) { if (path) return openDir(""); return; }
    dirView.path = r.data.path; dirView.data = r.data;
    if (pick && r.data.path) { $("fCwd").value = r.data.path; searchPending = false; }
    settings.browseDir = r.data.path; save();
    $("projSearch").value = ""; searchPending = false;
    searchDeep(); // bekleyen alt klasör aramasını iptal eder
    renderProjects();
  }
  // Sık kullanılan kökler: son projelerin ilk iki düzeyi (ör. C:\Projeler), en çok proje içeren üstte.
  function dirRoots() {
    const count = new Map();
    for (const p of projects) {
      const parts = p.cwd.split("\\").filter(Boolean);
      if (parts.length < 3) continue;
      const root = parts.slice(0, 2).join("\\");
      count.set(root, (count.get(root) || 0) + 1);
    }
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(e => e[0]);
  }
  function renderDirs() {
    const d = dirView.data, box = $("projList");
    if (!d) { box.innerHTML = ""; return; }
    const crumbs = $("dirCrumbs");
    crumbs.innerHTML = "";
    const home = document.createElement("button");
    home.type = "button"; home.textContent = t("dirDrives");
    home.addEventListener("click", () => openDir(""));
    crumbs.appendChild(home);
    const parts = d.path ? d.path.split("\\").filter(Boolean) : [];
    parts.forEach((part, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = part;
      const target = parts.slice(0, i + 1).join("\\") + (i === 0 ? "\\" : "");
      b.addEventListener("click", () => openDir(target));
      crumbs.appendChild(b);
    });
    crumbs.scrollLeft = crumbs.scrollWidth;
    $("dirUp").disabled = !d.path;
    $("dirRoots").innerHTML = "";
    for (const root of dirRoots()) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.textContent = root.split("\\").pop(); b.title = root;
      b.addEventListener("click", () => openDir(root));
      $("dirRoots").appendChild(b);
    }
    const q = norm($("projSearch").value.trim());
    const sel = $("fCwd").value.trim().toLowerCase();
    const list = d.dirs.filter(x => !q || norm(x.name).includes(q));
    box.innerHTML = list.length ? "" : `<p class="muted">${t(d.dirs.length ? "noProject" : "dirEmpty")}</p>`;
    // Bulunulan klasörün kendisi de seçilebilir
    if (d.path) {
      const self = document.createElement("button");
      self.type = "button";
      self.className = "dir-row self" + (d.path.toLowerCase() === sel ? " active" : "");
      self.innerHTML = `<span class="ico">✓</span><b>${esc(t("dirThis"))}</b><small>${esc(d.path)}</small>`;
      self.addEventListener("click", () => { pickCwd(d.path); $("fPrompt").focus(); });
      box.appendChild(self);
    }
    list.forEach(x => {
      const row = document.createElement("div");
      row.className = "dir-row" + (x.path.toLowerCase() === sel ? " active" : "");
      row.innerHTML = `<button type="button" class="dir-pick"><span class="ico">📁</span><b>${esc(x.name)}</b>${x.known ? `<em>${esc(t("dirKnown"))}</em>` : ""}</button>` +
        `<button type="button" class="dir-in" title="${esc(t("dirOpen"))}">›</button>`;
      row.querySelector(".dir-pick").addEventListener("click", () => pickCwd(x.path));
      row.querySelector(".dir-pick").addEventListener("dblclick", () => openDir(x.path, true));
      row.querySelector(".dir-in").addEventListener("click", () => openDir(x.path, true));
      box.appendChild(row);
    });
    renderDeepDirs(q, sel, list.length);
  }
  // Alt klasörlerde arama: yazmayı 250 ms bekler; geç gelen eski yanıt yenisini ezmez (sıra numarası).
  let deepSeq = 0, deepTimer = 0;
  function searchDeep() {
    clearTimeout(deepTimer);
    const q = $("projSearch").value.trim(), path = dirView.path;
    const seq = ++deepSeq;
    dirView.deep = q && path ? { q: norm(q), path, loading: true, hits: [] } : null;
    if (!dirView.deep) return;
    deepTimer = setTimeout(async () => {
      const r = await api("/api/dirs/search", { path, q });
      if (seq !== deepSeq) return;
      dirView.deep = { q: norm(q), path, loading: false, hits: r.ok ? r.data.hits : [], truncated: r.ok && r.data.truncated };
      if (dirView.tab === "browse") renderDirs();
    }, 250);
  }
  function renderDeepDirs(q, sel, shallowCount) {
    const box = $("projList"), dp = dirView.deep;
    if (!q || !dp || dp.q !== q || dp.path !== dirView.path) return;
    if (!shallowCount && (dp.loading || dp.hits.length)) box.querySelector(":scope > p.muted")?.remove();
    const head = document.createElement("p");
    head.className = "muted dir-deep-head";
    head.textContent = dp.loading ? t("dirSearching") : dp.hits.length ? t(dp.truncated ? "dirDeepMore" : "dirDeep", dp.hits.length) : "";
    if (head.textContent) box.appendChild(head);
    dp.hits.forEach(x => {
      const row = document.createElement("div");
      row.className = "dir-row deep" + (x.path.toLowerCase() === sel ? " active" : "");
      const parent = x.rel.includes("\\") ? x.rel.slice(0, x.rel.lastIndexOf("\\")) : "";
      row.innerHTML = `<button type="button" class="dir-pick" title="${esc(x.path)}"><span class="ico">📁</span><b>${esc(x.name)}</b>` +
        `<small>${esc(parent)}</small>${x.known ? `<em>${esc(t("dirKnown"))}</em>` : ""}</button>` +
        `<button type="button" class="dir-in" title="${esc(t("dirOpen"))}">›</button>`;
      row.querySelector(".dir-pick").addEventListener("click", () => pickCwd(x.path));
      row.querySelector(".dir-pick").addEventListener("dblclick", () => openDir(x.path, true));
      row.querySelector(".dir-in").addEventListener("click", () => openDir(x.path, true));
      box.appendChild(row);
    });
  }
  function setProjTab(tab) {
    dirView.tab = tab;
    document.querySelectorAll("#projTabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
    $("dirBar").hidden = $("dirRoots").hidden = tab !== "browse";
    $("projSearch").placeholder = t(tab === "browse" ? "dirSearchPh" : "projSearchPh");
    $("projSearch").value = ""; searchPending = false;
    if (tab === "browse" && !dirView.data) {
      const cur = $("fCwd").value.trim();
      const start = settings.browseDir || (cur ? cur.replace(/\\[^\\]+\\?$/, "") : "");
      openDir(start);
    } else renderProjects();
  }
  document.querySelectorAll("#projTabs button").forEach(b => b.addEventListener("click", () => setProjTab(b.dataset.tab)));
  $("dirUp").addEventListener("click", () => openDir(dirView.data?.parent || ""));
  function renderProjects() {
    if (dirView.tab === "browse") { renderDirs(); return; }
    const q = norm($("projSearch").value.trim());
    const sel = $("fCwd").value.trim().toLowerCase();
    const list = projects.filter(p => !q || norm(p.cwd).includes(q));
    const box = $("projList");
    box.innerHTML = list.length ? "" : `<p class="muted">${t("noProject")}</p>`;
    const now = Date.now() + serverOffset;
    list.slice(0, 60).forEach(p => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "proj" + (p.cwd.toLowerCase() === sel ? " active" : "");
      b.innerHTML = `<b>${esc(p.name)}</b><small>${esc(p.cwd)}</small><em>${t("since", dur(now - p.lastUsed))}</em>`;
      b.addEventListener("click", () => { pickCwd(p.cwd); $("fPrompt").focus(); });
      b.addEventListener("dblclick", () => $("fPrompt").focus());
      box.appendChild(b);
    });
  }
  $("btnNew").addEventListener("click", async () => {
    $("newErr").textContent = "";
    $("projSearch").value = "";
    searchPending = false;
    $("dlgNew").showModal();
    try { projects = await getJson("/api/projects"); } catch { projects = []; }
    if (!$("fCwd").value && projects.length) $("fCwd").value = projects[0].cwd;
    dirView.data = null;
    setProjTab(dirView.tab);
    $("projSearch").focus();
  });
  $("projSearch").addEventListener("input", () => { searchPending = !!$("projSearch").value.trim(); if (dirView.tab === "browse") searchDeep(); renderProjects(); });
  $("projSearch").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); const first = $("projList").querySelector(dirView.tab === "browse" ? ".dir-row:not(.self) .dir-in" : ".proj"); if (first) first.click(); }
  });
  $("fCwd").addEventListener("input", () => { searchPending = false; renderProjects(); });
  $("btnBrowse").addEventListener("click", async () => {
    const b = $("btnBrowse");
    if (b.disabled) return;
    b.disabled = true;
    let r;
    try { r = await api("/api/pick-folder"); } finally { b.disabled = false; }
    if (r.ok && r.data?.path) { $("fCwd").value = r.data.path; renderProjects(); $("fPrompt").focus(); }
  });
  $("btnCancel").addEventListener("click", () => $("dlgNew").close());
  let startingNew = false; // istek sürerken ikinci gönderim yok (yanıt gecikince art arda basılıp aynı oturum 5 kez açılmıştı)
  $("formNew").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (startingNew) return;
    if (searchPending) { $("newErr").textContent = t("err_pickFolder", $("fCwd").value.trim()); $("projSearch").focus(); return; }
    const body = { cwd: $("fCwd").value.trim(), name: $("fName").value.trim() || null, prompt: $("fPrompt").value.trim(), model: $("fModel").value || null };
    if (REMOTE) where = "panel"; // telefondan terminal penceresi açılamaz
    startingNew = true;
    $("btnStart").disabled = true;
    $("btnStart").textContent = t("starting");
    let r;
    try { r = await startHosted(body, where === "panel" ? "/api/hosted" : "/api/sessions"); }
    finally { startingNew = false; $("btnStart").disabled = false; $("btnStart").textContent = t("start"); }
    if (!r.ok) { $("newErr").textContent = r.cancelled ? "" : t(`err_${r.data?.error || "generic"}`); return; }
    $("dlgNew").close();
    $("fPrompt").value = ""; $("fName").value = "";
    rememberFolders([body.cwd]);
    const reused = r.data?.sent || r.data?.queued; // mesaj projedeki mevcut oturuma gitti
    if (!reused) toast(t("started_ok"));
    if (r.data?.key) { // panel oturumu (terminal seçilmişken mevcut panel oturumuna gönderme dahil)
      setView("sessions");
      openDrawer(items.find(s => s.key === r.data.key)
        || { id: "h:" + r.data.key, kind: "panel", key: r.data.key, cwd: r.data.worktree || body.cwd, name: body.name || folderName(body.cwd), lane: "busy", status: "busy" });
    }
  });

  // ---- Çekmece olayları ----
  $("dClose").addEventListener("click", closeDrawer);
  $("scrim").addEventListener("click", closeDrawer);
  $("dComposer").addEventListener("submit", (e) => { e.preventDefault(); sendFromDrawer(); });
  // Gönder'e dokunmak yazı alanından odağı almasın: telefonda klavye kapanıp sayfa kaymasın (WhatsApp gibi).
  $("dSend").addEventListener("mousedown", (e) => { if (document.activeElement === $("dInput")) e.preventDefault(); });

  // ---- "/" komut listesi (terminaldeki gibi) ----
  const slash = { items: [], idx: 0, open: false, cacheKey: null, all: [] };
  // Claude Code'un hazır komutları (başsız modda init listesinde de geliyor; ölçüldü 2026-11-16)
  const BUILTIN_DESC = { clear: "Konuşmayı temizle", compact: "Konuşmayı özetleyip sıkıştır", context: "Bağlam kullanımı", init: "CLAUDE.md oluştur", review: "Kod incelemesi" };
  const BUILTIN_SLASH = Object.keys(BUILTIN_DESC);
  async function slashSource() {
    const live = liveOf(drawer.target);
    const key = live?.kind === "panel" ? live.key : "lib";
    if (slash.cacheKey === key && slash.all.length) return slash.all;
    if (!lib) { try { lib = await getJson("/api/skills"); } catch { lib = { skills: [], guide: [], categories: [] }; } }
    const byName = new Map(lib.skills.map(s => [s.name.toLowerCase(), s]));
    let names = null;
    if (live?.kind === "panel") { try { names = await getJson(`/api/hosted/${live.key}/commands`); } catch { /* listesi yok */ } }
    // Oturum listesini ilk mesajdan sonra gönderir; o zamana kadar hazır komutlar + kütüphane.
    // Yedek liste önbelleğe alınmaz, gerçek liste gelince o kullanılır.
    const real = !!(names && names.length);
    const list = real ? names : [...BUILTIN_SLASH, ...lib.skills.filter(s => s.active).map(s => s.name)
      .filter(n => !BUILTIN_SLASH.includes(n.toLowerCase()))];
    slash.all = list.map(n => ({ name: n, desc: BUILTIN_DESC[n] || byName.get(n.toLowerCase())?.summary || "" }));
    slash.cacheKey = real || live?.kind !== "panel" ? key : null;
    return slash.all;
  }
  function slashQuery(el) {
    const before = el.value.slice(0, el.selectionStart);
    const m = before.match(/(^|\s)\/([^\s/]*)$/);
    return m ? m[2].toLowerCase() : null;
  }
  async function slashUpdate() {
    const el = $("dInput"), pop = $("slashPop");
    const q = slashQuery(el);
    if (q === null || el.disabled) { slashClose(); return; }
    const all = await slashSource();
    const starts = all.filter(c => c.name.toLowerCase().startsWith(q));
    const inside = all.filter(c => !c.name.toLowerCase().startsWith(q) && (c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q)));
    slash.items = [...starts, ...inside].slice(0, 9);
    if (!slash.items.length) { slashClose(); return; }
    slash.idx = Math.min(slash.idx, slash.items.length - 1);
    pop.innerHTML = slash.items.map((c, i) =>
      `<div class="sl-item${i === slash.idx ? " active" : ""}" data-i="${i}"><b>/${esc(c.name)}</b><span>${esc(c.desc)}</span></div>`).join("");
    pop.querySelectorAll(".sl-item").forEach(d => d.addEventListener("mousedown", (e) => { e.preventDefault(); slash.idx = +d.dataset.i; slashApply(); }));
    pop.hidden = false;
    slash.open = true;
  }
  function slashClose() { $("slashPop").hidden = true; slash.open = false; slash.idx = 0; }
  function slashApply() {
    const el = $("dInput"), c = slash.items[slash.idx];
    if (!c) return;
    const caret = el.selectionStart, before = el.value.slice(0, caret);
    const start = before.lastIndexOf("/");
    el.value = el.value.slice(0, start) + "/" + c.name + " " + el.value.slice(caret);
    el.selectionStart = el.selectionEnd = start + c.name.length + 2;
    slashClose();
    el.focus();
  }
  $("dInput").addEventListener("input", slashUpdate);
  $("dInput").addEventListener("blur", () => setTimeout(slashClose, 150));
  // Yakalama aşamasında: liste açıkken Enter/Tab/oklar listeye gider, mesaj gönderilmez.
  $("dInput").addEventListener("keydown", (e) => {
    if (!slash.open) return;
    const n = slash.items.length;
    if (e.key === "ArrowDown") { slash.idx = (slash.idx + 1) % n; }
    else if (e.key === "ArrowUp") { slash.idx = (slash.idx - 1 + n) % n; }
    else if (e.key === "Enter" || e.key === "Tab") { slashApply(); }
    else if (e.key === "Escape") { slashClose(); }
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (slash.open) slashUpdate();
  }, true);
  // Masaüstünde Enter gönderir, Shift+Enter yeni satır. Telefonda (dokunmatik) Enter yeni satır, gönder = düğme.
  const TOUCH = matchMedia("(pointer: coarse)");
  const PHONE = matchMedia("(max-width: 640px)");
  $("dInput").addEventListener("keydown", (e) => {
    if (TOUCH.matches) return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendFromDrawer(); }
  });
  // Telefonda metin kutusu yazdıkça 1→5 satır büyür; boşken gönder düğmesi soluk.
  const COMPOSER_MAX_LINES = 5;
  function syncComposer() {
    const el = $("dInput");
    $("dSend").classList.toggle("send-empty", !el.value.trim());
    el.rows = PHONE.matches ? 1 : 2;
    if (!PHONE.matches) { el.style.height = ""; return; }
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 22;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, line * COMPOSER_MAX_LINES + pad) + "px";
  }
  $("dInput").addEventListener("input", syncComposer);
  PHONE.addEventListener("change", syncComposer);
  // Yapıştırma ve 📎 düğmesi: Gezgin/Finder'da kopyalanan dosya → yolu yazılır; panodaki ekran görüntüsü → kaydedilip yolu yazılır.
  const insertAtCursor = (el, text) => {
    const s = el.selectionStart, e2 = el.selectionEnd;
    el.value = el.value.slice(0, s) + text + el.value.slice(e2);
    el.selectionStart = el.selectionEnd = s + text.length;
    el.focus();
    if (el.id === "dInput") syncComposer();
  };
  const quote = (p) => /\s/.test(p) ? `"${p}"` : p;

  // ---- Dikte (0.8.13) ----
  // Ses tarayıcıda ham olarak kaydedilir, 16 kHz tek kanal WAV'a çevrilip panele gönderilir; panel bu bilgisayarda
  // Whisper ile yazıya çevirir (ses dış servise gitmez, her cihazda aynı motor). Model ilk kullanımda bir kez iner.
  const DICT_MAX_MS = 290_000; // sunucu sınırı 5 dk
  const dict = { state: "idle", ctx: null, stream: null, chunks: [], rate: 48000, timer: 0, poll: 0 };
  function setMic(state) {
    dict.state = state;
    const b = $("dMic");
    b.classList.toggle("rec", state === "rec");
    b.classList.toggle("wait", state === "wait");
    b.textContent = state === "rec" ? "⏹" : state === "wait" ? "⏳" : "🎤";
    b.title = t(state === "rec" ? "micStop" : state === "wait" ? "micWorking" : "mic");
  }
  function wavFrom(chunks, inRate) {
    const n = chunks.reduce((a, c) => a + c.length, 0);
    const all = new Float32Array(n);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    const ratio = inRate / 16000, len = Math.floor(n / ratio);
    const buf = new ArrayBuffer(44 + len * 2), v = new DataView(buf);
    const str = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
    v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, len * 2, true);
    for (let i = 0; i < len; i++) {
      // Basit örnek azaltma: her çıkış örneği kendi aralığındaki giriş örneklerinin ortalaması.
      const a = Math.floor(i * ratio), z = Math.min(n, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = a; j < z; j++) sum += all[j];
      const x = Math.max(-1, Math.min(1, sum / Math.max(1, z - a)));
      v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }
  const pct = (s) => s.total ? Math.floor(s.got * 100 / s.total) : 0;
  async function micModelReady() {
    let st;
    try { st = await getJson("/api/dictation"); } catch { toast(t("micError", ""), "warn"); return false; }
    if (st.ready) return true;
    if (st.downloading) { toast(t("micDownloading", pct(st))); return false; }
    if (st.verifying) { toast(t("micVerifying")); return false; }
    const v = await ask(t("micModelTitle"), t(st.invalid ? "micModelBadText" : "micModelText"), [], [{ value: "go", label: t("micModelGo"), cls: "primary" }]);
    if (v !== "go") return false;
    await api("/api/dictation/model");
    toast(t("micDownloading", 0));
    clearInterval(dict.poll);
    dict.poll = setInterval(async () => {
      let s2;
      try { s2 = await getJson("/api/dictation"); } catch { return; }
      if (s2.downloading) { $("dMic").title = t("micDownloading", pct(s2)); return; }
      clearInterval(dict.poll);
      setMic("idle");
      toast(s2.ready ? t("micModelDone") : t("micModelFail", s2.error || ""), s2.ready ? "ok" : "warn");
    }, 2000);
    return false;
  }
  async function micStart() {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) { toast(t("micUnsupported"), "warn"); return; }
    if (!await micModelReady()) return;
    try {
      dict.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch { toast(t("micDenied"), "warn"); return; }
    fetch("/api/dictation/warm", { method: "POST", headers: { "X-Panel-Token": TOKEN } }).catch(() => {});
    dict.ctx = new AudioContext();
    dict.rate = dict.ctx.sampleRate;
    await dict.ctx.audioWorklet.addModule("/assets/mic-worklet.js");
    const src = dict.ctx.createMediaStreamSource(dict.stream);
    const node = new AudioWorkletNode(dict.ctx, "mic-rec");
    const mute = dict.ctx.createGain();
    mute.gain.value = 0; // düğüm işlesin diye çıkışa bağlı ama sessiz
    dict.chunks = [];
    node.port.onmessage = (e) => dict.chunks.push(e.data);
    src.connect(node); node.connect(mute); mute.connect(dict.ctx.destination);
    setMic("rec");
    dict.timer = setTimeout(micStop, DICT_MAX_MS);
  }
  function micRelease() {
    clearTimeout(dict.timer);
    dict.stream?.getTracks().forEach(tr => tr.stop());
    dict.ctx?.close().catch(() => {});
    dict.stream = dict.ctx = null;
  }
  async function micStop() {
    if (dict.state !== "rec") return;
    const chunks = dict.chunks, rate = dict.rate;
    micRelease();
    const samples = chunks.reduce((a, c) => a + c.length, 0);
    if (samples < rate * 0.5) { setMic("idle"); return; } // yarım saniyeden kısa: yanlışlıkla basılmış
    setMic("wait");
    try {
      const res = await fetch(`/api/dictation?lang=${settings.lang === "en" ? "en" : "tr"}`, {
        method: "POST", headers: { "X-Panel-Token": TOKEN, "Content-Type": "audio/wav" }, body: wavFrom(chunks, rate)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast(t(data.error === "model" ? "micModelFail" : "micError", ""), "warn"); return; }
      const el = $("dInput"), text = (data.text || "").trim();
      if (!text) { toast(t("micEmpty"), "warn"); return; }
      const before = el.value.slice(0, el.selectionStart ?? el.value.length);
      insertAtCursor(el, (before && !/\s$/.test(before) ? " " : "") + text);
    } catch { toast(t("micError", ""), "warn"); }
    finally { setMic("idle"); }
  }
  $("dMic").addEventListener("click", () => {
    if (dict.state === "rec") micStop();
    else if (dict.state === "idle") micStart().catch(() => { micRelease(); setMic("idle"); toast(t("micError", ""), "warn"); });
  });
  async function pastePaths(el) {
    const r = await api("/api/clipboard-paths");
    const paths = r.data?.paths || [];
    if (paths.length) {
      insertAtCursor(el, paths.map(quote).join(" ") + " ");
      if (r.data?.image) toast(t("imageSaved"));
      return true;
    }
    return false;
  }
  $("dInput").addEventListener("paste", async (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const img = items.find(i => i.kind === "file" && i.type.startsWith("image/"));
    const text = e.clipboardData?.getData("text");
    if (img && !text) {
      e.preventDefault();
      const file = img.getAsFile();
      const res = await fetch("/api/paste-image", { method: "POST", headers: { "X-Panel-Token": TOKEN, "Content-Type": file.type }, body: file });
      if (res.ok) { const d = await res.json(); insertAtCursor($("dInput"), quote(d.path) + " "); toast(t("imageSaved")); }
      else toast(t("err_generic"), "warn");
      return;
    }
    if (!text) { e.preventDefault(); if (!(await pastePaths($("dInput")))) toast(t("nothingToPaste"), "warn"); }
  });
  // 📎: dosya seçici (masaüstü ve telefon). Seçilen dosyalar panel veri klasörüne (pastes) özgün adıyla kopyalanır,
  // yolları mesaja eklenir; Claude dosyayı yoldan okur. Panodaki yol/resim yapıştırma Ctrl+V ile sürer.
  const MAX_UPLOAD = 20_000_000; // sunucudaki /api/paste-image sınırıyla aynı
  async function uploadFile(file) {
    if (file.size > MAX_UPLOAD) { toast(t("fileTooBig", file.name), "warn"); return null; }
    const res = await fetch(`/api/paste-image?name=${encodeURIComponent(file.name)}`, { method: "POST",
      headers: { "X-Panel-Token": TOKEN, "Content-Type": file.type || "application/octet-stream" }, body: file });
    if (!res.ok) { toast(t("err_generic"), "warn"); return null; }
    return (await res.json()).path;
  }
  $("dFile").addEventListener("change", async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    const paths = [];
    for (const f of files) { const p = await uploadFile(f); if (p) paths.push(p); }
    if (!paths.length) return;
    insertAtCursor($("dInput"), paths.map(quote).join(" ") + " ");
    toast(t("filesAttached", paths.length));
  });
  $("dPastePath").addEventListener("click", () => $("dFile").click());
  $("fPrompt").addEventListener("paste", async (e) => {
    if (!e.clipboardData?.getData("text")) { e.preventDefault(); await pastePaths($("fPrompt")); }
  });

  // ---- Gece modu ----
  let night = null; // sunucudaki ayar + olaylar (/api/night)
  function renderNightPill(n) {
    const pill = $("nightPill");
    pill.hidden = !n?.enabled;
    if (!n?.enabled) return;
    pill.textContent = n.active ? (n.waiting ? t("nightWaitingPill") : t("nightActivePill")) : t("nightOnPill");
    pill.dataset.state = n.active ? (n.waiting ? "wait" : "active") : "on";
    pill.title = n.waiting || "";
  }
  function fillNight() {
    if (!night) return;
    $("nEnabled").checked = night.settings.enabled;
    $("nStart").value = night.settings.start; $("nEnd").value = night.settings.end;
    $("nAutostart").checked = night.autostart;
    $("nAutoRow").hidden = !night.autostartSupported;
    $("nWaiting").hidden = !night.waiting; $("nWaiting").textContent = night.waiting || "";
  }
  async function loadNight() {
    try { night = await getJson("/api/night"); fillNight(); } catch { /* panel kapanıyor olabilir */ }
  }
  async function saveNight(autostart) {
    if (!night) return;
    const s = { ...night.settings, enabled: $("nEnabled").checked, start: $("nStart").value, end: $("nEnd").value };
    if (!s.start || !s.end) return;
    const r = await api("/api/night", { settings: s, autostart });
    if (r.ok) { night = r.data; fillNight(); toast(t(s.enabled ? "nightSaved" : "nightOff")); }
    else toast(t("nightSaveFail"), "warn");
  }
  // Gece modu açılınca Windows açılışında başlatma da açılır; kapatılması ayrı kutudan.
  $("nEnabled").addEventListener("change", (e) => saveNight(e.target.checked && night?.autostartSupported ? true : undefined));
  $("nStart").addEventListener("change", () => saveNight());
  $("nEnd").addEventListener("change", () => saveNight());
  $("nAutostart").addEventListener("change", (e) => saveNight(e.target.checked));
  const NIGHT_KIND = { start: "evStart", end: "evEnd", nudge: "evNudge", decision: "evDecision", done: "evDone", limit: "evLimit", quota: "evQuota" };
  $("btnNightLog").addEventListener("click", async () => {
    await loadNight();
    const box = $("nightLog");
    box.innerHTML = "";
    const evs = night?.events || [];
    if (!evs.length) box.innerHTML = `<p class="hint wide">${esc(t("nLogEmpty"))}</p>`;
    for (const ev of evs) {
      const row = document.createElement("div");
      row.className = "night-ev";
      row.dataset.kind = ev.kind;
      const when = new Date(ev.at).toLocaleString(settings.lang, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      row.innerHTML = `<div class="ev-top"><span class="ev-time">${esc(when)}</span><b class="ev-kind">${esc(t(NIGHT_KIND[ev.kind] || ev.kind))}</b><span class="ev-name">${esc(ev.name || "")}</span></div>
        ${ev.cwd ? `<div class="ev-cwd">${esc(ev.cwd)}</div>` : ""}<div class="ev-text">${esc(ev.text || "")}</div>`;
      box.appendChild(row);
    }
    $("dlgNight").showModal();
  });

  // ---- Ayarlar ----
  $("btnSettings").addEventListener("click", () => {
    $("sNotify").checked = settings.notify; $("sSound").checked = settings.sound;
    $("sLight").checked = settings.light; $("sLang").value = settings.lang;
    fillNight(); loadNight(); loadRemote(); loadTermQuota();
    $("dlgSettings").showModal();
  });

  // ---- Terminal oturumlarında kota (durum satırı + kota koruması, ~/.claude/settings.json) ----
  function fillTermQuota(st, error) {
    $("tqEnabled").checked = !!st?.enabled;
    $("tqEnabled").disabled = !st?.available;
    const lines = [st?.enabled ? t("tqOn") : t("tqOff")];
    if (st?.ownGuard) lines.push(t("tqOwnGuard"));
    const err = error || st?.error;
    if (err) lines.push(t("tqErr_" + err));
    $("tqState").textContent = lines.join(" ");
  }
  async function loadTermQuota() {
    try { fillTermQuota(await getJson("/api/terminal-quota")); } catch { $("tqBox").hidden = true; }
  }
  $("tqEnabled").addEventListener("change", async (e) => {
    const on = e.target.checked;
    if (on) {
      let st = null;
      try { st = await getJson("/api/terminal-quota"); } catch { /* aşağıda sunucu hatası gösterilir */ }
      if (st?.currentStatusLine && !await confirmBox({ title: t("tqReplaceTitle"), text: t("tqReplace"), list: [st.currentStatusLine], okText: t("tqReplaceGo") })) { e.target.checked = false; return; }
    }
    const r = await api("/api/terminal-quota", { enabled: on, lang: settings.lang });
    if (r.ok) fillTermQuota(r.data);
    else { e.target.checked = !on; fillTermQuota(null, r.data?.error || "write"); loadTermQuota(); }
  });

  // ---- Telefondan erişim (yönetim yalnız bilgisayardan) ----
  let pairTimer = null, pairDevices = 0;
  async function loadRemote() {
    if (REMOTE) return loadRemoteView();
    try { renderRemote(await getJson("/api/remote")); } catch { /* eski sunucu */ }
  }
  // Telefonda: durum ve eşleşmiş cihazlar, yalnız okuma.
  async function loadRemoteView() {
    let st;
    try { st = await getJson("/api/remote/view"); } catch { return; }
    $("rmState").textContent = st.enabled && st.host ? t("rAddr", "https://" + st.host) : t("rOffShort");
    const ul = $("rmDevices");
    ul.innerHTML = "";
    const now = Date.now() + serverOffset;
    st.devices.forEach(d => {
      const li = document.createElement("li");
      const note = d.current ? t("rThisDevice") : t("rLastSeen", dur(now - d.lastSeen));
      li.innerHTML = `<span><b>${esc(d.name)}</b><small>${esc(note)}</small></span>`;
      if (d.current) li.classList.add("current");
      ul.appendChild(li);
    });
  }
  function stopPairing(cancel) {
    clearInterval(pairTimer); pairTimer = null;
    if (cancel && !$("rPair").hidden) api("/api/remote/pair/cancel");
    $("rPair").hidden = true; $("rQr").innerHTML = "";
  }
  // Kurulum adımları: her biri tamam (✓) ya da yapılacak işin düğmesiyle.
  function renderSteps(st) {
    const ol = $("rSteps");
    ol.innerHTML = "";
    const step = (done, text, btnLabel, fn, extra) => {
      const li = document.createElement("li");
      li.className = done ? "done" : "todo";
      li.innerHTML = `<span class="mark">${done ? "✓" : "•"}</span><span class="txt"></span>`;
      li.querySelector(".txt").textContent = text;
      if (!done && btnLabel) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "btn small primary"; b.textContent = btnLabel;
        b.addEventListener("click", async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } });
        li.appendChild(b);
      }
      if (extra) li.appendChild(extra);
      ol.appendChild(li);
    };
    const open = (url) => window.open(url, "_blank", "noopener");
    step(st.tailscale, t(st.tailscale ? "rS1ok" : "rS1"), t("rInstall"), async () => {
      const r = await api("/api/remote/install");
      if (r.data?.url) open(r.data.url);
      toast(t(r.data?.started ? "rInstallStarted" : "rInstallManual"));
    });
    step(!!st.host, st.host ? t("rS2ok", st.host) : t("rS2"), st.tailscale ? t("rLogin") : null, async () => {
      const r = await api("/api/remote/login");
      if (r.data?.url) open(r.data.url); else toast(t("rLoginApp"), "warn");
    });
    step(st.enabled, t(st.enabled ? "rS3ok" : "rS3"));
    const qr = document.createElement("details");
    qr.className = "app-qr";
    qr.innerHTML = `<summary></summary><div class="qr"></div>`;
    qr.querySelector("summary").textContent = t("rAppQr");
    qr.querySelector(".qr").innerHTML = st.appQr || ""; // sunucunun ürettiği SVG (sabit adres)
    step(false, t("rS4"), null, null, qr);
    step(st.devices.length > 0, st.devices.length ? t("rS5ok", st.devices.length) : t("rS5"));
  }
  function renderRemote(st) {
    renderSteps(st);
    $("rEnabled").checked = st.enabled;
    $("rEnabled").disabled = !st.tailscale;
    $("rState").textContent = !st.tailscale ? t("rNoTs") : !st.host ? t("rTsOff")
      : st.enabled ? t("rAddr", "https://" + st.host) : t("rOff");
    $("btnPair").hidden = !st.enabled || !st.host;
    const ul = $("rDevices");
    ul.innerHTML = "";
    const now = Date.now() + serverOffset;
    st.devices.forEach(d => {
      const li = document.createElement("li");
      li.innerHTML = `<span><b>${esc(d.name)}</b><small>${esc(t("rLastSeen", dur(now - d.lastSeen)))}</small></span>`;
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn small danger"; b.textContent = t("rRemove");
      b.addEventListener("click", async () => {
        if (!await confirmBox({ title: t("rRemoveTitle", d.name), text: t("rRemoveConfirm"), okText: t("rRemove"), danger: true })) return;
        const r = await api(`/api/remote/revoke/${encodeURIComponent(d.id)}`);
        if (r.ok) renderRemote(r.data);
      });
      li.appendChild(b);
      ul.appendChild(li);
    });
    if (pairTimer && st.devices.length > pairDevices) { stopPairing(false); toast(t("rPaired")); }
  }
  $("rEnabled").addEventListener("change", async (e) => {
    const on = e.target.checked;
    e.target.disabled = true;
    const r = await api("/api/remote/enable", { enabled: on });
    e.target.disabled = false;
    if (!r.ok) { toast(t("err_generic"), "warn"); return loadRemote(); }
    if (!on) stopPairing(false);
    renderRemote(r.data.status);
    if (on && r.data.enableUrl) {
      // Tailscale hesabında HTTPS/Serve kapalı: bir kez açılması gerekiyor, sonra kutu yeniden işaretlenir.
      $("rState").textContent = t("rNeedEnable") + " ";
      const a = document.createElement("a");
      a.href = r.data.enableUrl; a.target = "_blank"; a.rel = "noopener"; a.textContent = t("rEnableLink");
      $("rState").appendChild(a);
      $("rEnabled").checked = false;
      $("btnPair").hidden = true;
      await api("/api/remote/enable", { enabled: false });
    } else if (on && !r.data.serveOk) toast(t("rServeFail", r.data.serveMessage || ""), "warn");
  });
  $("btnPair").addEventListener("click", async () => {
    const r = await api("/api/remote/pair");
    if (!r.ok) { toast(t(r.data?.error === "nohost" ? "rTsOff" : "err_generic"), "warn"); return; }
    const st = await getJson("/api/remote").catch(() => null);
    pairDevices = st ? st.devices.length : 0;
    $("rQr").innerHTML = r.data.qr; // sunucunun ürettiği SVG (kullanıcı verisi içermez)
    $("rCode").textContent = r.data.code.slice(0, 3) + " " + r.data.code.slice(3);
    $("rPair").hidden = false;
    clearInterval(pairTimer);
    const tickPair = async () => {
      const left = r.data.expires - Date.now();
      if (left <= 0) { stopPairing(false); toast(t("rExpired"), "warn"); return; }
      $("rExpire").textContent = t("rExpire", Math.ceil(left / 1000));
      if (Math.floor(left / 1000) % 3 === 0) loadRemote();
    };
    pairTimer = setInterval(tickPair, 1000);
    tickPair();
  });
  // Ayarlar açıkken kurulum adımları 3 sn'de bir yenilenir (Tailscale kurulunca/giriş yapılınca kendiliğinden ✓).
  let remotePoll = null;
  $("btnSettings").addEventListener("click", () => { clearInterval(remotePoll); remotePoll = setInterval(() => { if (!pairTimer) loadRemote(); }, REMOTE ? 15000 : 3000); });
  $("dlgSettings").addEventListener("close", () => { clearInterval(remotePoll); if (pairTimer) stopPairing(true); });
  document.querySelectorAll("[data-help=phone]").forEach(b => b.addEventListener("click", () => {
    $("phoneGuide").innerHTML = t("phoneGuide"); // sabit, kendi metnimiz (kullanıcı verisi yok)
    $("dlgPhoneHelp").showModal();
  }));
  // Uygulama olarak yükle: Chrome/Edge yükleme olayını verirse kendi penceresi açılır; vermezse (iOS Safari,
  // olay henüz gelmedi) menü yolu yazılır. Uygulama olarak açıksa düğme gizlenir.
  let installEvent = null;
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  function syncInstall() {
    const on = standalone();
    $("btnInstall").hidden = on;
    $("installHint").hidden = !on;
    if (on) $("installHint").textContent = t("rInstalled");
  }
  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; });
  addEventListener("appinstalled", () => { installEvent = null; syncInstall(); });
  $("btnInstall").addEventListener("click", async () => {
    if (installEvent) {
      installEvent.prompt();
      await installEvent.userChoice;
      installEvent = null;
      return;
    }
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    $("installHint").textContent = t(ios ? "rInstallIos" : "rInstallOther");
    $("installHint").hidden = false;
  });
  syncInstall();
  $("btnForget").addEventListener("click", async () => {
    if (!await confirmBox({ title: t("rForgetTitle"), text: t("rForgetConfirm"), okText: t("rForget"), danger: true })) return;
    await api("/api/remote/forget");
    location.replace("/pair");
  });
  $("sNotify").addEventListener("change", async (e) => {
    settings.notify = e.target.checked; save();
    if (settings.notify && "Notification" in window && Notification.permission === "default") await Notification.requestPermission();
  });
  $("sSound").addEventListener("change", (e) => { settings.sound = e.target.checked; save(); if (settings.sound) chime(); });
  $("sLight").addEventListener("change", (e) => { settings.light = e.target.checked; save(); applyTheme(); });
  $("sLang").addEventListener("change", async (e) => {
    settings.lang = e.target.value; save(); applyI18n(); render(); F.render(); R.paintSettings(); L.render();
    if ($("tqEnabled").checked) { const r = await api("/api/terminal-quota", { enabled: true, lang: settings.lang }); if (r.ok) fillTermQuota(r.data); }
  });
  $("btnBulk").addEventListener("click", (e) => { e.stopPropagation(); A.laneMenu(e.currentTarget); });
  $("bulkBar").querySelectorAll("button[data-bulk]").forEach(b => b.addEventListener("click", () => A.bulk(b.dataset.bulk)));
  $("bulkCancel").addEventListener("click", () => A.setSelecting(false));
  $("bulkAll").addEventListener("click", () => A.allSelected() ? A.deselectAll() : A.selectAll());
  $("dTaskCancel").addEventListener("click", () => drawer.target && A.cancelTask(liveOf(drawer.target)));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && A.selecting() && !document.querySelector("dialog[open]")) A.setSelecting(false); });
  $("btnResumeAll").addEventListener("click", resumeAllIdle);
  $("btnRecentOpen").addEventListener("click", openPicked);
  $("btnRecentClear").addEventListener("click", () => { picked.clear(); renderRecent(); });
  $("btnResetTabs").addEventListener("click", () => { settings.tabMap = {}; settings.tabIds = {}; save(); render(); toast(t("tabsReset")); });
  $("btnQuit").addEventListener("click", async () => {
    if (items.some(s => s.kind === "panel") && !await confirmBox({ title: t("quitTitle"), text: t("quitWarn"), okText: t("quit"), danger: true })) return;
    let r = await api("/api/quit");
    if (r.status === 409) {
      // Çalışan oturum ve/veya "boşta" oturumda süren arka plan işi: uyarı + "Yine de kapat" (bekle seçeneği yok).
      const list = [...(r.data?.sessions || []), ...B.lines(r.data?.background)];
      const bgOnly = !(r.data?.sessions || []).length;
      if (!await confirmBox({ title: t(bgOnly ? "quitBgTitle" : "quitBusyTitle"), text: t(bgOnly ? "quitBg" : "quitBusy"), list, okText: t("quitBusyGo"), danger: true })) return;
      r = await api("/api/quit?force=1");
    }
    if (!r.ok) return;
    panelQuit = true;
    window.close();
    // Tarayıcı kapatmayı reddederse (sunucu pencereyi de kapatır; o da olmazsa) sayfa canlı görünmesin.
    setTimeout(() => { document.body.replaceChildren(Object.assign(document.createElement("p"), { className: "quit-done", textContent: t("quitDone") })); }, 1500);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("drawer-open") && !document.querySelector("dialog[open]")) { closeDrawer(); return; }
    if (document.querySelector("dialog[open]") || e.target.matches("input, textarea, select")) return;
    if (e.key === "n" || e.key === "N") { e.preventDefault(); $("btnNew").click(); }
    if (e.key === "/") { e.preventDefault(); $("search").focus(); }
  });

  getJson("/api/version").then(v => { $("ver").textContent = "v" + v.version; }).catch(() => {});
  applyTheme();
  applyI18n();
  if (settings.notify && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
  poll();
  K.load();
  F.load(false); // sekme rozeti için

  // Adresten açılış: ?view=recent|skills|follow, ?open=<oturum kimliği>
  const qs = new URLSearchParams(location.search);
  if (["recent", "skills", "follow"].includes(qs.get("view"))) setView(qs.get("view"));
  const openId = qs.get("open");
  if (openId && /^[0-9a-f-]{36}$/i.test(openId)) {
    getJson("/api/recent").then(list => {
      const r = list.find(x => x.sessionId === openId);
      if (r) openDrawer({ id: "r:" + r.sessionId, kind: "closed", sessionId: r.sessionId, cwd: r.cwd, name: r.title, title: r.title });
    }).catch(() => { /* bulunamadı */ });
  }
})();
