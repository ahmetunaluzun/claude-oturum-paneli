// "Maillerimi özetle" (0.25.0; sunucu Mail/MailSummary.cs, POST /api/mail-summary): mail ve takvim Claude hesabının claude.ai
// Google bağlayıcısıyla okunur, panelde kurulum yok. Birden çok Claude hesabı varsa önce hangisi sorulur (bağlayıcı hesap
// başınadır); tek hesapta sormaz. Oturum panelde açılır, çekmecede izlenir; Claude yalnız okur.
// Düğmeler: Takip başlığı (btnFuMail), Ayarlar → Mail ve takvim (btnSetMail).
window.PanelMailSummary = function (c) {
  "use strict";
  const { t, api, ask, accounts, accountName, toast, lang, open } = c;
  const $ = (id) => document.getElementById(id);
  let busy = false;

  async function pick() {
    const list = accounts();
    if (list.length < 2) return null;
    const buttons = list.map((a, i) => ({ value: a.id, label: accountName(a), cls: i === 0 ? "primary" : "" }));
    const v = await ask(t("msPickTitle"), t("msPickText"), null, buttons, { focus: buttons[0].value });
    return v === "cancel" ? undefined : v;
  }

  async function run() {
    if (busy) return;
    const account = await pick();
    if (account === undefined) return;
    busy = true;
    let r;
    try { r = await api("/api/mail-summary", { account, lang: lang() }); } catch { r = { ok: false }; }
    finally { busy = false; }
    if (!r.ok || !r.data?.key) { toast(t("msFail"), "warn"); return; }
    toast(t("msStarted"));
    open(r.data.key, r.data.cwd, t("msBtn"));
  }

  for (const id of ["btnFuMail", "btnSetMail"]) $(id)?.addEventListener("click", run);
  return { run };
};
