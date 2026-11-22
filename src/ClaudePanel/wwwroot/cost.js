// Proje maliyeti (sunucu ProjectCost.cs, GET /api/cost): proje (çalışma klasörü) başına çalışma süresi, token ve API
// fiyatıyla tahmini tutar. Oturumlar'da açık oturumların projeleri, Son oturumlar'da dönemdeki tüm projeler.
// Proje satırında kısa özet (ör. "3 sa 20 dk · 4,2 M token · ~$38"), tıklayınca döküm (dönem toplamları + modele göre).
// Dönem 7 gün / 30 gün / tümü ve bölümün açık/kapalı durumu kalıcı (localStorage["panel.cost"]).
// Sunucu taramayı arka planda yapar: hazır değilse "taranıyor" yazar, birkaç saniyede bir yeniden sorar.

/** Sayı biçimleri (load.js de kullanır). */
window.PanelCostFmt = function (t, lang) {
  "use strict";
  const nf = (max) => new Intl.NumberFormat(lang() === "en" ? "en-US" : "tr-TR", { maximumFractionDigits: max });
  const tok = (n) => n < 1000 ? nf(0).format(n) : n < 1e6 ? `${nf(1).format(n / 1e3)} k` : `${nf(1).format(n / 1e6)} M`;
  const usd = (v) => `$${nf(v >= 10 ? 0 : v >= 1 ? 1 : 2).format(v)}`;
  const money = (v) => v > 0 && v < 0.005 ? `<${usd(0.01)}` : `~${usd(v)}`; // yaklaşık tutar; çok küçükse "<$0,01"
  const hm = (ms) => {
    const m = Math.round(ms / 60000), h = Math.floor(m / 60);
    return h ? `${nf(0).format(h)} ${t("h")} ${m % 60} ${t("m")}` : `${m} ${t("m")}`;
  };
  return { tok, usd, money, hm, nf };
};

