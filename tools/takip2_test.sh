#!/usr/bin/env bash
# Takip 2. aşama tarayıcı testi: ortamı kurar, tools/takip2_test.mjs'i başsız Chrome'da koşturur (ayrıntı o dosyada).
# Gerçek ~/.claude'a ve canlı panele dokunmaz: geçici klasör, boş portlar, test kopyası --no-window, sahte claude
# (tools/sahte_claude.py), uzak depolar geçici klasörde yerel bare depo. Görüntüler: _onizleme/takip2_*.png (uydurma veri).
# Kullanım: tools/takip2_test.sh [exe]
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
tools/takip_ortam.sh "$T" || { echo "ortam kurulamadı"; rm -rf "$T"; exit 1; }
G=(git -c user.name=Demo -c user.email=demo@example.invalid -c init.defaultBranch=main -c core.autocrlf=false -c commit.gpgsign=false)
P="$T/projeler"
proje() { local dir="$P/$1" id; mkdir -p "$dir" "$T/claude/projects/$2"; id=$(printf '%08x-0000-4000-8000-%012x' "$RANDOM" "$RANDOM")
  printf '{"type":"user","uuid":"%s","timestamp":"2026-11-18T09:00:00Z","cwd":"%s","message":{"role":"user","content":"Demo görev"}}\n' \
    "$id" "$(cygpath -w "$dir" | sed 's/\\/\\\\/g')" > "$T/claude/projects/$2/$id.jsonl"; }
depo() { "${G[@]}" -C "$P/$1" init -q; echo "# $1" > "$P/$1/README.md"; "${G[@]}" -C "$P/$1" add -A; "${G[@]}" -C "$P/$1" commit -q -m "İlk commit"
  "${G[@]}" init -q --bare "$T/uzak/$2.git"; "${G[@]}" -C "$P/$1" remote add origin "$T/uzak/$2.git"; "${G[@]}" -C "$P/$1" push -q -u origin main; }
# Gizli Depo: gönderilmemiş commit'lerde izin dosyası + uydurma belirteç (parça parça kurulur; bu dosyada sabit durmaz).
SAHTE="gh""p_$(printf 'A%.0s' $(seq 1 36))"
proje "Gizli Depo" gizli-depo; depo "Gizli Depo" gizli-depo
mkdir -p "$P/Gizli Depo/.claude"; echo '{"permissions":{"allow":[]}}' > "$P/Gizli Depo/.claude/settings.local.json"; echo "TOKEN = $SAHTE" > "$P/Gizli Depo/ayar.txt"
"${G[@]}" -C "$P/Gizli Depo" add -f .claude/settings.local.json ayar.txt; "${G[@]}" -C "$P/Gizli Depo" commit -q -m "Ayar"
# Kirli Uzak: 1 gönderilmemiş commit + commit'lenmemiş dosya
proje "Kirli Uzak" kirli-uzak; depo "Kirli Uzak" kirli-uzak
echo a > "$P/Kirli Uzak/a.txt"; "${G[@]}" -C "$P/Kirli Uzak" add -A; "${G[@]}" -C "$P/Kirli Uzak" commit -q -m "A"; echo b > "$P/Kirli Uzak/b.txt"
printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
printf '{"_test":"gece-modu-koruma quota-guard project-guard"}' > "$T/claude/settings.json"
mkdir -p "$T/chrome" _onizleme; rm -f _onizleme/takip2_*.png

PORT=$(freeport); DPORT=$(freeport)
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
  SAHTE_CLAUDE_GECIKME=5 TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
check "test kopyası açıldı" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/state")" 200
check "canlı oturum listesi boş (gerçek ~/.claude okunmuyor)" "$(curl -s "http://127.0.0.1:$PORT/api/state" | grep -c '"sessions":\[\]')" 1
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TW\\chrome" --remote-debugging-port="$DPORT" about:blank >/dev/null 2>&1 &
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$DPORT/json/version" >/dev/null 2>&1 && break; sleep 0.2; done
# Hata ayıklama portu gerçekten bizim açtığımız Chrome'un mu (başka oturumun tarayıcısına komut gitmesin).
check "hata ayıklama portu bizim Chrome'da" "$(pwsh -NoProfile -c "\$p=(Get-NetTCPConnection -LocalPort $DPORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if (\$p -and (Get-CimInstance Win32_Process -Filter \"ProcessId=\$p\").CommandLine -like '*$TW*') { 1 } else { 0 }" | tr -d '\r')" 1

if [ $fail = 0 ]; then
  node tools/takip2_test.mjs "$DPORT" "http://127.0.0.1:$PORT/" "_onizleme/takip2" "$TW\\projeler" 'C:\Projeler' || fail=1
  check "uydurma belirteç uzak depoya gitmedi" "$("${G[@]}" -C "$T/uzak/gizli-depo.git" rev-list --count main)" 1
  check "Kirli Uzak uzak depoya gönderildi (3 commit)" "$("${G[@]}" -C "$T/uzak/kirli-uzak.git" rev-list --count main)" 3
fi

# ---- temizlik ----
TOK=$(cat "$T/data/panel-$PORT.token" 2>/dev/null)
for k in $(curl -s "http://127.0.0.1:$PORT/api/state" | grep -o '"key":"[0-9a-f]*"' | cut -d'"' -f4); do
  curl -s -o /dev/null -X POST "http://127.0.0.1:$PORT/api/hosted/$k/stop" -H "X-Panel-Token: $TOK" -H "Origin: http://127.0.0.1:$PORT"; done
kill $PID 2>/dev/null; wait $PID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
# Durdurulan oturumların sahte claude süreçleri birkaç saniyede kapanabiliyor: 10 sn'ye kadar bekle
for i in $(seq 10); do
  kalan="$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_claude.py*') }).Count" | tr -d '\r')"
  [ "$kalan" = 0 ] && break; sleep 1
done
check "test süreci kalmadı" "$kalan" 0
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail
