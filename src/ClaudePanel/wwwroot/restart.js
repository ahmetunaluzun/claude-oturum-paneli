// Paneli yeniden başlat (Ayarlar düğmesi, Takip → Güncellemeler'deki "Yeni sürüm hazır" satırı). Sunucu: Restart.cs.
// Yalnız panelde çalışan oturum yokken; varsa adları gösterilir, bilgisayarda onaylı "Yine de yeniden başlat" (telefonda yok).
// Başarıda tam ekran "Yeniden başlatılıyor…" katmanı: /api/version yoklanır, açılış kimliği (boot) değişince sayfa yenilenir.
// 60 sn'de gelmezse ya da yeni süreç devralamazsa (restartError) hata metni + "Yeniden dene".
(() => {
  "use strict";
  Object.assign(window.I18N.tr, {
    rsGo: "Paneli yeniden başlat", rsGoNew: "Yeniden başlat",
    rsTitle: "Panel yeniden başlatılsın mı?",
    rsText: "Panel kapanıp hemen yeniden açılır. Açık oturumlar kaldığı yerden geri gelir, bu pencere kendini yeniler.",
    rsTextNew: "Çalışan sürüm v{0}, diskteki yeni sürüm v{1}. Panel kapanıp yeni sürümle açılır; açık oturumlar kaldığı yerden geri gelir.",
    rsBusyTitle: "Panelde çalışan oturum var",
    rsBusy: "Şu oturumlar şu an çalışıyor. Yeniden başlatırsanız işleri yarıda kalır (konuşma kaybolmaz, panel açılınca geri gelir).",
    rsBusyGo: "Yine de yeniden başlat",
    rsBusyPhone: "Şu oturumlar şu an çalışıyor. İşleri bitince yeniden deneyin.",
    rsReady: "Yeni sürüm hazır (v{0}). Yeniden başlatınca açılır.",
    rsReadyTitle: "Yeni sürüm hazır: v{0}", rsReadyWhat: "Çalışan v{0} · yeniden başlatınca yeni sürüm açılır",
    rsWaitTitle: "Yeniden başlatılıyor…", rsWaitText: "Panel kapanıp yeniden açılıyor. Bu pencere kendiliğinden yenilenecek.",
    rsErrTitle: "Panel yeniden başlatılamadı", rsRetry: "Yeniden dene", rsClose: "Kapat",
    rsErr_timeout: "Panel 60 saniyede geri gelmedi. Biraz bekleyip yeniden deneyin; açılmazsa kısayoldan açın.",
    rsErr_busy: "Bu arada bir oturum çalışmaya başladı; panel kapatılmadı. İş bitince yeniden deneyin.",
    rsErr_token: "Yeni panel eskisini kapatamadı (anahtar dosyası yok); panel açık kaldı.",
    rsErr_quit: "Eski panel kapatma isteğini reddetti; panel açık kaldı.",
    rsErr_exited: "Yeni panel açılamadı; çalışan panel açık kaldı.",
    rsErr_noexe: "Panelin programı diskte bulunamadı; çalışan panel açık kaldı.",
    rsErr_start: "Yeni panel başlatılamadı; çalışan panel açık kaldı.",
    rsErr_restarting: "Yeniden başlatma zaten sürüyor.",
    rsErr_offline: "Panele ulaşılamıyor."
  });
  Object.assign(window.I18N.en, {
    rsGo: "Restart panel", rsGoNew: "Restart",
    rsTitle: "Restart the panel?",
    rsText: "The panel closes and opens again right away. Open sessions come back where they were; this window reloads itself.",
    rsTextNew: "Running v{0}, new version on disk v{1}. The panel closes and opens with the new version; open sessions come back where they were.",
    rsBusyTitle: "A panel session is working",
    rsBusy: "These sessions are working right now. Restarting interrupts them (conversations are kept and come back when the panel opens).",
    rsBusyGo: "Restart anyway",
    rsBusyPhone: "These sessions are working right now. Try again when they finish.",
    rsReady: "New version ready (v{0}). It opens when you restart.",
    rsReadyTitle: "New version ready: v{0}", rsReadyWhat: "Running v{0} · restart to open the new version",
    rsWaitTitle: "Restarting…", rsWaitText: "The panel is closing and opening again. This window reloads by itself.",
    rsErrTitle: "Couldn't restart the panel", rsRetry: "Try again", rsClose: "Close",
    rsErr_timeout: "The panel didn't come back in 60 seconds. Wait a moment and try again; if it doesn't open, use the shortcut.",
    rsErr_busy: "A session started working meanwhile; the panel wasn't closed. Try again when it finishes.",
    rsErr_token: "The new panel couldn't close the old one (no key file); the panel stays open.",
    rsErr_quit: "The old panel refused to close; the panel stays open.",
    rsErr_exited: "The new panel didn't open; the running panel stays open.",
    rsErr_noexe: "The panel program wasn't found on disk; the running panel stays open.",
    rsErr_start: "The new panel couldn't be started; the running panel stays open.",
    rsErr_restarting: "A restart is already in progress.",
    rsErr_offline: "Can't reach the panel."
  });
})();

