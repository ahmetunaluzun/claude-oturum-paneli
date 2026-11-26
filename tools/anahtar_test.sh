#!/usr/bin/env bash
# Dış servis anahtarı bağlama testi (ApiKeys.cs, HubEndpoints.cs: /api/hub/key/*). Gerçek ağa ÇIKILMAZ, gerçek anahtar KULLANILMAZ:
# deneme istekleri tools/sahte_anahtar.py'ye gider (CLAUDE_PANEL_KEYTEST_BASE), anahtar sayfası açılmaz (CLAUDE_PANEL_HUB_OPEN_LOG),
# Chrome profilleri uydurma dosyadan okunur (CLAUDE_PANEL_CHROME_STATE). Gerçek ~/.claude'a ve canlı panele dokunmaz.
# Denetlenenler: geçerli anahtar şifreli saklanır (düz metin hiçbir dosyada yok), hata nedenleri ayrışır, yanıtlarda ve adreste
# anahtar yok, telefondan (uzak istek) 403, belirteçsiz 403. Kullanım: tools/anahtar_test.sh [exe]
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
unset CLAUDE_CONFIG_DIR
fail=0; n=0
check() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
mkdir -p "$T/claude" "$T/data" "$T/tmp"
printf '{"Notify":false,"Introduced":true}' > "$T/data/tray.json"
echo '{"claudeAiOauth":{"accessToken":"sahte"}}' > "$T/claude/.credentials.json"
# Kişisel Claude hesabının giriş e-postası "Profile 1" ile aynı → otomatik profil Profile 1 (HubEndpoints.AutoProfile)
echo '{"oauthAccount":{"emailAddress":"kisi@ornek.com"}}' > "$T/claude/.claude.json"
printf '{"profile":{"info_cache":{"Default":{"name":"İş","user_name":"is@ornek.com.tr"},"Profile 1":{"name":"Kişisel","user_name":"kisi@ornek.com"}}}}' > "$T/chrome-state.json"

PORT=$(freeport); KPORT=$(freeport); B="http://127.0.0.1:$PORT"; RH=test.ts.net
py -3.13 tools/sahte_anahtar.py "$KPORT" "$TW\\anahtar.log" >/dev/null 2>&1 &
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CODEX_HOME="$TW\\codex" \
  CLAUDE_PANEL_KEYTEST_BASE="http://127.0.0.1:$KPORT" CLAUDE_PANEL_HUB_OPEN_LOG="$TW\\acilan.log" CLAUDE_PANEL_CHROME_STATE="$TW\\chrome-state.json" \
  CLAUDE_PANEL_REMOTE_HOST=$RH TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window > "$T/panel.out" 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
