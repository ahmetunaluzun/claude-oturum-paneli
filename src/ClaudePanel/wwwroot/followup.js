// Takip sekmesi: günlük takip edilecekler. Her kaynak ayrı bölümdür (SECTIONS); yeni kaynak (takvim, mail) eklemek için
// bölüm tanımı + çizim işlevi yazılır. Bu aşamadaki kaynaklar kota harcamaz: git durumu, NEXT_SESSION.md, karar bekleyen
// oturumlar, güncellemeler. Veri /api/followup'tan (sunucuda önbellekli), karar bekleyenler oturum listesinden gelir.
window.PanelFollowUp = function (d) {
  "use strict";
  const { t, api, getJson, toast, esc, dur, openDrawer, items, setView, now, isOpen } = d;
  const $ = (id) => document.getElementById(id);
  const SCAN_POLL_MS = 1500, OPEN_POLL_MS = 60_000, BACKGROUND_POLL_MS = 300_000, REOPEN_FRESH_MS = 30_000;
  const STALE_PLAN_MS = 3 * 86_400_000;
  let snap = null, timer = null, decisionSig = "";
  const started = new Set(); // bu sayfada oturum başlatılan satırlar: aynı işe ikinci oturum açılmasın

  const decisions = () => items().filter(s => s.night === "decision");
  const SECTIONS = [
    { id: "git", title: "fuGit", count: () => snap.git.repos.length, draw: drawGit },
    { id: "next", title: "fuNext", count: () => snap.next.length, draw: drawNext },
    { id: "decisions", title: "fuDecisions", count: () => decisions().length, draw: drawDecisions },
    { id: "updates", title: "fuUpdates", count: () => [snap.updates.panel, snap.updates.claude].filter(u => u.newer).length, draw: drawUpdates }
  ];

  function badge() {
    const n = snap ? SECTIONS.reduce((sum, s) => sum + s.count(), 0) : decisions().length;
    $("navFollow").hidden = !n;
    $("navFollow").textContent = n;
  }

  async function load(force) {
    clearTimeout(timer);
    if (force) { started.clear(); await api("/api/followup/refresh"); } // yeniden taranınca düğmeler yine açılır
    try { snap = await getJson("/api/followup"); } catch { /* bağlantı yok: eldeki görüntü kalır */ }
    if (snap) render();
    const wait = snap?.scanning ? SCAN_POLL_MS : isOpen() && !document.hidden ? OPEN_POLL_MS : BACKGROUND_POLL_MS;
    timer = setTimeout(() => load(false), wait);
  }

  // Sekme açılınca: eldeki görüntü hemen çizilir, yarım dakikadan eskiyse yeniden taranır.
  function open() {
    if (snap) render();
    load(!snap || now() - snap.checkedAt > REOPEN_FRESH_MS);
  }

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  const tag = (text, cls = "") => `<span class="fu-tag ${cls}">${esc(text)}</span>`;

  /** Satır: başlık + etiketler, açıklama, soluk alt satır; sağda süre ve düğmeler. */
  function row({ title, tags = "", what = "", sub = "", side = "", buttons = [], cls = "" }) {
    const r = el("div", "fu-row " + cls);
    r.appendChild(el("div", "fu-main", `<span class="fu-title"><b>${esc(title)}</b>${tags}</span>`
      + (what ? `<span class="fu-what">${esc(what)}</span>` : "") + (sub ? `<small title="${esc(sub)}">${esc(sub)}</small>` : "")));
    const s = el("div", "fu-side", side ? `<small>${esc(side)}</small>` : "");
    for (const b of buttons) s.appendChild(b);
    r.appendChild(s);
    return r;
  }

  function button(label, fn, primary) {
    const b = el("button", "btn small" + (primary ? " primary" : ""));
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => fn(b));
    return b;
  }

  /** O klasörde panel oturumu başlatır ve Oturumlar'a geçer. */
  function startButton(label, key, cwd, prompt, name, primary) {
    const b = button(label, async () => {
      b.disabled = true;
      b.textContent = t("starting");
      let r;
      try { r = await api("/api/hosted", { cwd, prompt, resumeId: null, name: null, model: null }); }
      catch { r = { ok: false, data: null }; }
      b.textContent = label;
      if (!r.ok) { b.disabled = false; toast(t(`err_${r.data?.error || "generic"}`), "warn"); return; }
      started.add(key);
      toast(t("fuStarted", name));
      setView("sessions");
    }, primary);
    b.disabled = started.has(key);
    return b;
  }

  const clean = (text, unknown) => el("p", "fu-clean" + (unknown ? " unk" : ""), esc(text));

  function drawGit(box) {
    const g = snap.git;
    if (g.state === "nogit") { box.appendChild(clean(t("fuNoGit"), true)); return; }
    for (const r of g.repos) {
      const what = [r.dirty ? t("fuDirty", r.dirty) : "", r.ahead ? t("fuAhead", r.ahead) : ""].filter(Boolean).join(" · ");
      const buttons = [];
      if (r.dirty) buttons.push(startButton(t("fuCommit"), "c:" + r.path, r.path, t("fuCommitPrompt"), r.name, true));
      if (r.ahead || r.noUpstream) buttons.push(startButton(t("fuPush"), "p:" + r.path, r.path, t("fuPushPrompt"), r.name, !r.dirty));
      box.appendChild(row({ title: r.name, tags: (r.branch ? tag(r.branch) : "") + (r.noUpstream ? tag(t("fuNoUpstream"), "warn") : ""),
        what, sub: r.path, buttons }));
    }
    if (g.clean || !g.repos.length) box.appendChild(clean(g.clean ? t("fuCleanRepos", g.clean) : t("fuNoRepos"), !g.clean));
    if (g.failed) box.appendChild(clean(t("fuGitFailed", g.failed), true));
  }

  function drawNext(box) {
    for (const n of snap.next) {
      const age = now() - n.updatedAt, stale = age >= STALE_PLAN_MS;
      box.appendChild(row({ title: n.name, tags: stale ? tag(t("fuStale"), "warn") : "", what: n.summary, sub: n.cwd,
        side: t("since", dur(age)), cls: stale ? "fu-stale" : "",
        buttons: [startButton(t("fuContinue"), "n:" + n.cwd, n.cwd, t("fuContinuePrompt"), n.name, !stale)] }));
    }
    if (!snap.next.length) box.appendChild(clean(t("fuNoNext")));
  }

  function drawDecisions(box) {
    const list = decisions();
    for (const s of list)
      box.appendChild(row({ title: s.name, tags: tag(t("night_decision"), "warn"), sub: s.cwd, side: t("since", dur(now() - s.since)),
        buttons: [button(t("fuOpenChat"), () => openDrawer(s), true)] }));
    if (!list.length) box.appendChild(clean(t("fuNoDecisions")));
  }

  function drawUpdates(box) {
    const { panel, claude } = snap.updates;
    if (panel.newer) {
      const link = el("a", "btn small primary", esc(t("fuReleasePage")));
      link.href = panel.url; link.target = "_blank"; link.rel = "noopener";
      box.appendChild(row({ title: t("fuPanelNew", panel.latest), what: t("fuInstalled", panel.current), buttons: [link] }));
    }
    if (claude.newer)
      box.appendChild(row({ title: t("fuClaudeNew", claude.latest), what: `${t("fuInstalled", claude.current)} · ${t("fuClaudeHow")}` }));
    for (const [u, name] of [[panel, t("fuPanelName")], [claude, "Claude Code"]]) {
      if (u.state !== "ok") box.appendChild(clean(t("fuUnknown", name), true));
      else if (!u.newer) box.appendChild(clean(t("fuUpToDate", name, u.current)));
    }
  }

  function drawSection(s) {
    const sec = $("fu-" + s.id) || $("fuBody").appendChild(Object.assign(el("section", "fu-sec"), { id: "fu-" + s.id }));
    const n = s.count();
    sec.innerHTML = `<h2>${esc(t(s.title))}<span class="count${n ? " fu-on" : ""}">${n}</span></h2>`;
    s.draw(sec.appendChild(el("div", "list")));
  }

  function render() {
    badge();
    if (!isOpen() || !snap) return;
    $("fuChecked").textContent = snap.scanning ? t("fuScanning") : snap.checkedAt ? t("fuChecked", dur(now() - snap.checkedAt)) : "";
    $("btnFuRefresh").disabled = snap.scanning;
    if (!snap.checkedAt) { $("fuBody").innerHTML = `<p class="muted">${esc(t("loading"))}</p>`; return; }
    if (!$("fu-" + SECTIONS[0].id)) $("fuBody").innerHTML = "";
    SECTIONS.forEach(drawSection);
    decisionSig = decisions().map(s => s.id).join();
  }

  /** Oturum listesi her yenilendiğinde: rozet güncellenir, karar bekleyenler değiştiyse o bölüm yeniden çizilir. */
  function onItems() {
    badge();
    if (!isOpen() || !snap?.checkedAt) return;
    const sig = decisions().map(s => s.id).join();
    if (sig === decisionSig) return;
    decisionSig = sig;
    drawSection(SECTIONS.find(s => s.id === "decisions"));
  }

  $("btnFuRefresh").addEventListener("click", () => load(true));
  document.addEventListener("visibilitychange", () => { if (!document.hidden && isOpen()) load(false); });

  return { open, load, render, onItems };
};
