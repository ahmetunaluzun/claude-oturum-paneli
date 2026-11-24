// Oturum eylemleri: kart ve konuşma ekranı AYNI kümeyi kullanır (birincil düğme + ⋯ menüsü),
// seçerek toplu işlem, model rozeti ve bağlam/token özeti. app.js bağımlılıklarını verir.
window.PanelActions = function (d) {
  "use strict";
  const { t, api, toast, ask, confirmBox, adopt, goTo, openFolder, openDrawer, REMOTE } = d;

  // ---- Bilgi ----
  const FAMILIES = ["opus", "fable", "sonnet", "haiku"];
  function modelInfo(id) {
    if (!id) return null;
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
    // Panelden seçilen kısa ad ("opus") — oturumun ilk yanıtına kadar tam kimlik bilinmez.
    if (!m) {
      const fam = FAMILIES.find(f => id.toLowerCase().startsWith(f)) || "";
      const name = fam ? fam[0].toUpperCase() + fam.slice(1) : id;
      return { family: fam, label: name, short: name, id };
    }
    const fam = FAMILIES.includes(m[1]) ? m[1] : "";
    const name = m[1][0].toUpperCase() + m[1].slice(1);
    return { family: fam, label: `${name} ${m[2]}${m[3] ? "." + m[3] : ""}`, short: name, id };
  }
  function modelChip(id) {
    const mi = modelInfo(id);
    if (!mi) return null;
    const el = document.createElement("span");
    el.className = `model ${mi.family}`;
    el.title = mi.id;
    el.innerHTML = `<span class="long"></span><span class="short"></span>`;
    el.firstChild.textContent = mi.label;
    el.lastChild.textContent = mi.short;
    return el;
  }
  const fmtTok = n => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n || 0);
  function ctxInfo(s) {
    const st = s?.stats;
    if (!st || !st.ctxTokens) return null;
    const pct = st.ctxWindow ? Math.min(100, Math.round(st.ctxTokens * 100 / st.ctxWindow)) : null;
    return { pct, tokens: st.ctxTokens, window: st.ctxWindow, level: pct == null ? "" : pct >= 90 ? "high" : pct >= 75 ? "mid" : "" };
  }
  function ctxLabel(s) {
    const c = ctxInfo(s);
    if (!c) return "";
    return c.pct == null ? t("ctxTokens", fmtTok(c.tokens)) : t("ctxPct", c.pct, fmtTok(c.tokens));
  }
  // Konuşma başlığı için ayrıntı satırı.
  function statsLine(s) {
    const st = s?.stats;
    if (!st) return "";
    const c = ctxInfo(s);
    const parts = [];
    if (c) parts.push(c.window ? t("ctxFull", c.pct, fmtTok(c.tokens), fmtTok(c.window)) : t("ctxTokens", fmtTok(c.tokens)));
    parts.push(t("tokIn", fmtTok(st.inTok + st.cacheRead + st.cacheWrite)), t("tokOut", fmtTok(st.outTok)));
    if (st.turns) parts.push(t("turns", st.turns));
    if (st.compactions) parts.push(t("compactions", st.compactions));
    return parts.join(" · ");
  }
  const wantsClear = s => /\/clear\b/.test(s?.stats?.lastText || "");
  // Son mesajın son satırı soruyla bitiyorsa "soru sordu".
  const asked = s => /\?\s*[*_`)"”]*\s*$/.test((s?.stats?.lastText || "").trim().split("\n").pop() || "");
  function lastTool(s) {
    const st = s?.stats;
    if (!st?.lastToolName || !st.lastIsTool) return "";
    return st.lastTool ? `${st.lastToolName}: ${st.lastTool}` : st.lastToolName;
  }

  // ---- Eylemler ----
  const isPanel = s => !!s && s.kind === "panel" && s.status !== "ended";
  const resume = s => api(`/api/hosted/${s.key}/send`, { text: t("resumeAllMsg") });
  const later = s => api(`/api/hosted/${s.key}/later`, { text: t("resumeAllMsg") });
  const wrap = (s, close) => api(`/api/hosted/${s.key}/wrap`, { close });
  const cancelTask = s => api(`/api/hosted/${s.key}/cancel-task`);
  async function stopNow(s) {
    const v = await ask(t("closeTitle"), t(s.lane === "busy" ? "closeNowBusyText" : "closeNowText"), [s.name],
      [{ value: "go", label: t("closeNow"), cls: "danger" }]);
    if (v === "go") await api(`/api/hosted/${s.key}/stop`);
  }
  const done = (p, msg) => p.then(r => r.ok ? msg && toast(msg) : toast(t("err_generic"), "warn"));

  function primary(s) {
    if (!s) return null;
    if (isPanel(s) && s.lane === "idle" && !s.task) {
      const c = ctxInfo(s);
      if (wantsClear(s) || c?.level === "high") return { label: t("saveClear"), run: () => done(wrap(s, false), t("clearStarted")) };
      return { label: t("resume"), run: () => done(resume(s)) };
    }
    if (isPanel(s) && s.lane === "busy") return { label: t("interrupt"), cls: "", run: () => api(`/api/hosted/${s.key}/interrupt`) };
    // Masaüstü uygulamasındaki oturumda "Panele al" öne çıkmaz (oturumu uygulamadan koparır); ⋯ menüsünde durur.
    if (canAdopt(s) && s.surface !== "desktop") return { label: t("adopt"), run: () => adopt(s) };
    if (s.kind !== "panel" && !REMOTE) return { label: t(goLabel(s)), cls: "", run: () => goTo(s) };
    return null;
  }

  function menu(s, inDrawer) {
    const L = [];
    const add = (label, run, cls) => L.push({ label, run, cls });
    if (isPanel(s)) {
      if (s.task) add(t("cancelTask"), () => done(cancelTask(s)));
      if (s.lane === "idle" && !s.task) {
        add(t("resume"), () => done(resume(s)));
        add(t("saveClear"), () => done(wrap(s, false), t("clearStarted")));
        add(t("saveClose"), () => done(wrap(s, true), t("closeSaving")));
      } else if (s.lane === "busy") {
        add(t("laterResume"), () => done(later(s), t("laterSet")));
        add(t("laterClear"), () => done(wrap(s, false), t("laterSet")));
        add(t("laterClose"), () => done(wrap(s, true), t("laterSet")));
      }
    }
    if (s?.kind === "terminal" && !REMOTE) {
      add(t(goLabel(s)), () => goTo(s));
      if (canAdopt(s)) add(t("adopt"), () => adopt(s));
    }
    // Öteki Claude hesabında devam (yalnız boştaki oturum; birden çok hesap varsa)
    if ((isPanel(s) && s.lane === "idle" && !s.task) || canAdopt(s))
      for (const a of d.otherAccounts?.(s) || []) add(t("switchAcct", a.name), () => d.switchAccount(s, a));
    if (s?.kind === "bg" && !REMOTE) add(t("openAgents"), () => goTo(s));
    if (!inDrawer) add(t("openConv"), () => openDrawer(s));
    if (L.length) L.push(null);
    if (!REMOTE && s?.cwd) add(t("openFolderMenu"), () => openFolder(s));
    if (isPanel(s)) add(t("closeNow"), () => stopNow(s), "danger");
    while (L.length && L[L.length - 1] === null) L.pop();
    return L;
  }

  function goLabel(s) {
    return s.kind !== "terminal" ? "openAgents" : s.surface === "desktop" ? "goApp" : s.surface === "vscode" ? "goVscode" : "goTab";
  }

  function taskLabel(s) {
    if (!s?.task) return "";
    return t({ clearing: "task_clearing", closing: "task_closing", continuing: "task_continuing" }[s.task] || "task_clearing");
  }

  // ---- Açılır menü (body'e eklenir; atasının transform'una hapsolmaz) ----
  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function openMenu(anchor, list, { alignStart = false } = {}) { // alignStart: menü anchor'ın sol kenarından açılır
    closeMenu();
    if (!list.length) return;
    const m = document.createElement("div");
    m.className = "pop-menu";
    m.setAttribute("role", "menu");
    for (const it of list) {
      if (!it) { m.appendChild(document.createElement("hr")); continue; }
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.className = it.cls || "";
      b.textContent = it.label;
      b.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); it.run(); });
      m.appendChild(b);
    }
    document.body.appendChild(m);
    menuEl = m;
    const r = anchor.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
    const left = Math.max(8, Math.min(alignStart ? r.left : r.right - w, innerWidth - w - 8));
    const top = r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6;
    m.style.left = left + "px";
    m.style.top = top + "px";
    m.querySelector("button")?.focus();
  }
  document.addEventListener("click", (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  addEventListener("resize", closeMenu);
  addEventListener("scroll", closeMenu, true);

  // Bir kaba birincil düğme + ⋯ yerleştirir (kart ve konuşma ekranı).
  function fillActions(box, s, inDrawer, extra) {
    box.innerHTML = "";
    const p = primary(s);
    if (p) box.appendChild(button(p.label, `btn small ${p.cls ?? "primary"}`, p.run));
    for (const x of extra || []) box.appendChild(x);
    const sp = document.createElement("span");
    sp.className = "sp";
    box.appendChild(sp);
    const list = menu(s, inDrawer);
    if (list.length) {
      const more = button("⋯", "btn small icon more", () => openMenu(more, menu(s, inDrawer)));
      more.title = t("moreActions");
      more.setAttribute("aria-haspopup", "menu");
      box.appendChild(more);
    }
  }
  function button(label, cls, fn) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    return b;
  }

  // ---- Seçerek toplu işlem ----
  const selected = new Set();
  let selecting = false;
  // Her canlı oturum seçilebilir; her toplu işlem yalnız uygulanabildiği oturumlara gider.
  const selectable = s => !!s && s.status !== "ended";
  const canAdopt = s => !!s && s.kind === "terminal" && s.lane === "idle" && s.waiting == null && !REMOTE;
  const applies = (kind, s) => kind === "adopt" ? canAdopt(s) : isPanel(s);
  function setSelecting(on) {
    selecting = on;
    if (!on) selected.clear();
    d.render();
  }
  function toggle(s) {
    if (!selectable(s)) { toast(t("selectNotPanel"), "warn"); return; }
    if (selected.has(s.id)) selected.delete(s.id); else selected.add(s.id);
    if (!selecting) selecting = true;
    d.render();
  }
  function selectAll() { for (const s of d.items()) if (selectable(s)) selected.add(s.id); selecting = true; d.render(); }
  // Seçimi boşaltır, seçim kipinde kalır (tek tek yeniden seçmek için).
  function deselectAll() { selected.clear(); d.render(); }
  const allSelected = () => { const all = d.items().filter(selectable); return all.length > 0 && all.every(s => selected.has(s.id)); };
  // Seçili ve hâlâ var olan oturumlar.
  const chosen = () => d.items().filter(s => selected.has(s.id) && selectable(s));
  let bulkBusy = false; // toplu işlem sürerken ikinci tıklama aynı oturumları yeniden açmasın
  async function bulk(kind) {
    if (bulkBusy) return;
    bulkBusy = true;
    try { await bulkNow(kind); } finally { bulkBusy = false; }
  }
  async function bulkNow(kind) {
    const all = chosen();
    const list = all.filter(s => applies(kind, s));
    if (!list.length) return;
    if (kind === "adopt" && !await confirmBox({ title: t("adoptManyTitle", list.length), text: t("adoptConfirmMany"), list: list.map(s => s.name), okText: t("adopt") })) return;
    let ok = 0;
    for (const s of list) {
      const r = kind === "adopt" ? await api(`/api/adopt/${s.pid}`)
        : kind === "resume" ? await (s.lane === "busy" ? later(s) : resume(s))
        : await wrap(s, kind === "close");
      if (r.ok) ok++;
    }
    const skipped = all.length - list.length;
    toast(t("bulkDone", ok, list.length) + (skipped ? " · " + t(kind === "adopt" ? "bulkSkippedAdopt" : "bulkSkipped", skipped) : ""),
      ok === list.length && !skipped ? undefined : "warn");
    setSelecting(false);
  }
  function renderBulkBar() {
    const bar = document.getElementById("bulkBar");
    for (const id of [...selected]) if (!d.items().some(s => s.id === id)) selected.delete(id);
    bar.hidden = !selecting;
    document.documentElement.classList.toggle("selecting", selecting);
    document.getElementById("bulkCount").textContent = t("bulkCount", selected.size);
    const sel = chosen();
    bar.querySelectorAll("button[data-bulk]").forEach(b => {
      const n = sel.filter(s => applies(b.dataset.bulk, s)).length;
      b.disabled = !n;
      b.title = sel.length && n < sel.length ? t("bulkApplies", n, sel.length) : "";
    });
    bar.querySelector('button[data-bulk="adopt"]').hidden = REMOTE || !sel.some(s => s.kind === "terminal");
    const toggleAll = document.getElementById("bulkAll");
    toggleAll.textContent = t(allSelected() ? "deselectAll" : "selectAll");
  }

  // Başlıktaki "Toplu ▾" menüsü.
  function laneMenu(anchor) {
    if (selecting) {
      openMenu(anchor, [
        { label: t("selectAll"), run: selectAll },
        { label: t("deselectAll"), run: deselectAll },
        null,
        { label: t("selectExit"), run: () => setSelecting(false) }]);
      return;
    }
    openMenu(anchor, [
      { label: t("resumeAll"), run: d.resumeAllIdle, cls: "only-phone" },
      { label: t("selectMode"), run: () => setSelecting(true) },
      { label: t("selectAll"), run: selectAll },
      null,
      { label: t("saveClearAll"), run: d.wrapAllIdle },
      { label: t("saveCloseAll"), run: d.closeAll }]);
  }

  return {
    modelInfo, modelChip, ctxInfo, ctxLabel, statsLine, wantsClear, asked, lastTool, taskLabel,
    fillActions, openMenu, closeMenu, laneMenu, toggle, selectAll, deselectAll, allSelected, setSelecting, bulk, renderBulkBar,
    isSelected: id => selected.has(id), selecting: () => selecting, cancelTask: s => done(cancelTask(s)),
    selectable
  };
};
