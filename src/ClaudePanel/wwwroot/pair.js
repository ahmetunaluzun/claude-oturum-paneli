(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const tr = (navigator.language || "tr").toLowerCase().startsWith("tr");
  const T = tr ? {
    wrong: "Kod yanlış. Tekrar dene.", nopairing: "Kodun süresi doldu ya da çok yanlış denendi. Bilgisayardan yeni kod al.",
    full: "En fazla 10 cihaz eşleşebilir. Bilgisayardan eski bir cihazı kaldır.", fail: "Bağlanılamadı. Bilgisayar açık mı?",
    ok: "Eşleşti, panel açılıyor…", phone: "Telefon"
  } : {
    wrong: "Wrong code. Try again.", nopairing: "The code expired or was tried too many times. Get a new code on the computer.",
    full: "At most 10 devices can be paired. Remove an old one on the computer.", fail: "Could not connect. Is the computer on?",
    ok: "Paired, opening the panel…", phone: "Phone"
  };
  if (!tr) {
    document.documentElement.lang = "en";
    $("pTitle").textContent = "Pair this phone";
    $("pHint").textContent = "On the computer, open Settings → Phone access → \"Add phone\" and type the 6-digit code shown there.";
    $("pCodeLabel").textContent = "Code";
    $("pNameLabel").textContent = "Name of this device";
    $("pBtn").textContent = "Pair";
  }
  const ua = navigator.userAgent;
  $("pName").value = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : T.phone;

  async function claim(body) {
    $("pBtn").disabled = true;
    $("pMsg").textContent = "";
    try {
      const res = await fetch("/api/remote/claim", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ name: $("pName").value }, body))
      });
      if (res.ok) { $("pMsg").textContent = T.ok; location.replace("/"); return; }
      const data = await res.json().catch(() => ({}));
      $("pMsg").textContent = T[data.error] || T.fail;
    } catch { $("pMsg").textContent = T.fail; }
    $("pBtn").disabled = false;
  }

  $("pForm").addEventListener("submit", (e) => { e.preventDefault(); claim({ code: $("pCode").value.trim() }); });

  // Kare kod adresi: /pair#s=<gizli değer>. Parça sunucuya gitmez; okununca adresten silinir.
  const m = /[#&]s=([0-9a-f]{48})/.exec(location.hash);
  if (m) { history.replaceState(null, "", "/pair"); claim({ secret: m[1] }); }
})();