TOK=$(cat "$T/data/panel-$PORT.token")
for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$KPORT/x" && break; sleep 0.2; done
: > "$T/anahtar.log"
L=(-H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json")
post() { curl -s -w '\n%{http_code}' -X POST "${L[@]}" -d "$2" "$B$1"; } # gövde + son satırda durum kodu
code() { echo "$1" | tail -1; }
field() { py -3.13 -c "import json,sys; d=json.loads(sys.argv[1]); k=[x for x in d.get('keys',[]) if x['id']==sys.argv[2]]; print(json.dumps(k[0].get(sys.argv[3]) if k else None))" "$(echo "$1" | head -1)" "$2" "$3"; }
err() { py -3.13 -c "import json,sys; print(json.loads(sys.argv[1]).get('error'))" "$(echo "$1" | head -1)"; }
hub() { curl -s "$B/api/hub"; }
calls() { wc -l < "$T/anahtar.log" | tr -d ' '; }
# Sahte anahtarlar (gerçek değil): her biri ayrı, yanıt ve dosyalarda aranır
K_EL="sahte-iyi-elevenlabs-0001-QWER"; K_OR="sahte-iyi-openrouter-0002-ASDF"; K_GM="sahte-iyi-gemini-0003-ZXCV"; K_OR2="sahte-sinirsiz-openrouter-0004-TYUI"
ALL_OUT="$T/yanitlar.txt"; : > "$ALL_OUT"

H=$(hub); echo "$H" >> "$ALL_OUT"
check "başlangıç: üç servis de bağlı değil" "$(py -3.13 -c "import json,sys; print([(k['id'],k['connected']) for k in json.loads(sys.argv[1])['keys']])" "$H")" "[('elevenlabs', False), ('openrouter', False), ('gemini', False)]"
check "yerel istekte Chrome profilleri listelenir" "$(py -3.13 -c "import json,sys; c=json.loads(sys.argv[1])['chrome']; print([p['dir'] for p in c['profiles']], repr(c['selected']), c['auto'])" "$H")" "['Default', 'Profile 1'] '' Profile 1"

# ---- yetki ----
check "belirteçsiz kaydetme 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "{\"provider\":\"elevenlabs\",\"key\":\"$K_EL\"}" "$B/api/hub/key/save")" 403
check "yabancı kökenden kaydetme 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-Panel-Token: $TOK" -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d "{\"provider\":\"elevenlabs\",\"key\":\"$K_EL\"}" "$B/api/hub/key/save")" 403
check "bilinmeyen servis 400" "$(code "$(post /api/hub/key/save '{"provider":"baska","key":"sahte-iyi-xxxxxxxx"}')")" 400
check "yetkisiz denemeler sahte sunucuya gitmedi" "$(calls)" 0

# ---- biçimi bozuk anahtar: ağa çıkılmaz ----
for bad in '""' '"kisa"' '"sahte iyi bosluklu anahtar"' "\"$(printf 'a%.0s' $(seq 1 401))\"" '"sahte-iyi-\u00fc-anahtar"'; do # ASCII dışı harf (JSON kaçışıyla: kabuk kodlamasına bağlı kalmasın)
  R=$(post /api/hub/key/save "{\"provider\":\"elevenlabs\",\"key\":$bad}")
  [ "$(code "$R")/$(err "$R")" = "400/badkey" ] || { echo "KALDI  bozuk anahtar reddi: ${bad:0:30} → $(code "$R")/$(err "$R")"; fail=1; }
done
check "biçimi bozuk anahtarlar ağa çıkmadan reddedildi" "$(calls)" 0

# ---- hata nedenleri ayrışır, hiçbiri kaydedilmez ----
R=$(post /api/hub/key/save '{"provider":"elevenlabs","key":"sahte-kotu-anahtar-9999"}'); echo "$R" >> "$ALL_OUT"
check "ElevenLabs yanlış anahtar: badkey (401)" "$(code "$R")/$(err "$R")" "400/badkey"
R=$(post /api/hub/key/save '{"provider":"elevenlabs","key":"sahte-izin-anahtar-9998"}'); echo "$R" >> "$ALL_OUT"
check "ElevenLabs izin eksik: noperm" "$(err "$R")" "noperm"
R=$(post /api/hub/key/save '{"provider":"elevenlabs","key":"sahte-bos-anahtar-9997"}'); echo "$R" >> "$ALL_OUT"
check "ElevenLabs karakter kalmamış: nobalance" "$(err "$R")" "nobalance"
R=$(post /api/hub/key/save '{"provider":"openrouter","key":"sahte-bos-anahtar-9996"}'); echo "$R" >> "$ALL_OUT"
check "OpenRouter bakiye yok (402): nobalance" "$(err "$R")" "nobalance"
R=$(post /api/hub/key/save '{"provider":"openrouter","key":"sahte-ag-anahtar-9995"}'); echo "$R" >> "$ALL_OUT"
check "bağlantı kopuk: network" "$(err "$R")" "network"
R=$(post /api/hub/key/save '{"provider":"openrouter","key":"sahte-500-anahtar-9994"}'); echo "$R" >> "$ALL_OUT"
check "sunucu hatası: http + durum kodu" "$(err "$R")/$(py -3.13 -c "import json,sys; print(json.loads(sys.argv[1]).get('status'))" "$(echo "$R" | head -1)")" "http/500"
R=$(post /api/hub/key/save '{"provider":"gemini","key":"sahte-kotu-anahtar-9993"}'); echo "$R" >> "$ALL_OUT"
check "Gemini yanlış anahtar (400): badkey" "$(err "$R")" "badkey"
R=$(post /api/hub/key/save '{"provider":"gemini","key":"sahte-bos-anahtar-9992"}'); echo "$R" >> "$ALL_OUT"
check "Gemini kota dolu (429): nobalance" "$(err "$R")" "nobalance"
check "başarısız denemelerden sonra hiçbiri bağlı değil, kasa boş" "$(py -3.13 -c "import json,sys; print(sum(k['connected'] for k in json.loads(sys.argv[1])['keys']))" "$(hub)")/$(ls "$T/data/secrets" 2>/dev/null | wc -l | tr -d ' ')" "0/0"

