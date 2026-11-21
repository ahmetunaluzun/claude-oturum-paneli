#!/usr/bin/env bash
# Gizli bilgi engeli testleri için uydurma ortam (0.18.0): üç depo, her birinde gizli bilgi denetimine takılan gönderilmemiş
# commit; uzak = geçici klasörde yerel bare depo. Değerler uydurmadır ve parça parça kurulur (bu dosyada kalıp biçimli
# sabit durmasın). Kullanım: tools/gizli_ortam.sh <boş klasör>   (klasör yapısı tools/takip_ortam.sh ile aynı)
#   Test Kimlik  : test dosyasında iki kalıp bulgusu (parola + API anahtarı ataması) → "Test verisi, yine de gönder" sunulur
#   Env Depo     : .env dosyası + kalıp → yalnız "Claude'a incelet"
#   Telefon Depo : tek kalıp bulgusu (telefondan izin testi)
set -eu
T="$1"
mkdir -p "$T/claude/projects" "$T/data" "$T/projeler" "$T/uzak" "$T/tmp"
G=(git -c user.name=Demo -c user.email=demo@example.invalid -c init.defaultBranch=main -c core.autocrlf=false -c commit.gpgsign=false)
P="$T/projeler"
PAROLA="p@ss""1234test"; ANAHTAR="zz99""88776655aa"
proje() { # $1 = klasör adı, $2 = kayıt klasörü adı: klasör + konuşma kaydı (Takip depoyu buradan bulur)
  local dir="$P/$1" id; mkdir -p "$dir" "$T/claude/projects/$2"
  id=$(printf '%08x-0000-4000-8000-%012x' "$RANDOM" "$RANDOM")
  printf '{"type":"user","uuid":"%s","timestamp":"2026-11-18T09:00:00Z","cwd":"%s","message":{"role":"user","content":"Demo görev"}}\n' \
    "$id" "$(cygpath -w "$dir" | sed 's/\\/\\\\/g')" > "$T/claude/projects/$2/$id.jsonl"
}
depo() { # $1 = ad, $2 = uzak ad: ilk commit'i gönderilmiş depo
  "${G[@]}" -C "$P/$1" init -q; echo "# $1" > "$P/$1/README.md"
  "${G[@]}" -C "$P/$1" add -A; "${G[@]}" -C "$P/$1" commit -q -m "İlk commit"
  "${G[@]}" init -q --bare "$T/uzak/$2.git"; "${G[@]}" -C "$P/$1" remote add origin "$T/uzak/$2.git"; "${G[@]}" -C "$P/$1" push -q -u origin main
}
commit() { "${G[@]}" -C "$P/$1" add -A; "${G[@]}" -C "$P/$1" commit -q -m "$2"; }

proje "Test Kimlik" test-kimlik; depo "Test Kimlik" test-kimlik
mkdir -p "$P/Test Kimlik/test"
printf 'const sahte = {\n  password: "%s",\n  api_key: "%s",\n};\n' "$PAROLA" "$ANAHTAR" > "$P/Test Kimlik/test/kimlik.test.ts"
commit "Test Kimlik" "Kimlik testi"

proje "Env Depo" env-depo; depo "Env Depo" env-depo
printf 'API_URL=http://localhost\n' > "$P/Env Depo/.env"; printf 'secret = "%s"\n' "$PAROLA" > "$P/Env Depo/ayar.py"
commit "Env Depo" "Ortam"

proje "Telefon Depo" telefon-depo; depo "Telefon Depo" telefon-depo
printf 'auth_token = "%s"\n' "$ANAHTAR" > "$P/Telefon Depo/ornek.py"
commit "Telefon Depo" "Örnek"

# Güncelleme önbelleği: az önce denetlenmiş gibi (panel ağa çıkmaz).
now=$(date +%s)
printf '{"PanelAt":%s,"PanelOk":true,"PanelLatest":"v0.0.1","ClaudeAt":%s,"ClaudeOk":true,"ClaudeLatest":"0.0.1"}' "$now" "$now" > "$T/data/update-check.json"
printf '{"Notify":false,"Introduced":true}' > "$T/data/tray.json"
