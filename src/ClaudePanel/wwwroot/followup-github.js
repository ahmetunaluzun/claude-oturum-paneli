// Takip → GitHub: kullanıcının kendi depolarındaki açık issue ve PR'lar (sunucu: GitHubWatch.cs, GitHub CLI `gh` ile, YALNIZ OKUR).
// "Cevap bekliyor" = son söz kullanıcıda değil (başkası açmış ve yorum yok, ya da son yorumu başkası yazmış): öne çıkar, rozete
// ve "Tümü" sayısına girer. Son söz kullanıcıdaysa (ya da kendi açtığı yorumsuz issue) sakin bilgi satırıdır.
// Gizlenen satır yeni hareketle (updated_at ilerleyince) geri gelir: imza = son hareket zamanı.
// "Oturumda ele al" yalnız depo bilinen bir yerel klasörle eşleşiyorsa görünür; oturum inceler ve cevap TASLAĞI önerir,
// GitHub'a yazmaz (istemde açıkça yasak). Panel de GitHub'a hiçbir şey göndermez.
// Ayarlar'daki aç/kapat anahtarı da burada (sunucuda kalıcı: /api/github).
window.PanelFollowGithub = function (c) {
  "use strict";
  const { t, api, getJson, toast, dur, now, low, tag, button, startHosted, setView, reload } = c;
  const $ = (id) => document.getElementById(id);
  const started = new Set(); // bu sayfada "Oturumda ele al" ile oturum başlatılan öğeler

  function items(g) {
    return g.items.map(i => {
      const facts = [i.repo, t("fuGhBy", i.author), t(i.comments ? "fuGhComments" : "fuGhNoComments", i.comments)];
      if (i.comments && i.lastBy) facts.push(t("fuGhLast", i.lastBy));
      return { id: "gh:" + low(i.repo) + "#" + i.number, type: "gh", root: i.root ? low(i.root) : "~gh:" + low(i.repo), rootPath: i.root || i.repo,
        title: `#${i.number} ${i.title}`, tags: tag(t(i.pr ? "fuGhPr" : "fuGhIssue")) + (i.waiting ? tag(t("fuGhWaiting"), "warn") : ""),
        what: facts.join(" · "), sub: i.url, side: t("since", dur(Math.max(0, now() - i.updatedAt))), link: i.url, linkText: t("fuGhOpen"),
        rank: i.waiting ? 1.5 : 5, info: !i.waiting, sig: String(i.updatedAt), gh: i };
    }).sort((a, b) => a.rank - b.rank || b.gh.updatedAt - a.gh.updatedAt);
  }

  /** Bölüm: öğeler + durum notu (gh yok / giriş yok / güncellenemedi). Kapalıysa bölüm yok. */
  function section(snap) {
    const g = snap.github;
    if (!g || g.state === "off") return null;
    const notes = [];
    if (g.state === "nogh") notes.push([t("fuGhNoCli"), true]);
    else if (g.state === "noauth") notes.push([t("fuGhNoAuth"), true]);
    else if (g.state === "pending") notes.push([t("fuGhPending"), true]);
    else if (g.state === "failed") notes.push([t("fuGhFailed"), true]);
    else if (g.stale) notes.push([t("fuGhStale", dur(now() - g.checkedAt)), true]);
    else notes.push([t(g.items.length ? "fuGhChecked" : "fuGhNone", g.login, dur(Math.max(0, now() - g.checkedAt))), false]);
    return { id: "github", title: "fuGithub", all: g.state === "ok" ? items(g) : [], notes };
  }

  async function handle(it, btn) {
    const g = it.gh, label = btn.textContent;
    btn.disabled = true;
    btn.textContent = t("starting");
    const r = await startHosted({ cwd: g.root, prompt: t(g.pr ? "fuGhPromptPr" : "fuGhPromptIssue", g.url), resumeId: null, name: `GitHub #${g.number}`, model: null });
    btn.textContent = label;
    if (!r.ok) { btn.disabled = false; if (!r.cancelled) toast(t(`err_${r.data?.error || "generic"}`), "warn"); return; }
    started.add(it.id);
    if (!r.data?.sent && !r.data?.queued) toast(t("fuGhStarted", `#${g.number}`));
    setView("sessions");
  }

  function handleButton(it, primary) {
    const b = button(t("fuGhHandle"), (x) => handle(it, x), primary);
    b.disabled = started.has(it.id);
    return b;
  }

  /** Sağda: cevap bekleyen ve yerel klasörü bilinen öğede "Oturumda ele al" ("GitHub'da aç" bağlantısını satır çizimi ekler). */
  function side(it, box) {
    if (it.type === "gh" && it.gh.waiting && it.gh.root) box.appendChild(handleButton(it, true));
  }

  /** Açılan ayrıntıda: sakin satır için de "Oturumda ele al". */
  function more(it, box) {
    if (it.type === "gh" && !it.gh.waiting && it.gh.root) box.appendChild(handleButton(it, false));
  }

  /** "Yenile" düğmesi: GitHub da şimdi denetlenir (olağan aralık 15 dakika). */
  async function poke() {
    try { await api("/api/github/refresh", {}); } catch { /* bağlantı yok: tarama zaten hata gösterir */ }
  }

  // ---- Ayarlar: aç/kapat ----
  function fill(st) {
    $("sGithub").checked = !!st?.enabled;
    $("sGithubState").textContent = !st?.enabled ? t("sGithubOff") : st.state === "nogh" ? t("fuGhNoCli") : st.state === "noauth" ? t("fuGhNoAuth")
      : st.login ? t("sGithubOn", st.login) : t("sGithubHint");
  }
  $("btnSettings").addEventListener("click", async () => {
    try { fill(await getJson("/api/github")); } catch { /* bağlantı yok: eldeki kalır */ }
  });
  $("sGithub").addEventListener("change", async (e) => {
    const on = e.target.checked;
    e.target.disabled = true;
    let r;
    try { r = await api("/api/github", { enabled: on }); } catch { r = { ok: false }; }
    e.target.disabled = false;
    if (!r.ok) { e.target.checked = !on; toast(t("err_generic"), "warn"); return; }
    fill(r.data);
    reload();
  });

  return { section, side, more, poke };
};