# ---- geçerli anahtar: denenir, şifreli saklanır ----
R=$(post /api/hub/key/save "{\"provider\":\"elevenlabs\",\"key\":\"  $K_EL  \"}"); echo "$R" >> "$ALL_OUT"
check "ElevenLabs geçerli anahtar: 200, bağlı, son 4, kalan/limit, paket" "$(code "$R") $(field "$R" elevenlabs connected) $(field "$R" elevenlabs last4) $(field "$R" elevenlabs remaining)/$(field "$R" elevenlabs limit) $(field "$R" elevenlabs tier)" '200 true "QWER" 186000/300000 "creator"'
R=$(post /api/hub/key/save "{\"provider\":\"openrouter\",\"key\":\"$K_OR\"}"); echo "$R" >> "$ALL_OUT"
check "OpenRouter geçerli anahtar: kalan limit" "$(code "$R") $(field "$R" openrouter last4) $(field "$R" openrouter balance)" '200 "ASDF" 7.5'
R=$(post /api/hub/key/save "{\"provider\":\"gemini\",\"key\":\"$K_GM\"}"); echo "$R" >> "$ALL_OUT"
check "Gemini geçerli anahtar: model sayısı" "$(code "$R") $(field "$R" gemini last4) $(field "$R" gemini models)" '200 "ZXCV" 3'
check "kasada üç şifreli dosya" "$(ls "$T/data/secrets" | sort | tr '\n' ' ')" "apikey-elevenlabs.bin apikey-gemini.bin apikey-openrouter.bin "
# Yanlış anahtarla değiştirme denemesi: eski anahtar yerinde kalır
R=$(post /api/hub/key/save '{"provider":"openrouter","key":"sahte-kotu-anahtar-9991"}'); echo "$R" >> "$ALL_OUT"
check "yanlış anahtarla değiştirme: hata, eski anahtar bağlı kalır" "$(err "$R") $(py -3.13 -c "import json,sys; print([k['last4'] for k in json.loads(sys.argv[1])['keys'] if k['id']=='openrouter'][0])" "$(hub)")" "badkey ASDF"
R=$(post /api/hub/key/save "{\"provider\":\"openrouter\",\"key\":\"$K_OR2\"}"); echo "$R" >> "$ALL_OUT"
check "anahtar değiştirme: yeni son 4, harcama sınırı yok" "$(field "$R" openrouter last4) $(field "$R" openrouter noLimit) $(field "$R" openrouter balance)" '"TYUI" true null'
R=$(post /api/hub/key/check '{"provider":"elevenlabs"}'); echo "$R" >> "$ALL_OUT"
check "yeniden dene: kayıtlı anahtarla 200" "$(code "$R") $(field "$R" elevenlabs remaining)" "200 186000"
hub >> "$ALL_OUT"; curl -s "$B/api/state" >> "$ALL_OUT"

# ---- gizlilik: anahtar hiçbir yanıtta, adreste, düz dosyada, panel çıktısında yok ----
leak=0
for k in "$K_EL" "$K_OR" "$K_GM" "$K_OR2" sahte-kotu-anahtar sahte-bos-anahtar sahte-izin-anahtar; do
  grep -q -- "$k" "$ALL_OUT" && { echo "  yanıtta anahtar: ${k:0:14}…"; leak=1; }
  grep -rqa -- "$k" "$T/data" "$T/panel.out" "$T/tmp" 2>/dev/null && { echo "  dosyada anahtar: ${k:0:14}…"; leak=1; }
done
check "anahtar hiçbir yanıtta ve hiçbir dosyada düz metin değil" "$leak" 0
check "deneme isteklerinde adres (yol/sorgu) anahtar içermiyor" "$(grep -c -e 'sahte-' -e 'key=' "$T/anahtar.log")" 0
check "her serviste anahtar doğru başlıkta gitti" "$(cut -f2,3 "$T/anahtar.log" | sort -u | tr '\t\n' ' |')" "/elevenlabs/v1/user/subscription xi-api-key|/gemini/v1beta/models x-goog-api-key|/openrouter/api/v1/key authorization|"
check "durum dosyasında yalnız gizli olmayan bilgi" "$(py -3.13 -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); print(sorted(d), sorted(set(k for v in d.values() for k in v)))" "$TW\\data\\api-keys.json")" "['elevenlabs', 'gemini', 'openrouter'] ['At', 'Balance', 'Last4', 'Limit', 'Models', 'NoLimit', 'Remaining', 'Tier']"

# ---- anahtar sayfası: seçili Chrome profilinde ----
R=$(post /api/hub/key/open '{"provider":"openrouter"}')
check "otomatik: kişisel Claude hesabının e-postasıyla eşleşen profilde" "$(code "$R") $(tail -1 "$T/acilan.log")" "200 Profile 1	https://openrouter.ai/settings/keys"
R=$(post /api/hub/chrome-profile '{"dir":"-"}')
check "varsayılan tarayıcı seçimi kaydedildi" "$(code "$R") $(py -3.13 -c "import json,sys; print(json.loads(sys.argv[1])['selected'])" "$(echo "$R" | head -1)")" "200 -"
post /api/hub/key/open '{"provider":"openrouter"}' >/dev/null
check "varsayılan tarayıcı seçiliyken sayfa profilsiz açılır" "$(tail -1 "$T/acilan.log")" "-	https://openrouter.ai/settings/keys"
R=$(post /api/hub/chrome-profile '{"dir":""}')
check "otomatiğe dönüş" "$(code "$R") $(py -3.13 -c "import json,sys; d=json.loads(sys.argv[1]); print(repr(d['selected']), d['auto'])" "$(echo "$R" | head -1)")" "200 '' Profile 1"
echo '{"oauthAccount":{"emailAddress":"baska@ornek.org"}}' > "$T/claude/.claude.json"
post /api/hub/key/open '{"provider":"openrouter"}' >/dev/null
check "otomatik, eşleşen profil yoksa varsayılan tarayıcı" "$(tail -1 "$T/acilan.log")" "-	https://openrouter.ai/settings/keys"
echo '{"oauthAccount":{"emailAddress":"kisi@ornek.com"}}' > "$T/claude/.claude.json"
check "olmayan profil 400" "$(code "$(post /api/hub/chrome-profile '{"dir":"Profile 9"}')")" 400
R=$(post /api/hub/chrome-profile '{"dir":"Profile 1"}')
check "profil seçimi kaydedildi" "$(code "$R") $(py -3.13 -c "import json,sys; print(json.loads(sys.argv[1])['selected'])" "$(echo "$R" | head -1)")" "200 Profile 1"
post /api/hub/key/open '{"provider":"elevenlabs"}' >/dev/null; post /api/hub/key/open '{"provider":"gemini"}' >/dev/null
check "anahtar sayfaları seçili profilde açılır" "$(tail -2 "$T/acilan.log" | tr '\t\n' ' |')" "Profile 1 https://elevenlabs.io/app/settings/api-keys|Profile 1 https://aistudio.google.com/apikey|"

