#!/usr/bin/env bash
# Takip → Zamanlanmış işler satır düğmeleri testi: bilinen Windows sonuç kodları (bilgi / hata), görev başına "bu kod normal",
# Şimdi çalıştır, Logu aç, Claude'a incelet. Ortam tools/gorev_dugme_ortam.py, arayüz tools/gorev_dugme_test.mjs.
# Gerçek ~/.claude'a, canlı panele ve gerçek Görev Zamanlayıcı'ya dokunmaz: geçici klasör, boş portlar, test kopyası --no-window,
# sahte zamanlayıcı (CLAUDE_PANEL_TASKS_FILE) ve sahte claude. Görüntüler: _onizleme/gorev_*.png. Kullanım: tools/gorev_dugme_test.sh [exe]
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0
export PYTHONUTF8=1
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
FREE=$(pwsh -NoProfile -c '[math]::Floor((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB)' | tr -d '\r')
[ "$FREE" -lt 4 ] && { echo "Boş RAM $FREE GB (< 4 GB): tarayıcı testi başlatılmadı"; rm -rf "$T"; exit 3; }
mkdir -p "$T/claude/projects" "$T/data" "$T/tmp" "$T/chrome" _onizleme
rm -f _onizleme/gorev_*.png
py -3.13 tools/gorev_dugme_ortam.py "$TW" || { echo "ortam kurulamadı"; rm -rf "$T"; exit 1; }
printf '{"Notify":false,"Introduced":true}' > "$T/data/tray.json"
printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
printf '{"_test":"gece-modu-koruma quota-guard project-guard"}' > "$T/claude/settings.json"

PORT=$(freeport); DPORT=$(freeport); B="http://127.0.0.1:$PORT"
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
  CLAUDE_PANEL_TASKS_FILE="$TW\\gorevler.json" SAHTE_CLAUDE_LOG="$TW\\sahte.log" TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
TOK=$(cat "$T/data/panel-$PORT.token")
H=(-H "X-Panel-Token: $TOK" -H "Origin: $B" -H 'Content-Type: application/json')
# Gövde dosyadan (Türkçe karakterli argüman Git Bash'ten curl.exe'ye kod sayfasında bozuk gider).
post() { printf '%s' "$2" > "$T/govde.json"; curl -s -X POST "$B$1" "${H[@]}" --data-binary @"$T/govde.json" -w ' %{http_code}'; }
check "test kopyası açıldı" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/state")" 200
for _ in $(seq 1 40); do curl -s "$B/api/followup" | grep -q '"Yardım Sitesi"' && break; sleep 0.25; done

# ---- sunucu: log ve klasör alanları ----
alan() { curl -s "$B/api/followup" | py -3.13 -c "import json,sys;d=json.load(sys.stdin);t={x['name']:x for x in d['sched']['os']['tasks']};v=t[sys.argv[1]].get(sys.argv[2]);print(v if v is None else v.replace(sys.argv[3],'<T>'))" "$1" "$2" "$TW"; }
check "log: betikte göreli yazılı yol" "$(alan 'Yardım Sitesi' log)" '<T>\p\Yardim Sitesi\logs\izle.log'
check "log: komuttaki yönlendirme" "$(alan 'Edge İzleyici' log)" '<T>\p\Edge Izleyici\cikti.log'
check "log: betik klasöründeki logs/ klasörü" "$(alan 'Kaynak Öncelik' log)" '<T>\p\Kaynak Oncelik\logs'
check "log: göreli .bat betiğinde tırnaksız yönlendirme" "$(alan 'Haftalık Kontrol' log)" '<T>\claude\hooks\Haftalik Kontrol\son_kontrol.log'
check "inceleme klasörü: çalışma klasörü" "$(alan 'Haftalık Kontrol' cwd)" '<T>\claude\hooks\Haftalik Kontrol'
check "log: bulunamadı → null" "$(alan 'Günlük Rapor' log)" None
check "inceleme klasörü: betiğin klasörü" "$(alan 'Günlük Rapor' cwd)" '<T>\p\Gunluk Rapor'

# ---- sunucu: çalıştır / log uçları ----
check "çalıştır: bilinmeyen görev 404" "$(curl -s -X POST "$B/api/schedule/run" "${H[@]}" -d '{"id":"\\Yok"}' -w ' %{http_code}')" '{"error":"notask"} 404'
check "çalıştır: kapalı görev 409" "$(post /api/schedule/run '{"id":"\\Deneme\\Kapalı İş"}')" '{"error":"taskdisabled"} 409'
check "çalıştır: belirteçsiz 403" "$(curl -s -o /dev/null -X POST "$B/api/schedule/run" -H "Origin: $B" -H 'Content-Type: application/json' -d '{"id":"\\Deneme\\Günlük Rapor"}' -w '%{http_code}')" 403
check "log: logu olmayan görev 404" "$(post /api/schedule/log '{"id":"\\Deneme\\Günlük Rapor"}')" '{"error":"nolog"} 404'

"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TW\\chrome" --remote-debugging-port="$DPORT" about:blank >/dev/null 2>&1 &
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$DPORT/json/version" >/dev/null 2>&1 && break; sleep 0.2; done
check "hata ayıklama portu bizim Chrome'da" "$(pwsh -NoProfile -c "\$p=(Get-NetTCPConnection -LocalPort $DPORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if (\$p -and (Get-CimInstance Win32_Process -Filter \"ProcessId=\$p\").CommandLine -like '*$TW*') { 1 } else { 0 }" | tr -d '\r')" 1
if [ $fail = 0 ]; then
  node tools/gorev_dugme_test.mjs "$DPORT" "$B/" "_onizleme/gorev" "$TW" || fail=1
  check "Şimdi çalıştır: yalnız onaylanan görev çalıştı" "$(py -3.13 -c "import json,sys;print([t['name'] for t in json.load(open(sys.argv[1],encoding='utf-8')) if t['lastResult']==0x41301])" "$TW\\gorevler.json")" "['Günlük Rapor']"
  check "Claude'a incelet: istem görevi, kodu ve logu taşıyor" "$(grep -c 'Yardım Sitesi' "$T/sahte.log")/$(grep -c 'kod 1 (0x1)' "$T/sahte.log")/$(grep -c 'izle.log' "$T/sahte.log")" 1/1/1
  # (panel açılışta sahte claude'u kendi klasöründe sürüm/kota için de çağırır: yalnız proje klasöründeki açılışlar sayılır)
  check "Claude'a incelet: tek oturum, betiğin klasöründe" "$(grep '^ACILIS' "$T/sahte.log" | cut -f3 | grep -F "$TW" | sed "s#$(printf '%s' "$TW" | sed 's/\\/\\\\/g')#<T>#")" '<T>\p\Yardim Sitesi'
fi

# ---- temizlik ----
for k in $(curl -s "$B/api/state" | grep -o '"key":"[0-9a-f]*"' | cut -d'"' -f4); do curl -s -o /dev/null -X POST "$B/api/hosted/$k/stop" "${H[@]}"; done
curl -s -o /dev/null -X POST "$B/api/quit?force=1" "${H[@]}"
for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
kill $PID 2>/dev/null; wait $PID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
kalan() { pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_claude.py*') }).Count" | tr -d '\r'; }
for _ in $(seq 1 10); do [ "$(kalan)" = 0 ] && break; sleep 1; done
check "test süreci kalmadı" "$(kalan)" 0
rm -rf "$T" 2>/dev/null
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail
