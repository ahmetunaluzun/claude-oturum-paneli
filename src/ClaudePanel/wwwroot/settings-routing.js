// Ayarlar → Yapay zekâ işçileri (Codex, Gemini aç/kapa; sunucu Workers.cs, /api/workers) ve İş yönlendirme (iş türü başına
// araç sırası; Routing.cs, /api/routing). Claude listede açık ve bağlı olan ilk aracı kullanır, yoksa kendi yolunu.
// Sıra yukarı/aşağı düğmeleriyle değişir (dokunmatik dostu; sürükle-bırak yok) ve sunucuda kalır.
window.PanelSettingsRouting = function (d) {
  "use strict";
  const { t, api, getJson, esc, toast, hub, keys } = d;
  const $ = (id) => document.getElementById(id);
  // Araç adları özel addır, dile göre değişmez. Gemini her iş türünde başka bir ürünüyle anılır.
  const LABEL = {
    image: { gemini: "Gemini (Nano Banana)", openrouter: "OpenRouter", higgsfield: "Higgsfield" },
    video: { higgsfield: "Higgsfield", gemini: "Veo (Gemini)" },
    summary: { gemini: "Gemini CLI", codex: "Codex" },
    translate: { gemini: "Gemini Flash", codex: "Codex" },
    review: { codex: "Codex" }
  };
  const INSTALLED = new Set(["codex", "gemini"]); // kurulan araç ("kurulu değil"); öbürleri bağlanır ("bağlı değil")
  let workers = null, routing = null, busy = false;
  const editing = new Set();

  // ---- Yapay zekâ işçileri ----
  function workerCard(id, w) {
    const on = !!w.enabled;
    let who, extra = "", btn = "";
    if (id === "codex") {
      who = w.installed ? [w.plan, t("wkCodexCli", w.version || "")].filter(Boolean).join(" · ").trim() : t("wkNotInstalled", "codex CLI");
      if (on && !w.installed) extra = t("wkOnButMissing");
    } else {
      who = w.state === "ok" ? t("wkGeminiCli", w.version) : w.state === "checking" ? t("wkChecking") : t("wkNotInstalled", "gemini CLI");
      if (w.apiKey) who += " · " + t("wkGeminiKey");
      if (on && w.state === "none" && !w.apiKey) extra = t("wkOnButMissing");
      if (w.state !== "ok") btn = `<div class="set-btns"><button type="button" class="btn small" data-wk-act="gemini-check">${esc(t("setKeyRecheck"))}</button></div>`;
    }
    const name = id === "codex" ? "Codex" : `Gemini <span class="set-tag">${esc(t("setConnPersonal"))}</span>`;
    return `<div class="set-card" data-worker="${id}">
      <div class="set-card-top"><span class="set-logo">${id === "codex" ? "◎" : "✦"}</span>
        <div class="set-card-id"><div class="set-name">${name}</div><div class="set-who">${esc(who)}</div></div>
        <button type="button" class="wk-switch" role="switch" aria-checked="${on}" aria-label="${esc(id === "codex" ? "Codex" : "Gemini")}" data-wk="${id}"><i></i></button></div>
      <div class="set-uses">${esc(t(id === "codex" ? "wkCodexUse" : "wkGeminiUse"))}</div>
      ${extra ? `<p class="set-msg" data-kind="warn">${esc(extra)}</p>` : ""}${btn}</div>`;
  }

  function renderWorkers() {
    if (!workers) return;
    $("wkCards").innerHTML = workerCard("codex", workers.codex) + workerCard("gemini", workers.gemini);
  }

  // ---- İş yönlendirme ----
  function statusText(tool, st, job) {
    if (st === "on") return t(tool === "openrouter" ? "rtStConnected" : job === "review" ? "rtStOnRead" : "rtStOn");
    if (st === "off") return t("rtStOff");
    if (st === "checking") return t("wkChecking");
    return t(INSTALLED.has(tool) ? "rtStMissing" : "rtStNotConn");
  }

  function chip(job, c, i, n, edit) {
    const cls = ["rt-chip", c.status === "on" ? "on" : "", c.skipped ? "skip" : "", routingUse(job) === c.tool ? "use" : ""].filter(Boolean).join(" ");
    const st = statusText(c.tool, c.status, job) + (c.personal ? " · " + t("rtPersonal") : "");
    const moves = edit ? `<span class="rt-move">
        <button type="button" class="btn small" data-rt-move="-1" data-job="${job}" data-i="${i}" aria-label="${esc(t("rtUp", LABEL[job][c.tool]))}"${i === 0 ? " disabled" : ""}>↑</button>
        <button type="button" class="btn small" data-rt-move="1" data-job="${job}" data-i="${i}" aria-label="${esc(t("rtDown", LABEL[job][c.tool]))}"${i === n - 1 ? " disabled" : ""}>↓</button></span>` : "";
    return `<span class="${cls}" data-tool="${c.tool}"><span class="rt-n">${i + 1}</span><span class="rt-label">${esc(LABEL[job][c.tool] || c.tool)}</span><span class="rt-st">${esc(st)}</span>${moves}</span>`;
  }
  const routingUse = (job) => routing?.jobs.find(j => j.id === job)?.use ?? null;

  function routeCard(j) {
    const edit = editing.has(j.id);
    const now = j.use ? `<b>${esc(LABEL[j.id][j.use])}</b>` : `<b class="fb">${esc(t("rtOwnWay"))}</b>`;
    const arrow = `<span class="rt-arrow" aria-hidden="true">→</span>`;
    const chips = j.chain.map((c, i) => chip(j.id, c, i, j.chain.length, edit)).join(edit ? "" : arrow);
    const fallback = `<span class="rt-chip fallback${j.use ? "" : " use"}">${esc(t("rtFb_" + j.id))}</span>`;
    const note = t("rtNote_" + j.id);
    const ctl = j.chain.length > 1 ? `<div class="set-btns"><button type="button" class="btn small${edit ? " primary" : ""}" data-rt-edit="${j.id}">${esc(t(edit ? "rtDone" : "rtReorder"))}</button></div>` : "";
    return `<div class="rt-card" data-job="${j.id}">
      <div class="rt-head"><span class="rt-name">${esc(t("rtJob_" + j.id))}</span><span class="rt-now">${esc(t("rtNow"))} ${now}</span></div>
      <div class="rt-chain${edit ? " rt-editing" : ""}">${chips}${edit ? "" : arrow}${fallback}</div>
      ${note !== "rtNote_" + j.id ? `<div class="rt-note">${esc(note)}</div>` : ""}${ctl}</div>`;
  }

  function renderRouting() {
    if (!routing) return;
    $("rtList").innerHTML = routing.jobs.map(routeCard).join("");
  }

  async function load() {
    const [w, r] = await Promise.all([getJson("/api/workers").catch(() => null), getJson("/api/routing").catch(() => null)]);
    if (w) workers = w;
    if (r) routing = r;
    renderWorkers(); renderRouting();
    // Gemini sürümü ilk açılışta arka planda okunur: bitince kart ve yönlendirme yenilensin
    if (w?.gemini?.state === "checking") setTimeout(load, 2000);
  }

  async function move(job, i, dir) {
    if (busy) return;
    const j = routing.jobs.find(x => x.id === job);
    const order = j.chain.map(c => c.tool);
    const k = i + dir;
    if (k < 0 || k >= order.length) return;
    [order[i], order[k]] = [order[k], order[i]];
    busy = true;
    const r = await api("/api/routing", { job, order });
    busy = false;
    if (r.ok) { routing = r.data; renderRouting(); $("rtList").querySelector(`[data-job="${job}"] [data-rt-move="${dir}"][data-i="${k}"]`)?.focus(); }
    else toast(t(r.data?.error === "offline" ? "err_offline" : "err_generic"), "warn");
  }

  $("viewSettings").addEventListener("click", async (e) => {
    const sw = e.target.closest("[data-wk]");
    if (sw) {
      const id = sw.dataset.wk, on = sw.getAttribute("aria-checked") !== "true";
      sw.setAttribute("aria-checked", on); // anında geri bildirim; sunucu yanıtı kartı yeniden çizer
      const r = await api("/api/workers", { id, enabled: on });
      if (r.ok) { workers = r.data; renderWorkers(); load(); } else { sw.setAttribute("aria-checked", !on); toast(t("err_generic"), "warn"); }
      return;
    }
    if (e.target.closest("[data-wk-act=gemini-check]")) {
      const b = e.target.closest("button"); b.disabled = true; b.textContent = t("setKeyTesting");
      const r = await api("/api/workers/gemini/check", {});
      if (r.ok) workers = r.data;
      load();
      return;
    }
    const ed = e.target.closest("[data-rt-edit]");
    if (ed) { const j = ed.dataset.rtEdit; editing.has(j) ? editing.delete(j) : editing.add(j); renderRouting(); $("rtList").querySelector(`[data-rt-edit="${j}"]`)?.focus(); return; }
    const mv = e.target.closest("[data-rt-move]");
    if (mv && !mv.disabled) move(mv.dataset.job, +mv.dataset.i, +mv.dataset.rtMove);
  });

  hub.onRender(() => load());
  keys.onChange(() => load()); // anahtar bağlanınca/kaldırılınca araç durumu değişir
  return { load };
};