# ---- telefondan (uzak istek): anahtar uçları kapalı, durum okunur ama profil bilgisi gitmez ----
curl -s -o /dev/null -X POST "${L[@]}" -d '{"enabled":true}' "$B/api/remote/enable"
PC=$(curl -s -X POST "${L[@]}" "$B/api/remote/pair" | grep -o '"code":"[0-9]*' | cut -d'"' -f4)
HDR=$(mktemp)
curl -s -o /dev/null -D "$HDR" -X POST -H "Host: $RH" -H "Origin: https://$RH" -H 'Content-Type: application/json' -d "{\"code\":\"$PC\",\"name\":\"Test\"}" "$B/api/remote/claim"
CK=$(grep -i "^set-cookie: cp_dev" "$HDR" | tr -d '\r' | sed -E 's/^[^:]*: (cp_dev=[^;]*).*/\1/'); rm -f "$HDR"
RT=$(curl -s -H "Host: $RH" -b "$CK" "$B/" | grep -o 'panel-token" content="[^"]*' | cut -d'"' -f3)
RM=(-H "Host: $RH" -H "Origin: https://$RH" -b "$CK" -H "X-Panel-Token: $RT" -H 'Content-Type: application/json')
check "telefon eşleşti (sınama geçerli)" "$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $RH" -b "$CK" "$B/api/state")" 200
before=$(calls)
for ep in save check remove open; do
  check "telefondan /api/hub/key/$ep 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${RM[@]}" -d "{\"provider\":\"elevenlabs\",\"key\":\"$K_EL\"}" "$B/api/hub/key/$ep")" 403
done
check "telefondan profil seçimi 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${RM[@]}" -d '{"dir":""}' "$B/api/hub/chrome-profile")" 403
check "telefondan gelen istek deneme başlatmadı, anahtar yerinde" "$(calls) $(ls "$T/data/secrets" | wc -l | tr -d ' ')" "$before 3"
RH_HUB=$(curl -s -H "Host: $RH" -b "$CK" "$B/api/hub")
check "telefonda durum okunur, Chrome profilleri gönderilmez" "$(py -3.13 -c "import json,sys; d=json.loads(sys.argv[1]); print(sum(k['connected'] for k in d['keys']), d['chrome'])" "$RH_HUB") $(echo "$RH_HUB" | grep -c 'ornek.com')" "3 None 0"

# ---- kaldırma ----
R=$(post /api/hub/key/remove '{"provider":"gemini"}')
check "kaldırınca bağlı değil, kasadan silindi" "$(field "$R" gemini connected) $(ls "$T/data/secrets" | tr '\n' ' ')" "false apikey-elevenlabs.bin apikey-openrouter.bin "
check "kaldırılmış anahtarı yeniden deneme: badkey" "$(err "$(post /api/hub/key/check '{"provider":"gemini"}')")" "badkey"

# ---- temizlik ----
curl -s -o /dev/null -X POST "$B/api/quit?force=1" -H "X-Panel-Token: $TOK" -H "Origin: $B"
for _ in $(seq 1 40); do curl -s -o /dev/null "$B/api/ping" || break; sleep 0.25; done
kill $PID 2>/dev/null; wait $PID 2>/dev/null
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_anahtar.py* $KPORT *') } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
sleep 1
check "test süreci kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.Name -ne 'bash.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_anahtar.py* $KPORT *') }).Count" | tr -d '\r')" 0
pwsh -NoProfile -c "Remove-Item -LiteralPath '$TW' -Recurse -Force -ErrorAction SilentlyContinue"
echo "$n denetim"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail
