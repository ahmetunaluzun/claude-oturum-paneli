#!/usr/bin/env bash
# Yapay zekâ işçileri ve iş yönlendirme testi (Workers.cs, Routing.cs; /api/workers, /api/routing). Gerçek ~/.claude, ~/.codex,
# gerçek gemini ve canlı panel kullanılmaz: geçici klasör, boş port, test kopyası --no-window. Gemini CLI yerine sahte .cmd
# (CLAUDE_PANEL_GEMINI_EXE): önce yanıt vermeyen (zaman aşımı, istek beklemez, süreç kalmaz), sonra sürüm yazan, sonra silinmiş.
# Codex: sahte ağaç (tools/codex_ortam.py). OpenRouter anahtarı sahte deneme sunucusuyla (tools/sahte_anahtar.py) bağlanır.
# Kullanım: tools/yonlendirme_test.sh [exe]
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
unset CLAUDE_CONFIG_DIR
fail=0; n=0
check() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
mkdir -p "$T/claude" "$T/claude-is" "$T/data" "$T/tmp" "$T/p/Kisisel/Oyun" "$T/p/Musteri-Isleri/Divan" "$T/p/Muhasebe"
printf '{"Notify":false,"Introduced":true}' > "$T/data/tray.json"
echo '{"claudeAiOauth":{"accessToken":"sahte"}}' > "$T/claude/.credentials.json"
echo '{"claudeAiOauth":{"accessToken":"sahte"}}' > "$T/claude-is/.credentials.json"
MUH=$(cygpath -w "$T/p/Muhasebe"); MUHJ=$(echo "$MUH" | sed 's/\\/\\\\/g')
printf '{"%s":"claude-is"}' "${MUHJ,,}" > "$T/data/project-accounts.json"
py -3.13 -I tools/codex_ortam.py "$TW\\codex" kur >/dev/null
# Sahte gemini: önce hiç yanıt vermez (zaman aşımı denetimi)
printf '@echo off\r\nping -n 40 127.0.0.1 >nul\r\n' > "$T/gemini.cmd"

PORT=$(freeport); KPORT=$(freeport); B="http://127.0.0.1:$PORT"
py -3.13 tools/sahte_anahtar.py "$KPORT" "$TW\\anahtar.log" >/dev/null 2>&1 &
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CODEX_HOME="$TW\\codex" \
  CLAUDE_PANEL_GEMINI_EXE="$TW\\gemini.cmd" CLAUDE_PANEL_KEYTEST_BASE="http://127.0.0.1:$KPORT" CLAUDE_PANEL_HUB_OPEN_LOG="$TW\\acilan.log" \
  TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window > "$T/panel.out" 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
TOK=$(cat "$T/data/panel-$PORT.token")
for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$KPORT/x" && break; sleep 0.2; done
L=(-H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json")
post() { curl -s -w '\n%{http_code}' -X POST "${L[@]}" -d "$2" "$B$1"; }
code() { echo "$1" | tail -1; }
j() { py -3.13 -c "import json,sys; d=json.loads(sys.argv[1]); print(eval(sys.argv[2]))" "$(echo "$1" | head -1)" "$2"; }
route() { curl -s -G "$B/api/routing" --data-urlencode "project=$1"; }
uses() { j "$1" "' '.join(f\"{x['id']}={x['use']}\" for x in d['jobs'])"; }
# Sahte gemini'nin süreçleri: cmd (komut satırında gemini.cmd) ve çocuğu ping (-n 40). Ölçen pwsh'nin kendisi sayılmaz.
gemproc() { pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and (\$_.CommandLine -like '*$TW*gemini.cmd*' -or (\$_.Name -eq 'PING.EXE' -and \$_.CommandLine -like '*-n 40 127.0.0.1*')) }).Count" | tr -d '\r'; }

# ---- işçiler: varsayılanlar, Gemini yanıt vermezken istek beklemez ----
S=$(date +%s%N); W=$(curl -s "$B/api/workers"); E=$(( ($(date +%s%N) - S) / 1000000 ))
check "işçiler yanıtı beklemeden döner (<2 sn)" "$([ $E -lt 2000 ] && echo hızlı || echo "yavaş $E ms")" "hızlı"
check "varsayılan: Codex açık ve kurulu (sahte ağaç; plan, sürüm), Gemini kapalı, denetleniyor" \
  "$(j "$W" "(d['codex']['enabled'], d['codex']['installed'], d['codex']['plan'], d['codex']['version'], d['gemini']['enabled'], d['gemini']['state'])")" \
  "(True, True, 'go', '0.171.0', False, 'checking')"
check "yanıt vermeyen sahte gemini çalışıyor (süreç ölçümü onu görüyor)" "$([ "$(gemproc)" -ge 1 ] && echo var || echo yok)" "var"
for _ in $(seq 1 50); do [ "$(j "$(curl -s "$B/api/workers")" "d['gemini']['state']")" = none ] && break; sleep 0.5; done
check "yanıt vermeyen gemini zaman aşımında 'kurulu değil' sayılır" "$(j "$(curl -s "$B/api/workers")" "d['gemini']['state']")" "none"
sleep 1
check "zaman aşımından sonra gemini süreci kalmadı" "$(gemproc)" 0

# ---- yönlendirme: varsayılan sıra, araç durumu ----
R=$(route "")
check "varsayılan sıralar" "$(j "$R" "' | '.join(x['id']+':'+','.join(c['tool'] for c in x['chain']) for x in d['jobs'])")" \
  "image:gemini,openrouter,higgsfield | video:higgsfield,gemini | summary:gemini,codex | translate:gemini,codex | review:codex"
check "durumlar: Gemini kapalı, OpenRouter bağlı değil, Higgsfield bağlı değil, Codex açık" \
  "$(j "$R" "sorted({c['tool']:c['status'] for x in d['jobs'] for c in x['chain']}.items())")" \
  "[('codex', 'on'), ('gemini', 'off'), ('higgsfield', 'none'), ('openrouter', 'none')]"
check "seçilen: görsel ve video Claude'un kendi yolu, özet/çeviri/inceleme Codex" "$(uses "$R")" "image=None video=None summary=codex translate=codex review=codex"

# ---- Gemini açılır ve kurulur ----
check "Gemini aç: 200" "$(code "$(post /api/workers '{"id":"gemini","enabled":true}')")" 200
R=$(route ""); check "açık ama kurulu değil: durum none, seçilmez" "$(j "$R" "[c['status'] for c in d['jobs'][0]['chain'] if c['tool']=='gemini'][0]") $(uses "$R")" "none image=None video=None summary=codex translate=codex review=codex"
printf '@echo off\r\necho 0.1.7\r\n' > "$T/gemini.cmd"
W=$(post /api/workers/gemini/check '{}')
check "kurulunca yeniden dene: sürüm okunur" "$(code "$W") $(j "$W" "(d['gemini']['state'], d['gemini']['version'])")" "200 ('ok', '0.1.7')"
R=$(route "")
check "Gemini açık ve kurulu: görsel, video yedeği, özet ve çeviri Gemini" "$(uses "$R")" "image=gemini video=gemini summary=gemini translate=gemini review=codex"

# ---- şirket işi: kişisel araçlar atlanır ----
R=$(route "$(cygpath -w "$T/p/Musteri-Isleri/Divan")")
check "Musteri-Isleri altında: şirket, Gemini/Higgsfield atlanır" "$(j "$R" "d['company']") $(uses "$R")" "True image=None video=None summary=codex translate=codex review=codex"
check "atlanan çipler işaretli" "$(j "$R" "sorted({c['tool'] for x in d['jobs'] for c in x['chain'] if c['skipped']})")" "['gemini', 'higgsfield']"
R=$(route 'D:\Kod\SIMPHONY\Menu Board'); check "yolunda Simphony klasörü (büyük/küçük harf fark etmez)" "$(j "$R" "d['company']")" "True"
R=$(route 'D:\Kod\SimphonyAraclari'); check "adı Simphony ile başlayan ama Simphony olmayan klasör şirket sayılmaz" "$(j "$R" "d['company']")" "False"
R=$(route "$MUH"); check "şirket hesabına (claude-is) kayıtlı proje şirket işi" "$(j "$R" "d['company']") $(uses "$R")" "True image=None video=None summary=codex translate=codex review=codex"
R=$(route "$(cygpath -w "$T/p/Kisisel/Oyun")"); check "kişisel proje: Gemini kullanılır" "$(j "$R" "d['company']") $(uses "$R")" "False image=gemini video=gemini summary=gemini translate=gemini review=codex"

# ---- OpenRouter anahtarı bağlanınca ----
post /api/hub/key/save '{"provider":"openrouter","key":"sahte-iyi-openrouter-0002-ASDF"}' >/dev/null
R=$(route "$(cygpath -w "$T/p/Musteri-Isleri/Divan")")
check "şirket işinde görsel OpenRouter'a gider (Gemini atlanır)" "$(uses "$R")" "image=openrouter video=None summary=codex translate=codex review=codex"

# ---- sıra değiştirme ----
check "eksik araçlı sıra 400" "$(code "$(post /api/routing '{"job":"image","order":["openrouter","gemini"]}')")" 400
check "yabancı araçlı sıra 400" "$(code "$(post /api/routing '{"job":"image","order":["openrouter","gemini","codex"]}')")" 400
check "yinelenen araçlı sıra 400" "$(code "$(post /api/routing '{"job":"summary","order":["codex","codex"]}')")" 400
check "bilinmeyen iş türü 400" "$(code "$(post /api/routing '{"job":"muzik","order":[]}')")" 400
R=$(post /api/routing '{"job":"image","order":["openrouter","gemini","higgsfield"]}')
check "görsel sırası: OpenRouter önce" "$(code "$R") $(j "$R" "','.join(c['tool'] for c in d['jobs'][0]['chain'])") $(j "$R" "d['jobs'][0]['use']")" "200 openrouter,gemini,higgsfield openrouter"
post /api/routing '{"job":"summary","order":["codex","gemini"]}' >/dev/null
check "sıra kalıcı (hub.json)" "$(py -3.13 -c "import json,sys; print(json.load(open(sys.argv[1],encoding='utf-8'))['Routes'])" "$TW\\data\\hub.json")" "{'image': ['openrouter', 'gemini', 'higgsfield'], 'summary': ['codex', 'gemini']}"

# ---- kapatma ----
post /api/workers '{"id":"codex","enabled":false}' >/dev/null
R=$(route "")
check "Codex kapalı: özette Gemini, incelemede Claude" "$(uses "$R")" "image=openrouter video=gemini summary=gemini translate=gemini review=None"
check "işçi ayarı kalıcı (hub.json)" "$(py -3.13 -c "import json,sys; print(json.load(open(sys.argv[1],encoding='utf-8'))['Workers'])" "$TW\\data\\hub.json")" "{'gemini': True, 'codex': False}"
rm -f "$T/gemini.cmd"
W=$(post /api/workers/gemini/check '{}')
check "gemini kaldırılınca 'kurulu değil'" "$(j "$W" "d['gemini']['state']")" "none"
check "bilinmeyen işçi 400" "$(code "$(post /api/workers '{"id":"higgsfield","enabled":true}')")" 400
check "belirteçsiz işçi değişikliği 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"id":"codex","enabled":true}' "$B/api/workers")" 403
check "belirteçsiz sıra değişikliği 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"job":"summary","order":["gemini","codex"]}' "$B/api/routing")" 403

# ---- yeniden başlatma: ayarlar korunur ----
curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
wait $PID 2>/dev/null
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CODEX_HOME="$TW\\codex" \
  CLAUDE_PANEL_GEMINI_EXE="$TW\\gemini.cmd" TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >> "$T/panel.out" 2>&1 &
PID=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "$B/api/ping" && break; sleep 0.2; done
TOK=$(cat "$T/data/panel-$PORT.token")
check "yeniden başlatınca işçi ve sıra ayarları yerinde" "$(j "$(curl -s "$B/api/workers")" "(d['codex']['enabled'], d['gemini']['enabled'])") $(j "$(route "")" "','.join(c['tool'] for c in d['jobs'][0]['chain'])")" "(False, True) openrouter,gemini,higgsfield"

# ---- temizlik ----
curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
kill $PID 2>/dev/null; wait $PID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 1
check "test süreci kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and \$_.CommandLine -like '*$TW*' }).Count" | tr -d '\r')" 0
pwsh -NoProfile -c "Remove-Item -LiteralPath '$TW' -Recurse -Force -ErrorAction SilentlyContinue"
echo "$n denetim"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail
