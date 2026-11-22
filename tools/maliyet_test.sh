#!/usr/bin/env bash
# Proje maliyeti (/api/cost) ve açılış yükü (/api/startup-load) sunucu testi. Sahte ~/.claude ağacı tools/maliyet_ortam.py,
# beklentiler tools/maliyet_kontrol.py (elle hesaplanmış tutarlar). Gerçek ~/.claude'a ve canlı panele dokunmaz:
# geçici klasör, boş port, test kopyası --no-window. Tarayıcı açılmaz. Kullanım: tools/maliyet_test.sh [exe]
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0
export PYTHONUTF8=1
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
mkdir -p "$T/data" "$T/tmp"
printf '{"Notify":false,"Introduced":true}' > "$T/data/tray.json"
py -3.13 -I tools/maliyet_ortam.py "$TW" >/dev/null || { echo "ortam kurulamadı"; exit 1; }
# Panel dosyalara yazmamalı: ağacın parmak izi önce/sonra
iz() { (cd "$T" && find claude p .claude.json -type f -exec sha1sum {} + | sort); }
IZ1=$(iz)

PORT=$(freeport); B="http://127.0.0.1:$PORT"
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" \
  TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
TOK=$(cat "$T/data/panel-$PORT.token")

first=$(curl -s "$B/api/cost")
check "ilk istek beklemez (hazır değil ya da taranıyor)" "$(echo "$first" | grep -c '"ready":false\|"scanning":true')" 1
ready() { for _ in $(seq 1 60); do J=$(curl -s "$B/api/cost"); echo "$J" | grep -q '"ready":true' && echo "$J" | grep -q '"scanning":false' && { echo "$J"; return; }; sleep 0.5; done; echo "$J"; }
ready > "$T/cost.json"
curl -s "$B/api/startup-load" > "$T/load.json"
BETA=$(py -3.13 -I -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$TW\\p\\Beta")
curl -s "$B/api/startup-load?cwd=$BETA" > "$T/load_beta.json"
curl -s "$B/api/startup-load?cwd=C%3A%5CWindows" > "$T/load_bad.json"
py -3.13 -I tools/maliyet_kontrol.py "$T/cost.json" "$T/load.json" "$T/load_beta.json" "$T/load_bad.json" "$TW" || fail=1

# ---- artımlı okuma: yarım satır sayılmaz, tamamlanınca sayılır (dosya baştan okunmaz) ----
S1="$T/claude/projects/X-Alfa/00000000-0000-0000-0000-000000000001.jsonl"
TS=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
printf '{"type":"assistant","isSidechain":false,"cwd":"x","timestamp":"%s","message":{"id":"msg_G","model":"claude-opus-5-5","usage":{"input_tokens":1,"output_tokens":10}}}' "$TS" >> "$S1"
rescan() { sleep 16; curl -s -o /dev/null "$B/api/cost"; sleep 0.5; ready; }
cost7() { py -3.13 -I -c "import json,sys; d=json.load(sys.stdin); r=d['periods']['7'][0]; print(r['cost'], r['output'])"; }
check "yarım satır sayılmaz" "$(rescan | cost7)" "0.2882 2000"
printf '\n' >> "$S1"
check "satır tamamlanınca sayılır (G: 0,000204 $, 10 çıktı)" "$(rescan | cost7)" "0.2884 2010"
# Dosya küçülürse (yeniden yazıldı) baştan okunur: S1 yalnız A'yı içerecek şekilde yeniden yazılır
head -n 3 "$S1" > "$T/s1.tmp" && mv "$T/s1.tmp" "$S1"
check "küçülen dosya baştan okunur (A + alt ajan C)" "$(rescan | cost7)" "0.2004 1300"

curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
kill $PID 2>/dev/null; wait $PID 2>/dev/null
# S1 testte bilerek değiştirildi; diğer her dosya aynı kalmalı
check "panel ağaca yazmadı" "$(iz | grep -v '00000000-0000-0000-0000-000000000001.jsonl')" "$(echo "$IZ1" | grep -v '00000000-0000-0000-0000-000000000001.jsonl')"
kalan() { pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' }).Count" | tr -d '\r'; }
for _ in $(seq 1 10); do [ "$(kalan)" = 0 ] && break; sleep 1; done
check "test süreci kalmadı" "$(kalan)" 0
pwsh -NoProfile -c "Remove-Item -LiteralPath '$TW' -Recurse -Force -ErrorAction SilentlyContinue"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail
