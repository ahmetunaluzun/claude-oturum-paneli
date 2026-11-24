#!/usr/bin/env bash
# Ayarlar sekmesi arayüz testi (tools/ayarlar_ui_test.mjs). Gerçek ~/.claude'a ve canlı panele dokunmaz: geçici klasörde
# iki sahte hesap (claude + claude-is), taze kota önbelleği (API'ye gidilmez), test kopyası --no-window, başsız Chrome
# kendi geçici profiliyle (ekrana pencere açılmaz, hata ayıklama portu boş porttan).
# Görüntüler: _onizleme/ayarlar_*.png. Kullanım: tools/ayarlar_ui_test.sh [exe]
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
mkdir -p "$T/claude/sessions" "$T/claude-is" "$T/data" "$T/tmp" "$T/chrome" "$T/p/Muhasebe Projesi" _onizleme
rm -f _onizleme/ayarlar_*.png
printf '{"Notify":false,"Introduced":true}' > "$T/data/tray.json"
now=$(date +%s)
cache() { # $1 klasör, $2 5 saat kullanım, $3 haftalık kullanım, $4/$5 yenilenmeye kalan sn
  printf '{"_cached_at":%s,"five_hour":{"utilization":%s,"resets_at":"%s"},"seven_day":{"utilization":%s,"resets_at":"%s"}}' "$now" "$2" \
    "$(date -u -d "@$((now + $4))" +%Y-%m-%dT%H:%M:%S+00:00)" "$3" "$(date -u -d "@$((now + $5))" +%Y-%m-%dT%H:%M:%S+00:00)" > "$1/usage-cache.json"
}
cache "$T/claude" 12 99 7000 30000
cache "$T/claude-is" 76 8 9000 500000
echo '{"claudeAiOauth":{"accessToken":"sahte"}}' > "$T/claude/.credentials.json"
echo '{"claudeAiOauth":{"accessToken":"sahte"}}' > "$T/claude-is/.credentials.json"
echo '{"oauthAccount":{"organizationName":"kisi@ornek.com'"'"'s Organization"}}' > "$T/.claude.json"
echo '{"oauthAccount":{"organizationName":"Örnek Şirket A.Ş."}}' > "$T/claude-is/.claude.json"
CWD=$(cygpath -w "$T/p/Muhasebe Projesi" | sed 's/\\/\\\\/g')
printf '{"%s":"claude-is"}' "${CWD,,}" > "$T/data/project-accounts.json"
# GitHub kartı: gerçek gh çağrılmaz (tools/sahte_gh.py, boş liste)
SGH="$(cygpath -w "$PWD/tools/sahte_gh.py")"
printf '@echo off\r\npy -3.13 "%s" %%*\r\n' "$SGH" > "$T/sahte-gh.cmd"
py -3.13 "$SGH" --senaryo bos "$TW\\gh.json"

# Anahtar bağlama: deneme istekleri sahte sunucuya (gerçek ağa çıkılmaz), anahtar sayfası açılmaz (dosyaya yazılır), uydurma Chrome profilleri
printf '{"profile":{"info_cache":{"Default":{"name":"İş","user_name":"is@ornek.com.tr"},"Profile 1":{"name":"Kişisel","user_name":"kisi@ornek.com"}}}}' > "$T/chrome-state.json"
KPORT=$(freeport)
py -3.13 tools/sahte_anahtar.py "$KPORT" "$TW\\anahtar.log" >/dev/null 2>&1 & # log yolu $TW içinde: temizlikte süreç komut satırından bulunur
for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$KPORT/x" && break; sleep 0.2; done

PORT=$(freeport); DPORT=$(freeport); B="http://127.0.0.1:$PORT"
CLAUDE_PANEL_KEYTEST_BASE="http://127.0.0.1:$KPORT" CLAUDE_PANEL_HUB_OPEN_LOG="$TW\\acilan.log" CLAUDE_PANEL_CHROME_STATE="$TW\\chrome-state.json" \
  CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CODEX_HOME="$TW\\codex" \
  CLAUDE_PANEL_GH_EXE="$TW\\sahte-gh.cmd" SAHTE_GH_DOSYA="$TW\\gh.json" SAHTE_GH_LOG="$TW\\gh.log" \
  TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
TOK=$(cat "$T/data/panel-$PORT.token")
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TW\\chrome" --remote-debugging-port="$DPORT" about:blank >/dev/null 2>&1 &
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$DPORT/json/version" >/dev/null 2>&1 && break; sleep 0.2; done
check "hata ayıklama portu bizim Chrome'da" "$(pwsh -NoProfile -c "\$p=(Get-NetTCPConnection -LocalPort $DPORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if (\$p -and (Get-CimInstance Win32_Process -Filter \"ProcessId=\$p\").CommandLine -like '*$TW*') { 1 } else { 0 }" | tr -d '\r')" 1
[ $fail = 0 ] && { node "${AYAR_MJS:-tools/ayarlar_ui_test.mjs}" "$DPORT" "$B/" "_onizleme/ayarlar" || fail=1; }

# ---- temizlik ----
curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
kill $PID 2>/dev/null; wait $PID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_gh.py*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
kalan() { pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' }).Count" | tr -d '\r'; }
for _ in $(seq 1 10); do [ "$(kalan)" = 0 ] && break; sleep 1; done
check "test süreci kalmadı" "$(kalan)" 0
pwsh -NoProfile -c "Remove-Item -LiteralPath '$TW' -Recurse -Force -ErrorAction SilentlyContinue"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail
