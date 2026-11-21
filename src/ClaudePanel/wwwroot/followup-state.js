// Takip sekmesinin kalıcı görünüm durumu (localStorage["panel.follow"]): açık/kapalı bölümler, görünüm (projeye / türe göre),
// süzgeç, gizlenen ve ertelenen öğeler, "Yükledim" işaretleri, daha önce görülen öğeler ("yeni" işareti için).
// Gizleme öğenin imzasına bağlıdır ({ id: sig }): öğe değişirse (yeni commit, dosya yeniden üretildi) kendiliğinden geri gelir.
window.PanelFollowState = function (d) {
  "use strict";
  const { now } = d;
  const STORE = "panel.follow", KNOWN_MAX = 600;
  const OPEN_BY_DEFAULT = new Set(["decisions", "conflicts"]);
  const DEFER_TYPES = new Set(["git", "next", "drive", "update", "task", "sfile", "sdesk", "promise", "cloud", "plan", "gh", "mail", "cal"]); // karar, çakışma ve açık oturumdaki tekrarlı iş ertelenemez/gizlenemez: her zaman görünür
  const state = Object.assign({ collapsed: {}, dismissed: [], mode: "project", filter: "all", hidden: {}, snoozed: {}, uploaded: {}, known: null },
    (() => { try { return JSON.parse(localStorage.getItem(STORE) || "{}"); } catch { return {}; } })());
  const save = () => localStorage.setItem(STORE, JSON.stringify(state));
  const fresh = new Set(); // bu bakışta "yeni" görünen öğeler (sekme yeniden açılınca sıfırlanır)

  const isCollapsed = (id, openDefault) => state.collapsed[id] ?? !(openDefault ?? OPEN_BY_DEFAULT.has(id));
  const canDefer = (it) => DEFER_TYPES.has(it.type) && !it.pinned; // pinned: süren / kontrol ya da karar bekleyen planlı iş

  /** Yarın (yerel gece yarısı), sunucu saatine göre. */
  function tomorrow() {
    const d = new Date(now());
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }

  /** Öğe kenara alınmış mı: "uploaded" | "hidden" | "snoozed" | null. Geçerliliği biten kayıt burada silinir. */
  function aside(it) {
    let changed = false, why = null;
    if (it.id in state.uploaded) { if (state.uploaded[it.id] === it.mtime) why = "uploaded"; else { delete state.uploaded[it.id]; changed = true; } }
    if (it.id in state.hidden) { if (state.hidden[it.id] === it.sig) why ??= "hidden"; else { delete state.hidden[it.id]; changed = true; } }
    if (it.id in state.snoozed) { if (state.snoozed[it.id] > now()) why ??= "snoozed"; else { delete state.snoozed[it.id]; changed = true; } }
    if (changed) save();
    return why;
  }

  function hide(it) { state.hidden[it.id] = it.sig; save(); }
  function snooze(it) { state.snoozed[it.id] = tomorrow(); save(); }
  function upload(it) { state.uploaded[it.id] = it.mtime; save(); }
  function restore(it) { delete state.hidden[it.id]; delete state.snoozed[it.id]; delete state.uploaded[it.id]; save(); }

  /** Listede artık olmayan öğelerin kayıtları atılır (öğe ileride yeniden çıkarsa imzası zaten farklı olur). */
  function prune(ids) {
    let changed = false;
    for (const map of [state.hidden, state.snoozed, state.uploaded])
      for (const id of Object.keys(map)) if (!ids.has(id)) { delete map[id]; changed = true; }
    if (changed) save();
  }

  /** Görünen öğeleri "görüldü" olarak işler; ilk kez görülenler bu bakış boyunca "yeni" işareti taşır. */
  function track(ids) {
    const first = !state.known, known = new Set(state.known || []); // ilk kullanım: hiçbir şey "yeni" değil
    let changed = first || known.size !== ids.size;
    for (const id of ids) if (!known.has(id)) { if (!first) fresh.add(id); changed = true; }
    // Yalnız şu an var olanlar saklanır: listeden çıkıp sonra yeniden çıkan öğe yine "yeni" sayılır.
    if (changed) { state.known = [...ids].slice(-KNOWN_MAX); save(); }
  }
  const isNew = (id) => fresh.has(id);
  const newLook = () => fresh.clear();

  return { state, save, isCollapsed, canDefer, aside, hide, snooze, upload, restore, prune, track, isNew, newLook };
};
