// Takip sekmesi: günlük takip edilecekler. Her kaynak bir bölümdür; bölüm, öğe listesi üretir ({ id, type, root, prio, sig, … })
// ve çizim tek yerden yapılır. Bölümler açılır-kapanır (durum localStorage["panel.follow"]). Kaynaklar kota harcamaz:
// git durumu, NEXT_SESSION.md, karar bekleyenler, aynı projede birden çok oturum, güncellemeler.
// Commit / gönder düğmeleri oturum AÇMAZ: sunucudaki arka plan işini başlatır (/api/follow/*), sonuç satırda görünür.
// Projesinde açık oturum olan depo ve planlar gizlenir (oturum zaten o işi yapıyor); karar bekleyenler her zaman görünür.
window.PanelFollowUp = function (d) {
  "use strict";
  const { t, api, getJson, toast, esc, dur, openDrawer, items, setView, now, isOpen, startHosted, confirmBox, ask, lang } = d;
  const $ = (id) => document.getElementById(id);
  const SCAN_POLL_MS = 1500, OPEN_POLL_MS = 60_000, BACKGROUND_POLL_MS = 300_000, REOPEN_FRESH_MS = 30_000, JOB_POLL_MS = 1200;
  const STALE_PLAN_MS = 3 * 86_400_000, STORE = "panel.follow", ACTIVE = ["queued", "committing", "checking", "pushing"];
  const OPEN_BY_DEFAULT = new Set(["decisions", "conflicts"]);
  let snap = null, jobs = [], timer = null, jobTimer = null, itemSig = "", jobsWereActive = false;
  const started = new Set(); // bu sayfada "Devam et" ile oturum başlatılan planlar
  const revealed = new Set(); // "oturumda açık" projeleri gösterilen bölümler (kalıcı değil)

  // ---- Kalıcı görünüm durumu ----
  const state = Object.assign({ collapsed: {}, dismissed: [] }, (() => { try { return JSON.parse(localStorage.getItem(STORE) || "{}"); } catch { return {}; } })());
  const saveState = () => localStorage.setItem(STORE, JSON.stringify(state));
  const isCollapsed = (id) => state.collapsed[id] ?? !OPEN_BY_DEFAULT.has(id);

  const low = (s) => String(s || "").toLowerCase();
  const folder = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || p;
  /** Açık oturumu olan proje kökleri (küçük harf). */
  const activeRoots = () => new Set(items().map(s => s.root).filter(Boolean));

  // ---- İşler ----
  const isActive = (i) => ACTIVE.includes(i.state);
  /** Depo kökü → o deponun en son iş kaydı. */
  function jobOf(root) {
    let best = null;
    for (const j of jobs) for (const i of j.items) if (low(i.root) === low(root) && (!best || i.updatedAt >= best.updatedAt)) best = { ...i, jobId: j.id };
    return best && !state.dismissed.includes(best.jobId + "|" + low(root)) ? best : null;
  }
  const anyJobActive = () => jobs.some(j => j.items.some(isActive));

  function jobText(i) {
    if (isActive(i)) return t("fuJob_" + i.state);
    if (i.state === "decision") return t("fuNeedDecision");
    if (i.state === "done") {
      if (i.committed && i.pushed) return t("fuDoneBoth", i.committed, i.pushed);
      if (i.pushed) return t("fuDonePush", i.pushed);
      if (i.committed) return t("fuDoneCommit", i.committed);
      return t(i.code === "nothing" ? "fuDoneNothing" : "fuDoneNoChange");
    }
    let s = t("fuFail_" + (["secret", "rejected", "auth", "timeout", "noremote", "nogit", "insession", "busy"].includes(i.code) ? i.code : "failed"));
    if (i.code === "secret" && i.findings?.length)
      s += ": " + i.findings.map(f => `${f.file || "?"} (${t("fuSec_" + f.what)})`).join("; ");
    else if (i.detail && i.code !== "secret") s += ` (${i.detail})`;
    if (i.committed && i.state === "failed") s = t("fuDoneCommit", i.committed) + " · " + s;
    return s;
  }

  async function loadJobs() {
    clearTimeout(jobTimer);
    try { jobs = await getJson("/api/follow/jobs"); } catch { /* bağlantı yok: eldeki kalır */ }
    const active = anyJobActive();
    if (snap) render();
    if (active) jobTimer = setTimeout(loadJobs, JOB_POLL_MS);
    else if (jobsWereActive) setTimeout(() => load(false), 600); // iş bitti: sunucu depoları yeniden tarıyor
    jobsWereActive = active;
  }

  async function runJob(btn, path, body) {
    btn.disabled = true;
    let r;
    try { r = await api(path, { ...body, lang: lang() }); } catch { r = { ok: false, data: null }; }
    if (!r.ok) { btn.disabled = false; toast(t(`err_${r.data?.error || "generic"}`), "warn"); return; }
    toast(t("fuJobStarted"));
    jobsWereActive = true;
    loadJobs();
  }

  // ---- Öğeler ----
  const tag = (text, cls = "") => `<span class="fu-tag ${cls}">${esc(text)}</span>`;
  const decisions = () => items().filter(s => s.night === "decision");

  function repoPlan(r) {
    const push = r.ahead > 0 || r.noUpstream;
    if (r.dirty && push) return { label: t("fuCommitPush"), plan: t("fuPlanBoth"), path: "/api/follow/commit", body: { path: r.path, push: true } };
    if (r.dirty) return { label: t("fuCommit"), plan: t("fuPlanCommit"), path: "/api/follow/commit", body: { path: r.path, push: false } };
    return { label: t("fuPush"), plan: t("fuPlanPush"), path: "/api/follow/push", body: { path: r.path } };
  }

  /** Git: depo başına TEK düğme (Commit et / Gönder / Commit et ve gönder); iş sürerken düğme yerine durum. */
  function gitItems() {
    const out = [], seen = new Set();
    for (const r of snap.git.repos) {
      seen.add(low(r.path));
      const job = jobOf(r.path), plan = repoPlan(r);
      const what = [r.dirty ? t("fuDirty", r.dirty) : "", r.ahead ? t("fuAhead", r.ahead) : ""].filter(Boolean).join(" · ");
      const it = { id: "git:" + low(r.path), type: "git", root: low(r.path), prio: job && !isActive(job) && job.state !== "done" ? 1 : 2,
        title: r.name, tags: (r.branch ? tag(r.branch) : "") + (r.noUpstream ? tag(t("fuNoUpstream"), "warn") : ""), what, sub: r.path, repo: r, plan, job,
        sig: [r.dirty, r.ahead, r.noUpstream, job?.state, job?.updatedAt].join() };
      out.push(it);
    }
    // Biten işin deposu artık temizse satırı kalmaz: sonuç ayrı satırda görünür, "Tamam" ile kapanır.
    for (const j of jobs) for (const i of j.items) {
      const key = low(i.root);
      if (seen.has(key)) continue;
      const latest = jobOf(i.root);
      if (!latest || latest.jobId !== j.id) continue;
      seen.add(key);
      out.push({ id: "job:" + j.id + "|" + key, type: "job", root: key, prio: latest.state === "done" ? 3 : 1, title: i.name, sub: i.root, job: latest,
        result: true, sig: [latest.state, latest.updatedAt].join() });
    }
    return out.sort((a, b) => a.prio - b.prio);
  }

  function nextItems() {
    return snap.next.map(n => {
      const age = now() - n.updatedAt, stale = age >= STALE_PLAN_MS;
      return { id: "next:" + low(n.cwd), type: "next", root: low(n.root || n.cwd), prio: stale ? 2 : 1, title: n.name, tags: stale ? tag(t("fuStale"), "warn") : "",
        what: n.summary, sub: n.cwd, side: t("since", dur(age)), cls: stale ? "fu-stale" : "", next: n, stale, sig: [n.updatedAt, stale].join() };
    });
  }

  function decisionItems() {
    const list = decisions().map(s => ({ id: "dec:" + s.id, type: "decision", root: s.root, prio: 0, title: s.name, tags: tag(t("night_decision"), "warn"),
      sub: s.cwd, side: t("since", dur(now() - s.since)), session: s, sig: s.id }));
    // Arka plan işi karar isteyip görünür oturuma dönmüşse (oturum hâlâ açıksa) burada da durur.
    for (const j of jobs) for (const i of j.items) {
      const s = i.state === "decision" && i.sessionKey && items().find(x => x.key === i.sessionKey);
      if (s && !list.some(x => x.session.id === s.id))
        list.push({ id: "dec:" + s.id, type: "decision", root: low(i.root), prio: 0, title: i.name, tags: tag(t("fuNeedDecision"), "warn"), what: i.summary || "",
          sub: i.root, session: s, sig: s.id });
    }
    return list;
  }

  /** Aynı projede birden çok oturum (panel + terminal): çakışma riski. */
  function conflictItems() {
    const groups = new Map();
    for (const s of items()) if (s.root && s.status !== "ended") groups.set(s.root, [...(groups.get(s.root) || []), s]);
    return [...groups].filter(([, list]) => list.length > 1).map(([root, list]) => ({ id: "conf:" + root, type: "conflict", root, prio: 1,
      title: folder(list[0].rootPath || list[0].cwd), tags: tag(t("projMulti", list.length), "warn"),
      what: t("fuConflictWhat", list.length, list.map(s => s.name + (s.kind === "terminal" ? ` (${t("terminal")})` : "")).join(", ")),
      sub: list[0].rootPath || list[0].cwd, sig: list.map(s => s.id).join() }));
  }

  function updateItems() {
    const { panel, claude } = snap.updates, out = [];
    if (panel.newer) out.push({ id: "upd:panel", type: "update", prio: 1, title: t("fuPanelNew", panel.latest), what: t("fuInstalled", panel.current), link: panel.url, sig: panel.latest });
    if (claude.newer) out.push({ id: "upd:claude", type: "update", prio: 1, title: t("fuClaudeNew", claude.latest), what: `${t("fuInstalled", claude.current)} · ${t("fuClaudeHow")}`, sig: claude.latest });
    return out;
  }

  /** Bölümler: öğeler + oturumda açık olduğu için gizlenenler + alttaki bilgi satırları. */
  function build() {
    const act = activeRoots();
    const split = (list) => ({ items: list.filter(i => !act.has(i.root)), inSession: list.filter(i => act.has(i.root)) });
    const g = snap.git, { panel, claude } = snap.updates;
    const gitNotes = [];
    if (g.state === "nogit") gitNotes.push([t("fuNoGit"), true]);
    else {
      if (g.clean || !g.repos.length) gitNotes.push([g.clean ? t("fuCleanRepos", g.clean) : t("fuNoRepos"), !g.clean]);
      if (g.failed) gitNotes.push([t("fuGitFailed", g.failed), true]);
    }
    const updNotes = [];
    for (const [u, name] of [[panel, t("fuPanelName")], [claude, "Claude Code"]]) {
      if (u.state !== "ok") updNotes.push([t("fuUnknown", name), true]);
      else if (!u.newer) updNotes.push([t("fuUpToDate", name, u.current), false]);
    }
    const conflicts = conflictItems();
    return [
      { id: "decisions", title: "fuDecisions", items: decisionItems(), inSession: [], notes: [], empty: t("fuNoDecisions") },
      ...(conflicts.length ? [{ id: "conflicts", title: "fuConflicts", items: conflicts, inSession: [], notes: [] }] : []),
      { id: "git", title: "fuGit", ...split(g.state === "nogit" ? [] : gitItems()), notes: gitNotes },
      { id: "next", title: "fuNext", ...split(nextItems()), notes: [], empty: t("fuNoNext") },
      { id: "updates", title: "fuUpdates", items: updateItems(), inSession: [], notes: updNotes }
    ];
  }

  // ---- Çizim ----
  function el(tagName, cls, html) {
    const e = document.createElement(tagName);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function button(label, fn, primary) {
    const b = el("button", "btn small" + (primary ? " primary" : ""));
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => fn(b));
    return b;
  }
  const note = (text, unknown) => el("p", "fu-clean" + (unknown ? " unk" : ""), esc(text));

  function continueButton(it) {
    const n = it.next;
    const b = button(t("fuContinue"), async () => {
      b.disabled = true;
      b.textContent = t("starting");
      const r = await startHosted({ cwd: n.cwd, prompt: t("fuContinuePrompt"), resumeId: null, name: null, model: null });
      b.textContent = t("fuContinue");
      if (!r.ok) { b.disabled = false; if (!r.cancelled) toast(t(`err_${r.data?.error || "generic"}`), "warn"); return; }
      started.add(it.id);
      if (!r.data?.sent && !r.data?.queued) toast(t("fuStarted", n.name));
      setView("sessions");
    }, !it.stale);
    b.disabled = started.has(it.id);
    return b;
  }

  function sideOf(it, hidden) {
    const side = el("div", "fu-side", it.side ? `<small>${esc(it.side)}</small>` : "");
    if (hidden) return side; // oturumda açık proje: yalnız bilgi, düğme yok
    const job = it.job;
    if (job?.summary) side.appendChild(button(t("fuSummary"), () => ask(t("fuSummaryTitle", it.title), job.summary, null, [{ value: "ok", label: t("ok"), cls: "primary" }])));
    if (job?.state === "decision") {
      const s = items().find(x => x.key === job.sessionKey);
      if (s) side.appendChild(button(t("fuOpenChat"), () => openDrawer(s), true));
    }
    // İş bittiyse ama depo henüz yeniden taranmadıysa satırdaki sayılar eskidir: düğme tarama gelene kadar gösterilmez.
    const stale = job?.state === "done" && job.updatedAt > snap.checkedAt;
    if (it.type === "git" && !(job && isActive(job)) && !stale)
      side.appendChild(button(it.plan.label, (b) => runJob(b, it.plan.path, it.plan.body), !job || job.state === "done"));
    if (it.type === "job" && !isActive(job))
      side.appendChild(button(t("fuDismiss"), () => { state.dismissed = [...state.dismissed.slice(-49), job.jobId + "|" + it.root]; saveState(); render(); }));
    if (it.type === "next") side.appendChild(continueButton(it));
    if (it.type === "decision") side.appendChild(button(t("fuOpenChat"), () => openDrawer(it.session), true));
    if (it.type === "conflict") side.appendChild(button(t("fuShowSessions"), () => setView("sessions")));
    if (it.link) {
      const a = el("a", "btn small primary", esc(t("fuReleasePage")));
      a.href = it.link; a.target = "_blank"; a.rel = "noopener";
      side.appendChild(a);
    }
    return side;
  }

  /** Satır: başlık + etiketler, açıklama, iş durumu, soluk alt satır; sağda süre ve (tek) düğme. */
  function row(it, hidden) {
    const r = el("div", "fu-row " + (it.cls || ""));
    r.dataset.id = it.id;
    const job = it.job;
    const jobLine = job ? `<span class="fu-job ${isActive(job) ? "run" : job.state === "done" ? "ok" : "warn"}">${esc(jobText(job))}</span>` : "";
    r.appendChild(el("div", "fu-main", `<span class="fu-title"><b>${esc(it.title)}</b>${it.tags || ""}${hidden ? tag(t("fuInSessionTag")) : ""}</span>`
      + (it.what ? `<span class="fu-what">${esc(it.what)}</span>` : "") + jobLine + (it.sub ? `<small title="${esc(it.sub)}">${esc(it.sub)}</small>` : "")));
    r.appendChild(sideOf(it, hidden));
    return r;
  }

  /** "Tümünü commit et ve gönder": onay listesi → tek arka plan işi. */
  function allBar(sec) {
    const list = sec.items.filter(i => i.type === "git" && !(i.job && isActive(i.job)));
    if (list.length < 2) return null;
    const bar = el("div", "fu-allbar");
    bar.appendChild(button(t("fuAllBtn"), async (b) => {
      const ok = await confirmBox({ title: t("fuAllTitle", list.length), text: t("fuAllText"), okText: t("fuAllGo"),
        list: list.map(i => `${i.title} — ${i.plan.plan}`) });
      if (ok) runJob(b, "/api/follow/all", { paths: list.map(i => i.repo.path) });
    }));
    return bar;
  }

  function drawSection(sec) {
    const box = el("section", "fu-sec");
    box.id = "fu-" + sec.id;
    const n = sec.items.length, collapsed = isCollapsed(sec.id);
    const head = el("button", "fu-fold");
    head.type = "button";
    head.setAttribute("aria-expanded", String(!collapsed));
    const names = sec.items.map(i => i.title).join(", ") || (sec.inSession.length ? t("fuInSession", sec.inSession.length) : t("fuNothing"));
    head.innerHTML = `<span class="fu-chev" aria-hidden="true"></span><span class="fu-name">${esc(t(sec.title))}</span>`
      + `<span class="count${n ? " fu-on" : ""}">${n}</span><span class="fu-sum">${esc(names)}</span>`;
    head.addEventListener("click", () => { state.collapsed[sec.id] = !isCollapsed(sec.id); saveState(); render(); });
    box.appendChild(head);
    if (collapsed) return box;
    const body = box.appendChild(el("div", "list fu-body"));
    if (sec.id === "git") { const bar = allBar(sec); if (bar) body.appendChild(bar); }
    for (const it of sec.items) body.appendChild(row(it, false));
    if (!n && sec.empty && !sec.inSession.length) body.appendChild(note(sec.empty));
    for (const [text, unknown] of sec.notes) body.appendChild(note(text, unknown));
    if (sec.inSession.length) {
      const more = el("button", "fu-insess");
      more.type = "button";
      more.setAttribute("aria-expanded", String(revealed.has(sec.id)));
      more.textContent = t("fuInSession", sec.inSession.length);
      more.addEventListener("click", () => { revealed.has(sec.id) ? revealed.delete(sec.id) : revealed.add(sec.id); render(); });
      body.appendChild(more);
      if (revealed.has(sec.id)) for (const it of sec.inSession) body.appendChild(row(it, true));
    }
    return box;
  }

  const count = (secs) => secs.reduce((sum, s) => sum + s.items.filter(i => !(i.result && i.job?.state === "done")).length, 0);

  function badge(secs) {
    const n = snap?.checkedAt ? count(secs || build()) : decisions().length;
    $("navFollow").hidden = !n;
    $("navFollow").textContent = n;
  }

  function render() {
    const secs = snap?.checkedAt ? build() : null;
    badge(secs);
    if (!isOpen() || !snap) return;
    $("fuChecked").textContent = snap.scanning ? t("fuScanning") : snap.checkedAt ? t("fuChecked", dur(now() - snap.checkedAt)) : "";
    $("btnFuRefresh").disabled = snap.scanning;
    const body = $("fuBody");
    if (!secs) { body.innerHTML = `<p class="muted">${esc(t("loading"))}</p>`; $("btnFuFold").hidden = true; return; }
    const anyCollapsed = secs.some(s => isCollapsed(s.id));
    const fold = $("btnFuFold");
    fold.hidden = false;
    fold.textContent = t(anyCollapsed ? "fuOpenAll" : "fuCloseAll");
    fold.dataset.open = anyCollapsed ? "1" : "0";
    // Odak yeniden çizimde kaybolmasın: odaktaki başlık/düğme kimliğiyle geri verilir.
    const focusSec = document.activeElement?.closest?.(".fu-sec")?.id, wasFold = document.activeElement?.classList?.contains("fu-fold");
    body.replaceChildren(...secs.map(drawSection));
    if (focusSec && wasFold) document.getElementById(focusSec)?.querySelector(".fu-fold")?.focus();
    itemSig = liveSig();
  }

  /** Oturum listesine bağlı kısımların imzası: değişince yeniden çizilir. */
  const liveSig = () => items().map(s => [s.id, s.root, s.night, s.status === "ended"].join()).join("|");

  async function load(force) {
    clearTimeout(timer);
    if (force) { started.clear(); await api("/api/followup/refresh"); } // yeniden taranınca düğmeler yine açılır
    try { snap = await getJson("/api/followup"); } catch { /* bağlantı yok: eldeki görüntü kalır */ }
    if (!anyJobActive()) await loadJobs(); else if (snap) render();
    const wait = snap?.scanning ? SCAN_POLL_MS : isOpen() && !document.hidden ? OPEN_POLL_MS : BACKGROUND_POLL_MS;
    timer = setTimeout(() => load(false), wait);
  }

  // Sekme açılınca: eldeki görüntü hemen çizilir, yarım dakikadan eskiyse yeniden taranır.
  function open() {
    if (snap) render();
    load(!snap || now() - snap.checkedAt > REOPEN_FRESH_MS);
  }

  /** Oturum listesi her yenilendiğinde: rozet güncellenir; oturuma bağlı kısımlar değiştiyse yeniden çizilir. */
  function onItems() {
    if (!isOpen() || !snap?.checkedAt) { badge(); return; }
    if (liveSig() !== itemSig) render(); else badge();
  }

  $("btnFuRefresh").addEventListener("click", () => load(true));
  $("btnFuFold").addEventListener("click", () => {
    const openAll = $("btnFuFold").dataset.open === "1";
    for (const s of build()) state.collapsed[s.id] = !openAll;
    saveState();
    render();
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && isOpen()) load(false); });

  return { open, load, render, onItems };
};
