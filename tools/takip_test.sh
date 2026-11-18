#!/usr/bin/env bash
# Takip sekmesi API testi: /api/followup (git durumu, NEXT_SESSION.md, güncellemeler) ve /api/followup/refresh.
# Gerçek ~/.claude'a ve gerçek projelere dokunmaz: uydurma ortam (tools/takip_ortam.sh) geçici klasörde, test kopyası
# --no-window ve boş portta. Ağa çıkmaz (güncelleme önbelleği dolu). claude oturumu BAŞLATMAZ (düğmeler /api/hosted
# kullanır; o uç burada yalnız geçersiz klasörle denenir).
# Kullanım: tools/takip_test.sh [exe]   (varsayılan: Release derlemesi)
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
T="$(mktemp -d)"
fail=0
export PYTHONUTF8=1
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
tools/takip_ortam.sh "$T" || { echo "ortam kurulamadı"; rm -rf "$T"; exit 1; }
G=(git -c user.name=Demo -c user.email=demo@example.invalid -c core.autocrlf=false -c commit.gpgsign=false)

PORT=$(pwsh -NoProfile -c '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$l.Start();$l.LocalEndpoint.Port;$l.Stop()')
B="http://127.0.0.1:$PORT"
TW=$(cygpath -w "$T")
CLAUDE_PANEL_PORT=$PORT CLAUDE_PANEL_DATA="$TW\\data" CLAUDE_PANEL_CLAUDE_DIR="$TW\\claude" TMP="$TW\\tmp" TEMP="$TW\\tmp" \
  "$EXE" --no-window >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 50); do [ -f "$T/data/panel-$PORT.token" ] && break; sleep 0.2; done
