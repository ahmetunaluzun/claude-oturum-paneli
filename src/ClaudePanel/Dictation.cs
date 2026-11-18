using System.Text;
using Whisper.net;
using Whisper.net.LibraryLoader;

namespace ClaudePanel;

/// <summary>
/// Dikte: tarayıcının kaydettiği 16 kHz tek kanal WAV'ı bu bilgisayarda Whisper (whisper.cpp, Whisper.net) ile yazıya çevirir.
/// Ses dış servise gitmez; her cihazda (masaüstü, Android, iOS) aynı motor çalışır. Model ilk kullanımda bir kez indirilir.
/// Aynı anda tek çeviri yapılır; model 5 dakika kullanılmazsa bellekten atılır.
/// </summary>
public sealed class Dictation : IDisposable
{
    public const string ModelName = "ggml-large-v3-turbo-q5_0.bin";
    const string ModelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/" + ModelName;
    public const long MaxWavBytes = 16_000 * 2 * 300 + 44; // 5 dakika
    static readonly TimeSpan IdleUnload = TimeSpan.FromMinutes(5);
    static readonly string ModelDir = Path.Combine(Handoff.DataDir, "models");
    static string ModelPath => Path.Combine(ModelDir, ModelName);

    readonly ILogger<Dictation> _log;
    readonly SemaphoreSlim _one = new(1, 1);
    readonly Timer _idle;
    readonly object _dlLock = new();
    WhisperFactory? _factory;
    DateTime _lastUse;
    Task? _download;
    long _got, _total;
    string? _error;

    public Dictation(ILogger<Dictation> log)
    {
        _log = log;
        // Windows: ekran kartı (Vulkan) varsa onu kullan, yoksa işlemci. Ölçüm (i7-11390H, 8,5 sn Türkçe): işlemci 57 sn, Vulkan 5 sn.
        if (OperatingSystem.IsWindows()) RuntimeOptions.RuntimeLibraryOrder = [RuntimeLibrary.Vulkan, RuntimeLibrary.Cpu];
        _idle = new Timer(_ => UnloadIfIdle(), null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
    }

    public object Status() => new
    {
        ready = File.Exists(ModelPath),
        downloading = _download is { IsCompleted: false },
        got = Interlocked.Read(ref _got),
        total = Interlocked.Read(ref _total),
        error = _error
    };

    /// <summary>Model yoksa indirmeyi başlatır (zaten iniyorsa bir şey yapmaz).</summary>
    public void EnsureModel()
    {
        if (File.Exists(ModelPath)) return;
        lock (_dlLock)
        {
            if (_download is { IsCompleted: false }) return;
            _error = null;
            _download = Task.Run(Download);
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
            await using (var src = await res.Content.ReadAsStreamAsync())
            await using (var dst = File.Create(part))
            {
                var buf = new byte[1 << 16];
                int n;
                while ((n = await src.ReadAsync(buf)) > 0)
                {
                    await dst.WriteAsync(buf.AsMemory(0, n));
                    Interlocked.Add(ref _got, n);
                }
            }
            File.Move(part, ModelPath, overwrite: true);
            _log.LogInformation("Dikte modeli indi ({Bytes} bayt)", new FileInfo(ModelPath).Length);
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
        if (_factory is not null || !File.Exists(ModelPath)) return;
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

    /// <summary>WAV'ı yazıya çevirir. Model yoksa null.</summary>
    public async Task<string?> Transcribe(Stream wav, string lang, CancellationToken ct)
    {
        if (!File.Exists(ModelPath)) return null;
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
