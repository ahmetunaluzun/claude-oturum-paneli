#!/usr/bin/env bash
# İki hesaplı kota görünümü arayüz testi (tools/hesap_ui_test.mjs). Gerçek ~/.claude'a ve canlı panele dokunmaz:
# geçici klasörde iki sahte hesap (claude + claude-is), taze önbellek (API'ye gidilmez), test kopyası --no-window.
# Görüntüler: _onizleme/hesap_*.png. Kullanım: tools/hesap_ui_test.sh [exe]
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
unset CLAUDE_CONFIG_DIR
fail=0
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
FREE=$(pwsh -NoProfile -c '[math]::Floor((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB)' | tr -d '\r')
[ "$FREE" -lt 4 ] && { echo "Boş RAM $FREE GB (< 4 GB): tarayıcı testi başlatılmadı"; rm -rf "$T"; exit 3; }
mkdir -p "$T/claude/sessions" "$T/claude-is" "$T/data" "$T/tmp" "$T/chrome" _onizleme
rm -f _onizleme/hesap_*.png
printf '{"Notify":false,"Introduced":true}' > "$T/data/tray.json"
now=$(date +%s)
cache() { # $1 klasör, $2 5 saat kullanım, $3 haftalık kullanım, $4/$5 yenilenmeye kalan sn
  printf '{"_cached_at":%s,"five_hour":{"utilization":%s,"resets_at":"%s"},"seven_day":{"utilization":%s,"resets_at":"%s"}}' "$now" "$2" \
    "$(date -u -d "@$((now + $4))" +%Y-%m-%dT%H:%M:%S+00:00)" "$3" "$(date -u -d "@$((now + $5))" +%Y-%m-%dT%H:%M:%S+00:00)" > "$1/usage-cache.json"
}
cache "$T/claude" 12 99 7000 30000
cache "$T/claude-is" 8 1 9000 500000
echo '{"claudeAiOauth":{"accessToken":"sahte"}}' > "$T/claude/.credentials.json"
echo '{"claudeAiOauth":{"accessToken":"sahte"}}' > "$T/claude-is/.credentials.json"
echo '{"oauthAccount":{"organizationName":"kisi@ornek.com'"'"'s Organization"}}' > "$T/.claude.json"
echo '{"oauthAccount":{"organizationName":"Örnek Şirket A.Ş."}}' > "$T/claude-is/.claude.json"
# Şirket hesabında boştaki bir terminal oturumu (kart rozeti + ⋯ menüsünde "Kişisel hesabında devam et")
mkdir -p "$T/claude-is/sessions" "$T/p/Muhasebe Projesi"
py -3.13 -c "import time; time.sleep(900)  # $TW" >/dev/null 2>&1 & YP=$!
sleep 0.3; WPID=$(cat /proc/$YP/winpid)
FT=$(pwsh -NoProfile -c "(Get-Process -Id $WPID).StartTime.ToFileTimeUtc()" | tr -d '\r')
CWD=$(cygpath -w "$T/p/Muhasebe Projesi" | sed 's/\\/\\\\/g')
printf '{"pid":%s,"sessionId":"6f0c2a10-0000-4000-8000-00000000a001","cwd":"%s","startedAt":%s000,"procStart":"%s","version":"2.1.331","kind":"interactive","entrypoint":"cli","status":"idle","statusUpdatedAt":%s000}' \
  "$WPID" "$CWD" "$((now-600))" "$FT" "$((now-120))" > "$T/claude-is/sessions/$WPID.json"
# Muhasebe Projesi şirket hesabına kayıtlı (ProjectAccounts.cs): yeni oturum penceresinde şirket hesabı seçili gelmeli
printf '{"%s":"claude-is"}' "${CWD,,}" > "$T/data/project-accounts.json"
export HESAP_PROJ="$(cygpath -w "$T/p/Muhasebe Projesi")" HESAP_BASKA="$(cygpath -w "$T/p")"

PORT=$(freeport); DPORT=$(freeport); B="http://127.0.0.1:$PORT"
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CODEX_HOME="$TW\\codex" \
  TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
TOK=$(cat "$T/data/panel-$PORT.token")
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TW\\chrome" --remote-debugging-port="$DPORT" about:blank >/dev/null 2>&1 &
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$DPORT/json/version" >/dev/null 2>&1 && break; sleep 0.2; done
check "hata ayıklama portu bizim Chrome'da" "$(pwsh -NoProfile -c "\$p=(Get-NetTCPConnection -LocalPort $DPORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if (\$p -and (Get-CimInstance Win32_Process -Filter \"ProcessId=\$p\").CommandLine -like '*$TW*') { 1 } else { 0 }" | tr -d '\r')" 1
[ $fail = 0 ] && { node tools/hesap_ui_test.mjs "$DPORT" "$B/" "_onizleme/hesap" || fail=1; }

# ---- temizlik ----
curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
kill $PID 2>/dev/null; wait $PID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
kalan() { pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' }).Count" | tr -d '\r'; }
for _ in $(seq 1 10); do [ "$(kalan)" = 0 ] && break; sleep 1; done
check "test süreci kalmadı" "$(kalan)" 0
pwsh -NoProfile -c "Remove-Item -LiteralPath '$TW' -Recurse -Force -ErrorAction SilentlyContinue"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail
