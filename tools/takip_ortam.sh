#!/usr/bin/env bash
# Takip sekmesi için uydurma test ortamı kurar (gerçek proje/oturum göstermeden test ve ekran görüntüsü).
# Kullanım: tools/takip_ortam.sh <boş klasör>
#   <klasör>/claude   → CLAUDE_PANEL_CLAUDE_DIR (sahte projects/*.jsonl)
#   <klasör>/data     → CLAUDE_PANEL_DATA (güncelleme önbelleği dolu: panel ağa çıkmaz)
#   <klasör>/projeler → uydurma projeler: kirli depo, gönderilmemiş commit'li depo (uzak = yerel bare), uzak dalsız depo,
#                       temiz depo, depo olmayan klasör, iki NEXT_SESSION.md (biri 5 günlük)
#   <klasör>/tmp      → panelin TMP/TEMP'i (panel geçici klasördeki projeleri listelemez; projeler onun dışında kalmalı)
set -eu
T="$1"
mkdir -p "$T/claude/projects" "$T/data" "$T/projeler" "$T/uzak" "$T/tmp"
G=(git -c user.name=Demo -c user.email=demo@example.invalid -c init.defaultBranch=main -c core.autocrlf=false -c commit.gpgsign=false)

proje() { # $1 = klasör adı (projeler altında), $2 = kayıt klasörü adı; konuşma kaydını yazar
  local dir="$T/projeler/$1" id
  mkdir -p "$dir" "$T/claude/projects/$2"
  id=$(printf '%08x-0000-4000-8000-%012x' "$RANDOM" "$RANDOM")
  local cwd; cwd=$(cygpath -w "$dir" | sed 's/\\/\\\\/g')
  printf '{"type":"user","uuid":"%s","timestamp":"2026-11-18T09:00:00Z","cwd":"%s","message":{"role":"user","content":"Demo görev"}}\n' \
    "$id" "$cwd" > "$T/claude/projects/$2/$id.jsonl"
}
depo() { # $1 = klasör: ilk commit'li depo
  local dir="$T/projeler/$1"
  "${G[@]}" -C "$dir" init -q
  echo "# $1" > "$dir/README.md"
  "${G[@]}" -C "$dir" add -A && "${G[@]}" -C "$dir" commit -q -m "İlk commit"
}

# 1) Kirli depo (uzak depo yok): 1 değişmiş + 1 yeni dosya. Alt klasörü de ayrı proje: aynı depo iki kez sayılmamalı.
proje "Demo Mağaza" demo-magaza; depo "Demo Mağaza"
echo "değişti" >> "$T/projeler/Demo Mağaza/README.md"; echo "yeni" > "$T/projeler/Demo Mağaza/sepet.txt"
proje "Demo Mağaza/src" demo-magaza-src

# 2) Gönderilmemiş 2 commit (uzak = yerel bare depo) + yok sayılan NEXT_SESSION.md
proje "Örnek API" ornek-api; depo "Örnek API"
"${G[@]}" init -q --bare "$T/uzak/ornek-api.git"
"${G[@]}" -C "$T/projeler/Örnek API" remote add origin "$T/uzak/ornek-api.git"
"${G[@]}" -C "$T/projeler/Örnek API" push -q -u origin main
for n in 1 2; do echo "$n" > "$T/projeler/Örnek API/uc$n.txt"; "${G[@]}" -C "$T/projeler/Örnek API" add -A; "${G[@]}" -C "$T/projeler/Örnek API" commit -q -m "Uç $n"; done
echo "NEXT_SESSION.md" >> "$T/projeler/Örnek API/.git/info/exclude"
cat > "$T/projeler/Örnek API/NEXT_SESSION.md" <<'MD'
# Sonraki Oturum Planı

> Otomatik oluşturuldu: 2026-11-18 09:10

## DURUM
- **Son yapılan:** Sipariş uç noktası yazıldı, `testler` yeşil; sıradaki iş [sayfalama](https://example.invalid/sayfalama) ve hata mesajlarının Türkçeleştirilmesi, ardından sürüm notunun yazılması ve yayın öncesi son kontrol turu
MD

# 3) Uzak depo var ama dal hiç gönderilmemiş
proje "Rapor Aracı" rapor-araci; depo "Rapor Aracı"
"${G[@]}" init -q --bare "$T/uzak/rapor-araci.git"
"${G[@]}" -C "$T/projeler/Rapor Aracı" remote add origin "$T/uzak/rapor-araci.git"

# 4) Temiz depo
proje "Temiz Kütüphane" temiz-kutuphane; depo "Temiz Kütüphane"

# 5) Depo olmayan klasör + 5 günlük plan
proje "Stok Sayım" stok-sayim
printf '## Sayım ekranı\n\n1. Barkod okuma düzeltilecek\n' > "$T/projeler/Stok Sayım/NEXT_SESSION.md"
touch -d "5 days ago" "$T/projeler/Stok Sayım/NEXT_SESSION.md"

# 6) Silinmiş klasör: listede görünmemeli
proje "Silinen Proje" silinen-proje; rmdir "$T/projeler/Silinen Proje"

# Güncelleme önbelleği: az önce denetlenmiş gibi (ağa çıkılmaz), ikisinde de daha yeni sürüm var.
now=$(date +%s)
printf '{"PanelAt":%s,"PanelOk":true,"PanelLatest":"v99.1.0","PanelUrl":"https://github.com/ahmetunaluzun/claude-oturum-paneli/releases/tag/v99.1.0","ClaudeAt":%s,"ClaudeOk":true,"ClaudeLatest":"99.0.0"}' \
  "$now" "$now" > "$T/data/update-check.json"