window.PanelCost = function (d) {
  "use strict";
  const { t, getJson, esc, lang, liveCwds } = d;
  const $ = (id) => document.getElementById(id);
  const F = window.PanelCostFmt(t, lang);
  const STORE = "panel.cost", SHORT_LIST = 8, REFRESH_MS = 60_000, RETRY_MS = 2500;
  const PERIODS = ["7", "30", "all"];
  const state = Object.assign({ period: "7", closed: {} },
    (() => { try { return JSON.parse(localStorage.getItem(STORE) || "{}"); } catch { return {}; } })());
  if (!PERIODS.includes(state.period)) state.period = "7";
  const save = () => localStorage.setItem(STORE, JSON.stringify(state));
  const key = (p) => String(p || "").replace(/[\\/]+$/, "").toLowerCase();
  const expanded = new Set();
  const showAll = { recent: false };
  let data = null, timer = null;

  async function load() {
    clearTimeout(timer);
    try { data = await getJson("/api/cost"); } catch { /* bağlantı kopukluğunu app.js gösterir; son veri kalır */ }
    render();
    timer = setTimeout(load, data?.ready && !data.scanning ? REFRESH_MS : RETRY_MS);
  }

  /** Kısa özet: "3 sa 20 dk · 4,2 M token · ~$38" (fiyatı bilinmeyen model varsa "+"). */
  const amount = (r) => r.costKnown ? `${F.money(r.cost)}${r.costComplete ? "" : "+"}` : t("costUnknown");
  function summary(r) {
    const tokens = r.input + r.output + r.cacheRead + r.cacheWrite;
    return `${F.hm(r.activeMs)} · ${t("costTok", F.tok(tokens))} · ${amount(r)}`;
  }

  function totals(rows) {
    const z = { activeMs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costComplete: true, costKnown: rows.length > 0 };
    for (const r of rows) {
      for (const k of ["activeMs", "input", "output", "cacheRead", "cacheWrite", "cost"]) z[k] += r[k];
      z.costComplete &&= r.costComplete;
    }
    return z;
  }

  function header(where, rows) {
    const h = document.createElement("div");
    h.className = "cost-head";
    const closed = !!state.closed[where];
    h.innerHTML = `<button type="button" class="cost-fold" aria-expanded="${!closed}" title="${esc(t("costToggle"))}">
        <span class="cost-chev" aria-hidden="true">${closed ? "▸" : "▾"}</span><span>${esc(t("costTitle"))}</span></button>
      <div class="chips cost-chips" role="group">${PERIODS.map(p =>
        `<button type="button" data-p="${p}" class="${state.period === p ? "active" : ""}">${esc(t("costP" + p))}</button>`).join("")}</div>
      <small class="cost-label" title="${esc(t("costHint"))}">${esc(t("costLabel"))}</small>
      ${rows?.length ? `<small class="cost-total">${esc(t("costTotal", summary(totals(rows))))}</small>` : ""}`;
    h.querySelector(".cost-fold").addEventListener("click", () => { state.closed[where] = !closed; save(); render(); });
    h.querySelectorAll(".cost-chips button").forEach(b => b.addEventListener("click", () => { state.period = b.dataset.p; save(); render(); }));
    return h;
  }

  function stat(label, value, title) {
    return `<div class="cost-stat"${title ? ` title="${esc(title)}"` : ""}><small>${esc(label)}</small><b>${esc(value)}</b></div>`;
  }

  function detail(r) {
    const el = document.createElement("div");
    el.className = "cost-detail";
    const models = r.models.map(m => `<div class="cost-model"><b>${esc(m.model)}</b>
        <span>${esc(t("costIn"))} <em>${esc(F.tok(m.input))}</em></span><span>${esc(t("costOut"))} <em>${esc(F.tok(m.output))}</em></span>
        <span>${esc(t("costRead"))} <em>${esc(F.tok(m.cacheRead))}</em></span><span>${esc(t("costWrite"))} <em>${esc(F.tok(m.cacheWrite))}</em></span>
        <span class="cost-m-usd">${m.cost == null ? esc(t("costUnknown")) : esc(F.money(m.cost))}</span></div>`).join("");
    el.innerHTML = `<div class="cost-stats">
        ${stat(t("costActive"), F.hm(r.activeMs))}${stat(t("costSessions"), F.nf(0).format(r.sessions))}
        ${stat(t("costIn"), F.tok(r.input))}${stat(t("costOut"), F.tok(r.output))}
        ${stat(t("costRead"), F.tok(r.cacheRead))}${stat(t("costWrite"), F.tok(r.cacheWrite))}
        ${stat(t("costUsd"), amount(r), r.costComplete ? t("costHint") : t("costPartialHint", r.unknownModels.join(", ")))}</div>
      <p class="cost-sub">${esc(t("costModels"))}</p><div class="cost-models">${models}</div>
      <p class="cost-foot">${esc(t("costHint"))} ${esc(t("costFoot", data.gapMinutes))}<br>${esc(t("costSource", data.asOf))} <a href="${esc(data.source)}" target="_blank" rel="noopener">${esc(data.source.replace(/^https:\/\//, ""))}</a></p>`;
    return el;
  }

  function row(r) {
    const k = key(r.cwd), open = expanded.has(k);
    const wrap = document.createElement("div");
    wrap.className = "cost-item" + (open ? " open" : "");
    wrap.dataset.cwd = r.cwd;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cost-row";
    b.setAttribute("aria-expanded", open);
    b.innerHTML = `<span class="cost-main"><b>${esc(r.name)}</b><small>${esc(r.cwd)}</small></span>
      <span class="cost-sum">${esc(summary(r))}</span><span class="cost-chev" aria-hidden="true">${open ? "▾" : "▸"}</span>`;
    b.title = r.costComplete ? t("costHint") : t("costPartialHint", r.unknownModels.join(", "));
    b.addEventListener("click", () => { open ? expanded.delete(k) : expanded.add(k); render(); });
    wrap.appendChild(b);
    if (open) wrap.appendChild(detail(r));
    return wrap;
  }

  // Oturumlar görünümü birkaç saniyede bir yeniden çizilir: kutu yalnız içeriği değişince kurulur (odak, açık döküm kalır).
  const sigs = {};
  function renderBox(where, box, force) {
    if (!box) return;
    const live = where === "sessions" ? new Set(liveCwds().map(key)) : null;
    const sig = [data?.scannedAt, data?.ready, state.period, state.closed[where], [...expanded].join("|"), showAll.recent,
      live ? [...live].sort().join("|") : "", lang()].join("§");
    if (!force && sigs[where] === sig) return;
    sigs[where] = sig;
    if (live && !live.size) { box.hidden = true; return; }
    box.hidden = false;
    let rows = data?.ready ? data.periods[state.period] || [] : null;
    if (rows && live) rows = rows.filter(r => live.has(key(r.cwd)));
    box.replaceChildren(header(where, rows));
    if (state.closed[where]) return;
    const body = document.createElement("div");
    body.className = "cost-list";
    if (!rows) body.innerHTML = `<p class="muted">${esc(t("costScanning"))}</p>`;
    else if (!rows.length) body.innerHTML = `<p class="muted">${esc(t(live ? "costNoneLive" : "costNone"))}</p>`;
    else {
      const all = where !== "recent" || showAll.recent;
      rows.slice(0, all ? rows.length : SHORT_LIST).forEach(r => body.appendChild(row(r)));
      if (where === "recent" && rows.length > SHORT_LIST) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "btn small cost-more";
        more.textContent = showAll.recent ? t("costLess") : t("costMore", rows.length);
        more.addEventListener("click", () => { showAll.recent = !showAll.recent; render(); });
        body.appendChild(more);
      }
    }
    box.appendChild(body);
  }

  function render(force = false) {
    renderBox("sessions", $("costSessions"), force);
    renderBox("recent", $("costRecent"), force);
  }

  return { load, render };
};