TOK=$(cat "$T/data/panel-$PORT.token")
# q <python ifadesi>: son /api/followup yanıtı d sözlüğünde; ifadenin sonucunu yazar.
q() { py -3.13 -c "import json,sys;d=json.load(open(sys.argv[1],encoding='utf-8'));r={x['name']:x for x in d['git']['repos']};n={x['name']:x for x in d['next']};print($1)" "$T/fu.json" 2>&1; }
snap() { # tarama bitene kadar bekler, yanıtı $T/fu.json'a yazar
  for _ in $(seq 1 60); do
    curl -s "$B/api/followup" > "$T/fu.json"
    [ "$(q "d['scanning'] or d['checkedAt']==0")" = "False" ] && return 0
    sleep 0.5
  done
  return 1
}
refresh() { curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/followup/refresh" -H "X-Panel-Token: $TOK" -H "Origin: $B"; }

# ---- test ortamı gerçekten kullanılıyor mu (CLAUDE_PANEL_CLAUDE_DIR) ----
check "projeler yalnız uydurma ortamdan (silinmiş klasör hariç 6)" "$(curl -s "$B/api/projects" | py -3.13 -c "import json,sys;print(len(json.load(sys.stdin)))")" 6
check "canlı oturum listesi boş (gerçek ~/.claude/sessions okunmuyor)" "$(curl -s "$B/api/state" | py -3.13 -c "import json,sys;print(len(json.load(sys.stdin)['sessions']))")" 0

# ---- ilk tarama ----
snap; check "tarama bitti" $? 0
check "git durumu ok" "$(q "d['git']['state']")" ok
check "bekleyen depo sayısı (alt klasör aynı depoya sayılır)" "$(q "len(r)")" 3
check "temiz depo sayısı" "$(q "d['git']['clean']")" 1
check "okunamayan depo yok" "$(q "d['git']['failed']")" 0
check "Demo Mağaza: 2 commit'lenmemiş dosya" "$(q "r['Demo Mağaza']['dirty']")" 2
check "Demo Mağaza: dal adı" "$(q "r['Demo Mağaza']['branch']")" main
check "Demo Mağaza: uzak depo yokken 'uzak dal yok' denmez" "$(q "r['Demo Mağaza']['noUpstream'], r['Demo Mağaza']['ahead']")" "False 0"
check "Örnek API: 2 gönderilmemiş commit, çalışma ağacı temiz" "$(q "r['Örnek API']['ahead'], r['Örnek API']['dirty'], r['Örnek API']['noUpstream']")" "2 0 False"
check "Rapor Aracı: uzak depo var, uzak dal yok" "$(q "r['Rapor Aracı']['noUpstream'], r['Rapor Aracı']['dirty']")" "True 0"
check "temiz depo listede yok" "$(q "'Temiz Kütüphane' in r")" False

check "iki NEXT_SESSION.md, yenisi üstte" "$(q "[x['name'] for x in d['next']]")" "['Örnek API', 'Stok Sayım']"
check "özet: başlık/alıntı atlandı, markdown temizlendi" "$(q "n['Örnek API']['summary'][:55]")" "Son yapılan: Sipariş uç noktası yazıldı, testler yeşil;"
check "özet en çok 140 karakter, kesildiyse … ile biter" "$(q "len(n['Örnek API']['summary'])<=140 and n['Örnek API']['summary'].endswith('…')")" True
check "özet: bağlantı adresi atıldı" "$(q "'example.invalid' in n['Örnek API']['summary']")" False
check "özet: başka satır yoksa numaralı madde" "$(q "n['Stok Sayım']['summary']")" "Barkod okuma düzeltilecek"
check "5 günlük plan 3 günden eski" "$(q "(d['checkedAt']-n['Stok Sayım']['updatedAt'])/86400000 > 3")" True

check "panel: yeni sürüm bildirilir" "$(q "d['updates']['panel']['state'], d['updates']['panel']['newer'], d['updates']['panel']['latest']")" "ok True 99.1.0"
check "panel: kurulu sürüm 0.11.0" "$(q "d['updates']['panel']['current']")" 0.11.0
check "panel: sürüm sayfası kendi depomuz" "$(q "d['updates']['panel']['url']")" "https://github.com/ahmetunaluzun/claude-oturum-paneli/releases/tag/v99.1.0"
# Kurulu claude sürümü bu bilgisayara bağlı: okunabildiyse yeni sürüm bildirilir, okunamadıysa "denetlenemedi".
check "Claude Code: son sürüm önbellekten, durum tutarlı" "$(q "d['updates']['claude']['latest'], d['updates']['claude']['newer'] == (d['updates']['claude']['state']=='ok')")" "99.0.0 True"

# ---- yenile ----
check "anahtarsız yenileme reddedilir" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/followup/refresh")" 403
check "yabancı kökenden yenileme reddedilir" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/followup/refresh" -H "X-Panel-Token: $TOK" -H "Origin: https://evil.example")" 403
"${G[@]}" -C "$T/projeler/Demo Mağaza" add -A; "${G[@]}" -C "$T/projeler/Demo Mağaza" commit -q -m "Sepet"
"${G[@]}" -C "$T/projeler/Örnek API" push -q
# Ağ hatası: son deneme başarısız ve bilinen sürüm yok → bölüm "denetlenemedi" der, hata vermez.
now=$(date +%s)
printf '{"PanelAt":%s,"PanelOk":false,"PanelLatest":null,"PanelUrl":null,"ClaudeAt":%s,"ClaudeOk":false,"ClaudeLatest":null}' "$now" "$now" > "$T/data/update-check.json"
before=$(q "d['checkedAt']")
check "yenile (200)" "$(refresh)" 200
for _ in $(seq 1 40); do snap; [ "$(q "d['checkedAt']")" != "$before" ] && break; sleep 0.3; done
check "commit + push sonrası bekleyen depo 1 (Rapor Aracı)" "$(q "sorted(r)")" "['Rapor Aracı']"
check "temiz depo sayısı 3" "$(q "d['git']['clean']")" 3
check "ağ hatası: panel 'denetlenemedi'" "$(q "d['updates']['panel']['state'], d['updates']['panel']['newer']")" "unknown False"
check "ağ hatası: Claude Code 'denetlenemedi'" "$(q "d['updates']['claude']['state'], d['updates']['claude']['newer']")" "unknown False"
grep -q '"PanelOk":false' "$T/data/update-check.json" && check "taze başarısız denemede ağa yeniden çıkılmadı" 1 1 || check "taze başarısız denemede ağa yeniden çıkılmadı" 0 1
# Sürümü olmayan depo (404 → PanelOk, sürüm yok): güncel sayılır.
printf '{"PanelAt":%s,"PanelOk":true,"PanelLatest":null,"PanelUrl":null,"ClaudeAt":%s,"ClaudeOk":true,"ClaudeLatest":"0.0.1"}' "$now" "$now" > "$T/data/update-check.json"
before=$(q "d['checkedAt']"); refresh >/dev/null
for _ in $(seq 1 40); do snap; [ "$(q "d['checkedAt']")" != "$before" ] && break; sleep 0.3; done
check "yayınlanmış sürüm yok: panel güncel" "$(q "d['updates']['panel']['state'], d['updates']['panel']['newer']")" "ok False"
check "eski npm sürümü: Claude Code için yeni sürüm denmez" "$(q "d['updates']['claude']['newer']")" False

# ---- oturum başlatma yolu (claude başlatmadan): geçersiz klasör reddedilir ----
check "düğmenin ucu: olmayan klasör 400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/hosted" -H "X-Panel-Token: $TOK" -H "Origin: $B" -H "Content-Type: application/json" -d '{"cwd":"Z:\\\\yok\\\\boyle","prompt":"devam"}')" 400
check "panel oturumu açılmadı" "$(curl -s "$B/api/state" | py -3.13 -c "import json,sys;print(len(json.load(sys.stdin)['hosted']))")" 0

kill $PID 2>/dev/null; wait $PID 2>/dev/null
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail
