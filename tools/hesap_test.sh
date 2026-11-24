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

# ---- panel: /api/state hesap listesi ----
export CLAUDE_PANEL_CLAUDE_DIR="$P"
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
PY
cat "$T/acc.txt" | sed 's/^/  /'
check "iki hesap (giriş yapılmamış klasör sayılmaz)" "$(sed -n 1p "$T/acc.txt")" 2
check "varsayılan hesap: ad yok (kişisel), kota 10/99" "$(sed -n 2p "$T/acc.txt")" ".claude None True 10 99"
check "ek hesap: kuruluş adı, kota 30/5" "$(sed -n 3p "$T/acc.txt")" ".claude-is Örnek Şirket A.Ş. False 30 5"
check "kişisel kuruluş adındaki e-posta arayüze gitmez" "$(sed -n 4p "$T/acc.txt")" "temiz"
kill $PID 2>/dev/null; wait $PID 2>/dev/null
# tek hesapta accounts null kalır
rm -f "$I/.credentials.json"
CLAUDE_PANEL_PORT=$PORT "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/state" && break; sleep 0.2; done
case "$(curl -s "http://127.0.0.1:$PORT/api/state")" in *'"accounts":null'*) check "tek hesapta accounts null" 1 1;; *) check "tek hesapta accounts null" 0 1;; esac
kill $PID 2>/dev/null; wait $PID 2>/dev/null
sleep 0.5
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail
