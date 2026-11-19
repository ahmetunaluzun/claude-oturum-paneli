#!/usr/bin/env bash
# Takip 3. aşama API testi (0.13.0): güncelleme kütüğü ayrıştırıcısı (DriveLedger.cs; üç biçim, okunamayan satır, KAPATILDI
# bölümü, dosya değişince mtime) ve "Kütüğü kapat" arka plan işi (/api/follow/ledger; gizli oturum, panel kütüğe yazmaz).
# Gerçek ~/.claude'a ve gerçek projelere dokunmaz: uydurma ortam (tools/takip_ortam.sh <klasör> kutuk), test kopyası
# --no-window ve boş portta, gerçek claude yerine tools/sahte_claude.py.
# Kullanım: tools/takip3_test.sh [exe]
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0
export PYTHONUTF8=1
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
freeport() { pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()' | tr -d '\r'; }
tools/takip_ortam.sh "$T" kutuk || { echo "ortam kurulamadı"; rm -rf "$T"; exit 1; }
P="$T/projeler"
printf '@echo off\r\npy -3.13 "%s"\r\n' "$(cygpath -w "$PWD/tools/sahte_claude.py")" > "$T/sahte-claude.cmd"
printf '{"_test":"gece-modu-koruma quota-guard project-guard"}' > "$T/claude/settings.json"
PORT=$(freeport); B="http://127.0.0.1:$PORT"
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" CLAUDE_PANEL_CLAUDE_EXE="$TW\\sahte-claude.cmd" \
  SAHTE_CLAUDE_LOG="$TW\\sahte.log" SAHTE_CLAUDE_GECIKME=3 TMP="$TW\\tmp" TEMP="$TW\\tmp" "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
TOK=$(cat "$T/data/panel-$PORT.token")
esc() { cygpath -w "$1" | sed 's/\\/\\\\/g'; }
post() { local f="$T/govde.$BASHPID.json"; printf '%s' "$2" > "$f"; curl -s -o "${3:-$T/son.json}" -w '%{http_code}' -X POST "$B$1" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json" --data-binary @"$f"; }
j() { py -3.13 -c "import json,sys;d=json.load(open(sys.argv[1],encoding='utf-8'));print($1)" "${2:-$T/son.json}" 2>&1; }
# q <ifade>: son /api/followup yanıtı d'de; D = proje adı → o kütüğün satırları (kütükteki sırayla)
q() { py -3.13 -c "
import json,sys,os
d=json.load(open(sys.argv[1],encoding='utf-8'));D={}
for x in sorted(d['drive'],key=lambda x:x['line']): D.setdefault(x['name'],[]).append(x)
rel=lambda x: os.path.relpath(x['path'],os.path.dirname(x['ledger'])).replace(os.sep,'/') if x['path'] else None
gun=lambda ms: __import__('datetime').datetime.fromtimestamp(ms/1000).strftime('%Y-%m-%d') if ms else None
print($1)" "$T/fu.json" 2>&1; }
snap() { for _ in $(seq 1 60); do curl -s "$B/api/followup" > "$T/fu.json"; [ "$(j "d['scanning'] or d['checkedAt']==0" "$T/fu.json")" = "False" ] && return 0; sleep 0.5; done; return 1; }
refresh() { local before; before=$(j "d['checkedAt']" "$T/fu.json"); curl -s -o /dev/null -X POST "$B/api/followup/refresh" -H "X-Panel-Token: $TOK" -H "Origin: $B"
  for _ in $(seq 1 60); do snap; [ "$(j "d['checkedAt']" "$T/fu.json")" != "$before" ] && return 0; sleep 0.3; done; return 1; }
hosted() { curl -s "$B/api/state" > "$T/state.json"; j "len(d['hosted'])" "$T/state.json"; }
it() { curl -s "$B/api/follow/jobs" > "$T/jobs.json"; py -3.13 -c "import json,sys;d=json.load(open(sys.argv[1],encoding='utf-8'));i=[x for job in d for x in job['items'] if x['name']==sys.argv[2]][-1];print($2)" "$T/jobs.json" "$1" 2>&1; }
bitir() { for _ in $(seq 1 80); do case "$(it "$1" "i['state']")" in done|failed|decision|skipped) return 0;; esac; sleep 0.3; done; return 1; }

snap; check "tarama bitti" $? 0
check "üç kütük okundu" "$(q "sorted(D)")" "['Kılavuz Deposu', 'Mimari Belgesi', 'Yardım Sitesi']"
check "toplam 9 satır (7 dosya + 2 okunamayan); kapalı ve bölüm dışı satırlar yok" "$(q "len(d['drive']), sum(1 for x in d['drive'] if x['path'] is None)")" "9 2"

# ---- biçim A: - [Ad vX —] \`yol\` [(not)] ----
check "A: dosyalar (kütük sırası)" "$(q "[rel(x) for x in D['Kılavuz Deposu']]")" "['cikti/v1.3.0/Etiket_Kilavuzu.docx', 'cikti/v1.3.0/Label_Guide.docx', None, 'cikti/v2.0.1/Fis_Kilavuzu.docx']"
check "A: sürüm addan, nottan, yoldaki klasörden" "$(q "[x['version'] for x in D['Kılavuz Deposu']]")" "['1.3.0', '1.3.0', None, '2.0.1']"
check "A: tarih üst başlıktan / kendi başlığından" "$(q "[gun(x['since']) for x in D['Kılavuz Deposu']]")" "['2026-11-10', '2026-11-10', '2026-11-10', '2026-11-15']"
check "A: nottaki \`0 - Yok\` yol sanılmadı; olmayan dosya 'yok' olarak döner" "$(q "[(x['file'], x['exists']) for x in D['Kılavuz Deposu'] if x['path']]")" "[('Etiket_Kilavuzu.docx', True), ('Label_Guide.docx', False), ('Fis_Kilavuzu.docx', True)]"
check "A: okunamayan satır metniyle döner (sessiz atlanmaz)" "$(q "[x['text'] for x in D['Kılavuz Deposu'] if not x['path']]")" "['Kapak görseli sonra eklenecek']"
check "A: KAPATILDI bölümündeki dosya alınmadı" "$(q "any('v1.2.0' in (x['path'] or '') for x in d['drive'])")" False
check "A: aynı belgenin eski sürümleri satır olmadı (yoldaki sürüm klasörü ve dosya adı eki), en yüksek sürüm kaldı" \
  "$(q "[[rel({'path':o,'ledger':x['ledger']}) for o in (x.get('older') or [])] for x in D['Kılavuz Deposu']]")" \
  "[['cikti/v1.2.1/Etiket_Kilavuzu.docx', 'cikti/v1.3.0/Etiket_Kilavuzu_v1.2.docx'], ['cikti/v1.2.1/Label_Guide.docx'], [], []]"
check "A: bölüm başlığı satırda" "$(q "D['Kılavuz Deposu'][3]['section']")" "AÇIK — DRIVE'A YÜKLENECEK (2026-11-15 düzeltme turu)"

# ---- biçim B: - \`yol\` [+ \`ek dosya\`] (sürüm) ----
check "B: iki satır, kalın paragraf alınmadı" "$(q "[rel(x) for x in D['Yardım Sitesi']]")" "['yayin/yardim.html', 'yayin/egitim.html']"
check "B: sürüm parantezden" "$(q "[x['version'] for x in D['Yardım Sitesi']]")" "['2.4.0', '1.7.0']"
check "B: ek dosyalar ilk dosyanın klasöründe" "$(q "[os.path.basename(e) for e in D['Yardım Sitesi'][1]['extras']], all(os.path.dirname(e)==os.path.dirname(D['Yardım Sitesi'][1]['path']) for e in D['Yardım Sitesi'][1]['extras'])")" "['Egitim.pdf', 'Training.pdf'] True"
check "B: tarih başlıktaki tam tarih (yarım tarihler değil)" "$(q "[gun(x['since']) for x in D['Yardım Sitesi']]")" "['2026-11-12', '2026-11-12']"
check "B: KAPANDI bölümü ve Drive geçmeyen AÇIK bölüm alınmadı" "$(q "[x['file'] for x in d['drive'] if x['file'] in ('eski.html','basvuru.html')]")" "[]"

# ---- biçim C: tablo ----
check "C: klasör hücresi dosya adıyla birleşti; tam yol olduğu gibi" "$(q "[rel(x) for x in D['Mimari Belgesi']]")" "['belgeler/Mimari.docx', 'belgeler/Mimari.pdf', None]"
check "C: sürüm hücreden, başlık ve çizgi satırı alınmadı" "$(q "[x['version'] for x in D['Mimari Belgesi']]")" "['3.1.0', '3.1.0', None]"
check "C: okunamayan tablo satırı hücreleriyle döner" "$(q "D['Mimari Belgesi'][2]['text']")" "Sunum · 1.0 · hazırlanıyor"
check "C: KAPATILDI tablosu alınmadı" "$(q "any(x['file']=='Eski.docx' for x in d['drive'])")" False
check "proje kökü ve kütük yolu satırda" "$(q "all(x['root'] and x['ledger'].endswith('GUNCELLEME_KUTUGU.md') for x in d['drive'])")" True

# ---- dosya değişince mtime ('Yükledim' işaretinin geri gelmesinin sunucu tarafı) ----
M1=$(q "D['Yardım Sitesi'][0]['mtime']"); E1=$(q "D['Yardım Sitesi'][1]['mtime']")
sleep 1.1; echo yeni >> "$P/Yardım Sitesi/yayin/yardim.html"; echo yeni >> "$P/Yardım Sitesi/yayin/Egitim.pdf"
refresh
check "dosya değişti: mtime ilerledi" "$(q "D['Yardım Sitesi'][0]['mtime'] > $M1")" True
check "ek dosya değişti: satırın mtime'ı ilerledi (en yeni dosya)" "$(q "D['Yardım Sitesi'][1]['mtime'] > $E1")" True

# ---- Kütüğü kapat: doğrulama ----
L=$(esc "$P/Yardım Sitesi/GUNCELLEME_KUTUGU.md"); F1=$(esc "$P/Yardım Sitesi/yayin/yardim.html"); F2=$(esc "$P/Yardım Sitesi/yayin/egitim.html")
check "anahtarsız: 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/follow/ledger" -H "Content-Type: application/json" -d '{}')" 403
check "bilinmeyen kütük: 404" "$(post /api/follow/ledger "{\"ledger\":\"C:\\\\Windows\\\\GUNCELLEME_KUTUGU.md\",\"files\":[\"C:\\\\Windows\\\\x.txt\"]}") $(j "d['error']")" "404 noledger"
check "kütükte olmayan dosya: 404" "$(post /api/follow/ledger "{\"ledger\":\"$L\",\"files\":[\"$(esc "$P/Yardım Sitesi/yayin/eski.html")\"]}") $(j "d['error']")" "404 noledger"
check "boş dosya listesi: 400" "$(post /api/follow/ledger "{\"ledger\":\"$L\",\"files\":[]}" /dev/null)" 400
S0=$(grep -c '^ACILIS' "$T/sahte.log" 2>/dev/null || true)

# ---- Kütüğü kapat: gizli oturum kütüğü günceller ----
SUM0=$(md5sum "$P/Yardım Sitesi/GUNCELLEME_KUTUGU.md" | cut -d' ' -f1)
check "Kütüğü kapat: 200" "$(post /api/follow/ledger "{\"ledger\":\"$L\",\"files\":[\"$F1\"]}") $(j "d['items'][0]['kind'], len(d['items'][0]['files'])")" "200 ledger 1"
for _ in $(seq 1 40); do [ "$(it "Yardım Sitesi" "i['state']")" = closing ] && break; sleep 0.2; done
check "iş sürüyor: 'closing', oturum kartı yok" "$(it "Yardım Sitesi" "i['state']") $(hosted)" "closing 0"
check "aynı kütüğe ikinci iş alınmaz: 409" "$(post /api/follow/ledger "{\"ledger\":\"$L\",\"files\":[\"$F2\"]}") $(j "d['error']")" "409 jobactive"
bitir "Yardım Sitesi"; check "iş bitti" $? 0
check "sonuç: done ok, özet satırda" "$(it "Yardım Sitesi" "i['state'], i['code'], i['summary']")" "done ok Kütük güncellendi."
check "kütüğü panel değil oturum değiştirdi (sahte claude 1 kez açıldı, kendi klasöründe)" "$(( $(grep -c '^ACILIS' "$T/sahte.log") - S0 )) $(grep '^MESAJ' "$T/sahte.log" | tail -1 | grep -c 'Yardım Sitesi.*GUNCELLEME_KUTUGU.md')" "1 1"
check "kütük dosyası değişti" "$([ "$(md5sum "$P/Yardım Sitesi/GUNCELLEME_KUTUGU.md" | cut -d' ' -f1)" != "$SUM0" ] && echo evet)" evet
check "gizli oturum kendiliğinden kapandı" "$(hosted)" 0
for _ in $(seq 1 40); do snap; [ "$(q "len(D.get('Yardım Sitesi', []))")" = 1 ] && break; sleep 0.3; done
check "iş sonrası yeniden tarandı: kapatılan dosya listeden çıktı, öteki duruyor" "$(q "[x['file'] for x in D['Yardım Sitesi']]")" "['egitim.html']"

# ---- oturum 'tamam' dedi ama kütük değişmedi → başarısız ----
touch "$P/Mimari Belgesi/.sahte-bos"
LM=$(esc "$P/Mimari Belgesi/GUNCELLEME_KUTUGU.md"); FM=$(esc "$P/Mimari Belgesi/belgeler/Mimari.docx")
post /api/follow/ledger "{\"ledger\":\"$LM\",\"files\":[\"$FM\"]}" >/dev/null; bitir "Mimari Belgesi"
check "kütük değişmediyse iş başarısız (işaret satırı kanıt sayılmaz)" "$(it "Mimari Belgesi" "i['state'], i['code']")" "failed unchanged"
rm "$P/Mimari Belgesi/.sahte-bos"

# ---- karar gerekirse oturum görünür olur ----
touch "$P/Kılavuz Deposu/.sahte-karar"
LK=$(esc "$P/Kılavuz Deposu/GUNCELLEME_KUTUGU.md"); FK=$(esc "$P/Kılavuz Deposu/cikti/v1.3.0/Etiket_Kilavuzu.docx")
post /api/follow/ledger "{\"ledger\":\"$LK\",\"files\":[\"$FK\"]}" >/dev/null; bitir "Kılavuz Deposu"
check "Kütüğü kapat istemi eski sürümleri de kapatıyor" "$(grep '^MESAJ' "$T/sahte.log" | tail -1 | grep -o 'v1.2.1.Etiket_Kilavuzu.docx\|Etiket_Kilavuzu_v1.2.docx' | sort | tr '\n' ' ')" "Etiket_Kilavuzu_v1.2.docx v1.2.1\\Etiket_Kilavuzu.docx "
check "karar gerekiyor: oturum görünür" "$(it "Kılavuz Deposu" "i['state'], bool(i['sessionKey'])") $(hosted)" "decision True 1"

# ---- projede açık oturum varken kütük işi başlamaz (az önce görünür olan oturum hâlâ açık) ----
before=$(grep -c '^ACILIS' "$T/sahte.log")
post /api/follow/ledger "{\"ledger\":\"$LK\",\"files\":[\"$FK\"]}" >/dev/null; bitir "Kılavuz Deposu"
check "açık oturum varken kütük işi atlanır, ikinci süreç açılmaz" "$(it "Kılavuz Deposu" "i['state'], i['code']") $(( $(grep -c '^ACILIS' "$T/sahte.log") - before ))" "skipped insession 0"

# ---- temizlik ----
for k in $(curl -s "$B/api/state" | grep -o '"key":"[0-9a-f]*"' | cut -d'"' -f4); do post "/api/hosted/$k/stop" "" /dev/null >/dev/null; done
check "oturum kalmadı" "$(hosted)" 0
kill $PID 2>/dev/null; wait $PID 2>/dev/null
sleep 1
pwsh -NoProfile -c "Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and \$_.CommandLine -like '*$TW*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
check "test süreci kalmadı" "$(pwsh -NoProfile -c "@(Get-CimInstance Win32_Process | Where-Object { \$_.Name -ne 'pwsh.exe' -and (\$_.CommandLine -like '*$TW*' -or \$_.CommandLine -like '*sahte_claude.py*') }).Count" | tr -d '\r')" 0
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail
