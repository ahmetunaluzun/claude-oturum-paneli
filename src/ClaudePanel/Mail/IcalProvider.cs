using System.Globalization;
using Ical.Net;
using IcalCalendar = Ical.Net.Calendar;
using Ical.Net.CalendarComponents;
using Ical.Net.DataTypes;

namespace ClaudePanel;

/// <param name="kind">"denied" (403/404/410: adres geçersiz ya da yönetici dışa paylaşımı kapatmış) | "net" | "parse" | "invalid".</param>
public sealed class IcalException(string kind, string message) : Exception(message)
{
    public string Kind => kind;
}

/// <summary>
/// Google Takvim "iCal biçiminde gizli adres" (YALNIZ OKUR; adres gizlidir: loga, yanıta, hata metnine yazılmaz).
/// Kaynak: https://support.google.com/calendar/answer/37648 ("Get your calendar view" → "Secret address in iCal format",
/// 22.11.2026'da doğrulandı). Adres biçimi: https://calendar.google.com/calendar/ical/&lt;takvim&gt;/private-&lt;anahtar&gt;/basic.ics.
/// Tekrarlayan etkinlikler (RRULE, EXDATE, RECURRENCE-ID), tüm gün ve saat dilimi Ical.Net ile açılır.
/// Test: CLAUDE_PANEL_ICAL_TEST_BASE ("http://127.0.0.1:port", yalnız yerel) o adresle başlayan adresleri de kabul eder.
/// </summary>
public static class IcalProvider
{
    const int Max = 20, TextMax = 200, MaxBytes = 20_000_000, UrlMax = 600;
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };

    static string? TestBase =>
        Environment.GetEnvironmentVariable("CLAUDE_PANEL_ICAL_TEST_BASE") is { Length: > 0 } b && (b.StartsWith("http://127.0.0.1:", StringComparison.Ordinal) || b.StartsWith("http://localhost:", StringComparison.Ordinal))
            ? b.TrimEnd('/') + "/" : null;

    /// <summary>Yalnız https://calendar.google.com/calendar/ical/…/….ics (başka alan adına istek gitmez).</summary>
    public static bool ValidUrl(string? url)
    {
        if (string.IsNullOrWhiteSpace(url) || url.Length > UrlMax || url.Any(char.IsControl)) return false;
        if (TestBase is { } tb && url.StartsWith(tb, StringComparison.Ordinal)) return true;
        return Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps && u.Host == "calendar.google.com" && u.UserInfo.Length == 0
               && u.IsDefaultPort && u.AbsolutePath.StartsWith("/calendar/ical/", StringComparison.Ordinal) && u.AbsolutePath.EndsWith(".ics", StringComparison.Ordinal);
    }

    /// <summary>Şimdiden 24 saat sonrasına kadar süren etkinlikler (sıralı).</summary>
    public static async Task<List<CalEvent>> Events(string url, CancellationToken ct, DateTimeOffset? at = null)
    {
        if (!ValidUrl(url)) throw new IcalException("invalid", "adres geçersiz");
        string text;
        try
        {
            using var res = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
            if (res.StatusCode is System.Net.HttpStatusCode.Forbidden or System.Net.HttpStatusCode.NotFound or System.Net.HttpStatusCode.Gone)
                throw new IcalException("denied", $"HTTP {(int)res.StatusCode}");
            if (!res.IsSuccessStatusCode) throw new IcalException("net", $"HTTP {(int)res.StatusCode}");
            if (res.Content.Headers.ContentLength > MaxBytes) throw new IcalException("parse", "dosya çok büyük");
            await using var s = await res.Content.ReadAsStreamAsync(ct);
            using var ms = new MemoryStream();
            var buf = new byte[81920];
            for (int n; (n = await s.ReadAsync(buf, ct)) > 0;)
            {
                ms.Write(buf, 0, n);
                if (ms.Length > MaxBytes) throw new IcalException("parse", "dosya çok büyük");
            }
            text = System.Text.Encoding.UTF8.GetString(ms.ToArray());
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException)
        {
            throw new IcalException("net", "alınamadı"); // ex.Message adres taşıyabilir: yazılmaz
        }
        return Parse(text, at ?? DateTimeOffset.UtcNow);
    }

    /// <summary>iCal metninden [now, now+24sa] aralığına değen etkinlikler.</summary>
    public static List<CalEvent> Parse(string ics, DateTimeOffset now)
    {
        IcalCalendar? cal;
        try { cal = IcalCalendar.Load(ics); }
        catch (Exception ex) when (ex is not OperationCanceledException) { throw new IcalException("parse", "iCal okunamadı"); }
        if (cal is null || !ics.Contains("BEGIN:VCALENDAR", StringComparison.Ordinal)) throw new IcalException("parse", "iCal değil");
        var from = now.UtcDateTime;
        var to = from.AddHours(24);
        var list = new List<CalEvent>();
        foreach (var occ in cal.GetOccurrences<CalendarEvent>(new CalDateTime(from.AddDays(-7), "UTC")).TakeWhile(o => o.Period.StartTime.AsUtc < to))
        {
            if (occ.Source is not CalendarEvent ev || string.Equals(ev.Status, "CANCELLED", StringComparison.OrdinalIgnoreCase)) continue;
            var st = occ.Period.StartTime;
            var allDay = !st.HasTime;
            var start = Ms(st, allDay);
            var end = occ.Period.EffectiveEndTime is { } et ? Ms(et, allDay) : start;
            if (end <= start) end = allDay ? start + 86_400_000 : start;
            var nowMs = now.ToUnixTimeMilliseconds();
            if ((end > start ? end : start) <= nowMs || start >= nowMs + 86_400_000) continue;
            var join = Https(ev.Properties.Get<string>("X-GOOGLE-CONFERENCE")) ?? Https(ev.Location);
            var updated = ev.LastModified?.AsUtc.Subtract(DateTime.UnixEpoch).TotalMilliseconds is { } lm ? (long)lm : start;
            list.Add(new CalEvent(Clip((ev.Uid ?? "ev") + "@" + start.ToString(CultureInfo.InvariantCulture)), Clip(ev.Summary ?? ""), start, end, allDay,
                string.IsNullOrWhiteSpace(ev.Location) || ev.Location.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? null : Clip(ev.Location), join,
                "https://calendar.google.com/calendar/r", updated));
        }
        return list.OrderBy(e => e.Start).ThenBy(e => e.Title, StringComparer.Ordinal).Take(Max).ToList();
    }

    /// <summary>Tüm gün: yerel gün başı (Google API yolundaki gibi); saatli: UTC anı.</summary>
    static long Ms(CalDateTime t, bool allDay) =>
        allDay ? new DateTimeOffset(DateTime.SpecifyKind(t.Value.Date, DateTimeKind.Local)).ToUnixTimeMilliseconds()
               : new DateTimeOffset(t.AsUtc, TimeSpan.Zero).ToUnixTimeMilliseconds();

    static string Clip(string s) => s.Length > TextMax ? s[..TextMax] + "…" : s;
    static string? Https(string? u) => u is not null && u.StartsWith("https://", StringComparison.Ordinal) && u.Length <= 1300 && !u.Any(char.IsWhiteSpace) ? u : null;
}
