#!/usr/bin/env bash
# Telefondan konuşmadaki dosya yolunu indirme testi (0.25.0): /api/files/links + /api/files/download.
# Test kopyası: geçici klasör, boş port, sahte telefon adresi (Host: test.ts.net), kök CLAUDE_PANEL_FILES_ROOT.
# Gerçek ~/.claude'a, canlı panele ve gerçek Tailscale ayarına dokunmaz. Kullanım: tools/indir_test.sh [exe]
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0
chk() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1 ($3)"; else echo "KALDI  $1: beklenen $2, gelen $3"; fail=1; fi; }
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
js() { printf '%s' "$1" | sed 's/\\/\\\\/g'; } # JSON içinde ters bölü

# Kök altında izinli ve yasak dosyalar; kök dışında bir dosya; kök içinden dışarı junction.
R="$T/kok"; mkdir -p "$R/Proje/alt" "$R/Test-Kimlik" "$R/Proje/.git" "$R/Proje/Bos Klasor" "$T/dis" "$T/claude" "$T/data"
printf 'merhaba dünya' > "$R/Proje/alt/rapor.txt"
printf 'x' > "$R/Proje/Bos Klasor/ad boşluklu.md"
printf 'p' > "$R/Test-Kimlik/sifre.txt"
printf 'e' > "$R/Proje/.env"
printf 'e' > "$R/Proje/.env.local"
printf 'k' > "$R/Proje/sertifika.pem"
printf 'g' > "$R/Proje/.git/config"
mkdir -p "$R/Proje/.claude"; printf 's' > "$R/Proje/.claude/settings.local.json"
printf 'dis' > "$T/dis/gizli.txt"
pwsh -NoProfile -c "New-Item -ItemType Junction -Path '$TW\\kok\\Proje\\kacis' -Target '$TW\\dis' | Out-Null"
fsutil file createnew "$TW\\kok\\Proje\\buyuk.bin" 104857601 >/dev/null
printf '{"Notify":false,"Introduced":true}' > "$T/data/tray.json"
W() { js "$(cygpath -w "$1")"; }

PORT=$(freeport); B="http://127.0.0.1:$PORT"; RH=test.ts.net
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_REMOTE_HOST=$RH \
  CLAUDE_PANEL_FILES_ROOT="$TW\\kok" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
TOKEN=$(cat "$T/data/panel-$PORT.token")
L=(-H "X-Panel-Token: $TOKEN" -H "Content-Type: application/json")
chk "test kopyası açıldı" 200 "$(code $B/api/state)"

# Telefonu eşleştir.
code -X POST "${L[@]}" -d '{"enabled":true}' $B/api/remote/enable >/dev/null
PC=$(curl -s -X POST "${L[@]}" $B/api/remote/pair | grep -o '"code":"[0-9]*' | cut -d'"' -f4)
HDR=$(mktemp)
code -D "$HDR" -X POST -H "Host: $RH" -H "Origin: https://$RH" -H 'Content-Type: application/json' -d "{\"code\":\"$PC\"}" $B/api/remote/claim >/dev/null
CK=$(grep -i "^set-cookie: cp_dev" "$HDR" | tr -d '\r' | sed -E 's/^[^:]*: (cp_dev=[^;]*).*/\1/'); rm -f "$HDR"
RT=$(curl -s -H "Host: $RH" -b "$CK" $B/ | grep -o 'panel-token" content="[^"]*' | cut -d'"' -f3)
RA=(-H "Host: $RH" -H "Origin: https://$RH" -H "X-Panel-Token: $RT" -H "Content-Type: application/json" -b "$CK")
chk "telefon eşleşti" 200 "$(code -H "Host: $RH" -b "$CK" $B/api/state)"

dl() { code -X POST "${RA[@]}" -d "{\"path\":\"$1\"}" $B/api/files/download; }
OK=$(W "$R/Proje/alt/rapor.txt")
chk "izinli dosya indirilir" 200 "$(dl "$OK")"
chk "içerik aynı" "merhaba dünya" "$(curl -s -X POST "${RA[@]}" -d "{\"path\":\"$OK\"}" $B/api/files/download)"
chk "dosya adı başlıkta" 1 "$(curl -s -D - -o /dev/null -X POST "${RA[@]}" -d "{\"path\":\"$OK\"}" $B/api/files/download | grep -ic 'content-disposition:.*rapor.txt')"
# Türkçe harfli gövde dosyadan gider: curl.exe komut satırını ANSI kod sayfasıyla alır, ş bozulur (telefon UTF-8 gönderir).
printf '{"path":"%s"}' "$(W "$R/Proje/Bos Klasor/ad boşluklu.md")" > "$T/govde.json"
chk "boşluklu, Türkçe harfli ad indirilir" 200 "$(code -X POST "${RA[@]}" --data-binary @"$T/govde.json" $B/api/files/download)"
chk "klasör indirilmez" 404 "$(dl "$(W "$R/Proje/alt")")"
chk "kök dışı dosya" 404 "$(dl "$(W "$T/dis/gizli.txt")")"
chk "'..' ile kök dışı" 404 "$(dl "$(js "$TW\\kok\\Proje\\..\\..\\dis\\gizli.txt")")"
chk "junction ile kök dışı" 404 "$(dl "$(js "$TW\\kok\\Proje\\kacis\\gizli.txt")")"
chk "Test-Kimlik" 404 "$(dl "$(W "$R/Test-Kimlik/sifre.txt")")"
chk ".env" 404 "$(dl "$(W "$R/Proje/.env")")"
chk ".env.local" 404 "$(dl "$(W "$R/Proje/.env.local")")"
chk ".pem" 404 "$(dl "$(W "$R/Proje/sertifika.pem")")"
chk ".git içi" 404 "$(dl "$(W "$R/Proje/.git/config")")"
chk "settings.local.json" 404 "$(dl "$(W "$R/Proje/.claude/settings.local.json")")"
chk "100 MB üstü" 404 "$(dl "$(W "$R/Proje/buyuk.bin")")"
chk "ağ yolu" 404 "$(dl '\\\\sunucu\\pay\\a.txt')"
chk "olmayan dosya" 404 "$(dl "$(js "$TW\\kok\\Proje\\yok.txt")")"
chk "belirteçsiz" 403 "$(code -X POST -H "Host: $RH" -H "Origin: https://$RH" -H 'Content-Type: application/json' -b "$CK" -d "{\"path\":\"$OK\"}" $B/api/files/download)"
chk "yabancı Origin" 403 "$(code -X POST -H "Host: $RH" -H 'Origin: https://evil.example' -H "X-Panel-Token: $RT" -H 'Content-Type: application/json' -b "$CK" -d "{\"path\":\"$OK\"}" $B/api/files/download)"
chk "çerezsiz" 401 "$(code -X POST -H "Host: $RH" -H "Origin: https://$RH" -H 'Content-Type: application/json' -d "{\"path\":\"$OK\"}" $B/api/files/download)"
chk "GET kapalı" 405 "$(code -H "Host: $RH" -b "$CK" "$B/api/files/download")"

# Bağlantı uzunlukları: izinli dosya cümlede (nokta kesilir), yasaklar 0, klasör 0.
OKS="$(cygpath -w "$R/Proje/alt/rapor.txt")"
LIST="[\"$(js "$OKS"). Bitti\",\"$(W "$R/Proje/.env")\",\"$(W "$R/Proje/alt")\",\"$(W "$T/dis/gizli.txt")\"]"
chk "bağlantı uzunlukları" "[${#OKS},0,0,0]" "$(curl -s -X POST "${RA[@]}" -d "$LIST" $B/api/files/links)"
chk "201 aday reddedilir" 400 "$(code -X POST "${RA[@]}" -d "[$(printf '"a",%.0s' {1..200})\"a\"]" $B/api/files/links)"
chk "telefondan /api/path-links hâlâ kapalı" 403 "$(code -X POST "${RA[@]}" -d '["C:\\\\"]' $B/api/path-links)"
chk "telefondan /api/reveal hâlâ kapalı" 403 "$(code -X POST "${RA[@]}" -d "{\"path\":\"$OK\"}" $B/api/reveal)"
chk "indirme loga yazıldı (3 indirme)" 3 "$(grep -c "Dosya indirildi (telefon).*rapor.txt" "$T"/data/logs/remote-*.log 2>/dev/null | head -1)"

kill $PID 2>/dev/null; wait $PID 2>/dev/null
cmd //c rmdir "$TW\\kok\\Proje\\kacis" >/dev/null 2>&1
rm -rf "$T"
[ $fail = 0 ] && echo "SONUÇ: hepsi geçti" || echo "SONUÇ: KALAN VAR"
exit $fail
