// Açılış yükü (Skill kütüphanesi; sunucu StartupLoad.cs, GET /api/startup-load): her oturumun başında modele giden bağlam.
// Ölçülen: son oturumların ilk yanıtındaki girdi + önbellekten okuma + önbelleğe yazma (en az / medyan / en çok).
// Dağılım TAHMİNİDİR (karakter / sunucudaki tek oran sabiti): genel CLAUDE.md, rules/ dosya dosya, proje ve üst klasör
// CLAUDE.md, proje hafızası, etkin skill açıklamaları; MCP sunucuları "ölçülemedi". Fark tek satır. Panel yalnız okur.
// Açık/kapalı ve seçilen proje kalıcı (localStorage["panel.load"]).
window.PanelLoad = function (d) {
  "use strict";
  const { t, getJson, esc, lang } = d;
  const $ = (id) => document.getElementById(id);
  const F = window.PanelCostFmt(t, lang);
  const STORE = "panel.load", SHOW = 6;
  const ORDER = ["global", "rule", "parentMd", "projectMd", "projectRule", "memory", "skill", "mcp"];
  const state = Object.assign({ open: false, cwd: null },
    (() => { try { return JSON.parse(localStorage.getItem(STORE) || "{}"); } catch { return {}; } })());
  const save = () => localStorage.setItem(STORE, JSON.stringify(state));
  const showAll = new Set();
  let data = null, loading = false;

  async function load() {
    if (loading) return;
    loading = true;
    try { data = await getJson("/api/startup-load" + (state.cwd ? "?cwd=" + encodeURIComponent(state.cwd) : "")); }
    catch { /* son veri kalır */ }
    finally { loading = false; }
    render();
  }

  const pct = (n) => data.median ? Math.max(0, Math.round(n / data.median * 1000) / 10) : 0;

  function groups() {
    const by = new Map();
    for (const it of data.items) (by.get(it.kind) || by.set(it.kind, []).get(it.kind)).push(it);
    return ORDER.filter(k => by.has(k)).map(k => {
      const list = by.get(k).sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || a.label.localeCompare(b.label));
      const measured = list.some(i => i.tokens != null);
      return { kind: k, list, tokens: measured ? list.reduce((s, i) => s + (i.tokens ?? 0), 0) : null };
    });
  }

  function itemRow(it) {
    const val = it.tokens == null ? t("loadNotMeasured") : `~${F.tok(it.tokens)}`;
    const sub = it.path || it.source || "";
    return `<li><span class="ld-name"><b>${esc(it.label)}</b>${sub && sub !== it.label ? `<small>${esc(sub)}</small>` : ""}</span>
      <span class="ld-val">${esc(val)}</span></li>`;
  }

  function group(g, i) {
    const el = document.createElement("details");
    el.className = "ld-group";
    el.dataset.kind = g.kind;
    el.style.setProperty("--c", `var(--ld-${i})`);
    const label = t("lg_" + g.kind, g.list.length);
    const val = g.tokens == null ? t("loadNotMeasured") : `~${F.tok(g.tokens)} · %${F.nf(1).format(pct(g.tokens))}`;
    const all = showAll.has(g.kind);
    const shown = all ? g.list : g.list.slice(0, SHOW);
    el.innerHTML = `<summary><span class="ld-dot"></span><span class="ld-label">${esc(label)}</span>
        <span class="ld-val">${esc(val)}${g.tokens == null ? "" : ` <em>${esc(t("loadEstimated"))}</em>`}</span></summary>
      <p class="ld-note">${esc(t("ln_" + g.kind))}</p><ul class="ld-items">${shown.map(itemRow).join("")}</ul>
      ${g.list.length > SHOW ? `<button type="button" class="btn small ld-more">${esc(all ? t("loadLess") : t("loadMore", g.list.length - SHOW))}</button>` : ""}`;
    el.querySelector(".ld-more")?.addEventListener("click", () => {
      all ? showAll.delete(g.kind) : showAll.add(g.kind);
      const open = [...document.querySelectorAll("#loadBox .ld-group[open]")].map(x => x.dataset.kind);
      render(open);
    });
    return el;
  }

  function render(openKinds = []) {
    const box = $("loadBox");
    if (!box) return;
    box.replaceChildren();
    const head = document.createElement("button");
    head.type = "button";
    head.className = "ld-head";
    head.setAttribute("aria-expanded", state.open);
    const sum = !data ? t("loading") : data.sessions
      ? t("loadSummary", data.sessions, F.tok(data.min), F.tok(data.median), F.tok(data.max)) : t("loadEmpty");
    head.innerHTML = `<span class="cost-chev" aria-hidden="true">${state.open ? "▾" : "▸"}</span><b>${esc(t("loadTitle"))}</b>
      <span class="ld-sum">${esc(sum)}</span>`;
    head.addEventListener("click", () => { state.open = !state.open; save(); render(); });
    box.appendChild(head);
    if (!state.open || !data?.sessions) return;

    const body = document.createElement("div");
    body.className = "ld-body";
    const gs = groups();
    const pick = data.cwds.length > 1
      ? `<label class="ld-pick"><span>${esc(t("loadProject"))}</span><select id="ldCwd">${data.cwds.map(c =>
          `<option value="${esc(c)}"${c === data.cwd ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></label>` : "";
    body.innerHTML = `<p class="ld-intro">${esc(t("loadIntro", F.nf(1).format(data.charsPerToken)))}</p>${pick}
      <div class="ld-bar" aria-hidden="true"></div>`;
    // Çubuk: her kalemin ölçülen medyana oranı. CSP satır içi style="" özniteliğine izin vermez; genişlik CSSOM ile verilir.
    for (const g of gs.filter(g => g.tokens)) {
      const s = document.createElement("span");
      s.style.width = Math.min(100, pct(g.tokens)) + "%";
      s.style.background = `var(--ld-${ORDER.indexOf(g.kind)})`;
      s.title = t("lg_" + g.kind, g.list.length);
      body.querySelector(".ld-bar").appendChild(s);
    }
    gs.forEach(g => {
      const el = group(g, ORDER.indexOf(g.kind));
      if (openKinds.includes(g.kind)) el.open = true;
      body.appendChild(el);
    });
    const rest = data.rest ?? 0;
    body.insertAdjacentHTML("beforeend", `<div class="ld-total">
        <div><span>${esc(t("loadEstimateTotal"))}</span><b>~${esc(F.tok(data.estimate))}</b></div>
        <div class="ld-rest"><span>${esc(t("loadRest"))}</span><b>${rest < 0 ? "−" : "~"}${esc(F.tok(Math.abs(rest)))}</b></div>
        <small>${esc(t("loadRestNote"))}</small>
        <div><span>${esc(t("loadMeasured"))}</span><b>${esc(F.tok(data.median))}</b></div></div>
      <p class="ld-foot">${esc(t("loadContext"))}<br>${esc(t("loadReadOnly"))}</p>`);
    body.querySelector("#ldCwd")?.addEventListener("change", (e) => { state.cwd = e.target.value; save(); load(); });
    box.appendChild(body);
  }

  return { load, render };
};
