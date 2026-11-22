// Takip sekmesi: günlük takip edilecekler. Her kaynak bir bölümdür; bölüm, öğe listesi üretir ({ id, type, root, rank, sig, … })
// ve çizim tek yerden yapılır. Kaynaklar kota harcamaz: git durumu, NEXT_SESSION.md, karar bekleyenler, aynı projede birden
// çok oturum, GitHub issue ve PR'ları (followup-github.js), mail ve takvim (followup-mail.js), güncelleme kütükleri (Drive; followup-drive.js), zamanlanmış ve
// planlı işler (followup-sched.js, followup-plan.js), güncellemeler.
// Görünüm (süzgeç çipleri, projeye / türe göre gruplama, gizle-ertele, toplu seçim) followup-view.js'te, kalıcı durum
// followup-state.js'te (localStorage["panel.follow"]).
// Commit / gönder / kütüğü kapat düğmeleri oturum AÇMAZ: sunucudaki arka plan işini başlatır (/api/follow/*), sonuç satırda görünür.
// Projesinde açık oturum olan depo ve planlar gizlenir (oturum zaten o işi yapıyor); karar bekleyenler her zaman görünür.
window.PanelFollowUp = function (d) {
  "use strict";
  const { t, api, getJson, toast, esc, dur, openDrawer, items, setView, now, isOpen, startHosted, confirmBox, ask, lang, openMenu, REMOTE } = d;
  const $ = (id) => document.getElementById(id);
  const SCAN_POLL_MS = 1500, OPEN_POLL_MS = 60_000, BACKGROUND_POLL_MS = 300_000, REOPEN_FRESH_MS = 30_000, JOB_POLL_MS = 1200, LONG_PRESS_MS = 500;
  const STALE_PLAN_MS = 3 * 86_400_000, ACTIVE = ["queued", "committing", "checking", "pushing", "closing"];
  let snap = null, jobs = [], timer = null, jobTimer = null, itemSig = "", jobsWereActive = false, model = null;
  const started = new Set(); // bu sayfada "Devam et" ile oturum başlatılan planlar
  const opened = new Set(); // ayrıntısı açık satırlar (kalıcı değil)
  const S = window.PanelFollowState({ now });
  const state = S.state;

  const low = (s) => String(s || "").toLowerCase();
  const folder = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || p;

  // ---- İşler ----
  const isActive = (i) => ACTIVE.includes(i.state);
  /** Depo kökü (ya da kütük yolu) → onun en son iş kaydı. */
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
      if (i.kind === "ledger") return t("fuLedgerDone");
      if (i.committed && i.pushed) return t("fuDoneBoth", i.committed, i.pushed);
      if (i.pushed) return t("fuDonePush", i.pushed);
      if (i.committed) return t("fuDoneCommit", i.committed);
      return t(i.code === "nothing" ? "fuDoneNothing" : "fuDoneNoChange");
    }
    // Gizli bilgi bulguları ayrı listede (followup-pushguard.js), metne eklenmez.
    let s = t("fuFail_" + (["secret", "rejected", "auth", "timeout", "noremote", "nogit", "insession", "busy", "unchanged"].includes(i.code) ? i.code : "failed"));
    if (i.detail && i.code !== "secret") s += ` (${i.detail})`;
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

  /** btn: yeniden çizimle yenilenen satır düğmesi (iş başlayınca kapalı kalır); kalıcı düğmede null verilir. */
  async function runJob(btn, path, body) {
    if (btn) btn.disabled = true;
    let r;
    try { r = await api(path, { ...body, lang: lang() }); } catch { r = { ok: false, data: null }; }
    if (!r.ok) { if (btn) btn.disabled = false; toast(t(`err_${r.data?.error || "generic"}`), "warn"); return r; }
    toast(t("fuJobStarted"));
    jobsWereActive = true;
    loadJobs();
    return r;
  }

  /** "Commit et ve gönder" toplu işi: onay listesi → tek arka plan işi. → başlatıldı mı. */
  async function commitAll(list, btn) {
    const ok = await confirmBox({ title: t("fuAllTitle", list.length), text: t("fuAllText"), okText: t("fuAllGo"),
      list: list.map(i => `${i.title} — ${i.plan.plan}`) });
    if (ok) runJob(btn, "/api/follow/all", { paths: list.map(i => i.repo.path) });
    return ok;
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
      const job = jobOf(r.path), plan = repoPlan(r), failed = job && !isActive(job) && job.state !== "done";
      const what = [r.dirty ? t("fuDirty", r.dirty) : "", r.ahead ? t("fuAhead", r.ahead) : ""].filter(Boolean).join(" · ");
      const it = { id: "git:" + low(r.path), type: "git", root: low(r.path), rootPath: r.path, prio: failed ? 1 : 2, rank: failed ? 1 : 3,
        title: r.name, tags: (r.branch ? tag(r.branch) : "") + (r.noUpstream ? tag(t("fuNoUpstream"), "warn") : ""), what, sub: r.path, repo: r, plan, job,
        sig: [r.dirty, r.ahead, r.noUpstream, job?.state, job?.updatedAt].join() };
      out.push(it);
    }
    // Biten işin deposu artık temizse satırı kalmaz: sonuç ayrı satırda görünür, "Tamam" ile kapanır.
    for (const j of jobs) for (const i of j.items) {
      const key = low(i.root);
      if (i.kind === "ledger" || seen.has(key)) continue; // kütük işleri Drive bölümünde
      const latest = jobOf(i.root);
      if (!latest || latest.jobId !== j.id) continue;
      seen.add(key);
      out.push({ id: "job:" + j.id + "|" + key, type: "job", root: key, rootPath: i.root, prio: latest.state === "done" ? 3 : 1, rank: latest.state === "done" ? 4 : 1,
        title: i.name, sub: i.root, job: latest, result: true, sig: [latest.state, latest.updatedAt].join() });
    }
    return out.sort((a, b) => a.prio - b.prio);
  }

  function nextItems() {
    return snap.next.map(n => {
      const age = now() - n.updatedAt, stale = age >= STALE_PLAN_MS;
      return { id: "next:" + low(n.cwd), type: "next", root: low(n.root || n.cwd), rootPath: n.root || n.cwd, rank: stale ? 2 : 3, title: n.name,
        tags: stale ? tag(t("fuStale"), "warn") : "", what: n.summary, sub: n.cwd, side: t("since", dur(age)), cls: stale ? "fu-stale" : "", next: n, stale,
        sig: [n.updatedAt, stale].join() };
    });
  }

  function decisionItems() {
    const list = decisions().map(s => ({ id: "dec:" + s.id, type: "decision", root: s.root, rootPath: s.rootPath || s.cwd, rank: 0, title: s.name,
      tags: tag(t("night_decision"), "warn"), sub: s.cwd, side: t("since", dur(now() - s.since)), session: s, sig: s.id }));
    // Arka plan işi karar isteyip görünür oturuma dönmüşse (oturum hâlâ açıksa) burada da durur.
    for (const j of jobs) for (const i of j.items) {
      const s = i.state === "decision" && i.sessionKey && items().find(x => x.key === i.sessionKey);
      if (s && !list.some(x => x.session.id === s.id))
        list.push({ id: "dec:" + s.id, type: "decision", root: s.root || low(i.root), rootPath: s.rootPath || s.cwd || i.root, rank: 0, title: i.name,
          tags: tag(t("fuNeedDecision"), "warn"), what: i.summary || "", sub: i.root, session: s, sig: s.id });
    }
    return list;
  }

  /** Aynı projede birden çok oturum (panel + terminal): çakışma riski. */
  function conflictItems() {
    const groups = new Map();
    for (const s of items()) if (s.root && s.status !== "ended") groups.set(s.root, [...(groups.get(s.root) || []), s]);
    return [...groups].filter(([, list]) => list.length > 1).map(([root, list]) => ({ id: "conf:" + root, type: "conflict", root, rank: 1,
      rootPath: list[0].rootPath || list[0].cwd, title: folder(list[0].rootPath || list[0].cwd), tags: tag(t("projMulti", list.length), "warn"),
      what: t("fuConflictWhat", list.length, list.map(s => s.name + (s.kind === "terminal" ? ` (${t("terminal")})` : "")).join(", ")),
      sub: list[0].rootPath || list[0].cwd, sig: list.map(s => s.id).join() }));
  }

  function updateItems() {
    const { panel, claude } = snap.updates, out = [];
    if (panel.newer) out.push({ id: "upd:panel", type: "update", rank: 4, title: t("fuPanelNew", panel.latest), what: t("fuInstalled", panel.current), link: panel.url, sig: panel.latest });
    const cu = snap.claudeUpdate || { state: "idle" };
    if (claude.newer || cu.state === "running")
      out.push({ id: "upd:claude", type: "update", rank: 4, title: t("fuClaudeNew", claude.latest), what: `${t("fuInstalled", claude.current)} · ${claudeUpdateText(cu)}`,
        claudeUpdate: cu, sig: claude.latest });
    return out;
  }

  /** Claude Code güncellemesinin satırdaki durumu: panel kendisi günceller (`claude update`). */
  function claudeUpdateText(cu) {
    if (cu.state === "running") return t("fuClaudeUpdating");
    if (cu.state === "failed") return t("fuClaudeFailed", t("fuCuErr_" + cu.error) !== "fuCuErr_" + cu.error ? t("fuCuErr_" + cu.error) : cu.error || "?");
    if (cu.state === "done" && !cu.to) return t("fuClaudeNoChange");
    return t("fuClaudeHow");
  }

  async function claudeUpdateNow(btn) {
    btn.disabled = true;
    let r;
    try { r = await api("/api/follow/claude-update", {}); } catch { r = { ok: false, data: null }; }
    if (!r.ok && r.data?.error !== "busy") { btn.disabled = false; toast(t("err_generic"), "warn"); return; }
    if (snap) snap.claudeUpdate = r.data?.state ? r.data : { ...(snap.claudeUpdate || {}), state: "running" };
    render();
    load(false);
  }

  /** Bölümler: ham öğeler (all) + alttaki bilgi satırları. hideable: projesinde oturum açık olan öğe gizlenir. */
  function build() {
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
    // Panelin kurduğu sürüm: yeni oturumlarda geçerli (açık oturumlar eski sürümle sürer). 12 saat gösterilir.
    const cu = snap.claudeUpdate;
    if (cu?.state === "done" && cu.to && !claude.newer && now() - cu.at * 1000 < 12 * 3600_000) updNotes.push([t("fuClaudeUpdated", cu.to), false]);
    const conflicts = conflictItems(), drive = D.items(snap, jobs), sched = Z.section(snap, P.list()), github = G.section(snap), mail = M.sections(snap);
    return [
      { id: "decisions", title: "fuDecisions", all: decisionItems(), notes: [], empty: t("fuNoDecisions") },
      ...(conflicts.length ? [{ id: "conflicts", title: "fuConflicts", all: conflicts, notes: [] }] : []),
      { id: "git", title: "fuGit", all: g.state === "nogit" ? [] : gitItems(), notes: gitNotes, hideable: true },
      { id: "next", title: "fuNext", all: nextItems(), notes: [], empty: t("fuNoNext"), hideable: true },
      ...(github ? [github] : []),
      ...mail,
      ...(drive.length ? [{ id: "drive", title: "fuDrive", all: drive, notes: [] }] : []),
      ...(sched ? [sched] : []),
      { id: "updates", title: "fuUpdates", all: updateItems(), notes: updNotes }
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
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(b); });
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

  /** mode: undefined (olağan) | "session" (oturumda açık proje: yalnız bilgi) | "aside" (gizli/ertelenmiş: yalnız "Geri getir"). */
  function sideOf(it, mode) {
    const side = el("div", "fu-side", it.side ? `<small>${esc(it.side)}</small>` : "");
    if (mode === "session") return side;
    if (mode === "aside") { side.appendChild(button(t("fuRestore"), () => { S.restore(it); render(); })); return side; }
    const job = it.job;
    if (job?.summary) side.appendChild(button(t("fuSummary"), () => ask(t(job.kind === "ledger" ? "fuLedgerSummary" : "fuSummaryTitle", it.title), job.summary, null, [{ value: "ok", label: t("ok"), cls: "primary" }])));
    if (job?.state === "decision") {
      const s = items().find(x => x.key === job.sessionKey);
      if (s) side.appendChild(button(t("fuOpenChat"), () => openDrawer(s), true));
    }
    // İş bittiyse ama depo henüz yeniden taranmadıysa satırdaki sayılar eskidir: düğme tarama gelene kadar gösterilmez.
    const stale = job?.state === "done" && job.updatedAt > snap.checkedAt;
    // Gizli bilgi engeli: "Claude'a incelet" (+ yalnız kalıp bulgularında "Test verisi, yine de gönder"); aynı nedenle yine
    // başarısız olacak "Gönder" konmaz. Commit de gerekiyorsa plan düğmesi ikincil kalır.
    const secret = X.side(it, side);
    if (it.type === "git" && !(job && isActive(job)) && !stale && !(secret && it.plan.path === "/api/follow/push"))
      side.appendChild(button(it.plan.label, (b) => runJob(b, it.plan.path, it.plan.body), !job || job.state === "done"));
    if (it.type === "job" && !isActive(job))
      side.appendChild(button(t("fuDismiss"), () => { state.dismissed = [...state.dismissed.slice(-49), job.jobId + "|" + it.root]; S.save(); render(); }));
    if (it.type === "next") side.appendChild(continueButton(it));
    if (it.type === "decision") side.appendChild(button(t("fuOpenChat"), () => openDrawer(it.session), true));
    if (it.type === "conflict") side.appendChild(button(t("fuShowSessions"), () => setView("sessions")));
    if (it.claudeUpdate && it.claudeUpdate.state !== "running") side.appendChild(button(t("fuClaudeUpdateNow"), claudeUpdateNow, true));
    D.side(it, side, snap);
    Z.side(it, side);
    P.side(it, side);
    G.side(it, side);
    M.side(it, side);
    if (it.link) {
      const a = el("a", "btn small" + (it.linkText ? "" : " primary"), esc(it.linkText || t("fuReleasePage")));
      a.href = it.link; a.target = "_blank"; a.rel = "noopener";
      a.addEventListener("click", (e) => e.stopPropagation());
      side.appendChild(a);
    }
    return side;
  }

  /** Açık satırın alt çubuğu: Klasörde göster (Drive), Ertele (yarına), Gizle. */
  function moreOf(it) {
    const box = el("div", "fu-more");
    D.more(it, box);
    Z.more(it, box);
    P.more(it, box);
    G.more(it, box);
    if (S.canDefer(it)) {
      box.appendChild(button(t("fuSnooze"), () => { S.snooze(it); toast(t("fuSnoozed", it.title)); render(); }));
      box.appendChild(button(t("fuHide"), () => { S.hide(it); toast(t("fuHidden", it.title)); render(); }));
    }
    return box.children.length ? box : null;
  }

  /** Sıkı satır: başlık + etiketler, tek satır açıklama, iş durumu; sağda süre ve (tek) düğme. Tıklayınca ayrıntı açılır. */
  function row(it, mode) {
    const open = opened.has(it.id), pick = !mode && V.selecting() && V.selectable(it);
    const r = el("div", "fu-row " + (it.cls || "") + (open ? " fu-open" : "") + (pick && V.isPicked(it.id) ? " fu-picked" : ""));
    r.dataset.id = it.id;
    r.dataset.type = it.type;
    if (pick) r.appendChild(el("span", "fu-pick" + (V.isPicked(it.id) ? " on" : "")));
    const job = it.job;
    const jobLine = job ? `<span class="fu-job ${isActive(job) ? "run" : job.state === "done" ? "ok" : "warn"}">${esc(jobText(job))}</span>` : "";
    const marks = (it.kind ? `<span class="fu-kind">${esc(it.kind)}</span>` : "") + (it.tags || "") + (mode === "session" ? tag(t("fuInSessionTag")) : "")
      + (mode === "aside" ? tag(t("fuAside_" + it.aside)) : "") + (!mode && S.isNew(it.id) ? `<span class="fu-new">${esc(t("fuNew"))}</span>` : "");
    r.appendChild(el("div", "fu-main", `<span class="fu-title"><b>${esc(it.title)}</b>${marks}</span>`
      + (it.what ? `<span class="fu-what">${esc(it.what)}</span>` : "") + jobLine + X.list(job) + (it.sub ? `<small title="${esc(it.sub)}">${esc(it.sub)}</small>` : "")));
    const tog = r.appendChild(el("button", "fu-tog", `<span class="fu-chev" aria-hidden="true"></span>`));
    tog.type = "button";
    tog.setAttribute("aria-expanded", String(open));
    tog.setAttribute("aria-label", t("fuDetails"));
    r.appendChild(sideOf(it, mode));
    const more = open && !mode ? moreOf(it) : null;
    if (more) r.appendChild(more);
    // Satıra tıkla: seçim kipinde seçer, değilse ayrıntıyı açar/kapatır. Uzun basma (telefon) seçim kipini açar.
    let pressTimer = 0, longPressed = false;
    r.addEventListener("click", (e) => {
      if (longPressed) { longPressed = false; return; }
      if (e.target.closest(".fu-side, .fu-more")) return;
      if (V.selecting() && !mode) { V.toggle(it); return; }
      opened.has(it.id) ? opened.delete(it.id) : opened.add(it.id);
      render();
    });
    if (!mode && V.selectable(it)) {
      r.addEventListener("pointerdown", (e) => {
        if (e.pointerType !== "touch" || e.target.closest("button, a")) return;
        longPressed = false;
        pressTimer = setTimeout(() => { longPressed = true; navigator.vibrate?.(15); V.toggle(it); }, LONG_PRESS_MS);
      });
      for (const ev of ["pointerup", "pointerleave", "pointercancel", "pointermove"]) r.addEventListener(ev, () => clearTimeout(pressTimer));
      r.addEventListener("contextmenu", (e) => { if (longPressed) e.preventDefault(); });
    }
    return r;
  }

  /** "Tümünü commit et ve gönder": açık Git bölümünün başında (bölüm kapalıyken üstteki Toplu menüsünden). */
  function allBar(sec) {
    const list = sec.items.filter(i => i.type === "git" && !(i.job && isActive(i.job)));
    if (list.length < 2) return null;
    const bar = el("div", "fu-allbar");
    bar.appendChild(button(t("fuAllBtn"), (b) => commitAll(list, b)));
    return bar;
  }

  /** Açılır-kapanır kap: türe göre görünümde bölüm, projeye göre görünümde proje grubu (sec.group). */
  function drawSection(sec) {
    const box = el("section", "fu-sec" + (sec.group ? " fu-group" : ""));
    box.id = sec.dom || "fu-" + sec.id;
    const n = sec.items.length, collapsed = S.isCollapsed(sec.id, sec.openDefault);
    const head = el("button", "fu-fold");
    head.type = "button";
    head.setAttribute("aria-expanded", String(!collapsed));
    const names = sec.group ? sec.sum : sec.items.map(i => i.title).join(", ") || (sec.inSession.length ? t("fuInSession", sec.inSession.length) : t("fuNothing"));
    head.innerHTML = `<span class="fu-chev" aria-hidden="true"></span><span class="fu-name">${esc(sec.name ?? t(sec.title))}</span>`
      + `<span class="count${n ? " fu-on" : ""}">${n}</span><span class="fu-sum">${esc(names)}</span>`;
    head.addEventListener("click", () => { state.collapsed[sec.id] = !collapsed; S.save(); render(); });
    box.appendChild(head);
    if (collapsed) return box;
    const body = box.appendChild(el("div", "list fu-body"));
    if (sec.id === "git") { const bar = allBar(sec); if (bar) body.appendChild(bar); }
    for (const it of sec.items) body.appendChild(row(it));
    if (!n && sec.empty && !sec.inSession.length) body.appendChild(note(sec.empty));
    for (const [text, unknown] of sec.notes) body.appendChild(note(text, unknown));
    if (sec.inSession.length) {
      const more = el("button", "fu-insess");
      more.type = "button";
      more.setAttribute("aria-expanded", String(V.isRevealed(sec.id)));
      more.textContent = t("fuInSession", sec.inSession.length);
      more.addEventListener("click", () => { V.flip(sec.id); render(); });
      body.appendChild(more);
      if (V.isRevealed(sec.id)) for (const it of sec.inSession) body.appendChild(row(it, "session"));
    }
    return box;
  }

  const D = window.PanelFollowDrive({ t, api, toast, dur, now, low, tag, jobOf, isActive, runJob, confirmBox, button, S, REMOTE, rerender: () => render() });
  const Z = window.PanelFollowSched({ t, api, toast, dur, now, low, tag, confirmBox, button, lang, REMOTE, startHosted, setView, S,
    reload: () => load(false) });
  const P = window.PanelFollowPlan({ t, api, getJson, toast, dur, now, low, tag, confirmBox, ask, button, lang, items, openDrawer, openMenu,
    reload: () => render() });
  const G = window.PanelFollowGithub({ t, api, getJson, toast, dur, now, low, tag, button, startHosted, setView, reload: () => load(false) });
  const M = window.PanelFollowMail({ t, api, dur, now, low, tag, lang });
  const X = window.PanelFollowSecret({ t, esc, api, toast, confirmBox, button, startHosted, setView, lang, runJob });
  const V = window.PanelFollowView({ t, esc, S, el, button, row, drawSection, note, toast, isActive, commitAll, openMenu, folder,
    sessions: () => items(), rerender: () => render() });

  /** Sekme rozeti: görünen (gizlenmemiş, ertelenmemiş, oturumda olmayan) öğe sayısı; süzgeçten bağımsız. */
  function badge() {
    const n = model ? model.total : decisions().length;
    $("navFollow").hidden = !n;
    $("navFollow").textContent = n;
  }

  function render() {
    model = snap?.checkedAt ? V.model(build()) : null;
    badge();
    if (!isOpen() || !snap) return;
    $("fuChecked").textContent = snap.scanning ? t("fuScanning") : snap.checkedAt ? t("fuChecked", dur(now() - snap.checkedAt)) : "";
    $("btnFuRefresh").disabled = snap.scanning;
    const body = $("fuBody");
    $("btnFuBulk").hidden = !model;
    if (!model) { body.innerHTML = `<p class="muted">${esc(t("loading"))}</p>`; $("btnFuFold").hidden = true; return; }
    S.prune(model.ids);
    S.track(new Set([...model.ids].filter(id => !/^(job|led):/.test(id)))); // iş sonucu ve kütük satırı kullanıcının kendi işleminin sonucudur
    const anyCollapsed = model.folds.some(s => S.isCollapsed(s.id, s.openDefault));
    const fold = $("btnFuFold");
    fold.hidden = false;
    fold.textContent = t(anyCollapsed ? "fuOpenAll" : "fuCloseAll");
    fold.dataset.open = anyCollapsed ? "1" : "0";
    // Odak yeniden çizimde kaybolmasın: odaktaki başlık/çip kimliğiyle geri verilir.
    const act = document.activeElement, focusSec = act?.closest?.(".fu-sec")?.id, wasFold = act?.classList?.contains("fu-fold");
    const chip = act?.dataset?.filter ? `[data-filter="${act.dataset.filter}"]` : act?.dataset?.mode ? `.fu-mode[data-mode="${act.dataset.mode}"]` : null;
    body.replaceChildren(...V.draw(model));
    if (focusSec && wasFold) document.getElementById(focusSec)?.querySelector(".fu-fold")?.focus();
    else if (chip) body.querySelector(chip)?.focus();
    itemSig = liveSig();
  }

  /** Oturum listesine bağlı kısımların imzası: değişince yeniden çizilir. */
  const liveSig = () => items().map(s => [s.id, s.root, s.night, s.status === "ended"].join()).join("|");

  async function load(force) {
    clearTimeout(timer);
    if (force) { started.clear(); await api("/api/followup/refresh"); } // yeniden taranınca düğmeler yine açılır
    try { [snap] = await Promise.all([getJson("/api/followup"), P.load()]); } catch { /* bağlantı yok: eldeki görüntü kalır */ }
    if (!anyJobActive()) await loadJobs(); else if (snap) render();
    const wait = snap?.scanning || snap?.claudeUpdate?.state === "running" || snap?.github?.fetching || snap?.mail?.fetching ? SCAN_POLL_MS : isOpen() && !document.hidden ? OPEN_POLL_MS : BACKGROUND_POLL_MS;
    timer = setTimeout(() => load(false), wait);
  }

  // Sekme açılınca: eldeki görüntü hemen çizilir, yarım dakikadan eskiyse yeniden taranır. Her açılış yeni bir "bakış"tır.
  function open() {
    S.newLook();
    if (snap) render();
    load(!snap || now() - snap.checkedAt > REOPEN_FRESH_MS);
  }

  /** Oturum listesi her yenilendiğinde: rozet güncellenir; oturuma bağlı kısımlar değiştiyse yeniden çizilir. */
  function onItems() {
    if (!isOpen() || !snap?.checkedAt) { model = snap?.checkedAt ? V.model(build()) : null; badge(); return; }
    if (liveSig() !== itemSig) render(); else badge();
  }

  $("btnFuRefresh").addEventListener("click", async () => { await Promise.all([G.poke(), M.poke()]); load(true); });
  $("btnFuBulk").addEventListener("click", (e) => { e.stopPropagation(); V.menu(e.currentTarget); });
  $("btnFuFold").addEventListener("click", () => {
    const openAll = $("btnFuFold").dataset.open === "1";
    for (const s of model?.folds || []) state.collapsed[s.id] = !openAll;
    S.save();
    render();
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && isOpen()) load(false); });

  return { open, load, render, onItems };
};
