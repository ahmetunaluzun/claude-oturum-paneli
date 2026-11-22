// Codex oturumları, salt okuma (issue #1 madde 8; sunucu CodexEndpoints.cs): Oturumlar'da Codex şeridi (açık ve çalışan
// oturumlar), Son oturumlar'da Codex satırları, okuma görünümü (çekmece), üst çubukta Codex kotası.
// Codex kurulu değilse (installed:false) hiçbir öğe görünmez. Panel Codex'e yazmaz, mesaj göndermez, oturumu panele almaz.
// Sayaçlar: üstteki "N oturum · N bekliyor · N çalışıyor" ve sekme sayısı yalnız Claude'u sayar; Codex şeridinin kendi sayısı var.
window.PanelCodex = function (d) {
  "use strict";
  const { t, api, getJson, toast, ask, esc, dur, REMOTE, now, openDrawer, matches, query, modelChip, lang, onRecentChange } = d;
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 5000;
  const folderName = (p) => (p || "").split(/[\\/]/).filter(Boolean).pop() || p || "";
  let data = { installed: false, sessions: [], quota: null };
  let recentSig = "";

  async function poll() {
    try {
      data = await getJson("/api/codex");
      data.sessions ||= [];
      render();
      const sig = data.sessions.map(s => [s.id, s.state, s.updated, s.title].join(":")).join("|");
      if (sig !== recentSig) { recentSig = sig; onRecentChange(); }
    } catch { /* bağlantı kopukluğunu app.js gösterir; son bilinen durum kalır */ }
    finally { setTimeout(poll, POLL_MS); }
  }

  const byId = (id) => data.sessions.find(s => s.id === id) || null;
  const live = () => data.installed ? data.sessions.filter(s => s.state !== "ended") : [];
  const stateText = (s) => t(s.state === "working" ? "codexWorking" : s.state === "open" ? "codexOpen" : "codexEnded");
  const laneOf = (s) => s?.state === "working" ? "busy" : s?.state === "open" ? "idle" : "closed";

  function open(s) {
    openDrawer({ id: "codex:" + s.id, kind: "codex", codexId: s.id, cwd: s.cwd, name: folderName(s.cwd), title: s.title });
  }

  async function openFolder(s) {
    const r = await api("/api/codex/open-folder", { id: s.id });
    if (!r.ok) toast(t(r.status === 404 ? "codexNoFolder" : `err_${r.data?.error || "generic"}`), "warn");
  }

  async function copyResume(s) {
    const cmd = s.resume;
    if (!cmd) return;
    try { await navigator.clipboard.writeText(cmd); toast(t("codexCopied", cmd)); }
    catch { await ask(t("codexCopyTitle"), t("codexCopyText"), [cmd], [{ value: "ok", label: t("ok"), cls: "primary" }]); }
  }

  const button = (label, run, cls = "btn small") => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    b.addEventListener("click", (e) => { e.stopPropagation(); run(); });
    return b;
  };
  // Eylemler (kart ve çekmece aynı küme): Konuşma (yalnız kartta), Klasörü aç (bilgisayardan), devam komutu (yalnız kapalı oturumda).
  function actions(box, s, inDrawer) {
    const L = [];
    if (!inDrawer) L.push(button(t("openConv"), () => open(s)));
    if (!REMOTE) L.push(button(t("codexOpenFolder"), () => openFolder(s)));
    if (s.resume) L.push(button(t("codexCopyResume"), () => copyResume(s), inDrawer ? "btn small" : "btn small primary"));
    else if (!inDrawer) {
      const note = document.createElement("small");
      note.className = "codex-note";
      note.textContent = t("codexLiveNote");
      L.push(note);
    }
    box.replaceChildren(...L);
  }

  // ---- Oturumlar: Codex şeridi ----
  function buildCard() {
    const el = document.createElement("article");
    el.className = "card codex-card";
    el.tabIndex = 0;
    el.innerHTML = `
      <div class="card-top"><span class="status-dot"></span><h3 class="name"></h3><span class="model-slot"></span><span class="badge codex-badge"></span></div>
      <p class="path"></p>
      <div class="meta"><span class="codex-state"></span><span class="codex-age"></span></div>
      <p class="codex-ask" hidden></p>
      <p class="last" hidden></p>
      <div class="card-actions"></div>`;
    const cur = () => byId(el.dataset.codexId);
    el.addEventListener("click", (e) => { if (!e.target.closest("button") && cur()) open(cur()); });
    el.addEventListener("keydown", (e) => { if (e.target === el && e.key === "Enter" && cur()) open(cur()); });
    return el;
  }

  function updateCard(card, s, at) {
    card.dataset.lane = laneOf(s);
    card.querySelector(".name").textContent = folderName(s.cwd) || s.id;
    card.querySelector(".path").textContent = card.querySelector(".path").title = s.cwd;
    card.querySelector(".codex-badge").textContent = t("codexBadge");
    card.querySelector(".codex-state").textContent = stateText(s);
    card.querySelector(".codex-age").textContent = t("codexLastWrite", dur(at - s.updated));
    const ask_ = card.querySelector(".codex-ask");
    ask_.hidden = !s.title;
    ask_.textContent = s.title || "";
    const last = card.querySelector(".last");
    const text = s.state === "open" ? (s.lastAssistant || "") : "";
    last.hidden = !text;
    last.textContent = text.replace(/[*_`#>]/g, "").split("\n").filter(x => x.trim()).slice(-3).join("\n");
    const slot = card.querySelector(".model-slot");
    if (slot.dataset.model !== (s.model || "")) {
      slot.dataset.model = s.model || "";
      slot.replaceChildren(...[modelChip(s.model)].filter(Boolean));
    }
    const box = card.querySelector(".card-actions"), sig = [s.state, s.resume, lang()].join("|");
    if (box.dataset.sig !== sig) { box.dataset.sig = sig; actions(box, s, false); }
  }

  function renderLane() {
    const lane = $("codexLane"), q = query();
    const list = live().filter(s => matches(q, s.cwd, s.title))
      .sort((a, b) => (a.state === "working" ? 0 : 1) - (b.state === "working" ? 0 : 1) || b.updated - a.updated);
    lane.hidden = list.length === 0;
    $("countCodex").textContent = list.length;
    const box = $("cardsCodex"), at = now();
    const existing = new Map([...box.children].map(c => [c.dataset.codexId, c]));
    list.forEach((s, i) => {
      const card = existing.get(s.id) || buildCard();
      card.dataset.codexId = s.id;
      updateCard(card, s, at);
      if (box.children[i] !== card) box.insertBefore(card, box.children[i] || null);
      existing.delete(s.id);
    });
    for (const [, el] of existing) el.remove();
  }

  // ---- Üst çubuk: Codex kotası ----
  const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : "";
  function windowName(min) {
    if (min === 300) return t("fiveHour");
    if (min === 10080) return t("week");
    if (min === 43200) return t("codexWin30");
    if (min > 0 && min % 1440 === 0) return t("codexDays", min / 1440);
    return min > 0 ? t("codexHours", Math.round(min / 60)) : "";
  }
  function renderQuota() {
    const box = $("codexQuota"), q = data.installed ? data.quota : null, w = q?.primary;
    if (!w) { box.hidden = true; box.replaceChildren(); box.dataset.sig = ""; return; }
    const at = now(), past = (x) => !!x?.resetsAt && x.resetsAt <= at;
    const name = t("codexQuotaName", cap(q.plan)).trim(), win = windowName(w.windowMinutes);
    const left = Math.max(0, Math.min(100, 100 - (w.usedPercent || 0)));
    const sec = q.secondary;
    const when = w.resetsAt ? new Date(w.resetsAt).toLocaleString(lang(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
    const sig = [lang(), name, win, left, past(w), when, sec?.usedPercent, past(sec), Math.floor((at - q.at) / 60_000)].join("|");
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.hidden = false;
    // Yenilenme anı geçtiyse eski yüzde gösterilmez (bayat değer): yeni değer Codex'in bir sonraki isteğinde gelir.
    const level = past(w) ? "codex-reset" : left < 15 ? "crit" : left < 40 ? "warn" : "ok";
    const secLine = sec ? `<small class="codex-q-sec">${esc(past(sec) ? t("codexQuotaSecReset", windowName(sec.windowMinutes))
      : t("codexQuotaSec", windowName(sec.windowMinutes), Math.round(Math.max(0, 100 - (sec.usedPercent || 0)))))}</small>` : "";
    box.innerHTML = `<div class="ring codex-ring ${level}"><svg viewBox="0 0 36 36"><circle class="bgc" cx="18" cy="18" r="15.9"/><circle class="fg" cx="18" cy="18" r="15.9" pathLength="100"/></svg>
      <div><b>${esc(past(w) ? t("codexQuotaReset") : t("codexQuotaLeft", Math.round(left)))}</b><small class="codex-q-name">${esc(name)}${win ? " · " + esc(win) : ""}</small>
      ${!past(w) && when ? `<small class="codex-q-reset">${esc(t("resetAt", when))}</small>` : ""}${secLine}</div></div>`;
    box.querySelector(".fg").style.strokeDasharray = `${past(w) ? 0 : left} 100`;
    box.title = past(w) ? t("codexQuotaResetHint") : t("codexQuotaHint", name, Math.round(w.usedPercent || 0), win, dur(at - q.at));
  }

  function render() { renderLane(); renderQuota(); }

  // ---- Son oturumlar ----
  const recent = () => data.installed ? data.sessions.map(s => ({ codex: true, id: s.id, sessionId: "codex:" + s.id,
    title: s.title || t("codexNoTitle"), cwd: s.cwd, updatedAt: s.updated, state: s.state })) : [];
  function recentRow(r, i) {
    const item = document.createElement("div");
    item.className = "recent-item codex-recent";
    item.style.setProperty("--i", Math.min(i, 20));
    const ph = document.createElement("span"); // seçim kutusunun yeri (Codex oturumu panelde açılmaz, seçilemez)
    ph.className = "r-pick codex-nopick";
    const row = document.createElement("button");
    row.className = "recent-row";
    const isLive = r.state !== "ended", s = byId(r.id);
    row.innerHTML = `<span class="r-dot ${isLive ? "live" : ""}"></span>
      <span class="r-main"><b>${esc(r.title)}</b><small>${esc(r.cwd)}</small></span>
      <span class="r-side"><span class="badge codex-badge">${esc(t("codexBadge"))}</span>${isLive ? `<em>${esc(stateText(r))}</em>` : ""}<small>${t("since", dur(now() - r.updatedAt))}</small></span>`;
    row.addEventListener("click", () => open(s || { id: r.id, cwd: r.cwd, title: r.title }));
    item.append(ph, row);
    return item;
  }

  // ---- Çekmece (okuma görünümü) ----
  function drawerHeader(tg) {
    const s = byId(tg.codexId);
    $("dTitle").textContent = tg.title || s?.title || tg.name || t("codexNoTitle");
    $("dPath").textContent = tg.cwd || "";
    $("dDot").dataset.lane = laneOf(s);
    $("dMeta").textContent = s ? [stateText(s), t("codexLastWrite", dur(now() - s.updated)), s.cliVersion ? "codex-cli " + s.cliVersion : ""]
      .filter(Boolean).join(" · ") : "";
    const sigM = "codex|" + (s?.model || "") + "|" + lang();
    if ($("dModel").dataset.model !== sigM) {
      $("dModel").dataset.model = sigM;
      const b = document.createElement("span");
      b.className = "badge codex-badge";
      b.textContent = t("codexBadge");
      $("dModel").replaceChildren(b, ...[modelChip(s?.model)].filter(Boolean));
    }
    const box = $("dActions"), sig = ["codex", tg.codexId, s?.state, s?.resume, lang()].join("|");
    if (box.dataset.sig !== sig) { box.dataset.sig = sig; if (s) actions(box, s, true); else box.replaceChildren(); }
    $("dTask").hidden = true;
    $("dInput").disabled = $("dSend").disabled = true;
    $("dSend").textContent = $("dSend").title = t("send");
    $("dSend").setAttribute("aria-label", t("send"));
    $("dNote").textContent = t(s && s.state !== "ended" ? "codexNoteLive" : "codexNoteEnded");
    $("dNote").hidden = false;
  }
  const transcriptUrl = (tg) => `/api/codex/transcript/${encodeURIComponent(tg.codexId)}?limit=250`;

  poll();
  return { render, liveCount: () => live().length, recent, recentRow, drawerHeader, transcriptUrl };
};