window.PanelRestart = function (d) {
  "use strict";
  const { t, api, getJson, confirmBox, ask, REMOTE } = d;
  const WAIT_MS = 60_000, POLL_MS = 800, CHECK_MS = 5 * 60_000;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const subs = [];
  let info = null, layer = null;

  async function check() {
    try { info = await getJson("/api/version"); } catch { return info; }
    subs.forEach(f => f(info));
    return info;
  }
  const disk = () => info?.diskVersion || null;
  const errText = (code) => { const k = "rsErr_" + code; return t(k) !== k ? t(k) : t("rsErr_exited"); };

  /** Onay → istek → bekleme katmanı. */
  async function run() {
    await check();
    const dv = disk();
    if (!await confirmBox({ title: t("rsTitle"), text: dv ? t("rsTextNew", info.version, dv) : t("rsText"), okText: t("rsGo") })) return;
    await start(false);
  }

  async function start(force) {
    const boot = (await check())?.boot;
    let r = await api("/api/restart" + (force ? "?force=1" : ""));
    if (r.status === 409 && r.data?.error === "busy") {
      hide();
      const list = r.data.sessions || [];
      if (REMOTE) { await ask(t("rsBusyTitle"), t("rsBusyPhone"), list, [{ value: "ok", label: t("ok"), cls: "primary" }]); return; }
      if (!await confirmBox({ title: t("rsBusyTitle"), text: t("rsBusy"), list, okText: t("rsBusyGo"), danger: true })) return;
      return start(true);
    }
    // Ağ hatası: eski süreç tam o anda kapanmış olabilir → yine yeni süreci bekle.
    if (!r.ok && r.data?.error !== "offline") { show("error", errText(r.data?.error || "exited"), force); return; }
    show("wait");
    const until = Date.now() + WAIT_MS;
    while (Date.now() < until) {
      await sleep(POLL_MS);
      let v;
      try { v = await getJson("/api/version"); } catch { continue; } // kapalı: yeni süreç açılıyor
      if (boot && v.boot !== boot) { location.reload(); return; }
      if (v.restartError) { show("error", errText(v.restartError), force); return; }
    }
    show("error", t("rsErr_timeout"), force);
  }

  function hide() { layer?.remove(); layer = null; }

  /** Tam ekran katman. Ayarlar penceresi tarayıcının üst katmanında: önce kapatılır, yoksa katman onun altında kalır. */
  function show(kind, text, force) {
    document.querySelectorAll("dialog[open]").forEach(x => x.close());
    hide();
    layer = document.createElement("div");
    layer.className = "rs-layer";
    layer.setAttribute("role", kind === "wait" ? "status" : "alertdialog");
    layer.setAttribute("aria-live", "polite");
    const box = document.createElement("div");
    box.className = "rs-box " + kind;
    const h = document.createElement("h2");
    h.textContent = kind === "wait" ? t("rsWaitTitle") : t("rsErrTitle");
    const p = document.createElement("p");
    p.textContent = kind === "wait" ? t("rsWaitText") : text;
    if (kind === "wait") box.appendChild(Object.assign(document.createElement("span"), { className: "rs-spin" }));
    box.append(h, p);
    if (kind === "error") {
      const row = document.createElement("div");
      row.className = "rs-actions";
      const close = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: t("rsClose") });
      close.addEventListener("click", hide);
      const retry = Object.assign(document.createElement("button"), { type: "button", className: "btn primary", textContent: t("rsRetry") });
      retry.addEventListener("click", () => start(!!force));
      row.append(close, retry);
      box.appendChild(row);
    }
    layer.appendChild(box);
    document.body.appendChild(layer);
    layer.querySelector(".btn.primary")?.focus();
  }

  /** Ayarlar'daki düğme ve "Yeni sürüm hazır" notu. */
  function paintSettings() {
    const dv = disk(), btn = document.getElementById("btnRestart"), note = document.getElementById("rsReady");
    if (!btn) return;
    btn.classList.toggle("primary", !!dv);
    btn.dataset.i18n = dv ? "rsGoNew" : "rsGo"; // dil değişince applyI18n doğru metni yazsın
    btn.textContent = t(btn.dataset.i18n);
    note.hidden = !dv;
    note.textContent = dv ? t("rsReady", dv) : "";
  }

  document.getElementById("btnRestart")?.addEventListener("click", run);
  document.getElementById("btnSettings")?.addEventListener("click", () => { paintSettings(); check(); });
  subs.push(paintSettings);
  check();
  setInterval(check, CHECK_MS);

  return { run, check, disk, current: () => info?.version || null, subscribe: (f) => subs.push(f), paintSettings };
};
