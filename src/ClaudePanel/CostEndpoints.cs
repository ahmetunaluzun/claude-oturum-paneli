namespace ClaudePanel;

/// <summary>
/// Proje maliyeti (/api/cost, ProjectCost.cs) ve açılış yükü (/api/startup-load, StartupLoad.cs). İkisi de salt okuma;
/// telefondan da açık (yalnız okur, dosya değiştirmez). Açılış yükünde istenen klasör yalnız ölçülen oturumlardan biri olabilir.
/// </summary>
public static class CostEndpoints
{
    public static void MapCost(this WebApplication app)
    {
        app.MapGet("/api/cost", (ProjectCost pc) => Results.Json(pc.Get()));
        app.MapGet("/api/startup-load", (string? cwd, StartupLoad sl) => Results.Json(sl.Get(cwd)));
    }
}
