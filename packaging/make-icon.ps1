# Generates assets\aerus-usage-hud.ico (multi-resolution 16, 24, 32, 48, 256px PNGs inside an ICO container).
param([string]$Out = (Join-Path $PSScriptRoot '..\assets\aerus-usage-hud.ico'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-IconPngBytes([int]$size) {
    $scale = $size / 256.0
    $bitmap = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.Clear([System.Drawing.Color]::FromArgb(255, 6, 15, 28))

        # High-contrast outer cyan border so 16x16/24x24 tray icons pop against dark Windows 11 taskbars
        $borderWidth = [Math]::Max(1.5, [float](6 * $scale))
        $borderPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(220, 34, 227, 240)), $borderWidth
        $pad = $borderWidth / 2.0
        $g.DrawRectangle($borderPen, $pad, $pad, [float]($size - $borderWidth), [float]($size - $borderWidth))
        $borderPen.Dispose()

        $gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            (New-Object System.Drawing.PointF 0, 0), (New-Object System.Drawing.PointF $size, $size),
            [System.Drawing.Color]::FromArgb(255, 47, 140, 255), [System.Drawing.Color]::FromArgb(255, 34, 227, 240))
        $diamond = [System.Drawing.PointF[]]@(
            (New-Object System.Drawing.PointF ([float](128 * $scale)), ([float](42 * $scale))),
            (New-Object System.Drawing.PointF ([float](220 * $scale)), ([float](94 * $scale))),
            (New-Object System.Drawing.PointF ([float](128 * $scale)), ([float](146 * $scale))),
            (New-Object System.Drawing.PointF ([float](36 * $scale)), ([float](94 * $scale))))
        $g.FillPolygon($gradient, $diamond)
        $gradient.Dispose()

        $stroke = [Math]::Max(2.0, [float](16 * $scale))
        $cyan = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 34, 227, 240)), $stroke
        $blue = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(220, 47, 140, 255)), $stroke
        $cyan.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $blue.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $g.DrawLines($cyan, [System.Drawing.PointF[]]@(
            (New-Object System.Drawing.PointF ([float](36 * $scale)), ([float](148 * $scale))),
            (New-Object System.Drawing.PointF ([float](128 * $scale)), ([float](196 * $scale))),
            (New-Object System.Drawing.PointF ([float](220 * $scale)), ([float](148 * $scale)))))
        $g.DrawLines($blue, [System.Drawing.PointF[]]@(
            (New-Object System.Drawing.PointF ([float](36 * $scale)), ([float](192 * $scale))),
            (New-Object System.Drawing.PointF ([float](128 * $scale)), ([float](238 * $scale))),
            (New-Object System.Drawing.PointF ([float](220 * $scale)), ([float](192 * $scale)))))
        $cyan.Dispose()
        $blue.Dispose()
    } finally {
        $g.Dispose()
    }

    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $stream.ToArray()
    $bitmap.Dispose()
    $stream.Dispose()
    return ,$bytes
}

$sizes = @(16, 24, 32, 48, 256)
$frames = @()
foreach ($s in $sizes) {
    $frames += ,@{ Size = $s; Bytes = (New-IconPngBytes $s) }
}

$out = [System.IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Path (Split-Path $out) -Force | Out-Null
$file = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $file
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]$frames.Count)

$offset = 6 + (16 * $frames.Count)
foreach ($f in $frames) {
    $dimByte = if ($f.Size -ge 256) { [byte]0 } else { [byte]$f.Size }
    $writer.Write($dimByte)
    $writer.Write($dimByte)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$f.Bytes.Length)
    $writer.Write([uint32]$offset)
    $offset += $f.Bytes.Length
}
foreach ($f in $frames) {
    $writer.Write($f.Bytes)
}
$writer.Flush()
[System.IO.File]::WriteAllBytes($out, $file.ToArray())
$writer.Dispose()
Write-Output "Wrote $out ($($frames.Count) frames, $($file.Length) bytes total)"
