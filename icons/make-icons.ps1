# ===================================================================
#  FAIBA LEDGER — icon generator
#  -------------------------------------------------------------------
#  Draws the brand mark (the three stacked wifi arcs from the app
#  header) into the PNG sizes the web app manifest and iOS need.
#
#  Run from this folder:  powershell -ExecutionPolicy Bypass -File .\make-icons.ps1
#  No image tooling required - System.Drawing is all that is used.
# ===================================================================

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'

# --- the mark, in the same 24x24 viewBox as the inline header SVG ---
$ARCS = @(
  @{ cx = 12.0; cy = 13.5; r = 10.0 }
  @{ cx = 12.0; cy = 16.0; r =  6.5 }
  @{ cx = 12.0; cy = 18.5; r =  2.5 }
)
$BOX = 24.0        # viewBox size
$LIFT = 0.75       # the mark sits optically high in its box, so nudge it up

$BG_TOP    = [System.Drawing.Color]::FromArgb(255, 12, 20, 36)
$BG_BOTTOM = [System.Drawing.Color]::FromArgb(255, 5, 7, 13)
$ACCENT_A  = [System.Drawing.Color]::FromArgb(255, 124, 180, 255)
$ACCENT_B  = [System.Drawing.Color]::FromArgb(255, 180, 124, 255)

function New-RoundedPath([double]$size, [double]$radius) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  if ($radius -le 0) {           # full bleed - no corners to round
    $p.AddRectangle((New-Object System.Drawing.RectangleF(0, 0, $size, $size)))
    return $p
  }
  $d = $radius * 2
  $p.AddArc(0, 0, $d, $d, 180, 90)
  $p.AddArc($size - $d, 0, $d, $d, 270, 90)
  $p.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $p.AddArc(0, $size - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-Icon {
  param(
    [int]    $Size,
    [double] $LogoScale = 0.74,
    [double] $Corner    = 0.22
  )

  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)

  # --- plate: rounded gradient square (radius 0 = full bleed) ---
  $full = New-Object System.Drawing.RectangleF(0, 0, $Size, $Size)
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush($full, $BG_TOP, $BG_BOTTOM, 90)
  $clip = New-RoundedPath $Size ($Size * $Corner)
  $g.FillPath($bg, $clip)

  # --- the mark, scaled into the plate ---
  $k  = ($Size / $BOX) * $LogoScale
  $ox = ($Size - $BOX * $k) / 2
  $oy = ($Size - $BOX * $k) / 2 - $LIFT * $k

  $stroke = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $full, $ACCENT_A, $ACCENT_B, 55)
  $pen = New-Object System.Drawing.Pen($stroke, [float](2.15 * $k))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

  foreach ($a in $ARCS) {
    $cx = $a.cx * $k + $ox
    $cy = $a.cy * $k + $oy
    $r  = $a.r * $k
    $g.DrawArc($pen,
      [float]($cx - $r), [float]($cy - $r),
      [float]($r * 2), [float]($r * 2),
      180, 180)
  }

  $g.Dispose()
  return $bmp
}

$TARGETS = @(
  @{ file = 'icon-192.png';         size = 192;  logo = 0.74; corner = 0.22 }
  @{ file = 'icon-512.png';         size = 512;  logo = 0.74; corner = 0.22 }
  # maskable: full bleed, mark kept inside the 80% safe circle
  @{ file = 'maskable-192.png';    size = 192;  logo = 0.50; corner = 0 }
  @{ file = 'maskable-512.png';    size = 512;  logo = 0.50; corner = 0 }
  # iOS masks and rounds this one itself, so it must be full bleed
  @{ file = 'apple-touch-icon.png'; size = 180; logo = 0.66; corner = 0 }
  @{ file = 'favicon-32.png';       size = 32;  logo = 0.80; corner = 0.22 }
)

foreach ($t in $TARGETS) {
  $bmp = New-Icon -Size $t.size -LogoScale $t.logo -Corner $t.corner
  $path = Join-Path $PSScriptRoot $t.file
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("{0,-24} {1}x{1}  {2:N1} KB" -f $t.file, $t.size, ((Get-Item $path).Length / 1KB))
}
