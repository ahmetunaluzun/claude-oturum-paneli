using System.Security.Cryptography;
using System.Text;
using Whisper.net;
using Whisper.net.LibraryLoader;

namespace ClaudePanel;

/// <summary>
/// Dikte: tarayıcının kaydettiği 16 kHz tek kanal WAV'ı bu bilgisayarda Whisper (whisper.cpp, Whisper.net) ile yazıya çevirir.
/// Ses dış servise gitmez; her cihazda (masaüstü, Android, iOS) aynı motor çalışır. Model ilk kullanımda bir kez indirilir.
/// Aynı anda tek çeviri yapılır; model 5 dakika kullanılmazsa bellekten atılır.
/// Bütünlük: model SHA256 ile doğrulanmadan kullanılmaz. İndirirken akış sırasında özet alınır; önceden inmiş dosya açılışta
/// bir kez arka planda doğrulanır, sonuç damga dosyasında (boyut + değiştirilme zamanı) tutulur, dosya değişmedikçe yinelenmez.
/// </summary>
public sealed class Dictation : IDisposable
{
    public const string ModelName = "ggml-large-v3-turbo-q5_0.bin";
    // Test: indirme adresi CLAUDE_PANEL_MODEL_URL ile yerel sunucuya çevrilebilir (tools/dikte_sha_test.py); özet denetimi aynı kalır.
    static readonly string ModelUrl = Environment.GetEnvironmentVariable("CLAUDE_PANEL_MODEL_URL") is { Length: > 0 } u ? u
        : "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/" + ModelName;
    /// <summary>
    /// Beklenen SHA256. Kaynak: HuggingFace LFS meta verisi, https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main
    /// ("lfs.oid", boyut 574041195) ve ModelUrl yanıtının X-Linked-ETag başlığı (depo commit 5359861c), 21.11.2026'da okundu;
    /// 18.11.2026'da bu bilgisayara inmiş dosyanın özetiyle aynı. Model dosyası depoda değişirse bu değer de güncellenmeli.
    /// </summary>
    const string ModelSha256 = "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2";
    public const long MaxWavBytes = 16_000 * 2 * 300 + 44; // 5 dakika
    static readonly TimeSpan IdleUnload = TimeSpan.FromMinutes(5);
    static readonly string ModelDir = Path.Combine(Handoff.DataDir, "models");
    static string ModelPath => Path.Combine(ModelDir, ModelName);
    static string StampPath => ModelPath + ".verified";
    const int Unchecked = 0, Valid = 1, Invalid = -1;

    readonly ILogger<Dictation> _log;
    readonly SemaphoreSlim _one = new(1, 1);
    readonly Timer _idle;
    readonly object _dlLock = new();
    WhisperFactory? _factory;
    DateTime _lastUse;
    Task? _download;
    long _got, _total;
    string? _error;
    int _state = Unchecked; // modelin doğrulama durumu (Unchecked / Valid / Invalid)
    Task? _verify;

    public Dictation(ILogger<Dictation> log)
    {
        _log = log;
        // Windows: ekran kartı (Vulkan) varsa onu kullan, yoksa işlemci. Ölçüm (i7-11390H, 8,5 sn Türkçe): işlemci 57 sn, Vulkan 5 sn.
        if (OperatingSystem.IsWindows()) RuntimeOptions.RuntimeLibraryOrder = [RuntimeLibrary.Vulkan, RuntimeLibrary.Cpu];
        _idle = new Timer(_ => UnloadIfIdle(), null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
        StartVerify();
    }

    /// <summary>Model var ve SHA256'sı doğrulandı mı.</summary>
    bool ModelReady => Volatile.Read(ref _state) == Valid && File.Exists(ModelPath);

    public object Status()
    {
        StartVerify(); // doğrulama okuma hatasıyla yarıda kaldıysa yeniden dener
        return new
        {
            ready = ModelReady,
            downloading = _download is { IsCompleted: false },
            verifying = _verify is { IsCompleted: false },
            invalid = Volatile.Read(ref _state) == Invalid,
            got = Interlocked.Read(ref _got),
            total = Interlocked.Read(ref _total),
            error = _error
        };
    }

    /// <summary>
    /// Model yoksa ya da doğrulanamadıysa indirmeyi başlatır (zaten iniyorsa ya da doğrulanıyorsa bir şey yapmaz).
    /// Doğrulanamayan dosya kendiliğinden silinmez: yalnız kullanıcı "İndir" deyince yenisiyle değiştirilir.
    /// </summary>
    public void EnsureModel()
    {
        lock (_dlLock)
        {
            if (ModelReady || _verify is { IsCompleted: false } || _download is { IsCompleted: false }) return;
            if (File.Exists(ModelPath) && Volatile.Read(ref _state) == Unchecked) { StartVerify(); return; }
            _error = null;
            _download = Task.Run(Download);
        }
    }

    /// <summary>Var olan model dosyasını bir kez doğrular: damga dosyası güncelse anında, değilse arka planda özet alınır.</summary>
    void StartVerify()
    {
        lock (_dlLock)
        {
            if (Volatile.Read(ref _state) != Unchecked || _verify is { IsCompleted: false } || _download is { IsCompleted: false }
                || !File.Exists(ModelPath)) return;
            if (StampMatches()) { Volatile.Write(ref _state, Valid); return; }
            _verify = Task.Run(VerifyExisting);
        }
    }

    static string StampOf(FileInfo f) =>
        $"{ModelSha256}|{f.Length.ToString(System.Globalization.CultureInfo.InvariantCulture)}|" +
        f.LastWriteTimeUtc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);

    static bool StampMatches()
    {
        try { return File.Exists(StampPath) && File.ReadAllText(StampPath).Trim() == StampOf(new FileInfo(ModelPath)); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return false; }
    }

    void WriteStamp()
    {
        try { File.WriteAllText(StampPath, StampOf(new FileInfo(ModelPath))); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.LogWarning("Dikte modeli doğrulama damgası yazılamadı: {Error}", ex.Message);
        }
    }

    void VerifyExisting()
    {
        try
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            string hash;
            using (var fs = new FileStream(ModelPath, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20, FileOptions.SequentialScan))
                hash = Convert.ToHexStringLower(SHA256.HashData(fs));
            if (hash == ModelSha256)
            {
                WriteStamp();
                Volatile.Write(ref _state, Valid);
                _log.LogInformation("Dikte modeli doğrulandı (SHA256, {Ms} ms)", sw.ElapsedMilliseconds);
                return;
            }
            Volatile.Write(ref _state, Invalid);
            _error = "Ses modeli doğrulanamadı: SHA256 özeti beklenenle uyuşmuyor; model kullanılmayacak, yeniden indirin.";
            _log.LogWarning("Dikte modeli doğrulanamadı: SHA256 {Got} (beklenen {Want}), dosya {Path}. Kullanılmayacak; silinmedi.",
                hash, ModelSha256, ModelPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _error = "Ses modeli doğrulanamadı: " + ex.Message;
            _log.LogWarning("Dikte modeli okunamadı, doğrulanamadı: {Error}", ex.Message);
        }
    }

