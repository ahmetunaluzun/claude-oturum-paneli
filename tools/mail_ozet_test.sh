#!/usr/bin/env bash
# "Maillerimi özetle" sunucu testi (Mail/MailSummary.cs, POST /api/mail-summary). Gerçek claude ÇALIŞMAZ (tools/sahte_claude.py),
# gerçek ~/.claude'a ve canlı panele dokunmaz: geçici klasör, boş port, test kopyası --no-window, iki sahte hesap (claude + claude-is).
# Kapsam: belirteçsiz 403, bilinmeyen hesap 400, bozuk gövde 400; seçilen hesapla (CLAUDE_CONFIG_DIR) ev klasöründe açılış;
# süreç komut satırında --settings içinde ENABLE_CLAUDEAI_MCP_SERVERS=true, --allowedTools okuma araçları, --disallowedTools yazma
# araçları (izinli listede hiçbir yazma aracı yok); hosted.json'da Mail=true (yeniden başlatmada aynı kiple döner); hesapsız istek
# varsayılan hesapta açılır. Kullanım: tools/mail_ozet_test.sh [exe]
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0
export PYTHONUTF8=1
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
j() { py -3.13 -c "import json,sys;d=json.load(open(sys.argv[1],encoding='utf-8'));print($1)" "${2:-$T/son.json}" 2>&1; }
trap 'pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne \"pwsh.exe\" -and \$_.CommandLine -like \"*$TW*\" } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1' EXIT
mkdir -p "$T/claude" "$T/claude-is" "$T/data" "$T/tmp"
# .cmd sahtesi satır içi JSON'u (--settings) taşıyamaz → argümanları kaydeden sahte claude.exe (tools/sahte_claude_exe)
dotnet build tools/sahte_claude_exe -c Release -o "$TW\\fake" -nologo -v q >/dev/null 2>&1 || { echo "sahte claude.exe derlenemedi"; exit 1; }
printf '{"Notify":false,"Introduced":true}' > "$T/data/tray.json"
echo '{"claudeAiOauth":{"accessToken":"sahte"}}' > "$T/claude/.credentials.json"
echo '{"claudeAiOauth":{"accessToken":"sahte"}}' > "$T/claude-is/.credentials.json"
PORT=$(freeport); B="http://127.0.0.1:$PORT"
SAHTE_CLAUDE_ARGS="$TW\\args.txt" SAHTE_CLAUDE_PY="$(cygpath -w "$PWD/tools/sahte_claude.py")" SAHTE_CLAUDE_LOG="$TW\\sahte.log" \
  CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\fake\\claude.exe" CLAUDE_PANEL_GH_EXE="$TW\\yok.cmd" TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
for _ in $(seq 1 60); do [ -f "$T/data/panel-$PORT.token" ] && curl -s -o /dev/null "$B/api/ping" && break; sleep 0.25; done
TOK=$(cat "$T/data/panel-$PORT.token")
post() { curl -s -o "$T/son.json" -w '%{http_code}' -X POST "$B/api/mail-summary" -H "X-Panel-Token: $1" -H "Origin: $B" -H "Content-Type: application/json" --data-binary "$2"; }

check "belirteçsiz istek 403" "$(post yanlis '{}')" 403
check "bilinmeyen hesap 400" "$(post "$TOK" '{"account":"claude-yok"}')" 400
check "bozuk gövde 400" "$(post "$TOK" '{bozuk')" 400

check "şirket hesabıyla açılış 200" "$(post "$TOK" '{"account":"claude-is","lang":"tr"}')" 200
KEY=$(j "d['key']"); HOMEW=$(cygpath -w "$HOME")
check "yanıtta ev klasörü" "$(j "d['cwd']")" "$HOMEW"
for _ in $(seq 1 60); do grep -q "^HESAP" "$T/sahte.log" 2>/dev/null && break; sleep 0.25; done
check "sahte claude ev klasöründe açıldı" "$(grep '^ACILIS' "$T/sahte.log" | head -1 | cut -f3 | tr -d '\r')" "$HOMEW"
check "seçilen hesabın klasörüyle (CLAUDE_CONFIG_DIR)" "$(grep '^HESAP' "$T/sahte.log" | head -1 | cut -f3 | tr -d '\r')" "$TW\\claude-is"
# Sahte claude.exe'nin kaydettiği ilk açılışın argümanları
py -3.13 -I tools/mail_ozet_args.py "$T/args.txt" > "$T/arg.txt"
check "--settings ile bağlayıcılar açık" "$(sed -n 1p "$T/arg.txt" | tr -d '\r')" "env"
check "izinli okuma araçları (10, Gmail arama, Takvim etkinlik)" "$(sed -n 2p "$T/arg.txt" | tr -d '\r')" "10 True True"
check "yasak yazma araçları, kesişim yok" "$(sed -n 3p "$T/arg.txt" | tr -d '\r')" "True True 0"
check "izinli listede yazma aracı yok" "$(sed -n 4p "$T/arg.txt" | tr -d '\r')" "False"
for _ in $(seq 1 40); do grep -q '"Mail":true' "$T/data/hosted.json" 2>/dev/null && break; sleep 0.25; done
check "hosted.json'da Mail=true ve hesap (yeniden başlatmada aynı kip)" "$(j "[(x['Mail'], x['Account']) for x in d]" "$T/data/hosted.json")" "[(True, 'claude-is')]"

check "hesapsız istek 200" "$(post "$TOK" '{"lang":"en"}')" 200
for _ in $(seq 1 60); do [ "$(grep -c '^HESAP' "$T/sahte.log")" -ge 2 ] && break; sleep 0.25; done
check "hesapsız istek varsayılan hesapta" "$(grep '^HESAP' "$T/sahte.log" | sed -n 2p | cut -f3 | tr -d '\r')" "-"

curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
for _ in $(seq 1 60); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
kalan() { pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' }).Count" | tr -d '\r'; }
for _ in $(seq 1 10); do [ "$(kalan)" = 0 ] && break; sleep 1; done
check "test süreci kalmadı" "$(kalan)" 0
pwsh -NoProfile -c "Remove-Item -LiteralPath '$TW' -Recurse -Force -ErrorAction SilentlyContinue"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail
