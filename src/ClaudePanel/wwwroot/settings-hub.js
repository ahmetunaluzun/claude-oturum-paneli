// Ayarlar sekmesi: sol bölüm menüsü (geniş ekranda yapışkan, dar ekranda yatay şerit) ve bölümler arası gezinme.
// Bölümlerin içeriği: eski Ayarlar penceresinin ayarları index.html'de (app.js, settings-mail.js, restart.js doldurur).
window.PanelSettingsHub = function (d) {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const nav = $("setNav"), view = $("viewSettings");
  const buttons = () => [...nav.querySelectorAll("button[data-sec]")];
  const sections = () => buttons().map(b => $(b.dataset.sec)).filter(s => s && !s.hidden);

  // Sayfayı kaydıran öğe: düzene göre body ya da belge kökü (app.css: html overflow-x clip, body overflow-x hidden).
  const scroller = () => document.body.scrollHeight > document.body.clientHeight + 1 ? document.body : document.scrollingElement;

  /** Yapışkan başlığın altında kalmasın: menünün ve bölüm başlıklarının üst boşluğu başlık yüksekliğine göre. */
  function measure() {
    const top = document.querySelector("header.top");
    const sticky = top && getComputedStyle(top).position === "sticky" ? top.offsetHeight : 0;
    view.style.setProperty("--set-top", sticky + 14 + "px");
    view.style.setProperty("--set-top-narrow", sticky + 10 + "px");
  }

  function mark(id) {
    buttons().forEach(b => {
      const on = b.dataset.sec === id;
      b.classList.toggle("active", on);
      // Yatay şeritte etkin satır görünür kalsın. scrollIntoView kullanılmaz: sayfayı da dikeyde menüye geri kaydırıyordu.
      if (on && nav.scrollWidth > nav.clientWidth) {
        const left = b.offsetLeft - nav.offsetLeft;
        if (left < nav.scrollLeft || left + b.offsetWidth > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = Math.max(0, left - 12);
      }
    });
  }

  // Menüden seçilen bölüm, kullanıcı sayfayı kendisi kaydırana dek etkin kalır: sayfa sonundaki kısa bölümler üst çizgiye
  // ulaşamaz, kaydırma konumundan hesaplanan bölüm seçileni ezmesin.
  let pinned = null;
  ["wheel", "touchmove", "keydown"].forEach(n => addEventListener(n, () => { pinned = null; }, { passive: true }));

  /** Ekranın üstüne en yakın (başlığın altından geçmiş son) bölüm etkin görünür. */
  function onScroll() {
    if (view.hidden) return;
    if (pinned) { mark(pinned); return; }
    const line = (parseInt(view.style.getPropertyValue("--set-top"), 10) || 14) + 30;
    const secs = sections();
    let cur = secs[0];
    for (const s of secs) if (s.getBoundingClientRect().top <= line) cur = s;
    // Sayfanın sonunda son bölüm kısa kalıp üst çizgiye hiç ulaşamayabilir
    const sc = scroller();
    if (sc.scrollTop > 0 && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) cur = secs[secs.length - 1];
    if (cur) mark(cur.id);
  }

  function go(id) {
    const s = $(id);
    if (!s || s.hidden) return;
    measure();
    pinned = id;
    s.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    mark(id);
  }

  /** Bölümü olmayan (gizli) menü satırı gösterilmez. */
  function syncNav() { buttons().forEach(b => { const s = $(b.dataset.sec); b.hidden = !s || s.hidden; }); }

  function open(top) {
    syncNav(); measure();
    if (top) { pinned = null; document.body.scrollTop = 0; document.scrollingElement.scrollTop = 0; }
    onScroll();
  }

  nav.addEventListener("click", (e) => { const b = e.target.closest("button[data-sec]"); if (b) go(b.dataset.sec); });
  document.addEventListener("scroll", onScroll, { passive: true, capture: true });
  addEventListener("resize", () => { if (!view.hidden) { measure(); onScroll(); } });

  return { open, go, syncNav };
};
