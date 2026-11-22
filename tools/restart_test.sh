#!/usr/bin/env bash
# Paneli yeniden başlat testi (Restart.cs, POST /api/restart). Gerçek ~/.claude'a ve canlı panele dokunmaz: geçici klasör,
# boş port, test kopyası --no-window, kendi CLAUDE_PANEL_DATA'sı, sahte claude (tools/sahte_claude.py).
#  (a) restart → yeni PID, aynı port, /api/version cevap verir, eski süreç kapandı, panel oturumu geri geldi, log satırı
#  (b) çalışan oturum varken 409 + oturum adı, süreç değişmez; bilgisayardan force=1 → yeniden başlar
#  (c) telefon çereziyle restart çalışır; telefondan force=1 çalışan oturumda 409
#  (d) ClaudePanel.old.exe çalışırken yanında daha yeni ClaudePanel.exe: diskVersion görünür, restart sonrası yeni sürüm çalışır
#  (e) yeni exe başlamazsa (bozuk dosya) ya da devralamazsa (anahtar dosyası yok) eski açık kalır, hata döner
#  (f) sonda test süreci kalmaz (/api/quit ile kapatılır)
# Kullanım: tools/restart_test.sh <A.exe> <B.exe>   A: bu kaynaktan tek dosya yayın; B: aynı kaynak, daha yüksek sürüm
#   (ör. dotnet publish -c Release -f net10.0-windows -o <a>; aynısı -p:Version=0.99.0 -o <b>). A'nın yanındaki runtimes\ de kopyalanır.
set -u
cd "$(dirname "$0")/.."
A="${1:?A.exe}"; Bx="${2:?B.exe}"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0; RH=test.ts.net
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
alive() { pwsh -NoProfile -c "if (Get-Process -Id $1 -ErrorAction SilentlyContinue) { 1 } else { 0 }" | tr -d '\r'; }
j() { py -3.13 -c "import json,sys;d=json.load(open(sys.argv[1],encoding='utf-8'));print($1)" "${2:-$T/son.json}" 2>&1; }
mkdir -p "$T/app" "$T/claude" "$T/data" "$T/tmp" "$T/proje"
cp "$A" "$T/app/ClaudePanel.exe"; cp -r "$(dirname "$A")/runtimes" "$T/app/" 2>/dev/null
printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
printf '{"_test":"gece-modu-koruma quota-guard project-guard"}' > "$T/claude/settings.json"
PORT=$(freeport); B="http://127.0.0.1:$PORT"; DATA="$T/data"; TOK=""

baslat() { # $1: exe adı ($T/app altında)
  CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
    CLAUDE_PANEL_GH_EXE="$TW\\yok.cmd" CLAUDE_PANEL_REMOTE_HOST=$RH TMP="$TW\\tmp" TEMP="$TW\\tmp" "$T/app/$1" --no-window >/dev/null 2>&1 &
  for _ in $(seq 1 60); do [ -f "$DATA/panel-$PORT.token" ] && curl -s -o /dev/null "$B/api/ping" && break; sleep 0.25; done
  TOK=$(cat "$DATA/panel-$PORT.token")
}
ver() { curl -s "$B/api/version" > "$T/ver.json" 2>/dev/null; j "$1" "$T/ver.json"; }
post() { curl -s -o "$T/son.json" -w '%{http_code}' -X POST "$B$1" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json" ${2:+--data-binary "$2"}; }
# Yeni süreç gelene kadar (PID değişene kadar) bekle; yeni PID'i yazar, gelmezse eskisini.
yeni_pid() { local p; for _ in $(seq 1 120); do p=$(ver "d['pid']"); [ -n "$p" ] && [ "$p" != "$1" ] && case "$p" in *[!0-9]*) ;; *) echo "$p"; return;; esac; sleep 0.25; done; echo "$1"; }
retok() { for _ in $(seq 1 40); do [ -f "$DATA/panel-$PORT.token" ] && [ "$(cat "$DATA/panel-$PORT.token")" != "$1" ] && break; sleep 0.25; done; TOK=$(cat "$DATA/panel-$PORT.token"); }
durum() { curl -s "$B/api/state" > "$T/st.json"; j "$1" "$T/st.json"; }
bekle_durum() { for _ in $(seq 1 80); do [ "$(durum "$1")" = "$2" ] && return; sleep 0.25; done; }
kapat() {
  curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
  for _ in $(seq 1 60); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
}

# ---- (a) olağan yeniden başlatma ----
baslat ClaudePanel.exe
P0=$(ver "d['pid']"); V0=$(ver "d['version']")
check "(a) test kopyası açıldı" "$(curl -s "$B/api/ping")" "claude-panel"
check "(a) diskte yeni sürüm yok" "$(ver "d['diskVersion']")" None
PJ=$(cygpath -w "$T/proje" | sed 's/\\/\\\\/g')
check "(a) panel oturumu açıldı" "$(post /api/hosted "{\"cwd\":\"$PJ\",\"prompt\":\"merhaba\",\"name\":\"Deneme oturumu\"}")" 200
KEY=$(j "d['key']")
bekle_durum "[h['status'] for h in d['hosted']]" "['idle']"
check "(a) oturum boşta" "$(durum "[h['status'] for h in d['hosted']]")" "['idle']"
check "(a) restart kabul edildi" "$(post /api/restart)" 200
P1=$(yeni_pid "$P0")
check "(a) yeni PID" "$([ "$P1" != "$P0" ] && echo farklı || echo aynı)" farklı
check "(a) aynı portta cevap veriyor" "$(ver "d['version']")" "$V0"
for _ in $(seq 1 40); do [ "$(alive "$P0")" = 0 ] && break; sleep 0.25; done
check "(a) eski süreç kapandı" "$(alive "$P0")" 0
retok "$TOK"
bekle_durum "len(d['hosted'])" 1
check "(a) panel oturumu geri geldi" "$(durum "[h['name'] for h in d['hosted']]")" "['Deneme oturumu']"
check "(a) restartError yok" "$(ver "d['restartError']")" None
check "(a) logda devir satırı" "$(grep -c "Devir: eski panel (PID $P0) kapandı" "$DATA/logs/restart.log")" 1
check "(a) yeni süreç pencere açmadan başladı" "$(pwsh -NoProfile -c "(Get-CimInstance Win32_Process -Filter 'ProcessId=$P1').CommandLine -like '*--no-window*--restart-from $P0*'" | tr -d '\r')" True

# ---- (b) çalışan oturum varken ----
KEY=$(durum "d['hosted'][0]['key']")
post "/api/hosted/$KEY/send" '{"text":"BEKLE"}' >/dev/null
bekle_durum "[h['status'] for h in d['hosted']]" "['busy']"
check "(b) oturum çalışıyor" "$(durum "[h['status'] for h in d['hosted']]")" "['busy']"
check "(b) restart 409" "$(post /api/restart)" 409
check "(b) hata busy + oturum adı" "$(j "d['error'], d['sessions']")" "busy ['Deneme oturumu']"
sleep 1
check "(b) süreç değişmedi" "$(ver "d['pid']")" "$P1"

# ---- (c) telefondan ----
post /api/remote/enable '{"enabled":true}' >/dev/null
PC=$(curl -s -X POST "$B/api/remote/pair" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json" | grep -o '"code":"[0-9]*' | cut -d'"' -f4)
curl -s -D "$T/hdr" -o /dev/null -X POST "$B/api/remote/claim" -H "Host: $RH" -H "Origin: https://$RH" -H "Content-Type: application/json" -d "{\"code\":\"$PC\",\"name\":\"Test\"}"
CK=$(grep -i "^set-cookie: cp_dev" "$T/hdr" | tr -d '\r' | sed -E 's/^[^:]*: (cp_dev=[^;]*).*/\1/')
rtok() { curl -s -H "Host: $RH" -b "$CK" "$B/" | grep -o 'panel-token" content="[^"]*' | cut -d'"' -f3; }
rpost() { curl -s -o "$T/son.json" -w '%{http_code}' -X POST "$B$1" -H "Host: $RH" -H "Origin: https://$RH" -H "X-Panel-Token: $(rtok)" -b "$CK"; }
check "(c) telefon eşleşti" "$([ -n "$CK" ] && echo var || echo yok)" var
check "(c) telefondan force=1 çalışan oturumda 409" "$(rpost "/api/restart?force=1")" 409
check "(c) telefondan zorlama yok: busy" "$(j "d['error']")" busy
check "(c) çerezsiz telefondan 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/restart" -H "Host: $RH" -H "Origin: https://$RH")" 401
check "(b) bilgisayardan force=1 kabul" "$(post "/api/restart?force=1")" 200
P2=$(yeni_pid "$P1")
check "(b) zorla yeniden başladı (yeni PID)" "$([ "$P2" != "$P1" ] && echo farklı || echo aynı)" farklı
retok "$TOK"
bekle_durum "[h['status'] for h in d['hosted']]" "['idle']"
check "(c) oturum yeniden boşta" "$(durum "[h['status'] for h in d['hosted']]")" "['idle']"
check "(c) telefon çereziyle restart 200" "$(rpost /api/restart)" 200
P3=$(yeni_pid "$P2")
check "(c) telefondan yeniden başladı (yeni PID)" "$([ "$P3" != "$P2" ] && echo farklı || echo aynı)" farklı
retok "$TOK"
check "(c) çerez yeniden başlatmadan sonra geçerli" "$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $RH" -b "$CK" "$B/api/version")" 200
kapat
for _ in $(seq 1 40); do [ "$(alive "$P3")" = 0 ] && break; sleep 0.25; done

# ---- (d) old.exe çalışıyor, yanında yeni ClaudePanel.exe ----
mv "$T/app/ClaudePanel.exe" "$T/app/ClaudePanel.old.exe"; cp "$Bx" "$T/app/ClaudePanel.exe"
VB=$(pwsh -NoProfile -c "\$v=(Get-Item '$TW\\app\\ClaudePanel.exe').VersionInfo; '{0}.{1}.{2}' -f \$v.FileMajorPart,\$v.FileMinorPart,\$v.FileBuildPart" | tr -d '\r')
baslat ClaudePanel.old.exe
P4=$(ver "d['pid']")
check "(d) old.exe çalışıyor" "$(ver "d['version']")" "$V0"
check "(d) diskVersion yeni sürümü gösteriyor" "$(ver "d['diskVersion']")" "$VB"
check "(d) restart kabul edildi" "$(post /api/restart)" 200
P5=$(yeni_pid "$P4")
check "(d) yeni sürüm çalışıyor" "$(ver "d['version']")" "$VB"
check "(d) diskVersion artık yok" "$(ver "d['diskVersion']")" None
check "(d) yeni süreç kanonik exe'den" "$(pwsh -NoProfile -c "(Get-Process -Id $P5).Path" | tr -d '\r')" "$TW\\app\\ClaudePanel.exe"
retok "$TOK"
kapat
for _ in $(seq 1 40); do [ "$(alive "$P5")" = 0 ] && break; sleep 0.25; done

# ---- (e) yeni exe başlamıyor / devralamıyor ----
printf 'bozuk' > "$T/app/ClaudePanel.exe"
baslat ClaudePanel.old.exe
P6=$(ver "d['pid']")
check "(e) bozuk exe: restart 500" "$(post /api/restart)" 500
check "(e) hata start" "$(j "d['error']")" start
check "(e) eski açık kaldı" "$(ver "d['pid']")" "$P6"
check "(e) restartError start" "$(ver "d['restartError']")" start
cp "$A" "$T/app/ClaudePanel.exe"
OLDTOK=$TOK; mv "$DATA/panel-$PORT.token" "$T/token.yedek"
# Yeni süreç anahtarı bulamayınca hemen çıkar: 1,5 sn içindeyse istek 500 + token döner, sonraysa 200 + sonra restartError.
RC=$(post /api/restart)
check "(e) anahtarsız devir: istek 500 token ya da 200" "$([ "$RC" = 200 ] || { [ "$RC" = 500 ] && [ "$(j "d['error']")" = token ]; } && echo uygun || echo "$RC")" uygun
for _ in $(seq 1 60); do [ "$(ver "d['restartError']")" = token ] && break; sleep 0.25; done
check "(e) yeni süreç devralamadı: restartError token" "$(ver "d['restartError']")" token
check "(e) eski açık kaldı (aynı PID)" "$(ver "d['pid']")" "$P6"
check "(e) logda uyarı" "$(grep -c "eski panelin anahtarı yok" "$DATA/logs/restart.log")" 1
mv "$T/token.yedek" "$DATA/panel-$PORT.token"
check "(e) sonra yine yeniden başlatılabilir" "$(post /api/restart)" 200
P7=$(yeni_pid "$P6")
check "(e) yeni PID" "$([ "$P7" != "$P6" ] && echo farklı || echo aynı)" farklı
retok "$OLDTOK"
kapat

# ---- (f) temizlik ----
sleep 1
Q="\$_.Name -ne 'pwsh.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_claude.py*')"
pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { $Q }) | ForEach-Object { \$_.Name + ' ' + \$_.ProcessId }"
check "(f) test süreci kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { $Q }).Count" | tr -d '\r')" 0
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { $Q } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
pwsh -NoProfile -c "Remove-Item -Recurse -Force -LiteralPath '$TW' -ErrorAction SilentlyContinue"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail
