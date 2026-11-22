namespace ClaudePanel;

/// <summary>
/// Takip → Mail ve takvim süzgeci (Ayarlar'da, kalıcı). Kurallar VEYA ile birleşir: bir mail en az bir kurala uyarsa listelenir.
/// Süzme yereldir; mail içeriği hiçbir yere gönderilmez, gövde hiç okunmaz (yalnız başlık meta verisi).
/// </summary>
/// <param name="Direct">Kime alanında ben varım.</param>
/// <param name="Cc">CC alanında ben varım.</param>
/// <param name="Awaiting">Cevap bekleyen: konuşmanın son mesajı bende değil, ben alıcıyım ve sonrasında cevap yazmadım.</param>
/// <param name="Senders">Gönderen adresi ya da alan adı ("ali@firma.com", "@firma.com", "firma.com").</param>
/// <param name="Keywords">Konuda geçen sözcükler (büyük/küçük harf ve Türkçe I/İ farkı yok).</param>
/// <param name="Labels">Gmail etiketi adları ("Müşteri", "IMPORTANT").</param>
public sealed record MailFilter(bool Direct = true, bool Cc = false, bool Awaiting = true,
    List<string>? Senders = null, List<string>? Keywords = null, List<string>? Labels = null)
{
    public bool Empty => !Direct && !Cc && !Awaiting && (Senders?.Count ?? 0) == 0 && (Keywords?.Count ?? 0) == 0 && (Labels?.Count ?? 0) == 0;
}

/// <param name="Id">Panelin verdiği kimlik (token anahtarı bununla saklanır; adres değil).</param>
/// <param name="Email">Girişten gelen adres (elle yazılmaz).</param>
/// <param name="Mail">Mail kaynağı açık.</param>
/// <param name="Cal">Takvim kaynağı açık.</param>
/// <param name="MailGranted">Mail okuma izni verilmiş (son girişte).</param>
/// <param name="CalGranted">Takvim okuma izni verilmiş (son girişte).</param>
/// <param name="Aliases">"Benim adreslerim / gruplarım": bu adreslerden biri Kime'de geçerse "direct", CC'de geçerse "cc" sayılır (tam adres, küçük harf).</param>
public sealed record MailAccount(string Id, string Provider, string Email, bool Mail, bool Cal, bool MailGranted, bool CalGranted, long AddedAt,
    List<string>? Aliases = null);

/// <summary>Grup/liste adresi önerisi: adres ve geçtiği ileti sayısı (konu/gövde taşımaz).</summary>
public sealed record MailSuggest(string Addr, int Count);

/// <summary>Sağlayıcının döndürdüğü bir konuşmanın en yeni gelen mesajı (yalnız başlık meta verisi).</summary>
/// <param name="ToMe">Kime alanında ben varım.</param>
/// <param name="CcMe">CC alanında ben varım.</param>
/// <param name="FromMe">Gönderen benim.</param>
/// <param name="Replied">Konuşmada bu mesajdan sonra (ya da aynı anda) benim gönderdiğim mesaj var.</param>
/// <param name="Labels">Etiket adları (Gmail kullanıcı etiketi adı ya da sistem etiketi kimliği: INBOX, IMPORTANT…).</param>
public sealed record MailMeta(string Id, string ThreadId, string Subject, string FromName, string FromAddr, long Date,
    bool ToMe, bool CcMe, bool FromMe, bool Replied, List<string> Labels)
{
    public bool Awaiting => !FromMe && (ToMe || CcMe) && !Replied;
}

/// <summary>Önümüzdeki 24 saatteki bir takvim etkinliği.</summary>
/// <param name="Join">Görüntülü toplantı bağlantısı (yalnız https); yoksa null.</param>
public sealed record CalEvent(string Id, string Title, long Start, long End, bool AllDay, string? Location, string? Join, string Url, long Updated);

/// <summary>Takip'e giden mail satırı: süzgece uyan konuşma.</summary>
/// <param name="Rules">Uyan kurallar: "direct" | "cc" | "awaiting" | "sender" | "keyword" | "label".</param>
public sealed record MailItem(string Account, string Id, string ThreadId, string Subject, string FromName, string FromAddr, long Date,
    IReadOnlyList<string> Rules, bool Awaiting, string Url);

public sealed record CalItem(string Account, string Id, string Title, long Start, long End, bool AllDay, string? Location, string? Join, string Url, long Updated);

/// <param name="State">"ok" | "pending" (henüz denenmedi) | "reauth" (yeniden giriş / şifre kabul edilmedi) | "net" (son deneme ağ hatası) | "noclient" (Google, istemci dosyası yok) | "disabled" (IMAP hesapta kapalı) | "domain" (yönetici alan adı düzeyinde kapatmış) | "icaldenied" (takvim adresi artık geçerli değil / dışa paylaşım kapalı).
/// Truncated: gelen kutusunda üst sınır aşıldı, yalnız en yeni bu kadar iletiye bakıldı (0 = hepsine). AwaitingOk: "cevap bekleyen" bu hesapta çalışır; GmailLink: "Gmail'de aç" bağlantısı kurulabilir (IMAP: sunucu Gmail uzantılarını veriyor).</param>
public sealed record MailAccountState(string Id, string Email, bool Mail, bool Cal, bool MailGranted, bool CalGranted, string State, long OkAt, long TriedAt,
    string Provider, bool AwaitingOk, bool GmailLink, int Truncated = 0);

/// <param name="State">"off" (hesap yok) | "noclient" | "ok".</param>
/// <param name="CheckedAt">En son başarılı alınma (Unix ms); hiç alınmadıysa 0.</param>
/// <param name="Stale">En az bir hesabın son denemesi başarısız: liste son bilinen durumdur.</param>
public sealed record MailSnapshot(string State, IReadOnlyList<MailAccountState> Accounts, IReadOnlyList<MailItem> Mails, IReadOnlyList<CalItem> Events,
    long CheckedAt, bool Stale, bool Fetching, bool MailOn, bool CalOn, bool FilterEmpty, bool FilterAwaiting = false)
{
    public static readonly MailSnapshot Off = new("off", [], [], [], 0, false, false, false, false, false);
}

/// <summary>Google (OAuth) sağlayıcısı arayüzü. IMAP (uygulama şifresi) ve iCal için ImapProvider / IcalProvider.</summary>
public interface IMailProvider
{
    string Name { get; }
    /// <summary>Gelen kutusundaki son konuşmalar (yalnız başlık meta verisi; gövde istenmez).</summary>
    Task<List<MailMeta>> Mails(string accessToken, string me, IReadOnlyCollection<string> aliases, CancellationToken ct);
    /// <summary>Şimdiden 24 saat sonrasına kadar başlayan etkinlikler.</summary>
    Task<List<CalEvent>> Events(string accessToken, CancellationToken ct);
}

/// <summary>Sağlayıcı ya da token sunucusu "yeniden giriş gerekli" dedi (iptal edilmiş/süresi dolmuş yenileme belirteci, 401).</summary>
public sealed class MailAuthException(string message) : Exception(message);
