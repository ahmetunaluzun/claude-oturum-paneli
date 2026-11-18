#!/usr/bin/env bash
# Telefondan erişim güvenlik testi (0.7.0). Panelin test kopyası test adresiyle çalışıyor olmalı (port: PORT değişkeni, varsayılan 8791):
#   CLAUDE_PANEL_PORT=<port> CLAUDE_PANEL_DATA=<boş klasör> CLAUDE_PANEL_REMOTE_HOST=test.ts.net ClaudePanel --no-window
#   PORT=<port> tools/remote_guvenlik_testi.sh
# Telefon isteği = Host: test.ts.net (Tailscale serve böyle iletir). Çıkış 0 = hepsi geçti.
set -u
B=http://127.0.0.1:${PORT:-8791}
RH=test.ts.net
JAR=$(mktemp)
fail=0
chk() { # ad beklenen gerçek
  if [ "$2" = "$3" ]; then echo "GEÇTİ  $1 ($3)"; else echo "KALDI  $1: beklenen $2, gelen $3"; fail=1; fi
}
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
R=(-H "Host: $RH")
RO=(-H "Host: $RH" -H "Origin: https://$RH")

TOKEN=$(curl -s $B/ | grep -o 'panel-token" content="[^"]*' | cut -d'"' -f3)
L=(-H "X-Panel-Token: $TOKEN" -H "Content-Type: application/json")
chk "yerel sayfa REMOTE=0" 1 "$(curl -s $B/ | grep -c 'panel-remote" content="0')"

chk "erişim kapalıyken telefon adresi" 403 "$(code "${R[@]}" $B/)"
chk "yabancı ad (DNS rebinding)" 403 "$(code -H 'Host: evil.example' $B/)"
chk "erişimi aç (yerel)" 200 "$(code -X POST "${L[@]}" -d '{"enabled":true}' $B/api/remote/enable)"

chk "çerezsiz ana sayfa → eşleştirmeye yönlendir" 302 "$(code "${R[@]}" $B/)"
chk "çerezsiz /api/state" 401 "$(code "${R[@]}" $B/api/state)"
chk "çerezsiz /api/transcript" 401 "$(code "${R[@]}" $B/api/transcript/x)"
chk "çerezsiz /api/followup (takip, 0.11.0)" 401 "$(code "${R[@]}" $B/api/followup)"
chk "çerezsiz /api/followup/refresh" 401 "$(code -X POST "${RO[@]}" $B/api/followup/refresh)"
chk "çerezsiz /assets/app.js" 401 "$(code "${R[@]}" $B/assets/app.js)"
chk "çerezsiz /api/dictation (dikte, 0.8.13)" 401 "$(code -X POST "${RO[@]}" -H 'Content-Type: audio/wav' --data-binary @/dev/null $B/api/dictation)"
chk "çerezsiz /api/dictation/model" 401 "$(code -X POST "${RO[@]}" $B/api/dictation/model)"
chk "çerezsiz /pair" 200 "$(code "${R[@]}" $B/pair)"
chk "sahte çerez" 401 "$(code "${R[@]}" -b "cp_dev=$(printf 'a%.0s' {1..64})" $B/api/state)"
chk "eşleştirme yokken claim" 409 "$(code -X POST "${RO[@]}" -H 'Content-Type: application/json' -d '{"code":"000000"}' $B/api/remote/claim)"

P=$(curl -s -X POST "${L[@]}" $B/api/remote/pair)
PC=$(echo "$P" | grep -o '"code":"[0-9]*' | cut -d'"' -f4)
chk "eşleştirme kodu 6 hane" 6 "${#PC}"
chk "kare kod SVG" 1 "$(echo "$P" | grep -c '<svg')"
WRONG=$(printf '%06d' $(( (10#$PC + 1) % 1000000 )))
chk "claim Origin'siz" 403 "$(code -X POST "${R[@]}" -H 'Content-Type: application/json' -d "{\"code\":\"$PC\"}" $B/api/remote/claim)"
chk "claim yerelden" 403 "$(code -X POST -H "Origin: $B" -H 'Content-Type: application/json' -d "{\"code\":\"$PC\"}" $B/api/remote/claim)"
chk "yanlış kod" 401 "$(code -X POST "${RO[@]}" -H 'Content-Type: application/json' -d "{\"code\":\"$WRONG\"}" $B/api/remote/claim)"
HDR=$(mktemp)
chk "doğru kod" 200 "$(code -D "$HDR" -X POST "${RO[@]}" -H 'Content-Type: application/json' -d "{\"code\":\"$PC\",\"name\":\"Test<b>\"}" $B/api/remote/claim)"
SC=$(grep -i "^set-cookie: cp_dev" "$HDR" | tr -d '\r')
chk "çerez HttpOnly+Secure+Lax" 1 "$(echo "$SC" | grep -i "httponly" | grep -i "secure" | grep -ic "samesite=lax")"
CK=$(echo "$SC" | sed -E 's/^[^:]*: (cp_dev=[^;]*).*/\1/')
rm -f "$HDR"
chk "aynı kod ikinci kez" 409 "$(code -X POST "${RO[@]}" -H 'Content-Type: application/json' -d "{\"code\":\"$PC\"}" $B/api/remote/claim)"

C=(-b "$CK")
PAGE=$(curl -s "${R[@]}" "${C[@]}" $B/)
chk "çerezli ana sayfa REMOTE=1" 1 "$(echo "$PAGE" | grep -c 'panel-remote" content="1')"
RT=$(echo "$PAGE" | grep -o 'panel-token" content="[^"]*' | cut -d'"' -f3)
RA=(-H "Host: $RH" -H "Origin: https://$RH" -H "X-Panel-Token: $RT" -H "Content-Type: application/json" "${C[@]}")
chk "çerezli /api/state" 200 "$(code "${R[@]}" "${C[@]}" $B/api/state)"
chk "çerezli /api/night (POST değil, okuma)" 200 "$(code "${R[@]}" "${C[@]}" $B/api/night)"
chk "telefondan /api/followup (okuma)" 200 "$(code "${R[@]}" "${C[@]}" $B/api/followup)"
chk "telefondan takip yenileme, belirteçsiz" 403 "$(code -X POST -H "Host: $RH" -H "Origin: https://$RH" "${C[@]}" $B/api/followup/refresh)"
chk "telefondan takip yenileme (izinli)" 200 "$(code -X POST "${RA[@]}" $B/api/followup/refresh)"
chk "telefondan /api/quit" 403 "$(code -X POST "${RA[@]}" $B/api/quit)"
chk "telefondan /API/QUIT (harf)" 403 "$(code -X POST "${RA[@]}" $B/API/QUIT)"
chk "telefondan /api/quit/ (bölü)" 403 "$(code -X POST "${RA[@]}" $B/api/quit/)"
chk "telefondan /api/focus/1" 403 "$(code -X POST "${RA[@]}" $B/api/focus/1)"
chk "telefondan /api/sessions (terminal)" 403 "$(code -X POST "${RA[@]}" -d '{}' $B/api/sessions)"
chk "telefondan /api/pick-folder" 403 "$(code -X POST "${RA[@]}" $B/api/pick-folder)"
chk "telefondan dikte, belirteçsiz" 403 "$(code -X POST -H "Host: $RH" -H "Origin: https://$RH" "${C[@]}" -H 'Content-Type: audio/wav' --data-binary @/dev/null $B/api/dictation)"
chk "telefondan dikte durumu (okuma)" 200 "$(code "${R[@]}" "${C[@]}" $B/api/dictation)"
chk "telefondan /api/clipboard-paths" 403 "$(code -X POST "${RA[@]}" $B/api/clipboard-paths)"
chk "telefondan /api/reveal (Gezgin)" 403 "$(code -X POST "${RA[@]}" -d '{"path":"C:\\\\"}' $B/api/reveal)"
chk "telefondan /api/path-links (yol varlığı)" 403 "$(code -X POST "${RA[@]}" -d '["C:\\\\"]' $B/api/path-links)"
chk "telefondan /api/terminal-quota (settings.json yazma)" 403 "$(code -X POST "${RA[@]}" -d '{"enabled":true}' $B/api/terminal-quota)"
chk "telefondan /api/terminal-quota (okuma)" 403 "$(code "${R[@]}" "${C[@]}" $B/api/terminal-quota)"
chk "telefondan /api/remote (liste)" 403 "$(code "${R[@]}" "${C[@]}" $B/api/remote)"
VIEW=$(curl -s "${R[@]}" "${C[@]}" $B/api/remote/view)
chk "telefondan /api/remote/view (okuma)" 200 "$(code "${R[@]}" "${C[@]}" $B/api/remote/view)"
chk "görünümde bu cihaz işaretli" 1 "$(echo "$VIEW" | grep -c '"current":true')"
chk "görünümde cihaz kimliği/kare kod yok" 0 "$(echo "$VIEW" | grep -c '"id"\|appQr\|<svg')"
chk "çerezsiz /api/remote/view" 401 "$(code "${R[@]}" $B/api/remote/view)"
chk "ana sayfa çerezi Lax ile yeniler" 1 "$(curl -s -D - -o /dev/null "${R[@]}" "${C[@]}" $B/ | grep -i '^set-cookie: cp_dev' | grep -ic 'samesite=lax')"
chk "telefondan /api/remote/pair" 403 "$(code -X POST "${RA[@]}" $B/api/remote/pair)"
chk "telefondan /api/remote/enable" 403 "$(code -X POST "${RA[@]}" -d '{"enabled":false}' $B/api/remote/enable)"
chk "telefondan anahtarsız POST /api/night" 403 "$(code -X POST "${R[@]}" "${C[@]}" -H 'Content-Type: application/json' -d '{}' $B/api/night)"
chk "telefondan yabancı Origin" 403 "$(code -X POST -H "Host: $RH" -H 'Origin: https://evil.example' -H "X-Panel-Token: $RT" -H 'Content-Type: application/json' "${C[@]}" -d '{}' $B/api/dirs)"
chk "telefondan /api/dirs (izinli)" 200 "$(code -X POST "${RA[@]}" -d '{}' $B/api/dirs)"

ST=$(curl -s "${L[@]}" $B/api/remote)
chk "cihaz adı temiz" 1 "$(echo "$ST" | grep -c '"name":"Test<b>"\|"name":"Test\\u003Cb\\u003E"')"
DID=$(echo "$ST" | grep -o '"id":"[0-9a-f]*' | head -1 | cut -d'"' -f4)
chk "cihazı kaldır (yerel)" 200 "$(code -X POST "${L[@]}" $B/api/remote/revoke/$DID)"
chk "kaldırılan cihazın çerezi" 401 "$(code "${R[@]}" "${C[@]}" $B/api/state)"

curl -s -o /dev/null -X POST "${L[@]}" $B/api/remote/pair
for i in 1 2 3 4 5; do curl -s -o /dev/null -X POST "${RO[@]}" -H 'Content-Type: application/json' -d '{"code":"999999"}' $B/api/remote/claim; done
chk "5 yanlıştan sonra kod düşer" 409 "$(code -X POST "${RO[@]}" -H 'Content-Type: application/json' -d '{"code":"999999"}' $B/api/remote/claim)"

chk "erişimi kapat" 200 "$(code -X POST "${L[@]}" -d '{"enabled":false}' $B/api/remote/enable)"
chk "kapalıyken telefon adresi" 403 "$(code "${R[@]}" $B/pair)"
rm -f "$JAR"
exit $fail
