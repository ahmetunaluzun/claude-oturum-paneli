// Arka plan işi görünürlüğü (sunucu: BackgroundWork.cs). Bir oturum kullanıcıya cevabını bitirince "boşta" görünür ama içinde arka planda
// çalışan alt ajan ya da arka plan komutu sürebilir; paneli yeniden başlatmak/kapatmak onu keser. Burada: kartta ve çekmece başlığında
// "arka planda: N alt ajan" rozeti, alt bilgide tüm panel için tek gösterge ("arka plan işi yok" / sayı) ve "işler bitince yeniden
// başlatılacak · İptal" notu; yeniden başlat/kapat uyarılarının iş listesi (restart.js, app.js kullanır).
(() => {
  "use strict";
  Object.assign(window.I18N.tr, {
    abjAgent1: "{0} alt ajan", abjAgentN: "{0} alt ajan", abjBash1: "{0} komut", abjBashN: "{0} komut",
    abjChip: "arka planda: {0}", abjStaleShort: "takılmış olabilir",
    abjNone: "arka plan işi yok", abjFoot: "arka planda {0} iş", abjFootStale: "{0} tanesi takılmış olabilir",
    abjWaiting: "işler bitince yeniden başlatılacak", abjCancel: "İptal", abjCancelled: "Bekleyen yeniden başlatma iptal edildi.",
    abjKindAgent: "alt ajan", abjKindBash: "komut", abjLine: "{0}: {1} — {2}", abjLineNoLabel: "{0}: {1}",
    abjStaleLine: "{0} (takılmış olabilir)",
    abjChipOne: "arka planda: {0} — {1}",
    abjPopTitle: "Arka planda süren işler",
    abjPopIntro: "Bu oturumlar cevabını bitirmiş görünür ama içlerinde iş sürüyor. Paneli yeniden başlatır ya da kapatırsanız bu işler yarıda kalır; iş bitince buradan kendiliğinden düşer.",
    abjPopAgent: "Alt ajan (Claude'un ayrıca çalıştırdığı yardımcı görev)", abjPopBash: "Arka plan komutu (terminal komutu)",
    abjPopNoLabel: "açıklama yazılmamış", abjPopFor: "{0} önce başladı", abjPopStale: "{0} önce başladı · uzun süredir iz yok, takılmış olabilir",
    abjPopOpen: "Oturumu aç", abjPopNone: "Şu an arka planda süren iş yok."
  });
  Object.assign(window.I18N.en, {
    abjAgent1: "{0} sub-agent", abjAgentN: "{0} sub-agents", abjBash1: "{0} command", abjBashN: "{0} commands",
    abjChip: "in background: {0}", abjStaleShort: "may be stuck",
    abjNone: "no background work", abjFoot: "{0} in background", abjFootStale: "{0} may be stuck",
    abjWaiting: "will restart when the work finishes", abjCancel: "Cancel", abjCancelled: "Pending restart cancelled.",
    abjKindAgent: "sub-agent", abjKindBash: "command", abjLine: "{0}: {1} — {2}", abjLineNoLabel: "{0}: {1}",
    abjStaleLine: "{0} (may be stuck)",
    abjChipOne: "in background: {0} — {1}",
    abjPopTitle: "Work running in the background",
    abjPopIntro: "These sessions look finished but work is still running inside them. Restarting or quitting the panel interrupts it; a job drops off this list by itself when it finishes.",
    abjPopAgent: "Sub-agent (a helper task Claude runs separately)", abjPopBash: "Background command (terminal command)",
    abjPopNoLabel: "no description", abjPopFor: "started {0} ago", abjPopStale: "started {0} ago · no activity for a long time, may be stuck",
    abjPopOpen: "Open session", abjPopNone: "No work is running in the background right now."
  });
})();

window.PanelBgJobs = function (d) {
  "use strict";
  const { t, api, toast, dur, openDrawer, restartError } = d;
  const $ = (id) => document.getElementById(id);
  let waiting = false, lastItems = [], clockSkew = 0; // clockSkew: sunucu saati − bu cihazın saati (uzaktan erişimde telefon saati farklı olabilir)

  /** "1 alt ajan, 2 komut" */
  function parts(jobs) {
    const a = jobs.filter(j => j.kind === "agent").length, b = jobs.length - a;
    return [a ? t(a === 1 ? "abjAgent1" : "abjAgentN", a) : "", b ? t(b === 1 ? "abjBash1" : "abjBashN", b) : ""].filter(Boolean).join(", ");
  }

  /** Kartta/çekmecede kısa metin; iş yoksa "". */
  function chip(jobs) {
    if (!jobs?.length) return "";
    const stale = jobs.some(j => j.stale);
    const head = jobs.length === 1 && jobs[0].label ? t("abjChipOne", parts(jobs), jobs[0].label) : t("abjChip", parts(jobs));
    return head + (stale ? " · " + t("abjStaleShort") : "");
  }

  /** Sunucudan gelen background satırları (oturum adı, tür, etiket) → uyarı penceresi listesi. */
  function lines(list) {
    return (list || []).map(b => {
      const kind = t(b.kind === "agent" ? "abjKindAgent" : "abjKindBash");
      const line = b.label ? t("abjLine", b.session, kind, b.label) : t("abjLineNoLabel", b.session, kind);
      return b.stale ? t("abjStaleLine", line) : line;
    });
  }

  function paintCard(card, s) {
    const el = card.querySelector(".abj-chip");
    if (!el) return;
    const text = chip(s.bgjobs);
    el.hidden = !text;
    el.textContent = text;
    el.dataset.stale = s.bgjobs?.some(j => j.stale) ? "1" : "0";
    el.title = (s.bgjobs || []).map(j => `${t(j.kind === "agent" ? "abjKindAgent" : "abjKindBash")}${j.label ? ": " + j.label : ""}`).join("\n");
  }

  /** Alt bilgi: tüm panel için tek gösterge + bekleyen yeniden başlatma notu. */
  function paintFoot(items, st) {
    const jobs = items.flatMap(s => s.bgjobs || []);
    const el = $("abjFoot");
    if (!el) return;
    const stale = jobs.filter(j => j.stale).length;
    el.textContent = jobs.length ? t("abjFoot", jobs.length) + (stale ? " · " + t("abjFootStale", stale) : "") : t("abjNone");
    el.dataset.has = jobs.length ? "1" : "0";
    lastItems = items;
    if (typeof st?.now === "number") clockSkew = st.now - Date.now();
    if (popOpen()) paintPop(); // açıkken canlı kalsın (süreler, biten işler)
    const wasWaiting = waiting;
    waiting = !!st?.restartWaiting;
    $("abjWait").hidden = !waiting;
    $("abjWaitText").textContent = t("abjWaiting");
    $("abjCancel").textContent = t("abjCancel");
    // Bekleyen yeniden başlatma başlayamadan bitti (yeni panel devralamadı): nedeni bir kez bildir.
    if (wasWaiting && !waiting && st?.restartError) toast(restartError(st.restartError), "warn");
  }

  // ---- Alt bilgideki göstergeye basınca açılan liste: hangi oturumda, ne iş, ne zamandır ----
  const pop = () => $("abjPop");
  const popOpen = () => pop() && !pop().hidden;

  function paintPop() {
    const el = pop();
    if (!el) return;
    const now = Date.now() + clockSkew;
    const withJobs = lastItems.filter(s => s.bgjobs?.length);
    el.replaceChildren();
    const h = document.createElement("h3");
    h.id = "abjPopTitle";
    h.textContent = t("abjPopTitle");
    el.append(h);
    if (!withJobs.length) {
      const p = document.createElement("p");
      p.className = "abj-empty";
      p.textContent = t("abjPopNone");
      el.append(p);
      return;
    }
    const intro = document.createElement("p");
    intro.className = "abj-intro";
    intro.textContent = t("abjPopIntro");
    el.append(intro);
    for (const s of withJobs) {
      const box = document.createElement("div");
      box.className = "abj-sess";
      const name = document.createElement("button");
      name.type = "button";
      name.className = "abj-sname";
      name.textContent = s.name || s.cwd || "?";
      name.title = t("abjPopOpen");
      name.addEventListener("click", () => { closePop(); openDrawer(s); });
      const ul = document.createElement("ul");
      for (const j of s.bgjobs) {
        const li = document.createElement("li");
        li.dataset.stale = j.stale ? "1" : "0";
        const what = document.createElement("span");
        what.className = "abj-what";
        what.textContent = j.label || t("abjPopNoLabel");
        const meta = document.createElement("span");
        meta.className = "abj-meta";
        const ago = dur(Math.max(0, now - j.since));
        meta.textContent = t(j.kind === "agent" ? "abjPopAgent" : "abjPopBash") + " · " + t(j.stale ? "abjPopStale" : "abjPopFor", ago);
        li.append(what, meta);
        ul.append(li);
      }
      box.append(name, ul);
      el.append(box);
    }
  }

  function placePop() {
    const el = pop(), btn = $("abjFoot");
    const r = btn.getBoundingClientRect();
    const w = el.offsetWidth;
    el.style.left = Math.max(12, Math.min(r.left, innerWidth - w - 12)) + "px";
    el.style.bottom = (innerHeight - r.top + 8) + "px";
    el.style.maxHeight = Math.max(160, r.top - 20) + "px";
  }

  function openPop() {
    if ($("abjFoot").dataset.has !== "1") return;
    paintPop();
    pop().hidden = false;
    placePop();
    $("abjFoot").setAttribute("aria-expanded", "true");
  }

  function closePop() {
    if (!popOpen()) return;
    pop().hidden = true;
    $("abjFoot").setAttribute("aria-expanded", "false");
  }

  $("abjFoot")?.addEventListener("click", (e) => { e.stopPropagation(); popOpen() ? closePop() : openPop(); });
  document.addEventListener("click", (e) => { if (popOpen() && !pop().contains(e.target)) closePop(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && popOpen()) { e.stopPropagation(); closePop(); $("abjFoot").focus(); } }, true);
  addEventListener("resize", () => { if (popOpen()) placePop(); });

  $("abjCancel")?.addEventListener("click", async () => {
    const r = await api("/api/restart/cancel", {});
    if (!r.ok) return;
    waiting = false; // not hemen kalksın (sonraki yoklamayı beklemesin)
    $("abjWait").hidden = true;
    toast(t("abjCancelled"));
  });

  return { chip, lines, parts, paintCard, paintFoot };
};
