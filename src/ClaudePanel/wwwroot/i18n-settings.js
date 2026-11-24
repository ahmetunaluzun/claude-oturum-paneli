// Ayarlar sekmesi metinleri (settings-hub.js, settings-routing.js): bölüm menüsü, Hesaplar, anahtar bağlama,
// yapay zekâ işçileri, iş yönlendirme, Google tablosu. i18n.js'ten sonra yüklenir, aynı sözlüğe eklenir.
(() => {
  "use strict";
  Object.assign(window.I18N.tr, {
    setNavAccounts: "Hesaplar", setNavWorkers: "Yapay zekâ işçileri", setNavRouting: "İş yönlendirme", setNavGeneral: "Genel",
    setNavNotify: "Bildirimler", setNavNight: "Gece modu", setNavMail: "Mail ve takvim", setNavPhone: "Telefondan erişim",
    setNavGoogle: "Google ile neler yapılır", setNavAdvanced: "Gelişmiş",
    setAccSub: "Her bağlantı tek yerde: Claude hesaplarının kotası ve panelin kullandığı diğer hesaplar.",
    setGrpClaude: "Claude", setGrpOther: "Diğer bağlantılar",
    setAccWeekLeft: "Haftalık %{0} kaldı", setAccNoQuota: "Kota bilgisi yok", setAccWeekReset: "Haftalık sıfırlanma: {0}", setAcc5h: "5 saat: %{0} kaldı",
    setAccWhoDefault: "Varsayılan hesap · {0}", setAccWho: "{0}",
    setAccDefaultAll: "Varsayılan: başka hesaba kayıtlı olmayan tüm projeler", setAccProjects: "Varsayılan: {0}",
    setAccNoProjects: "Bu hesaba kayıtlı proje yok. Yeni oturum açarken hesabı seçince proje bu hesaba kaydedilir.",
    setAccProjectsBtn: "Projeler ({0})", setDotLow: "Haftalık kotası azalan hesap: {0}",
    setAccAdd: "+ Claude hesabı ekle",
    setAccAddNote: "Bu sürümde panel yeni hesaba kendisi giriş yapamıyor. Terminalde CLAUDE_CONFIG_DIR değişkenine yeni bir klasör verip (ör. ana klasörünüzde .claude-is) claude'u başlatın ve /login ile giriş yapın. Giriş bitince hesap yarım dakika içinde burada görünür.",
    setConnOn: "Bağlı", setConnOff: "Bağlı değil", setConnClosed: "Kapalı", setConnPersonal: "Kişisel",
    setGoogleOnly: "Yalnız kişisel Google hesabı", setGoogleUse: "Mail ve takvim (Takip sekmesi). Panel yalnız okur.",
    setGoogleNone: "Gmail hesabınız Mail ve takvim bölümünden bağlanır. Şirket hesabı bu karta girmez.",
    setGoogleDetail: "Ayrıntı", setGoogleConnect: "Mail ve takvime git",
    setGhWho: "gh CLI · {0}", setGhUse: "Takip: açık issue ve PR'lar. Panel yalnız okur.", setGhTry: "Dene",
    setGhNoCli: "gh kurulu değil", setGhNoAuth: "Giriş yok", setGhWaiting: "Denetleniyor", setGhOk: "✓ Bağlantı çalışıyor: {0}",
    setGhClosedHint: "GitHub takibi kapalı; Genel bölümünden açılır.", setGhOpenGeneral: "Genel'e git",
    setKeyTesting: "Deneniyor…"
  });
  Object.assign(window.I18N.en, {
    setNavAccounts: "Accounts", setNavWorkers: "AI workers", setNavRouting: "Job routing", setNavGeneral: "General",
    setNavNotify: "Notifications", setNavNight: "Night mode", setNavMail: "Mail and calendar", setNavPhone: "Phone access",
    setNavGoogle: "What Google can do", setNavAdvanced: "Advanced",
    setAccSub: "Every connection in one place: quota of your Claude accounts and the other accounts the panel uses.",
    setGrpClaude: "Claude", setGrpOther: "Other connections",
    setAccWeekLeft: "Weekly {0}% left", setAccNoQuota: "No quota data", setAccWeekReset: "Weekly reset: {0}", setAcc5h: "5 hours: {0}% left",
    setAccWhoDefault: "Default account · {0}", setAccWho: "{0}",
    setAccDefaultAll: "Default for: every project not assigned to another account", setAccProjects: "Default for: {0}",
    setAccNoProjects: "No project is assigned to this account. Pick the account when starting a session and the project is assigned to it.",
    setAccProjectsBtn: "Projects ({0})", setDotLow: "Weekly quota running low: {0}",
    setAccAdd: "+ Add a Claude account",
    setAccAddNote: "In this version the panel can't sign in to a new account by itself. In a terminal, set CLAUDE_CONFIG_DIR to a new folder (e.g. .claude-work in your home folder), start claude and sign in with /login. The account shows up here within half a minute.",
    setConnOn: "Connected", setConnOff: "Not connected", setConnClosed: "Off", setConnPersonal: "Personal",
    setGoogleOnly: "Personal Google account only", setGoogleUse: "Mail and calendar (Follow-up tab). The panel only reads.",
    setGoogleNone: "Connect your Gmail account in Mail and calendar. A company account doesn't go on this card.",
    setGoogleDetail: "Details", setGoogleConnect: "Go to Mail and calendar",
    setGhWho: "gh CLI · {0}", setGhUse: "Follow-up: open issues and PRs. The panel only reads.", setGhTry: "Test",
    setGhNoCli: "gh not installed", setGhNoAuth: "Not signed in", setGhWaiting: "Checking", setGhOk: "✓ Connection works: {0}",
    setGhClosedHint: "GitHub tracking is off; turn it on in General.", setGhOpenGeneral: "Go to General",
    setKeyTesting: "Testing…"
  });
})();
