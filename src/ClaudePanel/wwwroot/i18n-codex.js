// Codex oturumları metinleri (codex.js): Oturumlar'daki Codex şeridi, Son oturumlar, okuma görünümü, üst çubuktaki kota.
// i18n.js'ten sonra yüklenir, aynı sözlüğe eklenir.
(() => {
  "use strict";
  Object.assign(window.I18N.tr, {
    codexLane: "Codex", codexBadge: "Codex",
    codexLaneHint: "Codex CLI oturumları · yalnız izlenir, panelden mesaj gönderilmez",
    codexWorking: "çalışıyor", codexOpen: "açık", codexEnded: "kapalı", codexLastWrite: "son yazma {0} önce",
    codexOpenFolder: "Klasörü aç", codexCopyResume: "Devam komutunu kopyala", codexCopied: "Panoya kopyalandı: {0}",
    codexCopyTitle: "Devam komutu", codexCopyText: "Panoya kopyalanamadı. Komutu terminalde çalıştırın:",
    codexLiveNote: "Oturum açık · devam komutu kapanınca",
    codexNoteLive: "Codex oturumu terminalde açık; burada yalnız okunur.",
    codexNoteEnded: "Codex oturumu; burada yalnız okunur. Sürdürmek için devam komutunu terminalde çalıştırın.",
    codexNoFolder: "Klasör bu bilgisayarda bulunamadı", codexNoTitle: "(başlıksız Codex oturumu)",
    codexQuotaLeft: "%{0} kaldı", codexQuotaReset: "yenilendi", codexQuotaName: "Codex {0}",
    codexWin30: "30 gün", codexDays: "{0} gün", codexHours: "{0} saat",
    codexQuotaSec: "{0}: %{1} kaldı", codexQuotaSecReset: "{0}: yenilendi",
    codexQuotaHint: "Codex kotası · {0} · kullanılan %{1} · {2} penceresi · son ölçüm {3} önce (en yeni Codex oturumundan)",
    codexQuotaResetHint: "Codex kotasının penceresi yenilendi; yeni değer Codex'in bir sonraki isteğinde gelir"
  });
  Object.assign(window.I18N.en, {
    codexLane: "Codex", codexBadge: "Codex",
    codexLaneHint: "Codex CLI sessions · watch only, the panel doesn't send messages",
    codexWorking: "working", codexOpen: "open", codexEnded: "closed", codexLastWrite: "last write {0} ago",
    codexOpenFolder: "Open folder", codexCopyResume: "Copy resume command", codexCopied: "Copied: {0}",
    codexCopyTitle: "Resume command", codexCopyText: "Couldn't copy to the clipboard. Run this in a terminal:",
    codexLiveNote: "Session open · resume command once it's closed",
    codexNoteLive: "This Codex session is open in a terminal; read-only here.",
    codexNoteEnded: "Codex session; read-only here. To continue, run the resume command in a terminal.",
    codexNoFolder: "Folder not found on this computer", codexNoTitle: "(untitled Codex session)",
    codexQuotaLeft: "{0}% left", codexQuotaReset: "reset", codexQuotaName: "Codex {0}",
    codexWin30: "30 days", codexDays: "{0} days", codexHours: "{0} hours",
    codexQuotaSec: "{0}: {1}% left", codexQuotaSecReset: "{0}: reset",
    codexQuotaHint: "Codex quota · {0} · {1}% used · {2} window · last measured {3} ago (from the newest Codex session)",
    codexQuotaResetHint: "The Codex quota window has reset; the new value arrives with Codex's next request"
  });
})();
