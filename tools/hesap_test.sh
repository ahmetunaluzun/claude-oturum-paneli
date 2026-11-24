#!/usr/bin/env bash
# İki Claude hesabı testi (Accounts.cs): ek hesap klasörü (.claude-*) bulunur, her hesabın kotası ayrı okunur,
# --statusline / --quota-guard oturumun CLAUDE_CONFIG_DIR'indeki hesabı kullanır.
# Gerçek ~/.claude'a dokunmaz: geçici klasörde iki sahte hesap; önbellek taze olduğu için API'ye gidilmez.
# Kullanım: tools/hesap_test.sh [exe]   (varsayılan: Release derlemesi)
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
T="$(mktemp -d)"
H="$T/home"
P="$H/.claude" I="$H/.claude-is" X="$H/.claude-bos"
mkdir -p "$P/sessions" "$I" "$X" "$T/data"
unset CLAUDE_CONFIG_DIR
export CLAUDE_PANEL_DATA="$T/data"
fail=0
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
now=$(date +%s)
cache() { # $1 klasör, $2 5 saatlik kullanım, $3 haftalık kullanım
  local reset; reset=$(date -u -d "@$((now + 3600))" +%Y-%m-%dT%H:%M:%S+00:00)
  printf '{"_cached_at":%s,"five_hour":{"utilization":%s,"resets_at":"%s"},"seven_day":{"utilization":%s,"resets_at":"%s"}}' \
    "$now" "$2" "$reset" "$3" "$reset" > "$1/usage-cache.json"
}
cache "$P" 10 99
cache "$I" 30 5
echo '{"claudeAiOauth":{"accessToken":"sahte","subscriptionType":"max","rateLimitTier":"default_claude_max_5x"}}' > "$P/.credentials.json"
echo '{"claudeAiOauth":{"accessToken":"sahte","subscriptionType":"team"}}' > "$I/.credentials.json"
# varsayılan hesabın kaydı klasörün yanında (~/.claude.json), ek hesabınki içinde
echo '{"oauthAccount":{"organizationName":"kisi@ornek.com'"'"'s Organization"}}' > "$H/.claude.json"
echo '{"oauthAccount":{"organizationName":"Örnek Şirket A.Ş."}}' > "$I/.claude.json"
# .claude-bos: giriş yapılmamış klasör → hesap sayılmaz

# ---- durum satırı / kota koruması oturumun hesabını kullanır ----
line=$(echo '{}' | CLAUDE_CONFIG_DIR="$I" "$EXE" --statusline --lang tr)
echo "  şirket satırı: $line"
case "$line" in *"5sa: %70 kaldı"*"Hafta: %95 kaldı"*) check "durum satırı ek hesabın kotası" 1 1;; *) check "durum satırı ek hesabın kotası" 0 1;; esac
line=$(echo '{}' | CLAUDE_CONFIG_DIR="$P" "$EXE" --statusline --lang tr)
case "$line" in *"5sa: %90 kaldı"*"Hafta: %1 kaldı"*) check "durum satırı varsayılan hesap" 1 1;; *) check "durum satırı varsayılan hesap ($line)" 0 1;; esac
cache "$I" 98 5
echo '{"tool_name":"Bash","tool_input":{"command":"git push"}}' | CLAUDE_CONFIG_DIR="$I" "$EXE" --quota-guard --lang tr 2>/dev/null
check "ek hesapta 5 saat %2: koruma engeller" $? 2
echo '{"tool_name":"Bash","tool_input":{"command":"git push"}}' | CLAUDE_CONFIG_DIR="$P" "$EXE" --quota-guard --lang tr 2>/dev/null
check "varsayılan hesapta %90: koruma serbest" $? 0
cache "$I" 30 5
# test klasörü verilmişse CLAUDE_CONFIG_DIR'e bakılmaz (testler gerçek hesaba kaymasın)
line=$(echo '{}' | CLAUDE_PANEL_CLAUDE_DIR="$P" CLAUDE_CONFIG_DIR="$I" "$EXE" --statusline --lang tr)
case "$line" in *"5sa: %90 kaldı"*) check "test klasörü CLAUDE_CONFIG_DIR'den önce gelir" 1 1;; *) check "test klasörü önceliği ($line)" 0 1;; esac

# ---- panel: /api/state hesap listesi + oturumun hesabı ----
export CLAUDE_PANEL_CLAUDE_DIR="$P"
# Her hesapta bir canlı oturum: yer tutucu süreç + kendi hesabının sessions klasöründe dosya (codex_ui_test.sh deseni)
oturum() { # $1 sessions klasörü, $2 oturum kimliği → canlı yer tutucu sürecin Windows pid'i
  py -3.13 -c "import time; time.sleep(300)  # $T" >/dev/null 2>&1 &
  sleep 0.3; local w; w=$(cat /proc/$!/winpid)
  local ft; ft=$(pwsh -NoProfile -c "(Get-Process -Id $w).StartTime.ToFileTimeUtc()" | tr -d '\r')
  printf '{"pid":%s,"sessionId":"%s","cwd":"C:\\\\p","startedAt":%s000,"procStart":"%s","kind":"interactive","status":"idle"}' "$w" "$2" "$now" "$ft" > "$1/$w.json"
  echo "$w"
}
mkdir -p "$I/sessions"
W1=$(oturum "$P/sessions" kisisel-oturum); W2=$(oturum "$I/sessions" sirket-oturum)
PORT=$(pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()')
CLAUDE_PANEL_PORT=$PORT "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/state" && break; sleep 0.2; done
curl -s "http://127.0.0.1:$PORT/api/state" > "$T/state.json"
PYTHONIOENCODING=utf-8 py -3.13 -I - "$T/state.json" > "$T/acc.txt" <<'PY'
import json, sys
sys.stdout.reconfigure(encoding="utf-8")
s = json.load(open(sys.argv[1], encoding='utf-8'))
a = s.get('accounts') or []
print(len(a))
for x in a:
    u = x.get('usage') or {}
    print(x['id'], x.get('label'), x.get('isDefault'), (u.get('five_hour') or {}).get('used'), (u.get('seven_day') or {}).get('used'))
print('EPOSTA' if 'kisi@ornek.com' in open(sys.argv[1], encoding='utf-8').read() else 'temiz')
print(' '.join(sorted(f"{x['sessionId']}={x.get('account')}" for x in s.get('sessions') or [])))
PY
cat "$T/acc.txt" | sed 's/^/  /'
check "iki hesap (giriş yapılmamış klasör sayılmaz)" "$(sed -n 1p "$T/acc.txt")" 2
check "varsayılan hesap: ad yok (kişisel), kota 10/99" "$(sed -n 2p "$T/acc.txt")" ".claude None True 10 99"
check "ek hesap: kuruluş adı, kota 30/5" "$(sed -n 3p "$T/acc.txt")" ".claude-is Örnek Şirket A.Ş. False 30 5"
check "kişisel kuruluş adındaki e-posta arayüze gitmez" "$(sed -n 4p "$T/acc.txt")" "temiz"
check "oturum kendi hesabıyla etiketli" "$(sed -n 5p "$T/acc.txt")" "kisisel-oturum=.claude sirket-oturum=.claude-is"
kill $PID 2>/dev/null; wait $PID 2>/dev/null
# ek hesabın sessions klasörü varsayılana bağlantıysa: oturum bir kez listelenir, hesap varsayılan sayılır
mv "$I/sessions" "$T/eski-sessions"
cmd //c mklink //J "$(cygpath -w "$I/sessions")" "$(cygpath -w "$P/sessions")" >/dev/null
CLAUDE_PANEL_PORT=$PORT "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/state" && break; sleep 0.2; done
check "bağlantılı sessions: kişisel oturum bir kez" "$(curl -s "http://127.0.0.1:$PORT/api/state" | grep -o '"sessionId":"kisisel-oturum"' | wc -l)" 1
kill $PID 2>/dev/null; wait $PID 2>/dev/null
cmd //c rmdir "$(cygpath -w "$I/sessions")"
# tek hesapta accounts null kalır
rm -f "$I/.credentials.json"
CLAUDE_PANEL_PORT=$PORT "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/state" && break; sleep 0.2; done
case "$(curl -s "http://127.0.0.1:$PORT/api/state")" in *'"accounts":null'*) check "tek hesapta accounts null" 1 1;; *) check "tek hesapta accounts null" 0 1;; esac
kill $PID 2>/dev/null; wait $PID 2>/dev/null

# ---- öteki hesapta devam: panel oturumu kapanır, aynı konuşma hedef hesabın klasörüyle (CLAUDE_CONFIG_DIR) açılır ----
echo '{"claudeAiOauth":{"accessToken":"sahte","subscriptionType":"team"}}' > "$I/.credentials.json"
mkdir -p "$T/proje"
printf '{"_test":"gece-modu-koruma quota-guard project-guard"}' > "$P/settings.json" # satır içi --settings JSON .cmd ile geçmez
printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
LOGF="$T/claude.log"; B="http://127.0.0.1:$PORT"
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_CLAUDE_EXE="$(cygpath -w "$T/sahte-claude.cmd")" SAHTE_CLAUDE_LOG="$(cygpath -w "$LOGF")" \
  "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && curl -s -o /dev/null "$B/api/state" && break; sleep 0.2; done
TOK=$(cat "$T/data/panel-$PORT.token")
post() { curl -s -o "$T/resp" -w '%{http_code}' -X POST "$B$1" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json" -d "$2"; }
hosted() { # $1 anahtar → "durum hesap"
  curl -s "$B/api/state" | PYTHONUTF8=1 py -3.13 -c "import json,sys;h=[x for x in json.load(sys.stdin)['hosted'] if x['key']==sys.argv[1]];print((h[0]['status']+' '+str(h[0].get('account'))) if h else 'yok')" "$1"
}
bekle_bos() { for _ in $(seq 1 60); do case "$(hosted "$1")" in idle*) return;; esac; sleep 0.25; done; }
son_hesap() { grep '^HESAP' "$LOGF" | tail -1 | cut -f3 | tr -d '\r'; }
PROJ=$(cygpath -w "$T/proje" | sed 's/\\/\\\\/g')
check "panel oturumu açıldı" "$(post /api/hosted "{\"cwd\":\"$PROJ\",\"prompt\":\"merhaba\"}")" 200
K=$(sed 's/.*"key":"\([^"]*\)".*/\1/' "$T/resp"); bekle_bos "$K"
check "ilk açılış varsayılan hesapta" "$(son_hesap)" "-"
check "varsayılan hesaptaki panel oturumu etiketli" "$(hosted "$K")" "idle .claude"
check "aynı hesaba geçiş reddedilir" "$(post /api/switch-account "{\"key\":\"$K\",\"account\":\".claude\"}")" 409
check "bilinmeyen hesap 400" "$(post /api/switch-account "{\"key\":\"$K\",\"account\":\"..\\\\\\\\x\"}")" 400
check "anahtarsız istek 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/switch-account" -H 'Content-Type: application/json' -d "{\"key\":\"$K\",\"account\":\".claude-is\"}")" 403
check "şirket hesabına geç (200)" "$(post /api/switch-account "{\"key\":\"$K\",\"account\":\".claude-is\"}")" 200
K2=$(sed 's/.*"key":"\([^"]*\)".*/\1/' "$T/resp"); bekle_bos "$K2"
check "yeni süreç şirket klasörüyle açıldı" "$(son_hesap)" "$(cygpath -w "$I")"
check "eski oturum listeden çıktı, yenisi şirket hesabında" "$(hosted "$K") / $(hosted "$K2")" "yok / idle .claude-is"
check "hesap diske yazıldı (panel yeniden açılınca aynı hesap)" "$(grep -c '"Account":".claude-is"' "$T/data/hosted.json")" 1
check "geri al: varsayılan hesaba (200)" "$(post /api/switch-account "{\"key\":\"$K2\",\"account\":\".claude\"}")" 200
K3=$(sed 's/.*"key":"\([^"]*\)".*/\1/' "$T/resp"); bekle_bos "$K3"
check "geri alınca değişken kaldırıldı" "$(son_hesap)" "-"
check "çalışan oturum taşınmaz (busy)" "$(post /api/hosted/$K3/send '{"text":"BEKLE"}' >/dev/null; sleep 0.5; post /api/switch-account "{\"key\":\"$K3\",\"account\":\".claude-is\"}")" 409
# ---- proje hesabı: yeni oturumda seçilen hesap projeye kaydedilir, hesapsız açılan oturum onu kullanır ----
check "geri alınca proje kaydı silindi" "$(cat "$T/data/project-accounts.json" 2>/dev/null | grep -c 'proje')" 0
check "bilinmeyen hesapla yeni oturum 400" "$(post /api/hosted "{\"cwd\":\"$PROJ\",\"prompt\":\"a\",\"account\":\"yok\",\"mode\":\"force\"}")" 400
check "şirket hesabı seçilerek açıldı" "$(post /api/hosted "{\"cwd\":\"$PROJ\",\"prompt\":\"a\",\"account\":\".claude-is\",\"mode\":\"force\"}")" 200
K4=$(sed 's/.*"key":"\([^"]*\)".*/\1/' "$T/resp"); bekle_bos "$K4"
check "seçilen hesapla açıldı" "$(son_hesap)" "$(cygpath -w "$I")"
check "proje şirket hesabına kaydedildi" "$(grep -c '.claude-is' "$T/data/project-accounts.json")" 1
case "$(curl -s "$B/api/state")" in *'"projectAccounts":{"'*'proje":".claude-is"}'*) check "durumda proje hesabı" 1 1;; *) check "durumda proje hesabı" 0 1;; esac
check "hesapsız açılan oturum (aynı proje) 200" "$(post /api/hosted "{\"cwd\":\"$PROJ\",\"prompt\":\"b\",\"mode\":\"force\"}")" 200
K5=$(sed 's/.*"key":"\([^"]*\)".*/\1/' "$T/resp"); bekle_bos "$K5"
check "hesapsız oturum projenin hesabıyla açıldı" "$(son_hesap)" "$(cygpath -w "$I")"
mkdir -p "$T/baska"; BASKA=$(cygpath -w "$T/baska" | sed 's/\\/\\\\/g')
check "başka projede hesapsız oturum 200" "$(post /api/hosted "{\"cwd\":\"$BASKA\",\"prompt\":\"c\"}")" 200
K6=$(sed 's/.*"key":"\([^"]*\)".*/\1/' "$T/resp"); bekle_bos "$K6"
check "başka proje varsayılan hesapta" "$(son_hesap)" "-"
curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
kill $PID 2>/dev/null; wait $PID 2>/dev/null
taskkill //F //PID "$W1" //PID "$W2" >/dev/null 2>&1
sleep 0.5
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail
