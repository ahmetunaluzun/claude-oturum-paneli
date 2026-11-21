// Takip sekmesinin görünüm katmanı: süzgeç çipleri, projeye göre gruplama (varsayılan) / türe göre görünüm, kenara alınan
// (gizlenen, ertelenen, "Yükledim" denen) öğelerin alt satırı ve seçerek toplu işlem. Öğeleri followup.js üretir ve çizer;
// burası hangi öğenin nerede görüneceğine karar verir. Durum followup-state.js'te (kalıcı).
window.PanelFollowView = function (c) {
  "use strict";
  const { t, esc, S, el, button, row, drawSection, note, toast, isActive, commitAll, openMenu, sessions, folder, rerender } = c;
  // Süzgeç → bölüm kimlikleri. Güncellemeler yalnız "Tümü"nde görünür.
  const FILTERS = { all: null, git: ["git"], next: ["next"], drive: ["drive"], sched: ["sched"], github: ["github"], decisions: ["decisions", "conflicts"] };
  const KIND = { git: "fuKind_git", job: "fuKind_git", next: "fuKind_next", drive: "fuKind_drive", ledger: "fuKind_drive", decision: "fuKind_decision", conflict: "fuKind_conflict",
    task: "fuKind_sched", sfile: "fuKind_sched", sdesk: "fuKind_sched", loop: "fuKind_sched", cloud: "fuKind_sched", promise: "fuKind_promise", plan: "fuKind_plan", planadd: "fuKind_plan", gh: "fuKind_github" };
  // Bilgi satırları (info: zamanlanmış görev, ileri tarihli söz…) bekleyen iş değildir: rozete ve "Tümü" sayısına girmez,
  // kendi süzgecinin (Zamanlanmış) sayısına girer.
  const counted = (i) => !i.info && !(i.result && i.job?.state === "done");
  const listed = (i) => i.info || counted(i);
  const revealed = new Set(); // açılmış "oturumda açık" / "gizli" satırları (kalıcı değil)
  const picked = new Set();
  let selecting = false, last = null;

  /** Bölümlerdeki ham öğeleri (sec.all) görünen / oturumda açık / kenara alınmış diye ayırır, süzgeci ve görünümü uygular. */
  function model(secs) {
    const act = new Set(sessions().map(s => s.root).filter(Boolean)), ids = new Set(), asideAll = [];
    for (const s of secs) {
      s.items = []; s.inSession = [];
      for (const it of s.all) {
        it.sec = s.id; it.proj ??= it.root; ids.add(it.id);
        it.aside = S.canDefer(it) ? S.aside(it) : null;
        if (it.aside) asideAll.push(it);
        else if (s.hideable && act.has(it.proj)) s.inSession.push(it);
        else s.items.push(it);
      }
    }
    const inFilter = (f, id) => !FILTERS[f] || FILTERS[f].includes(id);
    const chips = {};
    for (const f of Object.keys(FILTERS)) chips[f] = secs.filter(s => inFilter(f, s.id)).reduce((n, s) => n + s.items.filter(f === "all" ? counted : listed).length, 0);
    const off = new Set(secs.some(s => s.id === "github") ? [] : ["github"]); // kapalı kaynağın çipi çizilmez
    const filter = FILTERS[S.state.filter] !== undefined && !off.has(S.state.filter) ? S.state.filter : "all";
    const shown = secs.filter(s => inFilter(filter, s.id));
    const m = { secs, shown, chips, filter, ids, off, total: chips.all, aside: asideAll.filter(it => inFilter(filter, it.sec)), mode: S.state.mode === "type" ? "type" : "project" };
    if (m.mode === "project") Object.assign(m, groups(shown));
    m.folds = m.mode === "type" ? shown : [...m.groups, ...m.rest];
    last = m;
    return m;
  }

  /** Projeye göre: her proje bir grup; önem sırası (karar > sorun > eski bekleyen > bekleyen > bilgi), sonra ad. */
  function groups(shown) {
    const map = new Map(), sess = [], notes = [], rest = [];
    for (const s of shown) {
      if (s.id === "updates") { rest.push(s); continue; }
      sess.push(...s.inSession);
      notes.push(...s.notes);
      for (const it of s.items) {
        const key = it.proj || "?";
        if (!map.has(key)) map.set(key, { id: "p:" + key, name: folder(it.rootPath || it.sub || it.title), group: true, items: [], inSession: [], notes: [] });
        map.get(key).items.push(it);
      }
    }
    const list = [...map.values()];
    for (const g of list) {
      g.items.sort((a, b) => a.rank - b.rank);
      g.rank = g.items[0].rank;
      g.openDefault = g.items.some(i => i.type === "decision" || i.type === "conflict");
      const kinds = [...new Set(g.items.map(i => t(KIND[i.type] || "fuKind_git")))];
      g.sum = kinds.join(" · ");
    }
    list.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    list.forEach((g, i) => { g.dom = "fu-p" + i; });
    return { groups: list, sess, notes, rest };
  }

  // ---- Çipler + görünüm seçimi ----
  function bar(m) {
    const box = el("div", "fu-bar");
    const chips = box.appendChild(el("div", "fu-chips"));
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", t("fuFilterLabel"));
    for (const f of Object.keys(FILTERS).filter(x => !m.off.has(x))) {
      const b = el("button", "fu-chip", `${esc(t("fuFilter_" + f))}<span>${m.chips[f]}</span>`);
      b.type = "button"; b.dataset.filter = f;
      b.setAttribute("aria-pressed", String(m.filter === f));
      b.addEventListener("click", () => { S.state.filter = f; S.save(); rerender(); });
      chips.appendChild(b);
    }
    const modes = box.appendChild(el("div", "fu-modes"));
    modes.setAttribute("role", "group");
    modes.setAttribute("aria-label", t("fuModeLabel"));
    for (const mode of ["project", "type"]) {
      const b = el("button", "fu-mode", esc(t("fuMode_" + mode)));
      b.type = "button"; b.dataset.mode = mode;
      b.setAttribute("aria-pressed", String(m.mode === mode));
      b.addEventListener("click", () => { S.state.mode = mode; S.save(); rerender(); });
      modes.appendChild(b);
    }
    return box;
  }

  /** Tıkla-aç bilgi satırı (oturumda açık projeler, kenara alınanlar). */
  function more(key, cls, text, list, mode) {
    const out = [], b = el("button", cls);
    b.type = "button";
    b.setAttribute("aria-expanded", String(revealed.has(key)));
    b.textContent = text;
    b.addEventListener("click", () => { revealed.has(key) ? revealed.delete(key) : revealed.add(key); rerender(); });
    out.push(b);
    if (revealed.has(key)) { const box = el("div", "list fu-body"); for (const it of list) box.appendChild(row(it, mode)); out.push(box); }
    return out;
  }

  /** Sekmenin gövdesi: çipler, bölümler ya da proje grupları, alt satırlar. */
  function draw(m) {
    const out = [bar(m)];
    if (m.mode === "type") out.push(...m.shown.map(drawSection));
    else {
      for (const g of m.groups) for (const it of g.items) it.kind = t(KIND[it.type] || "fuKind_git");
      out.push(...m.groups.map(drawSection));
      if (!m.groups.length && !m.sess.length) out.push(note(t(m.filter === "all" ? "fuNothingAll" : "fuNothingFilter")));
      if (m.sess.length) out.push(...more("sess", "fu-insess", t("fuInSession", new Set(m.sess.map(i => i.proj)).size), m.sess, "session"));
      for (const [text, unknown] of m.notes) out.push(note(text, unknown));
      out.push(...m.rest.map(drawSection));
    }
    if (!m.aside.length) revealed.delete("aside");
    if (m.aside.length) out.push(...more("aside", "fu-insess fu-aside", t("fuAside", m.aside.length), m.aside, "aside"));
    drawBulk(m);
    return out;
  }

  // ---- Seçerek toplu işlem ----
  // Yalnız açık bölüm/gruplardaki (ekranda çizilen) satırlar seçilebilir: görünmeyen öğeye toplu işlem uygulanmaz.
  const visible = (m) => (m.mode === "type" ? m.shown : m.groups).filter(s => !S.isCollapsed(s.id, s.openDefault)).flatMap(s => s.items);
  const selectable = (it) => S.canDefer(it) && !it.aside;
  function setSelecting(on) { selecting = on; if (!on) picked.clear(); rerender(); }
  function toggle(it) {
    if (!selectable(it)) return;
    picked.has(it.id) ? picked.delete(it.id) : picked.add(it.id);
    selecting = true;
    rerender();
  }

  function bulk(action, btn) {
    const list = visible(last).filter(i => picked.has(i.id));
    if (!list.length) { toast(t("fuBulkNone"), "warn"); return; }
    const ok = { commit: (i) => i.type === "git" && !(i.job && isActive(i.job)), upload: (i) => i.type === "drive" && !i.unreadable, snooze: selectable, hide: selectable }[action];
    const run = list.filter(ok), skipped = list.length - run.length;
    const skipText = skipped ? t("fuBulkSkipped", skipped, t("fuBulkWhy_" + action)) : "";
    if (!run.length) { toast(skipText, "warn"); return; }
    if (action === "commit") {
      commitAll(run, btn).then(started => { if (started) { if (skipText) toast(skipText, "warn"); setSelecting(false); } });
      return;
    }
    for (const it of run) S[action](it);
    toast(t("fuBulkDone_" + action, run.length) + (skipText ? " · " + skipText : ""), skipped ? "warn" : undefined);
    setSelecting(false);
  }

  function drawBulk(m) {
    const barEl = document.getElementById("fuBulkBar");
    const shownIds = new Set(visible(m).map(i => i.id));
    for (const id of [...picked]) if (!shownIds.has(id)) picked.delete(id);
    barEl.hidden = !selecting;
    document.getElementById("viewFollow").classList.toggle("fu-selecting", selecting);
    if (!selecting) return;
    const all = visible(m).filter(selectable);
    barEl.replaceChildren(el("b", "", esc(t("fuBulkCount", picked.size))),
      button(t(all.length && all.every(i => picked.has(i.id)) ? "deselectAll" : "selectAll"), () => {
        const every = all.every(i => picked.has(i.id));
        for (const i of all) every ? picked.delete(i.id) : picked.add(i.id);
        rerender();
      }),
      ...["commit", "snooze", "hide", "upload"].map(a => { const b = button(t("fuBulk_" + a), (x) => bulk(a, x), a === "commit"); b.dataset.bulk = a; b.disabled = !picked.size; return b; }),
      button(t("selectExit"), () => setSelecting(false)));
  }

  /** Üst çubuktaki "Toplu" menüsü: bölüm kapalıyken de "tüm depoları commit et ve gönder" + seçim kipi. */
  function menu(anchor) {
    if (!last) return;
    const git = (last.secs.find(s => s.id === "git")?.items || []).filter(i => i.type === "git" && !(i.job && isActive(i.job)));
    const list = [];
    if (git.length) list.push({ label: t("fuBulkAllGit", git.length), run: () => commitAll(git, anchor) });
    if (selecting) list.push({ label: t("selectExit"), run: () => setSelecting(false) });
    else if (last.folds.some(s => s.items.some(selectable))) list.push({ label: t("fuBulkPick"), run: () => setSelecting(true) });
    if (!list.length) { toast(t("fuBulkEmpty"), "warn"); return; }
    openMenu(anchor, list);
  }

  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && selecting && !document.querySelector("dialog[open]") && !document.querySelector(".pop-menu")) setSelecting(false); });

  return { model, draw, menu, toggle, counted, selectable, selecting: () => selecting, isPicked: (id) => picked.has(id), isRevealed: (k) => revealed.has(k), flip: (k) => { revealed.has(k) ? revealed.delete(k) : revealed.add(k); } };
};
