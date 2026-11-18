# Claude Oturum Paneli — Mac deneme listesi (0.9.2)

Panel, Mac'te açık olan Claude Code oturumlarını tek ekranda gösterir; oturumu panelde açıp yürütebilir.
Mac sürümü Windows'ta derlendi, **gerçek Mac'te ilk kez deneniyor.** Aşağıdaki her maddede ne olduğunu yaz
(çalıştı / çalışmadı + ekran görüntüsü). Hata çıkarsa Terminal'deki çıktıyı da kopyala.

## 1. Kurulum

Hangi paket: Terminal'de `uname -m` → `arm64` ise **osx-arm64** (Apple Silicon: M1–M5), `x86_64` ise **osx-x64** (Intel).

Gereken: `claude` kurulu ve en az bir kez giriş yapılmış olmalı; Chrome, Edge, Brave ya da Chromium (yoksa varsayılan tarayıcıda açılır).

```
cd ~/Downloads/ClaudePanel-osx-arm64        # zip'i açtığın klasör
xattr -dr com.apple.quarantine .
chmod +x ClaudePanel
codesign --force --sign - ClaudePanel       # Apple Silicon'da zorunlu
codesign --force --sign - runtimes/*/*.dylib   # sesle yazma kitaplıkları (0.9.0)
./ClaudePanel
```

Panel kendi penceresinde açılır (adres `http://127.0.0.1:8790`). Terminal penceresini kapatma; panelin çıktısı orada görünür.

## 2. Denenecekler

| # | Ne yap | Beklenen |
|---|---|---|
| 1 | Paneli aç | Pencere açılır, başlıkta kota halkaları (5 saat / Hafta) ve yenilenme saati görünür |
| 2 | iTerm2 ya da Terminal'de bir klasörde `claude` başlat, bir şey sor | Oturum panelde kart olarak çıkar; çalışırken "Çalışıyor", bitince "Sizi bekliyor" şeridine geçer |
| 3 | Karttaki **Sekmeye git** | O oturumun iTerm2/Terminal sekmesi öne gelir. İlk seferde macOS "Otomasyon" izni sorar → izin ver |
| 4 | Oturum bitince | macOS bildirimi gelir |
| 5 | **+ Yeni oturum** → Gözat ile klasör seç → mesaj yaz → Başlat | Klasör seçme penceresi açılır; oturum panelde başlar, cevap Konuşma bölmesinde akar |
| 6 | Bekleyen bir terminal oturumunda **Panele al** | Terminaldeki claude kapanır, boş kalan sekme kapanır, aynı konuşma panelde sürer |
| 7 | Finder'da bir dosyayı ⌘C ile kopyala, Konuşma bölmesinde 📎 | Dosya yolu mesaja eklenir |
| 8 | Ekran görüntüsünü panoya al (⌘⇧⌃4), 📎 | Görüntü kaydedilir, yolu mesaja eklenir |
| 9 | Son oturumlar → iki kapalı oturum seç → **Panelde aç** | İkisi panelde açılır, mesaj beklerler |
| 10 | Panel oturumunda **Oturumu kapat → Kaydet ve kapat** | Oturum CLAUDE_MEMORY.md / NEXT_SESSION.md yazar, sonra kapanır |
| 11 | **Hepsini kaydet ve kapat** | Paneldeki tüm oturumlar kaydedip kapanır; çalışan, işi bitince |
| 12 | Panel oturumuna arka planda uzun komut başlattır (ör. "arka planda `sleep 300` çalıştır"), sonra oturumu kapat | `ps aux | grep "sleep 300"` boş döner |
| 13 | Ayarlar → **Paneli kapat**, sonra `./ClaudePanel` ile yeniden aç | Panel oturumları geri gelir |
| 14 | Paneli Terminal'den ⌃C ile ya da `kill -9` ile öldür, yeniden aç | Sahipsiz claude süreci kalmaz (`ps aux | grep claude`) |
| 15 | Pencereyi daralt / genişlet | Başlıkta yazılar üst üste binmez |
| 16 | Ayarlar → Gece modu → aç | "Bilgisayar açılınca paneli penceresiz başlat" kutusu görünür ve işaretlenir; `ls ~/Library/LaunchAgents/com.claudepanel.panel.plist` dosyayı gösterir |

## 2b. 0.7–0.9'da gelenler

| # | Ne yap | Beklenen |
|---|---|---|
| 17 | Gece modunu aç (16), Mac'ten çıkış yapıp yeniden giriş yap (ya da yeniden başlat) | Panel penceresiz kendiliğinden açılır; `curl -s http://127.0.0.1:8790/api/version` cevap verir. Panel oturumları geri gelir |
| 18 | Gece modu saatini şu anı kapsayacak şekilde ayarla (ör. şimdi 14:10 ise 14:00–15:00), 1–2 dk bekle, Terminal'de `pmset -g assertions \| grep caffeinate` | `caffeinate` görünür (PreventUserIdleSystemSleep). Saati geri alınca 1 dk içinde kaybolur |
| 19 | 18 açıkken bir panel oturumuna "şu komutu çalıştır: echo git push deneme" yaz | Komut engellenir, cevapta "Gece modu: git push engellendi" yazar. Gece saati dışında aynı komut çalışır |
| 20 | Konuşma bölmesinde 🎤 → konuş → ⏹ | İlk seferde model iner (~550 MB, ilerleme görünür); sonra konuşma yazıya çevrilip yazma alanına gelir. Kaç saniye sürdüğünü yaz. Tarayıcı mikrofon izni sorar → izin ver |
| 21 | Claude'a "bu klasördeki README'nin yolunu yaz" de, yanıttaki yola tıkla | Finder açılır, dosya seçili gösterilir (açılmaz) |
| 22 | 📎 → bir dosya seç | Dosya seçici açılır, seçilen dosyanın yolu mesaja eklenir |
| 23 | Başlıktaki kota kutusuna tıkla | Kalan süre ve "Bu hızla bitiş / yenilenmeye yeter" satırı görünür |

## 3. Geri bildirim

Madde numarasıyla: çalıştı / çalışmadı, ekran görüntüsü, Terminal çıktısı. Mac modeli, macOS sürümü,
iTerm2 mi Terminal mi, `claude --version`.

## Telefondan erişim (0.7.1, isteğe bağlı)
Kaynak: Tailscale macOS belgeleri (tailscale.com/kb/1065/macos-variants, kb/1242/tailscale-serve, docs/install/mac; 17.11.2026'da okundu).
Tailscale macOS Ventura 13 veya üstünü ister. Tailscale'in kendi sitesindeki sürüm (Standalone) önerilir; App Store sürümü de port paylaşımına izin verir.
- [ ] Ayarlar → Telefondan erişim → "Tailscale'i kur" indirme sayfasını açıyor mu; kurup giriş yapınca ilk iki adım ✓ oluyor mu?
- [ ] Panel Tailscale'i buluyor mu? (`/usr/local/bin/tailscale` — Standalone'da Tailscale Ayarlar → CLI integration → Install Now; App Store'da uygulamanın içindeki araç). Bulamazsa ekran görüntüsü at.
- [ ] Kutu işaretlenince "HTTPS'i aç" bağlantısı ya da adres çıkıyor mu; telefon kare kodla eşleşiyor mu?
- [ ] Mac uykudayken / kapak kapalıyken telefondan erişim ne oluyor? (belgede yazmıyor; gözlemi yaz)

## Telefondan Mac'in masaüstüne bağlanma (0.8.3, isteğe bağlı)
Adımlar: `docs/uzak-masaustu.md` §2 (Apple Mac User Guide, "Turn Mac screen sharing on or off"; 17.11.2026'da okundu).
Her adımın **ekran görüntüsünü** at; belgedeki Mac bölümü bu görüntülerle tamamlanacak.
- [ ] Sistem Ayarları → Genel → Paylaşma: menü adları Türkçe arayüzde ne yazıyor? (Paylaşma / Ekran Paylaşma / Uzaktan Yönetim — belgede İngilizce adlarla birlikte yazıldı, Türkçeleri doğrulanmadı)
- [ ] Ekran Paylaşma açıldı mı; "Erişime izin ver" (Allow access for) menüsünde kendi kullanıcın seçili mi?
- [ ] Telefona VNC uygulaması (RealVNC Viewer ya da Screens) kuruldu; adres olarak Mac'in Tailscale adı yazılınca bağlanıyor mu?
- [ ] Mac kullanıcı adı + parolası yetti mi, yoksa uygulama ayrı VNC parolası istedi mi?
- [ ] Bağlıyken Mac'in kendi ekranı ne gösteriyor (kilitlenmemesi bekleniyor)?
- [ ] Mac uyuyunca VNC bağlantısı ne oluyor; uyandırınca yeniden bağlanıyor mu?

