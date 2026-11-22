// Takip → Mail ve Takvim (sunucu: Mail/MailWatch.cs; YALNIZ OKUR, yalnız başlık meta verisi). Mail satırı = süzgece uyan konuşmanın
// en yeni gelen mesajı; süzgeç Ayarlar'da (settings-mail.js), yereldir. "Cevap bekliyor" (son mesaj bende değil, ben alıcıyım,
// sonra cevap yazmadım) öne çıkar, rozete ve "Tümü" sayısına girer; diğerleri sakin bilgi satırıdır. Takvim: önümüzdeki 24 saatin
// etkinlikleri (bilgi satırı; 30 dakika içinde başlayan "yakında"). Gizlenen mail satırı konuşmaya yeni mesaj gelince geri gelir
// (imza = en yeni mesaj kimliği); etkinlik değişince (updated) geri gelir. "Gmail'de aç" / "Takvimde aç" / "Katıl" tarayıcıda açar.
window.PanelFollowMail = function (c) {
  "use strict";
  const { t, api, dur, now, low, tag, lang } = c;
  const SOON_MS = 30 * 60_000;
  const multi = (m) => (m.accounts || []).length > 1;

  const hm = (ms) => new Date(ms).toLocaleTimeString(lang() === "tr" ? "tr-TR" : "en-GB", { hour: "2-digit", minute: "2-digit" });
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
  const clock = (ms) => sameDay(ms, now()) ? hm(ms) : t("fuCalTomorrow", hm(ms));

  function mailItems(m) {
    return m.mails.map(x => {
      const from = x.fromName && x.fromName !== x.fromAddr ? `${x.fromName} <${x.fromAddr}>` : x.fromAddr;
      const rules = x.rules.filter(r => r !== "awaiting").map(r => tag(t("fuMailRule_" + r))).join("");
      const age = dur(Math.max(0, now() - x.date));
      return { id: "mail:" + low(x.account) + ":" + x.threadId, type: "mail", root: "~mail", rootPath: t("fuMail"),
        title: x.subject || t("fuMailNoSubject"), tags: (x.awaiting ? tag(t("fuMailAwaiting"), "warn") : "") + rules,
        what: [from, multi(m) ? x.account : null].filter(Boolean).join(" · "), side: t(x.awaiting ? "fuMailWaitFor" : "since", age),
        link: x.url, linkText: t("fuMailOpen"), rank: x.awaiting ? 1.6 : 5.5, info: !x.awaiting, sig: x.id, mail: x };
    });
  }

  function calItems(m) {
    const n = now();
    return m.events.map(e => {
      const live = e.start <= n, soon = !live && e.start - n <= SOON_MS;
      const when = e.allDay ? t("fuCalAllDay") : `${clock(e.start)}–${hm(e.end || e.start)}`;
      return { id: "cal:" + low(e.account) + ":" + e.id, type: "cal", root: "~cal", rootPath: t("fuCal"),
        title: e.title || t("fuMailNoSubject"), tags: !e.allDay && (live || soon) ? tag(t(live ? "fuCalNow" : "fuCalSoon"), "warn") : "",
        what: [when, e.location, multi(m) ? e.account : null].filter(Boolean).join(" · "),
        side: e.allDay || live ? "" : t("fuCalIn", dur(e.start - n)), link: e.url, linkText: t("fuCalOpen"),
        rank: 5 + Math.min(1, Math.max(0, e.start - n) / 86_400_000), info: true, sig: `${e.updated}|${e.start}`, cal: e };
    });
  }

  /** Hesap durumları: istemci yok (yalnız Google girişi), yeniden giriş / şifre, IMAP kapalı, takvim adresi, güncellenemedi, denetleniyor. */
  function accountNotes(m) {
    const notes = [];
    for (const a of m.accounts) {
      const imap = a.provider === "imap";
      if (a.state === "noclient") notes.push([t("fuMailNoClient"), true]);
      else if (a.state === "reauth") notes.push([t(imap ? "fuMailI_reauth" : "fuMailReauth", a.email), true]);
      else if (imap && (a.state === "disabled" || a.state === "domain" || a.state === "icaldenied")) notes.push([t("fuMailI_" + a.state, a.email), true]);
      else if (a.state === "net" && a.okAt) notes.push([t("fuMailStale", a.email, dur(now() - a.okAt)), true]);
      else if (a.state === "net") notes.push([t("fuMailNet", a.email), true]);
      else if (a.state === "pending") notes.push([t("fuMailPending"), true]);
      if (m.filterAwaiting && a.mail && !a.awaitingOk && a.state === "ok") notes.push([t("fuMailNoAwaiting", a.email), false]);
    }
    return notes;
  }

  /** Bölümler: [Mail, Takvim]; kaynak açık değilse o bölüm (ve çipi) yok. */
  function sections(snap) {
    const m = snap.mail;
    if (!m || m.state === "off") return [];
    const ago = dur(Math.max(0, now() - m.checkedAt)), checked = m.checkedAt > 0;
    const out = [];
    if (m.mailOn) {
      const notes = accountNotes(m), all = mailItems(m);
      for (const a of m.accounts) if (a.mail && a.truncated) notes.push([t("fuMailTruncated", a.email, a.truncated), false]);
      if (m.filterEmpty) notes.unshift([t("fuMailFilterEmpty"), true]);
      else if (checked && !m.stale) notes.push([t(all.length ? "fuMailChecked" : "fuMailNone", ago), false]); // bayatsa "güncellenemedi" notu yeter
      out.push({ id: "mail", title: "fuMail", all, notes });
    }
    if (m.calOn) {
      const notes = accountNotes(m), all = calItems(m);
      if (checked && !all.length) notes.push([t("fuCalNone", ago), false]);
      out.push({ id: "cal", title: "fuCal", all, notes });
    }
    return out;
  }

  /** Sağda: etkinlikte toplantı bağlantısı varsa "Katıl" (öne çıkan). "Gmail'de aç" / "Takvimde aç" bağlantısını satır çizimi ekler. */
  function side(it, box) {
    if (it.type !== "cal" || !it.cal.join) return;
    const a = document.createElement("a");
    a.className = "btn small primary";
    a.textContent = t("fuCalJoin");
    a.href = it.cal.join; a.target = "_blank"; a.rel = "noopener";
    a.addEventListener("click", (e) => e.stopPropagation());
    box.appendChild(a);
  }

  /** "Yenile": mail ve takvim de şimdi denetlenir (olağan aralık 10 dakika). */
  async function poke() {
    try { await api("/api/mail/refresh", {}); } catch { /* bağlantı yok: tarama zaten hata gösterir */ }
  }

  return { sections, side, poke };
};
