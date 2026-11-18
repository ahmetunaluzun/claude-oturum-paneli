// Küçük ve güvenli Markdown çevirici: önce HTML kaçışı, sonra sınırlı biçimler.
window.md = (src) => {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  const out = [];
  const lines = String(src).replace(/\r/g, "").split("\n");
  let i = 0, list = null, table = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTable = () => { if (table) { out.push("</tbody></table></div>"); table = null; } };
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith("```")) {
      closeList(); closeTable();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      i++; continue;
    }
    if (/^\|.*\|\s*$/.test(l)) {
      closeList();
      const cells = l.trim().slice(1, -1).split("|").map(c => c.trim());
      if (/^\|[\s:|-]+\|\s*$/.test(l)) { i++; continue; }
      if (!table) { out.push(`<div class="tbl"><table><thead><tr>${cells.map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>`); table = true; }
      else out.push(`<tr>${cells.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`);
      i++; continue;
    }
    closeTable();
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { closeList(); out.push(`<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`); }
    // Girintili madde (numaralı listenin alt maddesi) içeride görünür; ardından gelen numara kaynaktaki
    // sayıdan sürer (start), 1-1-1 diye yeniden başlamaz.
    else if ((m = l.match(/^(\s*)[-*]\s+(.*)/))) { if (list !== "ul") { closeList(); out.push(m[1].length >= 2 ? `<ul class="sub">` : "<ul>"); list = "ul"; } out.push(`<li>${inline(m[2])}</li>`); }
    else if ((m = l.match(/^\s*(\d+)[.)]\s+(.*)/))) { if (list !== "ol") { closeList(); out.push(m[1] === "1" ? "<ol>" : `<ol start="${Number(m[1])}">`); list = "ol"; } out.push(`<li>${inline(m[2])}</li>`); }
    else if (l.trim() === "") { closeList(); }
    else { closeList(); out.push(`<p>${inline(l)}</p>`); }
    i++;
  }
  closeList(); closeTable();
  return out.join("");
};
