// Takip → Zamanlanmış işler → Planlı işler (0.16.0): kullanıcının belirlediği saatte projede istem çalıştıran işler.
// Sunucu: PlannedJobs.cs (/api/plans*). Türler: session (görünür oturum), review ("kontrolüme bırak": ayrı çalışma kopyası + dal,
// push yok), warmup (5 saatlik kota penceresini erken başlatır). Panel kendiliğinden birleştirmez/silmez: "Kontrolünü bekliyor"
// satırındaki İncele penceresinden kullanıcı birleştirir ya da atar. Form: index.html dlgPlan, fark penceresi dlgDiff.
window.PanelFollowPlan = function (c) {
  "use strict";
  const { t, api, getJson, toast, dur, now, low, tag, confirmBox, ask, button, lang, items, openDrawer, openMenu, reload } = c;
  const $ = (id) => document.getElementById(id);
  const NOPROJ = "~bilgisayar", PINNED = new Set(["running", "review", "decision"]);
  const ATTENTION = new Set(["review", "decision", "failed", "missed"]);
  let data = null, editing = null, projectsLoaded = false;

  const folder = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || p;
  const locale = () => (lang() === "en" ? "en-GB" : "tr-TR");
  const has = (key) => t(key) !== key;
  /** Hata kodu → metin: önce plana özel (plErr_*), sonra genel (err_*). */
  const errText = (code) => (has("plErr_" + code) ? t("plErr_" + code) : has("err_" + code) ? t("err_" + code) : t("err_generic"));
  /** Yanıtın ilk satırındaki işaret ([GECE-BITTI] / [KARAR-BEKLIYOR]) panel içindir, gösterilmez. */
  const unmark = (s) => String(s || "").replace(/^\s*\[(GECE-BITTI|KARAR-BEKLIYOR)\][ \t]*\r?\n?/, "").trim();
  const nameOf = (j) => j.name || (j.kind === "warmup" ? t("plWarmupName") : folder(j.cwd));

  async function load() {
    try { data = await getJson("/api/plans"); } catch { /* bağlantı yok: eldeki kalır */ }
  }

  function nextText(ms) {
    const d = new Date(ms), sameDay = new Date(now()).toDateString() === d.toDateString();
    const abs = d.toLocaleString(locale(), sameDay ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    return t("plNext", abs, t("fuIn", dur(Math.max(0, ms - now()))));
  }

  /** Son çalışmanın tek satırlık durumu. */
  function lastText(j) {
    const r = j.last;
    if (!r) return "";
    const ago = r.endedAt || r.at ? t("since", dur(now() - (r.endedAt || r.at))) : "";
    const code = r.code && has("plCode_" + r.code) ? t("plCode_" + r.code) : r.code || "";
    const cost = r.costUsd > 0 ? " · $" + r.costUsd.toFixed(2) : "";
    switch (r.state) {
      case "waiting": return t("plLast_waiting", code, Math.round((data?.[j.kind === "warmup" ? "warmupGraceMin" : "graceMin"] || 180) / 60));
      case "running": return t("plLast_running", dur(now() - r.at));
      case "review": return t("plLast_review", r.commits, r.files?.length || 0) + cost;
      case "failed": return t("plLast_failed", code + (r.detail ? ` (${r.detail})` : ""), ago);
      case "missed": return t(r.code ? "plLast_missedWhy" : "plLast_missed", code, ago);
      default: { const k = "plLast_" + (r.state === "done" && j.kind === "warmup" ? "warmdone" : r.state); return (has(k) ? t(k, ago) : r.state) + cost; }
    }
  }

  /** Planlı işlerin satırları + en sonda "Planla" satırı. Dikkat isteyenler (kontrol, karar, olmadı, kaçırıldı) rozete girer. */
  function list() {
    if (!data) return [];
    const out = data.jobs.map(j => {
      const r = j.last, st = r?.state, attention = ATTENTION.has(st), off = !j.enabled;
      const tags = tag(t("plKind_" + j.kind)) + tag(t("plRep_" + j.repeat))
        + (st === "review" ? tag(t("plReviewTag"), "warn") : st === "decision" ? tag(t("night_decision"), "warn")
          : st === "running" ? tag(t("plRunningTag")) : st === "failed" || st === "missed" ? tag(t("plLastTag_" + st), "warn")
            : st === "waiting" ? tag(t("plWaitingTag"), "warn") : "")
        + (off && !PINNED.has(st) ? tag(t("plOffTag")) : "");
      const parts = [];
      if (j.enabled && j.nextAt && st !== "running") parts.push(nextText(j.nextAt));
      const last = lastText(j);
      if (last) parts.push(last);
      const sub = st === "review" && r.files?.length ? r.files.join(", ")
        : j.kind === "warmup" ? t("plWarmupWhat") : `${j.prompt || ""}`;
      return { id: "plan:" + j.id, type: "plan", root: j.cwd ? low(j.cwd) : NOPROJ, rootPath: j.cwd || t("fuSchedNoProject"),
        title: nameOf(j), tags, what: (st === "review" || st === "decision") && r.summary ? unmark(r.summary) : parts.join(" · "),
        sub: (st === "review" || st === "decision") && r.summary ? `${parts.join(" · ")} — ${sub}` : sub,
        plan: j, pinned: PINNED.has(st), rank: st === "decision" ? 0.5 : attention ? 1 : 4.5, info: !attention,
        cls: off && !PINNED.has(st) && !attention ? "fu-stale" : "", sig: [j.enabled, j.nextAt, st, r?.at].join() };
    });
    out.push({ id: "plan:add", type: "planadd", root: NOPROJ, rootPath: t("fuSchedNoProject"), title: t("plAddTitle"),
      what: t("plAddWhat"), sub: t("plAwakeNote", data.awakeAheadH), rank: 5.5, info: true, sig: "1" });
    return out;
  }

  // ---- İşlemler ----
  async function call(path, body, okText) {
    let r;
    try { r = await api(path, body); } catch { r = { ok: false, data: null }; }
    if (!r.ok) { toast(errText(r.data?.error), "warn"); return null; }
    if (okText) toast(okText);
    await load();
    reload();
    return r.data;
  }

  async function remove(j) {
    if (await confirmBox({ title: t("plDelTitle", nameOf(j)), text: t("plDelText"), okText: t("plDel"), danger: true }))
      call("/api/plans/delete", { id: j.id }, t("plDeleted", nameOf(j)));
  }

  function menuFor(j, anchor) {
    const st = j.last?.state, busy = st === "running" || st === "review";
    openMenu(anchor, [
      { label: t("plEdit"), run: () => openForm(j) },
      ...(busy ? [] : [{ label: t("plRunNow"), run: () => call("/api/plans/run", { id: j.id }, t("plRunStarted", nameOf(j))) }]),
      { label: t(j.enabled ? "plDisable" : "plEnable"), run: () => call("/api/plans/enable", { id: j.id, on: !j.enabled }, t(j.enabled ? "plDisabled" : "plEnabled", nameOf(j))) },
      null,
      { label: t("plDel"), run: () => remove(j), cls: "danger" }]);
  }

  /** "Kontrolünü bekliyor": farkı göster; pencereden birleştir ya da at. */
  async function review(j, btn) {
    btn.disabled = true;
    let r;
    try { r = await api("/api/plans/diff", { id: j.id }); } catch { r = { ok: false, data: null }; }
    btn.disabled = false;
    if (!r.ok) { toast(errText(r.data?.error), "warn"); return; }
    const run = j.last, d = $("dlgDiff");
    $("diffTitle").textContent = t("plDiffTitle", nameOf(j));
    $("diffInfo").textContent = t("plDiffInfo", run.branch || "?", run.commits, (r.data.files || []).length) + (r.data.cut ? " " + t("plDiffCut") : "");
    $("diffText").textContent = r.data.text;
    d.returnValue = "";
    d.addEventListener("close", async () => {
      if (d.returnValue === "merge") merge(j);
      else if (d.returnValue === "discard") discard(j);
    }, { once: true });
    d.showModal();
    $("diffText").scrollTop = 0;
  }

  async function merge(j) {
    const run = j.last;
    if (await confirmBox({ title: t("plMergeTitle", nameOf(j)), text: t("plMergeText", run.branch, run.base ? run.base.slice(0, 7) : "", run.root || j.cwd), okText: t("plMerge") }))
      call("/api/plans/merge", { id: j.id }, t("plMerged", nameOf(j)));
  }

  async function discard(j) {
    if (await confirmBox({ title: t("plDiscardTitle", nameOf(j)), text: t("plDiscardText", j.last.branch), okText: t("plDiscard"), danger: true }))
      call("/api/plans/discard", { id: j.id }, t("plDiscarded", nameOf(j)));
  }

  function side(it, box) {
    if (it.type === "planadd") { box.appendChild(button(t("plAdd"), () => openForm(null))); return; }
    if (it.type !== "plan") return;
    const j = it.plan, st = j.last?.state;
    const s = j.last?.sessionKey && items().find(x => x.key === j.last.sessionKey);
    if (st === "review") box.appendChild(button(t("plReview"), (b) => review(j, b), true));
    else if (s && (st === "decision" || st === "running")) box.appendChild(button(t("fuOpenChat"), () => openDrawer(s), st === "decision"));
    const more = button("⋯", () => menuFor(j, more));
    more.classList.add("icon", "more");
    more.setAttribute("aria-label", t("plMenu"));
    box.appendChild(more);
  }

  /** Açılan ayrıntı: özet (varsa) ve kontrol bekleyen dalı atma. */
  function more(it, box) {
    if (it.type !== "plan") return;
    const r = it.plan.last;
    if (r?.summary) box.appendChild(button(t("fuSummary"), () => ask(t("fuSummaryTitle", it.title), unmark(r.summary), null, [{ value: "ok", label: t("ok"), cls: "primary" }])));
    if (r?.state === "review") box.appendChild(button(t("plDiscard"), () => discard(it.plan)));
  }

  // ---- Form (dlgPlan) ----
  let kind = "session";
  function setKind(k) {
    kind = k;
    for (const b of $("plKind").children) b.classList.toggle("active", b.dataset.kind === k);
    for (const e of document.querySelectorAll("#dlgPlan .pl-work")) e.hidden = k === "warmup";
    $("plHint").textContent = t("plHint_" + k, Math.round((data?.graceMin ?? 180) / 60));
  }
  const setRepeat = () => { $("plDateWrap").hidden = $("plRepeat").value !== "once"; };

  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  /** Tek seferlik işin varsayılan tarihi: saat bugün geçmediyse bugün, geçtiyse yarın. */
  function defaultDate(time) {
    const d = new Date(now()), [h, m] = time.split(":").map(Number);
    if (d.getHours() * 60 + d.getMinutes() >= h * 60 + m) d.setDate(d.getDate() + 1);
    return ymd(d);
  }

  async function fillProjects() {
    if (projectsLoaded) return;
    let list = [];
    try { list = await getJson("/api/projects"); } catch { /* öneri listesi boş kalır */ }
    $("plProjects").replaceChildren(...list.map(p => Object.assign(document.createElement("option"), { value: p.cwd })));
    projectsLoaded = list.length > 0;
  }

  function openForm(j) {
    editing = j;
    $("plFormTitle").textContent = t(j ? "plEditTitle" : "plNewTitle");
    $("plErr").textContent = "";
    $("plCwd").value = j?.cwd || "";
    $("plName").value = j?.name || "";
    $("plModel").value = j?.kind !== "warmup" ? j?.model || "" : "";
    $("plPrompt").value = j?.prompt || "";
    $("plTime").value = j?.time || "07:00";
    $("plRepeat").value = j?.repeat || "once";
    $("plDate").value = j?.date || defaultDate($("plTime").value);
    setKind(j?.kind || "session");
    setRepeat();
    $("dlgPlan").showModal();
    fillProjects();
    (kind === "warmup" ? $("plTime") : $("plCwd")).focus();
  }

  async function save(e) {
    e.preventDefault();
    const warm = kind === "warmup";
    const body = { id: editing?.id || "", kind, cwd: warm ? null : $("plCwd").value.trim(), name: $("plName").value.trim() || null,
      prompt: warm ? null : $("plPrompt").value, model: warm ? null : $("plModel").value || null, time: $("plTime").value,
      repeat: $("plRepeat").value, date: $("plRepeat").value === "once" ? $("plDate").value : null, lang: lang() };
    if (!warm && !body.cwd) { $("plErr").textContent = errText("folder"); return; }
    if (!warm && !body.prompt.trim()) { $("plErr").textContent = errText("prompt"); return; }
    const btn = $("plSave");
    btn.disabled = true;
    let r;
    try { r = await api("/api/plans", body); } catch { r = { ok: false, data: null }; }
    btn.disabled = false;
    if (!r.ok) { $("plErr").textContent = errText(r.data?.error); return; }
    $("dlgPlan").close();
    toast(t("plSaved", nameOf(r.data), r.data.nextAt ? nextText(r.data.nextAt) : ""));
    await load();
    reload();
  }

  for (const b of $("plKind").children) b.addEventListener("click", () => setKind(b.dataset.kind));
  $("plRepeat").addEventListener("change", setRepeat);
  $("plTime").addEventListener("change", () => { if (!editing && $("plRepeat").value === "once") $("plDate").value = defaultDate($("plTime").value || "07:00"); });
  $("formPlan").addEventListener("submit", save);
  $("plCancel").addEventListener("click", () => $("dlgPlan").close());

  return { load, list, side, more, openForm };
};
