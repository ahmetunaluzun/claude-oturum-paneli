// Ayarlar sekmesi metinleri (settings-hub.js, settings-routing.js): bölüm menüsü, Hesaplar, anahtar bağlama,
// yapay zekâ işçileri, iş yönlendirme, Google tablosu. i18n.js'ten sonra yüklenir, aynı sözlüğe eklenir.
(() => {
  "use strict";
  Object.assign(window.I18N.tr, {
    setNavAccounts: "Hesaplar", setNavWorkers: "Yapay zekâ işçileri", setNavRouting: "İş yönlendirme", setNavGeneral: "Genel",
    setNavNotify: "Bildirimler", setNavNight: "Gece modu", setNavMail: "Mail ve takvim", setNavPhone: "Telefondan erişim",
    setNavGoogle: "Google ile neler yapılır", setNavAdvanced: "Gelişmiş"
  });
  Object.assign(window.I18N.en, {
    setNavAccounts: "Accounts", setNavWorkers: "AI workers", setNavRouting: "Job routing", setNavGeneral: "General",
    setNavNotify: "Notifications", setNavNight: "Night mode", setNavMail: "Mail and calendar", setNavPhone: "Phone access",
    setNavGoogle: "What Google can do", setNavAdvanced: "Advanced"
  });
})();
