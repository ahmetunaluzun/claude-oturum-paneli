#!/usr/bin/env bash
# Paneli yeniden başlat arayüz testi (restart.js; tools/restart_ui_test.mjs). Görüntüler: _onizleme/restart_*.png.
# Kurulum: geçici klasörde ClaudePanel.old.exe (A, bu sürüm) çalışır, yanında daha yeni ClaudePanel.exe (B) durur → diskVersion.
# Yeniden başlatınca B açılır; hata adımı için betik çalışan B'yi .old.exe adına çekip yerine bozuk ClaudePanel.exe koyar.
# Gerçek ~/.claude'a ve canlı panele dokunmaz: boş portlar, test kopyası --no-window, kendi CLAUDE_PANEL_DATA'sı, sahte claude,
# başsız Chrome kendi profiliyle. Kullanım: tools/restart_ui_test.sh <A.exe> <B.exe>  (bkz. tools/restart_test.sh)
set -u
cd "$(dirname "$0")/.."
A="${1:?A.exe}"; Bx="${2:?B.exe}"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0
export PYTHONUTF8=1
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
FREE=$(pwsh -NoProfile -c '[math]::Floor((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB)' | tr -d '\r')
[ "$FREE" -lt 4 ] && { echo "Boş RAM $FREE GB (< 4 GB): tarayıcı testi başlatılmadı"; rm -rf "$T"; exit 3; }
mkdir -p "$T/app" "$T/claude/sessions" "$T/data" "$T/tmp" "$T/chrome" "$T/flags" _onizleme
rm -f _onizleme/restart_*.png
printf '{"Notify":false,"Introduced":true}' > "$T/data/tray.json"
cp "$A" "$T/app/ClaudePanel.old.exe"; cp "$Bx" "$T/app/ClaudePanel.exe"
VB=$(pwsh -NoProfile -c "\$v=(Get-Item '$TW\\app\\ClaudePanel.exe').VersionInfo; '{0}.{1}.{2}' -f \$v.FileMajorPart,\$v.FileMinorPart,\$v.FileBuildPart" | tr -d '\r')
printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
printf '{"_test":"gece-modu-koruma quota-guard project-guard"}' > "$T/claude/settings.json"

PORT=$(freeport); DPORT=$(freeport); B="http://127.0.0.1:$PORT"
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
  CLAUDE_PANEL_GH_EXE="$TW\\yok.cmd" TMP="$TW\\tmp" TEMP="$TW\\tmp" "$T/app/ClaudePanel.old.exe" --no-window >/dev/null 2>&1 &
for _ in $(seq 1 60); do [ -f "$T/data/panel-$PORT.token" ] && curl -s -o /dev/null "$B/api/ping" && break; sleep 0.25; done
check "test kopyası (old.exe) açıldı, gerçek oturumlar okunmuyor" "$(curl -s "$B/api/state" | grep -c '"sessions":\[\]')" 1
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TW\\chrome" --remote-debugging-port="$DPORT" about:blank >/dev/null 2>&1 &
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$DPORT/json/version" >/dev/null 2>&1 && break; sleep 0.2; done
check "hata ayıklama portu bizim Chrome'da" "$(pwsh -NoProfile -c "\$p=(Get-NetTCPConnection -LocalPort $DPORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if (\$p -and (Get-CimInstance Win32_Process -Filter \"ProcessId=\$p\").CommandLine -like '*$TW*') { 1 } else { 0 }" | tr -d '\r')" 1

if [ $fail = 0 ]; then
  # Hata adımı: sayfa isteyince çalışan B'yi .old.exe adına çek (çalışan exe yeniden adlandırılabilir), yerine bozuk dosya koy.
  ( for _ in $(seq 1 1200); do [ -f "$T/flags/boz.istek" ] && break; sleep 0.25; done
    rm -f "$T/app/ClaudePanel.old.exe"; mv "$T/app/ClaudePanel.exe" "$T/app/ClaudePanel.old.exe"; printf 'bozuk' > "$T/app/ClaudePanel.exe"
    touch "$T/flags/boz.ok" ) &
  node tools/restart_ui_test.mjs "$DPORT" "$B/" "_onizleme/restart" "$VB" "$(cygpath -m "$T/flags")" || fail=1
  check "logda devir satırı (yeni sürüm $VB)" "$(grep -c "sürüm $VB\." "$T/data/logs/restart.log")" 1
fi

TOK=$(cat "$T/data/panel-$PORT.token" 2>/dev/null)
curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
sleep 1
Q="\$_.Name -ne 'pwsh.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_claude.py*')"
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'chrome.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 1
check "test süreci kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { $Q }).Count" | tr -d '\r')" 0
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { $Q } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
pwsh -NoProfile -c "Remove-Item -Recurse -Force -LiteralPath '$TW' -ErrorAction SilentlyContinue"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail
