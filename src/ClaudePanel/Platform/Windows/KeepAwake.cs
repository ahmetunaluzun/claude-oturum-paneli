using System.Runtime.InteropServices;

namespace ClaudePanel;

/// <summary>
/// Gece modu penceresinde bilgisayarın boşta uykuya geçmesini engeller (ekran kapanabilir).
/// SetThreadExecutionState iş parçacığına bağlıdır; havuz iş parçacığı değişince düşer, bu yüzden ayrı bir iş parçacığı tutulur.
/// Kapak kapatma / güç düğmesi gibi kullanıcı eylemlerini engellemez.
/// </summary>
public static class KeepAwake
{
    const uint EsContinuous = 0x80000000, EsSystemRequired = 0x00000001;
    [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);

    static readonly object Lock = new();
    static ManualResetEventSlim? _release;

    public static bool Active { get { lock (Lock) return _release is not null; } }

    public static void Set(bool on)
    {
        lock (Lock)
        {
            if (on == (_release is not null)) return;
            if (!on) { _release!.Set(); _release = null; return; }
            var release = _release = new ManualResetEventSlim();
            new Thread(() =>
            {
                SetThreadExecutionState(EsContinuous | EsSystemRequired);
                release.Wait();
                SetThreadExecutionState(EsContinuous);
                release.Dispose();
            }) { IsBackground = true, Name = "KeepAwake" }.Start();
        }
    }
}
