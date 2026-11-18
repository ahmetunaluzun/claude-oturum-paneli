// Takip → Drive bölümü: projelerdeki güncelleme kütüklerinde (GUNCELLEME_KUTUGU.md) "Drive'a yüklenecek" diye AÇIK duran dosyalar.
// Sunucu kütüğü yalnız okur (DriveLedger.cs). "Yükledim" yerel bir işarettir (dosya yeniden üretilirse satır geri gelir);
// "Kütüğü kapat" işaretlenen dosyaları gizli bir arka plan oturumuna bildirir, kütüğü o oturum günceller (/api/follow/ledger).
window.PanelFollowDrive = function (c) {
  "use strict";
  const { t, api, toast, dur, now, low, tag, jobOf, isActive, runJob, confirmBox, button, S, REMOTE, rerender } = c;
  const OLD_MS = 3 * 86_400_000;
  const dirOf = (p) => String(p).replace(/[\\/][^\\/]*$/, "");

  function items(snap, jobs) {
    const out = [], ledgers = new Map();
    for (const d of snap.drive || []) {
      const key = low(d.ledger), since = d.since || d.mtime || 0, age = since ? now() - since : 0, old = age >= OLD_MS;
      const base = { type: "drive", root: low(d.root), rootPath: d.root, drive: d, rank: old ? 2 : 3, old, side: since ? t("fuWaiting", dur(age)) : "", mtime: d.mtime };
      if (!d.path) {
        out.push({ ...base, id: "drv:" + key + "|?" + d.text, title: t("fuUnreadable"), tags: tag(t("fuUnreadableTag"), "warn"), what: d.text,
          sub: `${d.ledger} · ${t("fuLine", d.line)}`, unreadable: true, sig: d.text });
        continue;
      }
      const tags = (d.version ? tag("v" + d.version) : "") + (d.extras.length ? tag(t("fuExtras", d.extras.length)) : "") + (d.exists ? "" : tag(t("fuMissing"), "warn"));
      const it = { ...base, id: "drv:" + key + "|" + low(d.path), title: d.file, tags, what: `${d.name} · ${d.section}`,
        sub: [d.path, ...d.extras].join(" + "), sig: [d.mtime, d.version, d.exists].join() };
      out.push(it);
      ledgers.set(key, [...(ledgers.get(key) || []), it]);
    }
    // Kütük satırı: "Yükledim" denmiş dosyası olan kütük (kütükte hâlâ AÇIK duruyorlar) → "Kütüğü kapat".
    for (const [key, rows] of ledgers) {
      const up = rows.filter(r => S.state.uploaded[r.id] === r.mtime);
      if (!up.length) continue;
      const d = rows[0].drive, job = jobOf(d.ledger);
      out.push({ id: "led:" + key, type: "ledger", root: low(d.root), rootPath: d.root, rank: job && !isActive(job) && job.state !== "done" ? 1 : 3,
        title: d.name, tags: tag(t("fuLedgerTag")), what: t("fuLedgerWhat", up.length), sub: d.ledger, ledger: d.ledger, files: up, job,
        sig: [up.length, job?.state, job?.updatedAt].join() });
    }
    // Biten kütük işi: kütük satırı kalmadıysa (dosyalar kütükten çıktı) sonuç ayrı satırda, "Tamam" ile kapanır.
    const seen = new Set();
    for (const j of jobs) for (const i of j.items) {
      const key = low(i.root);
      if (i.kind !== "ledger" || seen.has(key) || ledgers.has(key) && out.some(x => x.id === "led:" + key)) continue;
      const latest = jobOf(i.root);
      if (!latest || latest.jobId !== j.id) continue;
      seen.add(key);
      const proj = (snap.drive || []).find(d => low(d.ledger) === key)?.root || dirOf(i.root);
      out.push({ id: "job:" + j.id + "|" + key, type: "job", root: key, proj: low(proj), rootPath: proj, rank: latest.state === "done" ? 4 : 1, title: i.name,
        tags: tag(t("fuLedgerTag")), sub: i.root, job: latest, result: true, sig: [latest.state, latest.updatedAt].join() });
    }
    return out;
  }

  async function reveal(path) {
    const r = await api("/api/reveal", { path });
    if (!r.ok) toast(t("pathMissing"), "warn");
  }

  /** Sağdaki tek düğme: dosya satırında "Yükledim", kütük satırında "Kütüğü kapat". */
  function side(it, box, snap) {
    if (it.type === "drive" && !it.unreadable)
      box.appendChild(button(t("fuUploaded"), () => { S.upload(it); toast(t("fuUploadedToast", it.title)); rerender(); }, true));
    const job = it.job, stale = job?.state === "done" && job.updatedAt > snap.checkedAt;
    if (it.type === "ledger" && !(job && isActive(job)) && !stale)
      box.appendChild(button(t("fuLedgerClose"), async (b) => {
        const ok = await confirmBox({ title: t("fuLedgerTitle", it.title), text: t("fuLedgerText"), okText: t("fuLedgerGo"), list: it.files.map(f => f.title) });
        if (ok) runJob(b, "/api/follow/ledger", { ledger: it.ledger, files: it.files.map(f => f.drive.path) });
      }, true));
  }

  /** Açılan ayrıntıdaki ek düğme: Klasörde göster (yalnız bilgisayardan). */
  function more(it, box) {
    if (REMOTE || (it.type !== "drive" && it.type !== "ledger")) return;
    const target = it.type === "ledger" || it.unreadable ? it.ledger || it.drive.ledger : it.drive.exists ? it.drive.path : dirOf(it.drive.path);
    box.appendChild(button(t(it.unreadable || it.type === "ledger" ? "fuShowLedger" : "fuReveal"), () => reveal(target)));
  }

  return { items, side, more };
};
