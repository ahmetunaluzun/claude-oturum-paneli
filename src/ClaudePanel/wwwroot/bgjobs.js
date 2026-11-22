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
    abjStaleLine: "{0} (takılmış olabilir)"
  });
  Object.assign(window.I18N.en, {
    abjAgent1: "{0} sub-agent", abjAgentN: "{0} sub-agents", abjBash1: "{0} command", abjBashN: "{0} commands",
    abjChip: "in background: {0}", abjStaleShort: "may be stuck",
    abjNone: "no background work", abjFoot: "{0} in background", abjFootStale: "{0} may be stuck",
    abjWaiting: "will restart when the work finishes", abjCancel: "Cancel", abjCancelled: "Pending restart cancelled.",
    abjKindAgent: "sub-agent", abjKindBash: "command", abjLine: "{0}: {1} — {2}", abjLineNoLabel: "{0}: {1}",
    abjStaleLine: "{0} (may be stuck)"
  });
})();

window.PanelBgJobs = function (d) {
  "use strict";
  const { t, api, toast, restartError } = d;
  const $ = (id) => document.getElementById(id);
  let waiting = false;

  /** "1 alt ajan, 2 komut" */
  function parts(jobs) {
    const a = jobs.filter(j => j.kind === "agent").length, b = jobs.length - a;
    return [a ? t(a === 1 ? "abjAgent1" : "abjAgentN", a) : "", b ? t(b === 1 ? "abjBash1" : "abjBashN", b) : ""].filter(Boolean).join(", ");
  }

  /** Kartta/çekmecede kısa metin; iş yoksa "". */
  function chip(jobs) {
    if (!jobs?.length) return "";
    const stale = jobs.some(j => j.stale);
    return t("abjChip", parts(jobs)) + (stale ? " · " + t("abjStaleShort") : "");
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
    const wasWaiting = waiting;
    waiting = !!st?.restartWaiting;
    $("abjWait").hidden = !waiting;
    $("abjWaitText").textContent = t("abjWaiting");
    $("abjCancel").textContent = t("abjCancel");
    // Bekleyen yeniden başlatma başlayamadan bitti (yeni panel devralamadı): nedeni bir kez bildir.
    if (wasWaiting && !waiting && st?.restartError) toast(restartError(st.restartError), "warn");
  }

  $("abjCancel")?.addEventListener("click", async () => {
    const r = await api("/api/restart/cancel", {});
    if (!r.ok) return;
    waiting = false; // not hemen kalksın (sonraki yoklamayı beklemesin)
    $("abjWait").hidden = true;
    toast(t("abjCancelled"));
  });

  return { chip, lines, parts, paintCard, paintFoot };
};