    async Task Download()
    {
        var part = ModelPath + ".part";
        try
        {
            Directory.CreateDirectory(ModelDir);
            _log.LogInformation("Dikte modeli indiriliyor: {Url} → {Path}", ModelUrl, ModelPath);
            using var http = new HttpClient { Timeout = TimeSpan.FromHours(2) };
            using var res = await http.GetAsync(ModelUrl, HttpCompletionOption.ResponseHeadersRead);
            res.EnsureSuccessStatusCode();
            Interlocked.Exchange(ref _total, res.Content.Headers.ContentLength ?? 0);
            Interlocked.Exchange(ref _got, 0);
            using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            await using (var src = await res.Content.ReadAsStreamAsync())
            await using (var dst = File.Create(part))
            {
                var buf = new byte[1 << 16];
                int n;
                while ((n = await src.ReadAsync(buf)) > 0)
                {
                    await dst.WriteAsync(buf.AsMemory(0, n));
                    sha.AppendData(buf, 0, n);
                    Interlocked.Add(ref _got, n);
                }
            }
            var hash = Convert.ToHexStringLower(sha.GetHashAndReset());
            if (hash != ModelSha256)
            {
                File.Delete(part);
                _error = "İndirilen ses modeli doğrulanamadı (SHA256 özeti beklenenle uyuşmuyor), dosya silindi. Yeniden deneyin.";
                _log.LogWarning("Dikte modeli doğrulanamadı: SHA256 {Got} (beklenen {Want}); .part silindi, model kullanılmayacak",
                    hash, ModelSha256);
                return;
            }
            File.Move(part, ModelPath, overwrite: true);
            WriteStamp();
            Volatile.Write(ref _state, Valid);
            _log.LogInformation("Dikte modeli indi ve doğrulandı ({Bytes} bayt, SHA256 uyuşuyor)", new FileInfo(ModelPath).Length);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException or UnauthorizedAccessException)
        {
            _error = ex.Message;
            _log.LogWarning("Dikte modeli indirilemedi: {Error}", ex.Message);
            try { File.Delete(part); } catch (IOException) { }
        }
    }

    /// <summary>
    /// Kayıt başlarken çağrılır: modeli yükler ve 1 sn sessizlikle bir kez çalıştırır (ekran kartında ilk çağrı ~7 sn fazladan sürer).
    /// Kullanıcı konuşurken biter; zaten yüklüyse bir şey yapmaz.
    /// </summary>
    public void Warm()
    {
        if (_factory is not null || !ModelReady) return;
        _ = Task.Run(async () =>
        {
            using var ms = new MemoryStream(SilenceWav(1));
            await Transcribe(ms, "tr", CancellationToken.None);
        });
    }

    static byte[] SilenceWav(int seconds)
    {
        const int rate = 16_000;
        var data = rate * 2 * seconds;
        using var ms = new MemoryStream();
        using (var w = new BinaryWriter(ms, Encoding.ASCII, leaveOpen: true))
        {
            w.Write("RIFF"u8); w.Write(36 + data); w.Write("WAVE"u8);
            w.Write("fmt "u8); w.Write(16); w.Write((short)1); w.Write((short)1); w.Write(rate); w.Write(rate * 2); w.Write((short)2); w.Write((short)16);
            w.Write("data"u8); w.Write(data); w.Write(new byte[data]);
        }
        return ms.ToArray();
    }

    /// <summary>WAV'ı yazıya çevirir. Model yoksa ya da doğrulanmadıysa null.</summary>
    public async Task<string?> Transcribe(Stream wav, string lang, CancellationToken ct)
    {
        if (!ModelReady) return null;
        await _one.WaitAsync(ct);
        try
        {
            if (_factory is null)
            {
                _factory = WhisperFactory.FromPath(ModelPath);
                _log.LogInformation("Dikte modeli yüklendi, motor: {Lib}", RuntimeOptions.LoadedLibrary);
            }
            using var processor = _factory.CreateBuilder()
                .WithLanguage(lang)
                .WithThreads(Math.Max(1, Environment.ProcessorCount / 2)) // makinenin yarısı: kullanıcının işi aksamasın
                .Build();
            var sb = new StringBuilder();
            await foreach (var seg in processor.ProcessAsync(wav, ct)) sb.Append(seg.Text);
            return sb.ToString().Trim();
        }
        finally
        {
            _lastUse = DateTime.UtcNow;
            _one.Release();
        }
    }

    void UnloadIfIdle()
    {
        if (_factory is null || DateTime.UtcNow - _lastUse < IdleUnload || !_one.Wait(0)) return;
        try
        {
            _factory?.Dispose();
            _factory = null;
        }
        finally { _one.Release(); }
    }

    public void Dispose()
    {
        _idle.Dispose();
        _factory?.Dispose();
    }
}
