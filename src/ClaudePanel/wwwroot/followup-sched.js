// Takip → Zamanlanmış işler (0.14.0): bilgisayarın zamanlayıcısındaki görevler, Claude'un görev dosyaları, açık oturumlardaki
// tekrarlı işler (/loop, CronCreate, ScheduleWakeup), bulut rutinleri bağlantısı ve verilmiş sözler (NEXT_SESSION.md'deki
// "TAKİP: YYYY-AA-GG — metin" satırları). Sunucu yalnız okur (ScheduledJobs.cs, LoopScan.cs).
// Panel KENDİLİĞİNDEN hiçbir şeyi durdurmaz: "Devre dışı bırak" ve "Durdur" kullanıcının bastığı, onay penceresinden geçen işlemlerdir.
// "Devre dışı bırak" ve "Klasörde göster" yalnız bilgisayarda görünür (telefonda yok; sunucu da reddeder).
// Bilgi satırları (info: true) sekme rozetine ve "Tümü" sayısına girmez; dikkat isteyenler girer: tarihi gelmiş / okunamayan söz,
// son çalışması hatalı görev, üst üste boş dönen ya da kota düşükken süren tekrarlı iş.
window.PanelFollowSched = function (c) {
  "use strict";
  const { t, api, toast, dur, now, low, tag, confirmBox, button, lang, REMOTE, reload } = c;
  const NOOP_WARN = 3; // bu kadar tur üst üste "değişiklik yok" → uyarı
  const DAY = 86_400_000, ROUTINES_URL = "https://claude.ai/code/routines";
  // Görev Zamanlayıcı sonuç kodları (Microsoft Task Scheduler hata ve başarı sabitleri). Listede olmayan kod sayı olarak gösterilir.
  const RESULT = { 0: "ok", 0x41300: "ready", 0x41301: "running", 0x41302: "disabled", 0x41303: "never", 0x41306: "terminated", 0x41325: "queued",
    0x8004131F: "already", 0x800704DD: "nologon", 0x80070002: "nofile", 0x80070005: "denied", 0xC000013A: "closed", 0x800710E0: "refused" };
  const NOT_FAILED = new Set(["ok", "ready", "running", "disabled", "never", "terminated", "queued", "already"]);
  const NOPROJ = "~bilgisayar";
  const locale = () => (lang() === "en" ? "en-GB" : "tr-TR");
  const compact = (n) => new Intl.NumberFormat(locale(), { notation: "compact", maximumFractionDigits: 1 }).format(n);
  const dayOf = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const dateText = (ms) => new Date(ms).toLocaleDateString(locale(), { day: "numeric", month: "short", ...(new Date(ms).getFullYear() !== new Date(now()).getFullYear() ? { year: "numeric" } : {}) });
  const when = (ms) => (ms > now() ? t("fuIn", dur(ms - now())) : t("since", dur(now() - ms)));

  /** Sonuç kodu → { text, failed }. Kod bilinmiyorsa (null) metin "bilinmiyor". */
  function result(code, mac) {
    if (code === null || code === undefined) return { text: t("fuRes_unknown"), failed: false };
    const key = mac ? (code === 0 ? "ok" : null) : RESULT[code];
    if (key) return { text: t("fuRes_" + key), failed: !NOT_FAILED.has(key) };
    return { text: code >= 0 && code <= 0xFFFF ? t("fuRes_exit", code) : t("fuRes_code", "0x" + code.toString(16).toUpperCase()), failed: true };
  }

  function taskItems(os) {
    const mac = os.kind === "mac";
    return os.tasks.map(k => {
      const base = { type: "task", root: k.root ? low(k.root) : NOPROJ, rootPath: k.root || t("fuSchedNoProject"), task: k };
      if (k.unreadable)
        return { ...base, id: "task:" + low(k.id), title: k.name, tags: tag(t("fuUnreadableTag"), "warn"), what: t("fuTaskUnreadable"), sub: k.id, rank: 2, sig: "unreadable" };
      const res = result(k.lastResult, mac), failed = k.enabled && res.failed;
      const tags = tag(t("fuTask_" + os.kind)) + (k.enabled ? "" : tag(t("fuTaskOff"))) + (failed ? tag(t("fuTaskFailed"), "warn") : "");
      const parts = [];
      if (k.schedule) parts.push(k.schedule);
      if (k.enabled && k.nextRun) parts.push(t("fuTaskNext", when(k.nextRun)));
      if (k.lastRun) parts.push(t("fuTaskLast", when(k.lastRun), res.text));
      else if (mac) parts.push(t("fuTaskMacResult", res.text));
      else parts.push(res.text);
      return { ...base, id: "task:" + low(k.id), title: k.name, tags, what: parts.join(" · "), sub: k.command, rank: failed ? 2 : 5, info: !failed,
        cls: k.enabled ? "" : "fu-stale", sig: [k.enabled, failed].join() };
    });
  }

  function fileItems(s) {
    const out = s.files.map(f => ({ id: "sfile:" + low(f.path), type: "sfile", root: low(f.root), rootPath: f.root, title: f.name, tags: tag(t("fuSFileTag")),
      what: t(f.hasJson ? "fuSFileJson" : "fuSFileLock"), sub: f.path, side: t("fuChanged", dur(now() - f.mtime)), reveal: f.path, rank: 5, info: true, sig: String(f.mtime) }));
    for (const d of s.desktop)
      out.push({ id: "sdesk:" + low(d.path), type: "sdesk", root: NOPROJ, rootPath: t("fuSchedNoProject"), title: d.name, tags: tag(t("fuSDeskTag")),
        what: d.prompt || t("fuSDeskNoPrompt"), sub: `${t("fuSDeskWhen")} · ${d.path}`, reveal: d.path, rank: 5, info: true, sig: String(d.mtime) });
    return out;
  }

  function loopItems(snap) {
    const q = snap.quotaLow;
    return (snap.loops || []).map(l => {
      const cron = l.type === "cron", noop = l.noopStreak >= NOOP_WARN, warn = noop || !!q;
      const tags = tag(cron ? l.schedule : t("fuLoopEvery", dur(l.delaySeconds * 1000))) + (cron && !l.recurring ? tag(t("fuLoopOnce")) : "")
        + (l.key ? "" : tag(t("terminal"))) + (noop ? tag(t("fuLoopNoop", l.noopStreak), "warn") : "") + (q ? tag(t("fuLoopQuota"), "warn") : "");
      const facts = [t("fuLoopSince", dur(now() - l.startedAt)), t("fuLoopTokens", compact(l.tokens))];
      if (!cron) facts.push(t("fuLoopRuns", l.runs));
      if (!cron && l.schedule) facts.unshift("/loop " + l.schedule);
      return { id: "loop:" + l.id, type: "loop", root: low(l.root), rootPath: l.root, title: l.name, tags, what: l.prompt || t(cron ? "fuLoopCron" : "fuLoopWake"),
        sub: facts.join(" · "), loop: l, rank: warn ? 1 : 4, info: !warn, sig: [l.noopStreak >= NOOP_WARN, !!q].join() };
    });
  }

  function promiseItems(list) {
    const today = dayOf(now());
    return list.map(p => {
      const base = { type: "promise", root: low(p.root), rootPath: p.root, sub: `${p.file} · ${t("fuLine", p.line)}`, reveal: p.file, promise: p };
      if (p.date === null || p.date === undefined)
        return { ...base, id: "prm:" + low(p.file) + "|?" + p.text, title: t("fuPromiseBad"), tags: tag(t("fuUnreadableTag"), "warn"), what: p.text, rank: 2, sig: p.text };
      const days = Math.round((dayOf(p.date) - today) / DAY), level = days < 0 ? "late" : days === 0 ? "today" : "future";
      const tags = tag(dateText(p.date), level === "late" ? "fu-late" : level === "today" ? "warn" : "")
        + (level === "late" ? tag(t("fuPromiseLate", -days), "fu-late") : level === "today" ? tag(t("fuPromiseToday"), "warn") : "");
      return { ...base, id: "prm:" + low(p.file) + "|" + p.date + "|" + p.text, title: p.text, tags, what: p.name, side: level === "future" ? t("fuPromiseIn", days) : "",
        rank: level === "late" ? 1 : level === "today" ? 1.5 : 5, info: level === "future", cls: level === "late" ? "fu-due" : "", when: p.date, sig: level };
    }).sort((a, b) => a.rank - b.rank || (a.when || 0) - (b.when || 0));
  }

  /** Bölümün öğeleri ve alt notları. Sıra: dikkat isteyenler (rank) → sözler → tekrarlı işler → görevler → dosyalar → bulut. */
  function section(snap, plans = []) {
    const s = snap.sched;
    if (!s) return null;
    const cloud = { id: "cloud:routines", type: "cloud", root: NOPROJ, rootPath: t("fuSchedNoProject"), title: t("fuCloud"), what: t("fuCloudWhat"),
      link: ROUTINES_URL, linkText: t("fuCloudOpen"), rank: 6, info: true, sig: "1" };
    const all = [...plans, ...promiseItems(s.promises), ...loopItems(snap), ...taskItems(s.os), ...fileItems(s), cloud];
    all.forEach((it, i) => { it.order = i; });
    all.sort((a, b) => a.rank - b.rank || a.order - b.order);
    const notes = [];
    if (s.os.state !== "ok") notes.push([t("fuTasksFailed"), true]);
    else if (s.os.kind === "mac" && s.os.tasks.length) notes.push([t("fuTasksMacNote"), true]);
    const q = snap.quotaLow, n = (snap.loops || []).length;
    if (q && n) notes.push([t("fuQuotaLowNote", n, pct(q.fiveLeft), pct(q.weekLeft)), true]);
    return { id: "sched", title: "fuSched", all, notes };
  }
  const pct = (v) => (v === null || v === undefined ? "?" : Math.round(v));

  async function disable(it, btn) {
    const k = it.task;
    const ok = await confirmBox({ title: t("fuTaskOffTitle", k.name), text: t("fuTaskOffText"), okText: t("fuTaskOffBtn"), list: [k.command] });
    if (!ok) return;
    btn.disabled = true;
    let r;
    try { r = await api("/api/schedule/disable", { id: k.id }); } catch { r = { ok: false, data: null }; }
    if (!r.ok) { btn.disabled = false; toast(t(`err_${r.data?.error || "generic"}`), "warn"); return; }
    toast(t("fuTaskOffDone", k.name));
    reload();
  }

  async function stop(it, btn) {
    const l = it.loop;
    const ok = await confirmBox({ title: t("fuLoopStopTitle", l.name), text: t("fuLoopStopText"), okText: t("fuLoopStop") });
    if (!ok) return;
    btn.disabled = true;
    let r;
    try { r = await api("/api/schedule/stop", { key: l.key, lang: lang() }); } catch { r = { ok: false, data: null }; }
    if (!r.ok) { btn.disabled = false; toast(t(`err_${r.data?.error || "generic"}`), "warn"); return; }
    toast(t(r.data?.queued ? "fuLoopStopQueued" : "fuLoopStopSent", l.name));
    setTimeout(reload, 4000);
  }

  /** Sağdaki tek düğme: görevde "Devre dışı bırak" (yalnız bilgisayarda), panel oturumundaki döngüde "Durdur"; terminalde bilgi. */
  function side(it, box) {
    if (it.type === "task" && !REMOTE && it.task.enabled && it.task.canDisable && !it.task.unreadable)
      box.appendChild(button(t("fuTaskOffBtn"), (b) => disable(it, b)));
    if (it.type === "loop") {
      if (it.loop.key) box.appendChild(button(t("fuLoopStop"), (b) => stop(it, b), it.rank === 1));
      else { const s = document.createElement("small"); s.className = "fu-termhint"; s.textContent = t("fuLoopTerminal"); box.appendChild(s); }
    }
  }

  async function reveal(path) {
    const r = await api("/api/reveal", { path });
    if (!r.ok) toast(t("pathMissing"), "warn");
  }

  /** Açılan ayrıntıdaki ek düğme: Klasörde göster (yalnız bilgisayardan). */
  function more(it, box) {
    if (REMOTE) return;
    const target = it.type === "task" ? it.task.reveal : it.reveal;
    if (target) box.appendChild(button(t("fuReveal"), () => reveal(target)));
  }

  return { section, side, more };
};
