#!/usr/bin/env bash
# --project-guard hook'unun GERÇEK claude ile uçtan uca denemesi (kota harcar: haiku, iki kısa koşu).
# Panel açılmaz. Hook'un okuduğu project-sessions.json elle yazılır (2 sn'de bir tazelenir): aynı projede önce başlamış,
# çalışan bir oturum var. claude -p yalnız Write izniyle ve hook ayarıyla dosya yazmayı dener.
#   1) Veri dosyası var  → Write hook'ta bekletilmeli (dosya oluşmaz, claude engelin nedenini görür).
#   2) Veri dosyası yok  → aynı istek dosyayı yazmalı (hook boşuna engellemiyor, Write gerçekten çalışıyor).
# Test claude'u kullanıcının global kurallarını yükler: hafıza/NEXT_SESSION yazma yasağı verilir, ~/.claude/NEXT_SESSION.md
# öncesi/sonrası karşılaştırılır (hafıza: feedback_gercek_claude_testi_hafiza).
# Kullanım: tools/proje_engeli_gercek_claude.sh [exe]
set -u
cd "$(dirname "$0")/.."
EXE="${1:-src/ClaudePanel/bin/Release/net10.0-windows/win-x64/ClaudePanel.exe}"
EXEW=$(cygpath -w "$(realpath "$EXE")")
T="$(mktemp -d)"; TW=$(cygpath -w "$T")
fail=0
check() { if [ "$2" = "$3" ]; then echo "GEÇTİ  $1"; else echo "KALDI  $1 (beklenen $3, gelen $2)"; fail=1; fi; }
G=(git -c user.name=Demo -c user.email=demo@example.invalid -c init.defaultBranch=main -c commit.gpgsign=false)
NS="$HOME/.claude/NEXT_SESSION.md"
ozet() { [ -f "$NS" ] && sha256sum "$NS" | cut -c1-16 || echo yok; }
NS_ONCE=$(ozet)

P="$T/Demo Proje"; mkdir -p "$P" "$T/data"
"${G[@]}" -C "$P" init -q; echo "# Demo" > "$P/README.md"; "${G[@]}" -C "$P" add -A; "${G[@]}" -C "$P" commit -q -m ilk
R=$(cygpath -w "$P" | sed 's/\\/\\\\/g')
MYPID=$(cat /proc/$$/winpid)   # "panel süreci" yaşıyor görünsün: bu kabuk
printf '{"hooks":{"PreToolUse":[{"matcher":"Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell","hooks":[{"type":"command","command":"\\"%s\\" --project-guard","timeout":15}]}]}}' \
  "$(echo "$EXEW" | sed 's/\\/\\\\/g')" > "$T/settings.json"
tazele() { while :; do
  printf '{"at":%s,"pid":%s,"sessions":[{"id":"onceki-oturum","root":"%s","name":"Birinci oturum","busySince":1000}]}' \
    "$(date +%s)" "$MYPID" "$R" > "$T/data/project-sessions.json.tmp" && mv -f "$T/data/project-sessions.json.tmp" "$T/data/project-sessions.json"
  sleep 2; done; }

ISTEM="Bu bir test. Write aracıyla bu klasörde not.txt dosyasına 'merhaba' yaz. Başka hiçbir dosya yazma. Araç reddedilirse yeniden deneme; ret nedenini olduğu gibi tek satırda yaz."
YASAK="Bu bir otomatik testtir. Hiçbir hafıza, NEXT_SESSION.md veya CLAUDE_MEMORY.md dosyası yazma ya da güncelleme; yalnız istenen tek dosyayı yaz."
kos() { # $1 = çıktı dosyası
  (cd "$P" && CLAUDE_PANEL_DATA="$TW\\data" timeout 240 claude -p "$ISTEM" --model haiku --settings "$TW\\settings.json" \
    --allowedTools Write --max-turns 4 --append-system-prompt "$YASAK" > "$1" 2>&1); echo $?
}

tazele & TZ=$!
sleep 1
echo "1) aynı projede çalışan oturum varken (gerçek claude, haiku)…"
kos "$T/cikti1.txt" >/dev/null
check "Write bekletildi: not.txt oluşmadı" "$([ -f "$P/not.txt" ] && echo var || echo yok)" yok
check "claude engelin nedenini gördü (engelleyen oturumun adı yanıtta)" "$(grep -c 'Birinci oturum' "$T/cikti1.txt" | head -1 | awk '{print ($1>0)?1:0}')" 1
kill $TZ 2>/dev/null; wait $TZ 2>/dev/null
rm -f "$T/data/project-sessions.json"

echo "2) veri dosyası yokken aynı istek…"
kos "$T/cikti2.txt" >/dev/null
check "Write çalıştı: not.txt yazıldı" "$(cat "$P/not.txt" 2>/dev/null | tr -d '\r\n' | grep -ci merhaba)" 1

check "~/.claude/NEXT_SESSION.md değişmedi" "$(ozet)" "$NS_ONCE"
check "proje klasöründe yalnız beklenen dosyalar" "$(cd "$P" && command ls -A | LC_ALL=C sort | tr '\n' ' ')" ".git README.md not.txt "
echo "--- 1. koşu yanıtı (ilk 5 satır) ---"; head -5 "$T/cikti1.txt"
echo "--- 2. koşu yanıtı (ilk 3 satır) ---"; head -3 "$T/cikti2.txt"
rm -rf "$T"
[ $fail = 0 ] && echo "TÜMÜ GEÇTİ" || echo "HATA VAR"
exit $fail
