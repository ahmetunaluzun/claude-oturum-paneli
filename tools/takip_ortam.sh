#!/usr/bin/env bash
# Takip sekmesi için uydurma test ortamı kurar (gerçek proje/oturum göstermeden test ve ekran görüntüsü).
# Kullanım: tools/takip_ortam.sh <boş klasör> [kutuk]     (kutuk: üç uydurma güncelleme kütüğü de kurulur; betiğin sonu)
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

# ---- isteğe bağlı: güncelleme kütükleri (ikinci argüman "kutuk") ----
# Üç uydurma proje, üç kütük biçimi (DriveLedger.cs): (A) "- Ad vX — `yol` (not)", (B) "- `yol` + `ek` (sürüm)", (C) tablo.
# Her birinde: okunamayan satır, KAPATILDI/KAPANDI bölümü (alınmaz), bölüm dışı satır (alınmaz), olmayan dosya.
[ "${2:-}" = "kutuk" ] || exit 0
kutuk() { # $1 = proje klasörü; kütük metni stdin'den, @K@ = klasörün Windows yolu
  local w; w=$(cygpath -w "$T/projeler/$1"); local metin; metin=$(cat)
  printf '%s\n' "${metin//@K@/$w}" > "$T/projeler/$1/GUNCELLEME_KUTUGU.md"
}
proje "Kılavuz Deposu" kilavuz-deposu
mkdir -p "$T/projeler/Kılavuz Deposu/cikti/v1.3.0" "$T/projeler/Kılavuz Deposu/cikti/v2.0.1"
echo a > "$T/projeler/Kılavuz Deposu/cikti/v1.3.0/Etiket_Kilavuzu.docx"; echo b > "$T/projeler/Kılavuz Deposu/cikti/v2.0.1/Fis_Kilavuzu.docx"
kutuk "Kılavuz Deposu" <<'MD'
# Güncelleme Kütüğü

## 2026-11-10 — Etiket kılavuzu yenilendi

- **Bilgi:** ayar dosyası `ayar\etiket.json` değişti (bölüm dışı: alınmaz)

### AÇIK — DRIVE'A YÜKLENECEK
- Etiket Kılavuzu v1.3.0 — `@K@\cikti\v1.3.0\Etiket_Kilavuzu.docx`
- `@K@\cikti\v1.3.0\Label_Guide.docx` (v1.3.0; sürüm değişmedi, `0 - Yok` düzeltmesi)
- Kapak görseli sonra eklenecek

### KAPATILDI — DRIVE'A YÜKLENDİ (2026-11-01)
- Etiket Kılavuzu v1.2.0 — `@K@\cikti\v1.2.0\Etiket_Kilavuzu.docx`

### AÇIK — DRIVE'A YÜKLENECEK (2026-11-15 düzeltme turu)
- Fiş Kılavuzu — `@K@\cikti\v2.0.1\Fis_Kilavuzu.docx`
MD
proje "Yardım Sitesi" yardim-sitesi
mkdir -p "$T/projeler/Yardım Sitesi/yayin"
for f in yardim.html egitim.html Egitim.pdf; do echo "$f" > "$T/projeler/Yardım Sitesi/yayin/$f"; done
kutuk "Yardım Sitesi" <<'MD'
# Güncelleme Kütüğü

## AÇIK (Drive) — Yardım sayfaları 11.11 → 12.11 (12.11.2026)

**Yeni bilgi:** kaynak rapor `kaynak\rapor.md` (paragraf: alınmaz)
**Drive'a yüklenecek:**
- `@K@\yayin\yardim.html` (2.4.0)
- `@K@\yayin\egitim.html` + `Egitim.pdf` + `Training.pdf` (1.7.0)

## KAPANDI (05.11.2026, "drive güncellendi") — DRIVE: önceki tur
- `@K@\yayin\eski.html` (2.3.0)

## AÇIK — Başvuru formu 1.2.0 (04.11.2026)
- `@K@\form\basvuru.html` (Drive işi değil: alınmaz)
MD
proje "Mimari Belgesi" mimari-belgesi
mkdir -p "$T/projeler/Mimari Belgesi/belgeler"
echo d > "$T/projeler/Mimari Belgesi/belgeler/Mimari.docx"; echo p > "$T/projeler/Mimari Belgesi/belgeler/Mimari.pdf"
kutuk "Mimari Belgesi" <<'MD'
# Güncelleme Kütüğü

## 2026-11-14 — Şema yenilendi

### AÇIK — DRIVE'A YÜKLENECEK

| Dosya | Sürüm | Yerel yol |
|---|---|---|
| `Mimari.docx` | 3.1.0 | `belgeler\` |
| `Mimari.pdf` | 3.1.0 | `@K@\belgeler\Mimari.pdf` |
| Sunum | 1.0 | hazırlanıyor |

### KAPATILDI — DRIVE'A YÜKLENDİ (2026-11-02)

| Dosya | Sürüm | Yerel yol |
|---|---|---|
| `Eski.docx` | 3.0.0 | `belgeler\` |
MD
