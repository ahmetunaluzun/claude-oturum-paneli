# Ön plandaki pencerenin ekran görüntüsünü alır (belge görselleri için).
# Kullanım: pwsh tools\pencere_goruntu.ps1 -Uri ms-settings:remotedesktop -Out docs\img\x.png [-Bekle 4]
param([Parameter(Mandatory)][string]$Uri, [Parameter(Mandatory)][string]$Out, [int]$Bekle = 4)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Pencere {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[Pencere]::SetProcessDPIAware() | Out-Null
Start-Process $Uri
ping -n ($Bekle + 1) 127.0.0.1 > $null
$h = [Pencere]::GetForegroundWindow()
$r = New-Object Pencere+RECT
[Pencere]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) | Out-Null   # DWMWA_EXTENDED_FRAME_BOUNDS: gölgesiz çerçeve
$w = $r.R - $r.L; $hh = $r.B - $r.T
if ($w -le 0 -or $hh -le 0) { throw "Pencere boyutu okunamadı" }
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"$Out ($w x $hh)"
