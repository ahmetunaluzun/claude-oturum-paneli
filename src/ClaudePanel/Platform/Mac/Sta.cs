namespace ClaudePanel;

/// <summary>macOS'ta STA yok; iş arka plan iş parçacığında çalışır (Windows'taki Sta ile aynı imza).</summary>
public static class Sta
{
    public static Task<T> Run<T>(Func<T> work) => Task.Run(work);
}
