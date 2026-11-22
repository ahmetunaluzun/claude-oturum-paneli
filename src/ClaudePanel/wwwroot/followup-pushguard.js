// Takip → Git: gizli bilgi engelinin çıkış yolu (0.18.0). Gönderim denetime takılınca satırda bulgular (dosya:satır, kural,
// maskeli ipucu) listelenir ve iki düğme çıkar:
//  - "Claude'a incelet": o depoda panel oturumu açar; istem bulguları (değersiz) taşır, dosyayı/geçmişi değiştirmeyi ve
//    göndermeyi yasaklar.
//  - "Test verisi, yine de gönder": yalnız bulguların hepsi kalıp (anahtar/parola deseni) ise. Onay penceresinden sonra
//    /api/follow/push-allow bulguların parmak izini hatırlar ve gönderir; başka bulgu çıkarsa gönderim yine durur.
// Dosya bulgusu (izin dosyası, .env, anahtar dosyası...) varsa yalnız inceletme ve kısa açıklama.
window.PanelFollowSecret = function (c) {
  "use strict";
  const { t, esc, api, toast, confirmBox, button, startHosted, setView, lang, runJob } = c;
  const SHOWN = 6; // satırda gösterilen bulgu; kalanı "+N bulgu daha" (hepsi onay penceresinde ve inceletme isteminde)

  const blocked = (job) => !!job && job.state === "failed" && job.code === "secret" && (job.findings || []).length > 0;
  const allPattern = (job) => job.findings.every(f => f.kind === "pattern");
  const where = (f) => (f.file || "?") + (f.line ? ":" + f.line : "");
  const rule = (f) => t("fuSec_" + f.what);

  /** İş satırının altındaki bulgu listesi (HTML); engel yoksa boş. */
  function list(job) {
    if (!blocked(job)) return "";
    const fs = job.findings, rows = fs.slice(0, SHOWN).map(f =>
      `<li><span class="fu-secret-where">${esc(where(f))}</span> <span class="fu-secret-rule">${esc(rule(f))}</span>`
      + (f.hint ? ` <span class="fu-secret-hint">${esc(f.hint)}</span>` : "") + "</li>");
    if (fs.length > SHOWN) rows.push(`<li class="fu-secret-more">${esc(t("fuSecMore", fs.length - SHOWN))}</li>`);
    return `<ul class="fu-secret-list">${rows.join("")}</ul>`
      + (allPattern(job) ? "" : `<span class="fu-secret-note">${esc(t("fuSecFileNote"))}</span>`);
  }

  async function review(it, b) {
    const label = b.textContent, lines = it.job.findings.map(f => `- ${where(f)} — ${rule(f)}`).join("\n");
    b.disabled = true;
    b.textContent = t("starting");
    const r = await startHosted({ cwd: it.rootPath, prompt: t("fuSecAskPrompt", lines), resumeId: null, name: t("fuSecAskName", it.title), model: null });
    b.textContent = label;
    if (!r.ok) { b.disabled = false; if (!r.cancelled) toast(t(`err_${r.data?.error || "generic"}`), "warn"); return; }
    if (!r.data?.sent && !r.data?.queued) toast(t("fuSecAskStarted", it.title));
    setView("sessions");
  }

  async function allow(it, b) {
    const fs = it.job.findings;
    const ok = await confirmBox({ title: t("fuSecAllowTitle", it.title), text: t("fuSecAllowText"), okText: t("fuSecAllowGo"), danger: true,
      list: fs.map(f => `${where(f)} — ${rule(f)}${f.hint ? " (" + f.hint + ")" : ""}`) });
    if (!ok) return;
    const r = await runJob(b, "/api/follow/push-allow", { path: it.rootPath, fps: fs.map(f => f.fp) });
    // Bulgular değişmiş (yeni commit): depo yeniden denetlensin; satır güncel bulgularla gelir.
    if (r?.data?.error === "secretchanged") runJob(null, "/api/follow/push", { path: it.rootPath });
  }

  /** Engel varsa sağ düğmeleri koyar → true (çağıran o zaman "Gönder"i koymaz). */
  function side(it, box) {
    if (!blocked(it.job) || !it.rootPath) return false;
    box.appendChild(button(t("fuSecAsk"), (b) => review(it, b), true));
    if (allPattern(it.job)) box.appendChild(button(t("fuSecAllow"), (b) => allow(it, b)));
    return true;
  }

  return { blocked, list, side };
};
