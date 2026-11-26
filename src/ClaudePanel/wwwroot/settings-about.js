// Ayarlar → Hakkında (sunucu About.cs, /api/about): sürüm ve derleme, işletim sistemi, .NET, veri klasörü, bu sürümün
// yenilikleri (gömülü CHANGELOG.md'den). Başlıklar ve özellik listesi index.html'de data-i18n ile; burada yalnız değerler.
window.PanelSettingsAbout = function (d) {
  "use strict";
  const { api, getJson, toast, t, esc, hub } = d;
  const $ = (id) => document.getElementById(id);
  let info = null;

  function render() {
    if (!info) return;
    $("abVer").textContent = "v" + info.version + (info.commit ? " · " + info.commit : "");
    $("abOs").textContent = info.os + " (" + info.arch + ")";
    $("abRuntime").textContent = info.runtime;
    $("abData").textContent = info.dataDir;
    const list = $("abNew");
    list.innerHTML = info.changes.map(c => `<li>${esc(c)}</li>`).join("");
    $("abNewWrap").hidden = !info.changes.length;
  }

  async function load() {
    if (info) return render();
    info = await getJson("/api/about").catch(() => null);
    render();
  }

  $("abOpenData").addEventListener("click", async () => {
    const r = await api("/api/reveal", { path: info?.dataDir });
    if (!r.ok) toast(t("abOpenFail"));
  });

  hub.onRender(() => load()); // Ayarlar açılınca (Hesaplar yüklenince) doldurulur
  return { load };
};
