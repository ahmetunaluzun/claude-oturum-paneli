#!/usr/bin/env bash
# Kota özelliği testi: --quota-guard, --statusline ve Ayarlar → "Terminal oturumlarında kota" (settings.json kur/geri al).
# Gerçek ~/.claude'a dokunmaz: CLAUDE_PANEL_CLAUDE_DIR + CLAUDE_PANEL_DATA geçici klasörde, test kopyası --no-window.
# Kullanım: tools/kota_test.sh [exe]   (varsayılan: Release derlemesi)
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
T="$(mktemp -d)"
export CLAUDE_PANEL_CLAUDE_DIR="$T/claude" CLAUDE_PANEL_DATA="$T/data"
mkdir -p "$CLAUDE_PANEL_CLAUDE_DIR" "$CLAUDE_PANEL_DATA"
fail=0
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
now=$(date +%s)
cache() { # $1 = 5 saatlik kullanım, $2 = sıfırlanmaya kalan sn
  local reset; reset=$(date -u -d "@$((now + $2))" +%Y-%m-%dT%H:%M:%S+00:00)
  printf '{"_cached_at":%s,"five_hour":{"utilization":%s,"resets_at":"%s"},"seven_day":{"utilization":40,"resets_at":"%s"}}' \
    "$now" "$1" "$reset" "$reset" > "$CLAUDE_PANEL_CLAUDE_DIR/usage-cache.json"
}
guard() { echo "$1" | "$EXE" --quota-guard --lang tr 2>"$T/err"; echo $?; }

# ---- kota koruması ----
cache 97 3600
check "kota %3: git push engellenir" "$(guard '{"tool_name":"Bash","tool_input":{"command":"git push"}}')" 2
grep -q "Kota koruması" "$T/err" && check "engel mesajı Türkçe" 1 1 || check "engel mesajı Türkçe" 0 1
check "kota %3: Read serbest" "$(guard '{"tool_name":"Read","tool_input":{"file_path":"a.cs"}}')" 0
check "kota %3: NEXT_SESSION.md yazımı serbest" "$(guard '{"tool_name":"Write","tool_input":{"file_path":"C:/p/NEXT_SESSION.md"}}')" 0
check "kota %3: kod dosyası düzenleme engellenir" "$(guard '{"tool_name":"Edit","tool_input":{"file_path":"C:/p/a.cs"}}')" 2
check "kota %3: git status serbest" "$(guard '{"tool_name":"Bash","tool_input":{"command":"git status"}}')" 0
cache 50 3600
check "kota %50: her şey serbest" "$(guard '{"tool_name":"Bash","tool_input":{"command":"git push"}}')" 0
cache 99 -60
check "sıfırlanma geçmiş (bayat önbellek): serbest" "$(guard '{"tool_name":"Bash","tool_input":{"command":"rm x"}}')" 0
rm -f "$CLAUDE_PANEL_CLAUDE_DIR/usage-cache.json"
check "kota okunamıyor (önbellek+kimlik yok): serbest" "$(guard '{"tool_name":"Bash","tool_input":{"command":"rm x"}}')" 0
check "bozuk girdi: serbest" "$(guard 'bozuk')" 0

# ---- durum satırı ----
cache 30 7200
line=$(echo '{"context_window":{"context_window_size":200000,"remaining_percentage":8}}' | "$EXE" --statusline --lang tr)
echo "  satır: $line"
case "$line" in *"5sa: %70 kaldı"*"Hafta: %60 kaldı"*"Bağlam: %8 kaldı (16K) !!!"*"/compact"*) check "durum satırı TR" 1 1;; *) check "durum satırı TR" 0 1;; esac
line=$(echo '{}' | "$EXE" --statusline --lang en)
case "$line" in *"5h: 70% left"*) check "durum satırı EN" 1 1;; *) check "durum satırı EN ($line)" 0 1;; esac

# ---- Ayarlar: settings.json kur / geri al ----
S="$CLAUDE_PANEL_CLAUDE_DIR/settings.json"
cat > "$S" <<'JSON'
{
  "model": "opus",
  "statusLine": { "type": "command", "command": "python \"C:\\eski\\statusline.py\"" },
  "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "python güvenlik.py" } ] } ] }
}
JSON
cp "$S" "$T/orijinal.json"
PORT=$(pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()')
CLAUDE_PANEL_PORT=$PORT "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$CLAUDE_PANEL_DATA/panel-$PORT.token" ] && break; sleep 0.2; done
TOK=$(cat "$CLAUDE_PANEL_DATA/panel-$PORT.token")
post() { curl -s -o "$T/resp" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/terminal-quota" \
  -H "X-Panel-Token: $TOK" -H "Origin: http://127.0.0.1:$PORT" -H "Content-Type: application/json" -d "$1"; }
st=$(curl -s "http://127.0.0.1:$PORT/api/terminal-quota")
case "$st" in *'"enabled":false'*'eski'*) check "durum: kapalı + mevcut satır bildirilir" 1 1;; *) check "durum ($st)" 0 1;; esac
check "tokensız istek reddedilir" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/terminal-quota" -H "Content-Type: application/json" -d '{"enabled":true}')" 403
check "aç (200)" "$(post '{"enabled":true,"lang":"tr"}')" 200
grep -q -- '--statusline --lang tr' "$S" && check "statusLine panelinki" 1 1 || check "statusLine panelinki" 0 1
grep -q -- '--quota-guard --lang tr' "$S" && check "kota hook'u eklendi" 1 1 || check "kota hook'u eklendi" 0 1
grep -q 'güvenlik.py' "$S" && check "kullanıcının hook'u + Türkçe karakter korundu" 1 1 || check "kullanıcının hook'u korundu" 0 1
check "dil değişimi (en) yeniden yazar" "$(post '{"enabled":true,"lang":"en"}')" 200
check "tek kota hook'u kaldı" "$(grep -c -- '--quota-guard' "$S")" 1
grep -q -- '--statusline --lang en' "$S" && check "statusLine dili en" 1 1 || check "statusLine dili en" 0 1
check "kapat (200)" "$(post '{"enabled":false}')" 200
py -3.13 -c "import json,sys;a=json.load(open(sys.argv[1],encoding='utf-8'));b=json.load(open(sys.argv[2],encoding='utf-8'));sys.exit(0 if a==b else 1)" "$S" "$T/orijinal.json"
check "kapatınca settings.json ilk hâline döndü" $? 0
# kullanıcının kendi quota-guard'ı varsa ikinci hook eklenmez
sed -i 's/güvenlik.py/quota-guard.py/' "$S"
post '{"enabled":true,"lang":"tr"}' >/dev/null
check "kendi quota-guard varken panel hook'u eklenmez" "$(grep -c -- '--quota-guard' "$S")" 0
post '{"enabled":false}' >/dev/null
# bozuk settings.json'a dokunulmaz
printf '{ // yorum\n "a": 1 }' > "$S"; cp "$S" "$T/bozuk.json"
check "bozuk dosyada açma reddedilir (400)" "$(post '{"enabled":true}')" 400
cmp -s "$S" "$T/bozuk.json" && check "bozuk dosya değişmedi" 1 1 || check "bozuk dosya değişmedi" 0 1

kill $PID 2>/dev/null; wait $PID 2>/dev/null
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail
