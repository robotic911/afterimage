const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const zlib = require('zlib');

const WINDOWS_CP1500_BACKEND = 'Native Windows PrintTicket/XPS';
const WINDOWS_CP1500_JOB_TIMEOUT_MS = 60000;
// Windows CP1500 physical-output calibration only. Runtime overrides are
// intentionally in-memory so testing never changes generated/saved artwork.
const WINDOWS_CP1500_CALIBRATION = Object.freeze({
  scale: 1.00,
  offsetXmm: 0,
  offsetYmm: 0,
});
let runtimeCalibration = { ...WINDOWS_CP1500_CALIBRATION };

function normalizeCalibration(calibration = {}) {
  const scale = Number(calibration.scale);
  const offsetXmm = Number(calibration.offsetXmm);
  const offsetYmm = Number(calibration.offsetYmm);
  if (!Number.isFinite(scale) || scale < 0.9 || scale > 1.1) {
    throw new Error('Windows CP1500 scale must be between 0.90 and 1.10');
  }
  if (!Number.isFinite(offsetXmm) || Math.abs(offsetXmm) > 10 || !Number.isFinite(offsetYmm) || Math.abs(offsetYmm) > 10) {
    throw new Error('Windows CP1500 offsets must be between -10 mm and 10 mm');
  }
  return { scale, offsetXmm, offsetYmm };
}

function getWindowsCp1500Calibration() {
  return { ...runtimeCalibration };
}

function setWindowsCp1500Calibration(calibration) {
  runtimeCalibration = normalizeCalibration(calibration);
  return getWindowsCp1500Calibration();
}

function resetWindowsCp1500Calibration() {
  runtimeCalibration = { ...WINDOWS_CP1500_CALIBRATION };
  return getWindowsCp1500Calibration();
}

function calculateCenteredContentRectangle({
  sourceWidth,
  sourceHeight,
  pageWidth,
  pageHeight,
  scale = WINDOWS_CP1500_CALIBRATION.scale,
  offsetXmm = WINDOWS_CP1500_CALIBRATION.offsetXmm,
  offsetYmm = WINDOWS_CP1500_CALIBRATION.offsetYmm,
}) {
  const values = [sourceWidth, sourceHeight, pageWidth, pageHeight, scale, offsetXmm, offsetYmm].map(Number);
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
    if (values.slice(0, 5).some((value) => !Number.isFinite(value) || value <= 0) || values.slice(5).some((value) => !Number.isFinite(value))) {
      throw new Error('CP1500 content geometry requires positive dimensions/scale and finite offsets');
    }
  }
  const [sourceW, sourceH, pageW, pageH, contentScale, xMm, yMm] = values;
  const uniformBaseScale = Math.min(pageW / sourceW, pageH / sourceH);
  const baseWidth = sourceW * uniformBaseScale;
  const baseHeight = sourceH * uniformBaseScale;
  const baseX = (pageW - baseWidth) / 2;
  const baseY = (pageH - baseHeight) / 2;
  const width = baseWidth * contentScale;
  const height = baseHeight * contentScale;
  const x = ((pageW - width) / 2) + (xMm * 96 / 25.4);
  const y = ((pageH - height) / 2) + (yMm * 96 / 25.4);
  return {
    source: { width: sourceW, height: sourceH },
    page: { width: pageW, height: pageH },
    base: { x: baseX, y: baseY, width: baseWidth, height: baseHeight },
    calibration: { scale: contentScale, offsetXmm: xMm, offsetYmm: yMm },
    final: { x, y, width, height },
    cropBeyondPage: {
      left: Math.max(0, -x),
      right: Math.max(0, x + width - pageW),
      top: Math.max(0, -y),
      bottom: Math.max(0, y + height - pageH),
    },
    unused: {
      left: Math.max(0, x),
      right: Math.max(0, pageW - (x + width)),
      top: Math.max(0, y),
      bottom: Math.max(0, pageH - (y + height)),
    },
  };
}

function decodeImageDataUrl(dataUrl) {
  const match = /^data:image\/(png|jpe?g);base64,([\s\S]+)$/i.exec(String(dataUrl || ''));
  if (!match) throw new Error('Windows printing requires a PNG or JPEG data URL');
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!bytes.length) throw new Error('Windows print image is empty');
  return { bytes, extension: /^png$/i.test(match[1]) ? '.png' : '.jpg' };
}

function encodedPowerShellValue(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64');
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createSolidDiagnosticPng(width = 1200, height = 1800) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new TypeError('Diagnostic PNG dimensions must be positive integers');
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type, data) => {
    const typeBytes = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([length, typeBytes, data, checksum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.alloc(1 + width * 3, 255); row[0] = 0;
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y += 1) row.copy(raw, y * row.length);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function buildWindowsCp1500PrintScript({ printerName, imagePath, jobName, calibration = getWindowsCp1500Calibration(), diagnosticOnly = false }) {
  const printer = encodedPowerShellValue(printerName);
  const image = encodedPowerShellValue(imagePath);
  const job = encodedPowerShellValue(jobName);
  return String.raw`
$ErrorActionPreference = 'Stop'
$PrinterName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${printer}'))
$ImagePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${image}'))
$JobName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${job}'))
$ContentScale = [double]${calibration.scale}
$OffsetXmm = [double]${calibration.offsetXmm}
$OffsetYmm = [double]${calibration.offsetYmm}
$DiagnosticOnly = ${diagnosticOnly ? '$true' : '$false'}

function EnumName($value) { if ($null -eq $value) { return $null }; return $value.ToString() }
function ToMm($value) { if ($null -eq $value) { return $null }; return [Math]::Round(([double]$value * 25.4 / 96), 3) }
function MediaRecord($media) {
  if ($null -eq $media) { return $null }
  return [ordered]@{ name = EnumName $media.PageMediaSizeName; widthDip = $media.Width; heightDip = $media.Height; widthMm = ToMm $media.Width; heightMm = ToMm $media.Height }
}

<#$null = @'
function buildWindowsCp1500GeometryDiagnosticScript({ printerName, imagePath, calibration = getWindowsCp1500Calibration() }) {
  const printer = encodedPowerShellValue(printerName);
  const image = encodedPowerShellValue(imagePath);
  return String.raw
$ErrorActionPreference = 'Stop'
$PrinterName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${printer}'))
$ImagePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${image}'))
$ContentScale = [double]${calibration.scale}
$OffsetXmm = [double]${calibration.offsetXmm}
$OffsetYmm = [double]${calibration.offsetYmm}
$Stage = 'initialize'
$Warnings = New-Object System.Collections.Generic.List[string]
function Warn($message) { [void]$Warnings.Add([string]$message) }
function EnumName($value) { if ($null -eq $value) { return $null }; return $value.ToString() }
function ToMm($value) { if ($null -eq $value) { return $null }; return ([double]$value * 25.4 / 96.0) }
function PositiveNumber($value) { return ($null -ne $value -and [double]$value -gt 0) }
function MediaRecord($media) {
  if ($null -eq $media) { return $null }
  $width = $media.Width; $height = $media.Height
  return [ordered]@{
    name = EnumName $media.PageMediaSizeName
    widthDip = $width; heightDip = $height
    widthMm = ToMm $width; heightMm = ToMm $height
    aspect = if ((PositiveNumber $width) -and (PositiveNumber $height)) { [double]$width / [double]$height } else { $null }
  }
}
function MediaScore($media) {
  $record = MediaRecord $media
  if ($null -eq $record) { return 0 }
  $name = ([string]$record.name).ToLowerInvariant(); $score = 0
  if ($name -match 'postcard|4x6|4 x 6|photo') { $score += 100 }
  if ($name -match 'borderless|full|bleed|edge') { $score += 50 }
  if ((PositiveNumber $record.widthMm) -and (PositiveNumber $record.heightMm)) {
    $short = [Math]::Min([double]$record.widthMm, [double]$record.heightMm)
    $long = [Math]::Max([double]$record.widthMm, [double]$record.heightMm)
    if ($short -ge 98 -and $short -le 103 -and $long -ge 146 -and $long -le 153) { $score += 40 }
  }
  return $score
}
function ErrorRecord($exception, $stage) {
  return [ordered]@{ name = $exception.GetType().FullName; message = $exception.Message; stack = $exception.StackTrace; stage = $stage }
}

$result = [ordered]@{
  ok = $false; submitted = $false; backend = '${WINDOWS_CP1500_BACKEND}'
  printerName = $PrinterName; calibration = [ordered]@{ scale = $ContentScale; offsetXmm = $OffsetXmm; offsetYmm = $OffsetYmm }
  source = $null; ticket = $null; media = $null; imageableArea = $null
  destinationRectDip = $null; destinationRectMm = $null; wpfGeometry = $null
  warnings = $Warnings; error = $null
}
try {
  $Stage = 'load-windows-printing-assemblies'
  Add-Type -AssemblyName System.Printing
  Add-Type -AssemblyName ReachFramework
  Add-Type -AssemblyName PresentationCore
  Add-Type -AssemblyName PresentationFramework

  $Stage = 'open-printer-queue'
  $server = New-Object System.Printing.LocalPrintServer
  $queue = $server.GetPrintQueue($PrinterName); $queue.Refresh()

  $baseTicket = $null; $baseCapabilities = $null
  $Stage = 'read-default-print-ticket'
  try { $baseTicket = $queue.DefaultPrintTicket } catch { Warn ('DefaultPrintTicket unavailable: ' + $_.Exception.Message) }
  $Stage = 'read-print-capabilities'
  try { $baseCapabilities = $queue.GetPrintCapabilities($baseTicket) } catch { Warn ('PrintCapabilities unavailable: ' + $_.Exception.Message) }

  $borderlessValues = @(); $scalingValues = @(); $bestMedia = $null
  if ($null -ne $baseCapabilities) {
    try { $borderlessValues = @($baseCapabilities.PageBorderlessCapability | ForEach-Object { EnumName $_ }) } catch { Warn ('PageBorderless capability unavailable: ' + $_.Exception.Message) }
    try { $scalingValues = @($baseCapabilities.PageScalingCapability | ForEach-Object { EnumName $_ }) } catch { Warn ('PageScaling capability unavailable: ' + $_.Exception.Message) }
    try {
      $bestMedia = $baseCapabilities.PageMediaSizeCapability | ForEach-Object {
        [pscustomobject]@{ Media = $_; Score = MediaScore $_ }
      } | Sort-Object Score -Descending | Select-Object -First 1
    } catch { Warn ('PageMediaSize capabilities unavailable: ' + $_.Exception.Message) }
  }
  if ($borderlessValues.Count -eq 0) { Warn 'PageBorderless capability unavailable from Canon driver' }
  if ($scalingValues.Count -eq 0) { Warn 'PageScaling capability unavailable from Canon driver' }

  $ticket = $baseTicket
  if ($null -ne $baseTicket) {
    $Stage = 'validate-print-ticket'
    try {
      $requestedTicket = $baseTicket.Clone()
      if ($borderlessValues -contains 'Borderless') { $requestedTicket.PageBorderless = [System.Printing.PageBorderless]::Borderless }
      if ($null -ne $bestMedia -and $null -ne $bestMedia.Media) { $requestedTicket.PageMediaSize = $bestMedia.Media }
      if ($scalingValues -contains 'None') { $requestedTicket.PageScaling = [System.Printing.PageScaling]::None }
      $validation = $queue.MergeAndValidatePrintTicket($baseTicket, $requestedTicket)
      if ($null -ne $validation -and $null -ne $validation.ValidatedPrintTicket) { $ticket = $validation.ValidatedPrintTicket }
      else { Warn 'ValidatedPrintTicket unavailable; using the default ticket' }
    } catch { Warn ('PrintTicket validation unavailable: ' + $_.Exception.Message) }
  }

  $mediaObject = if ($null -ne $ticket -and $null -ne $ticket.PageMediaSize) { $ticket.PageMediaSize } elseif ($null -ne $bestMedia) { $bestMedia.Media } else { $null }
  $result.media = MediaRecord $mediaObject
  if ($null -eq $result.media) { Warn 'PageMediaSize unavailable from Canon driver' }
  elseif (-not (PositiveNumber $result.media.widthDip) -or -not (PositiveNumber $result.media.heightDip)) { Warn 'PageMediaSize dimensions unavailable from Canon driver' }
  $result.ticket = [ordered]@{
    mediaName = if ($null -ne $result.media) { $result.media.name } else { $null }
    validatedBorderless = if ($null -ne $ticket) { EnumName $ticket.PageBorderless } else { $null }
    validatedScaling = if ($null -ne $ticket) { EnumName $ticket.PageScaling } else { $null }
  }

  $validatedCapabilities = $null
  $Stage = 'read-validated-print-capabilities'
  try { if ($null -ne $ticket) { $validatedCapabilities = $queue.GetPrintCapabilities($ticket) } } catch { Warn ('Validated PrintCapabilities unavailable: ' + $_.Exception.Message) }
  if ($null -ne $validatedCapabilities -and $null -ne $validatedCapabilities.PageImageableArea) {
    try {
      $area = $validatedCapabilities.PageImageableArea
      $result.imageableArea = [ordered]@{
        originXDip = $area.OriginWidth; originYDip = $area.OriginHeight
        widthDip = $area.ExtentWidth; heightDip = $area.ExtentHeight
        originXMm = ToMm $area.OriginWidth; originYMm = ToMm $area.OriginHeight
        widthMm = ToMm $area.ExtentWidth; heightMm = ToMm $area.ExtentHeight
      }
    } catch { Warn ('PageImageableArea values unavailable: ' + $_.Exception.Message); $result.imageableArea = $null }
  } else { Warn 'PageImageableArea unavailable from Canon driver' }

  $Stage = 'read-source-bitmap'
  try {
    $bitmap = New-Object Windows.Media.Imaging.BitmapImage
    $bitmap.BeginInit(); $bitmap.CacheOption = [Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    $bitmap.UriSource = New-Object Uri -ArgumentList $ImagePath, ([UriKind]::Absolute); $bitmap.EndInit(); $bitmap.Freeze()
    $result.source = [ordered]@{ widthPx = $bitmap.PixelWidth; heightPx = $bitmap.PixelHeight; dpiX = $bitmap.DpiX; dpiY = $bitmap.DpiY; aspect = [double]$bitmap.PixelWidth / [double]$bitmap.PixelHeight }
  } catch { Warn ('Source bitmap metadata unavailable: ' + $_.Exception.Message) }

  if ($null -ne $result.media -and (PositiveNumber $result.media.widthDip) -and (PositiveNumber $result.media.heightDip) -and $null -ne $result.source) {
    $Stage = 'calculate-wpf-geometry'
    try {
      $pageWidth = [double]$result.media.widthDip; $pageHeight = [double]$result.media.heightDip
      if ($pageWidth -gt $pageHeight -and $result.source.widthPx -lt $result.source.heightPx) { $swap = $pageWidth; $pageWidth = $pageHeight; $pageHeight = $swap }
      if ($pageHeight -gt $pageWidth -and $result.source.widthPx -gt $result.source.heightPx) { $swap = $pageWidth; $pageWidth = $pageHeight; $pageHeight = $swap }
      $baseScale = [Math]::Min($pageWidth / [double]$result.source.widthPx, $pageHeight / [double]$result.source.heightPx)
      $width = [double]$result.source.widthPx * $baseScale * $ContentScale
      $height = [double]$result.source.heightPx * $baseScale * $ContentScale
      $x = (($pageWidth - $width) / 2) + ($OffsetXmm * 96.0 / 25.4)
      $y = (($pageHeight - $height) / 2) + ($OffsetYmm * 96.0 / 25.4)
      $result.destinationRectDip = [ordered]@{ x = $x; y = $y; width = $width; height = $height }
      $result.destinationRectMm = [ordered]@{ x = ToMm $x; y = ToMm $y; width = ToMm $width; height = ToMm $height }
      $control = New-Object Windows.Controls.Image
      $control.Stretch = [Windows.Media.Stretch]::Uniform; $control.Width = $width; $control.Height = $height
      [Windows.Controls.Canvas]::SetLeft($control, $x); [Windows.Controls.Canvas]::SetTop($control, $y)
      $page = New-Object Windows.Documents.FixedPage; $page.Width = $pageWidth; $page.Height = $pageHeight
      $result.wpfGeometry = [ordered]@{
        image = [ordered]@{ width = $control.Width; height = $control.Height; left = [Windows.Controls.Canvas]::GetLeft($control); top = [Windows.Controls.Canvas]::GetTop($control); stretch = EnumName $control.Stretch }
        fixedPage = [ordered]@{ width = $page.Width; height = $page.Height }
      }
    } catch { Warn ('WPF geometry unavailable: ' + $_.Exception.Message) }
  } else { Warn 'Destination geometry unavailable because source or media dimensions are missing' }
  $result.ok = $true
} catch {
  $result.error = ErrorRecord $_.Exception $Stage
}
$result.warnings = @($Warnings)
$result | ConvertTo-Json -Depth 12 -Compress
;
}
'@
#>
function AreaRecord($cap, $ticket) {
  if ($null -eq $cap.PageImageableArea) { return $null }
  $area = $cap.PageImageableArea
  $pw = $cap.OrientedPageMediaWidth; $ph = $cap.OrientedPageMediaHeight
  if (($null -eq $pw -or $pw -le 0) -and $null -ne $ticket.PageMediaSize) { $pw = $ticket.PageMediaSize.Width }
  if (($null -eq $ph -or $ph -le 0) -and $null -ne $ticket.PageMediaSize) { $ph = $ticket.PageMediaSize.Height }
  $right = [Math]::Max(0, [double]$pw - [double]$area.OriginWidth - [double]$area.ExtentWidth)
  $bottom = [Math]::Max(0, [double]$ph - [double]$area.OriginHeight - [double]$area.ExtentHeight)
  return [ordered]@{
    physicalWidthDip = $pw; physicalHeightDip = $ph
    physicalWidthMm = ToMm $pw; physicalHeightMm = ToMm $ph
    originXDip = $area.OriginWidth; originYDip = $area.OriginHeight
    extentWidthDip = $area.ExtentWidth; extentHeightDip = $area.ExtentHeight
    originXMm = ToMm $area.OriginWidth; originYMm = ToMm $area.OriginHeight
    extentWidthMm = ToMm $area.ExtentWidth; extentHeightMm = ToMm $area.ExtentHeight
    hardwareMarginsMm = [ordered]@{ left = ToMm $area.OriginWidth; right = ToMm $right; top = ToMm $area.OriginHeight; bottom = ToMm $bottom }
  }
}
function MediaScore($media) {
  $record = MediaRecord $media; $name = ([string]$record.name).ToLowerInvariant()
  $short = [Math]::Min([double]$record.widthMm, [double]$record.heightMm)
  $long = [Math]::Max([double]$record.widthMm, [double]$record.heightMm)
  $score = 0
  if ($name -match 'postcard|4x6|4 x 6|photo') { $score += 100 }
  if ($name -match 'borderless|full|bleed|edge') { $score += 50 }
  if ($short -ge 98 -and $short -le 103 -and $long -ge 146 -and $long -le 153) { $score += 40 }
  return $score
}

$Stage = 'initialize'; $Warnings = New-Object System.Collections.Generic.List[string]
function Warn($message) { [void]$Warnings.Add([string]$message) }
$result = [ordered]@{ ok = $false; submitted = $false; backend = '${WINDOWS_CP1500_BACKEND}'; printerName = $PrinterName; source = $null; ticket = $null; borderlessSupported = $false; borderlessSelected = $false; media = $null; pageImageableArea = $null; conflictStatus = $null; warnings = $Warnings; error = $null }
try {
  $Stage = 'load-windows-printing-assemblies'
  Add-Type -AssemblyName System.Printing
  Add-Type -AssemblyName ReachFramework
  Add-Type -AssemblyName PresentationCore
  Add-Type -AssemblyName PresentationFramework
  $Stage = 'open-printer-queue'; $server = New-Object System.Printing.LocalPrintServer
  $queue = $server.GetPrintQueue($PrinterName); $queue.Refresh()
  $Stage = 'read-default-print-ticket'; $baseTicket = $queue.DefaultPrintTicket
  $Stage = 'read-print-capabilities'; $baseCapabilities = $queue.GetPrintCapabilities($baseTicket)
  $borderlessValues = @($baseCapabilities.PageBorderlessCapability | ForEach-Object { EnumName $_ })
  $result.borderlessSupported = $borderlessValues -contains 'Borderless'
  if (-not $result.borderlessSupported) {
    if ($DiagnosticOnly) { Warn 'PageBorderless capability unavailable from Canon driver' }
    else { throw 'The selected Windows printer queue does not expose PageBorderless=Borderless.' }
  }

  $bestMedia = $baseCapabilities.PageMediaSizeCapability | ForEach-Object {
    [pscustomobject]@{ Media = $_; Score = MediaScore $_ }
  } | Sort-Object Score -Descending | Select-Object -First 1
  if ($null -eq $bestMedia -or $bestMedia.Score -lt 40) {
    if ($DiagnosticOnly) { Warn 'Preferred Postcard/4x6 PageMediaSize unavailable; using the default ticket media when available'; $bestMedia = $null }
    else { throw 'The selected Windows printer queue does not expose a Postcard/4x6 media size.' }
  }

  $Stage = 'validate-print-ticket'
  $jobTicket = $baseTicket.Clone()
  if ($result.borderlessSupported) { $jobTicket.PageBorderless = [System.Printing.PageBorderless]::Borderless }
  if ($null -ne $bestMedia -and $null -ne $bestMedia.Media) { $jobTicket.PageMediaSize = $bestMedia.Media }
  if (@($baseCapabilities.PageScalingCapability | ForEach-Object { EnumName $_ }) -contains 'None') {
    $jobTicket.PageScaling = [System.Printing.PageScaling]::None
  }
  if (@($baseCapabilities.OutputQualityCapability | ForEach-Object { EnumName $_ }) -contains 'Photographic') {
    $jobTicket.OutputQuality = [System.Printing.OutputQuality]::Photographic
  }
  $validation = $null; $ticket = $baseTicket
  try {
    $validation = $queue.MergeAndValidatePrintTicket($baseTicket, $jobTicket)
    if ($null -ne $validation -and $null -ne $validation.ValidatedPrintTicket) { $ticket = $validation.ValidatedPrintTicket }
    elseif ($DiagnosticOnly) { Warn 'ValidatedPrintTicket unavailable; using the default ticket' }
  } catch {
    if ($DiagnosticOnly) { Warn ('PrintTicket validation unavailable: ' + $_.Exception.Message) }
    else { throw }
  }
  $result.conflictStatus = EnumName $validation.ConflictStatus
  $result.borderlessSelected = ((EnumName $ticket.PageBorderless) -eq 'Borderless')
  $result.media = MediaRecord $ticket.PageMediaSize
  $result.scalingRequested = 'None'
  $result.scalingValidated = EnumName $ticket.PageScaling
  $result.ticket = [ordered]@{ mediaName = if ($null -ne $result.media) { $result.media.name } else { $null }; validatedBorderless = EnumName $ticket.PageBorderless; validatedScaling = EnumName $ticket.PageScaling; outputQuality = EnumName $ticket.OutputQuality }
  if (-not $result.borderlessSelected) {
    if ($DiagnosticOnly) { Warn 'Validated PageBorderless value unavailable or not Borderless' }
    else { throw 'Windows rejected PageBorderless=Borderless for the selected media.' }
  }

  $Stage = 'read-validated-print-capabilities'
  $cap = $null
  try { $cap = $queue.GetPrintCapabilities($ticket) } catch { if ($DiagnosticOnly) { Warn ('Validated PrintCapabilities unavailable: ' + $_.Exception.Message) } else { throw } }
  if ($null -ne $cap -and $null -ne $cap.PageImageableArea) {
    $rawArea = $cap.PageImageableArea
    if ($DiagnosticOnly -and ($null -eq $rawArea.OriginWidth -or $null -eq $rawArea.OriginHeight -or $null -eq $rawArea.ExtentWidth -or $null -eq $rawArea.ExtentHeight)) {
      Warn 'PageImageableArea contains incomplete values from Canon driver'
      $result.pageImageableArea = [ordered]@{
        physicalWidthDip = $ticket.PageMediaSize.Width; physicalHeightDip = $ticket.PageMediaSize.Height
        physicalWidthMm = ToMm $ticket.PageMediaSize.Width; physicalHeightMm = ToMm $ticket.PageMediaSize.Height
        originXDip = $rawArea.OriginWidth; originYDip = $rawArea.OriginHeight
        extentWidthDip = $rawArea.ExtentWidth; extentHeightDip = $rawArea.ExtentHeight
        originXMm = ToMm $rawArea.OriginWidth; originYMm = ToMm $rawArea.OriginHeight
        extentWidthMm = ToMm $rawArea.ExtentWidth; extentHeightMm = ToMm $rawArea.ExtentHeight
        hardwareMarginsMm = $null
      }
    } else { $result.pageImageableArea = AreaRecord $cap $ticket }
  }
  $area = $result.pageImageableArea
  if ($null -eq $area) {
    if ($DiagnosticOnly) { Warn 'PageImageableArea unavailable from Canon driver' }
    else { throw 'Windows did not report a printable area for the validated borderless ticket.' }
  } else {
    $maxInsetMm = (@($area.hardwareMarginsMm.left, $area.hardwareMarginsMm.right, $area.hardwareMarginsMm.top, $area.hardwareMarginsMm.bottom) | Measure-Object -Maximum).Maximum
    if ([double]$maxInsetMm -gt 0.3 -and -not $DiagnosticOnly) { throw ('Validated borderless ticket still reports a reduced printable area (maximum inset {0} mm).' -f $maxInsetMm) }
  }

  $Stage = 'read-source-bitmap'
  $bitmap = New-Object Windows.Media.Imaging.BitmapImage
  $bitmap.BeginInit(); $bitmap.CacheOption = [Windows.Media.Imaging.BitmapCacheOption]::OnLoad
  $bitmap.UriSource = New-Object Uri -ArgumentList $ImagePath, ([UriKind]::Absolute); $bitmap.EndInit(); $bitmap.Freeze()
  $result.source = [ordered]@{ widthPx = $bitmap.PixelWidth; heightPx = $bitmap.PixelHeight; dpiX = $bitmap.DpiX; dpiY = $bitmap.DpiY; aspect = [double]$bitmap.PixelWidth / [double]$bitmap.PixelHeight }
  $pageWidth = $ticket.PageMediaSize.Width; $pageHeight = $ticket.PageMediaSize.Height
  if ($null -eq $result.media) { Warn 'PageMediaSize unavailable from Canon driver' }
  elseif ($null -eq $pageWidth -or $null -eq $pageHeight -or [double]$pageWidth -le 0 -or [double]$pageHeight -le 0) { Warn 'PageMediaSize dimensions unavailable from Canon driver' }
  if ($null -ne $pageWidth -and $null -ne $pageHeight -and [double]$pageWidth -gt 0 -and [double]$pageHeight -gt 0) {
  $Stage = 'calculate-wpf-geometry'; $pageWidth = [double]$pageWidth; $pageHeight = [double]$pageHeight
  if ($pageWidth -gt $pageHeight -and $bitmap.PixelWidth -lt $bitmap.PixelHeight) { $swap = $pageWidth; $pageWidth = $pageHeight; $pageHeight = $swap }
  if ($pageHeight -gt $pageWidth -and $bitmap.PixelWidth -gt $bitmap.PixelHeight) { $swap = $pageWidth; $pageWidth = $pageHeight; $pageHeight = $swap }
  $baseUniformScale = [Math]::Min($pageWidth / [double]$bitmap.PixelWidth, $pageHeight / [double]$bitmap.PixelHeight)
  $baseWidth = [double]$bitmap.PixelWidth * $baseUniformScale; $baseHeight = [double]$bitmap.PixelHeight * $baseUniformScale
  $baseX = ($pageWidth - $baseWidth) / 2; $baseY = ($pageHeight - $baseHeight) / 2
  $width = $baseWidth * $ContentScale; $height = $baseHeight * $ContentScale
  $offsetXDiu = $OffsetXmm * 96.0 / 25.4; $offsetYDiu = $OffsetYmm * 96.0 / 25.4
  $x = (($pageWidth - $width) / 2) + $offsetXDiu; $y = (($pageHeight - $height) / 2) + $offsetYDiu
  $result.contentCalibration = [ordered]@{
    source = [ordered]@{ width = $bitmap.PixelWidth; height = $bitmap.PixelHeight }
    physicalPage = [ordered]@{ widthDiu = $pageWidth; heightDiu = $pageHeight; widthMm = ToMm $pageWidth; heightMm = ToMm $pageHeight }
    baseDestination = [ordered]@{ xDiu = $baseX; yDiu = $baseY; widthDiu = $baseWidth; heightDiu = $baseHeight; xMm = ToMm $baseX; yMm = ToMm $baseY; widthMm = ToMm $baseWidth; heightMm = ToMm $baseHeight }
    scale = $ContentScale; offsetXmm = $OffsetXmm; offsetYmm = $OffsetYmm
    finalDestination = [ordered]@{ xDiu = $x; yDiu = $y; widthDiu = $width; heightDiu = $height; xMm = ToMm $x; yMm = ToMm $y; widthMm = ToMm $width; heightMm = ToMm $height }
    cropBeyondPage = [ordered]@{ leftMm = ToMm ([Math]::Max(0, -$x)); rightMm = ToMm ([Math]::Max(0, $x + $width - $pageWidth)); topMm = ToMm ([Math]::Max(0, -$y)); bottomMm = ToMm ([Math]::Max(0, $y + $height - $pageHeight)) }
    unused = [ordered]@{ leftMm = ToMm ([Math]::Max(0, $x)); rightMm = ToMm ([Math]::Max(0, $pageWidth - ($x + $width))); topMm = ToMm ([Math]::Max(0, $y)); bottomMm = ToMm ([Math]::Max(0, $pageHeight - ($y + $height))) }
  }
  $ticketDiagnostic = [ordered]@{
    backend = $result.backend; printerName = $PrinterName; media = $result.media
    borderlessRequested = $true; borderlessValidated = $result.borderlessSelected
    scalingRequested = $result.scalingRequested; scalingValidated = $result.scalingValidated
    pageImageableArea = $result.pageImageableArea; contentCalibration = $result.contentCalibration
  }
  Write-Output ('AFTERIMAGE_CP1500_TICKET:' + ($ticketDiagnostic | ConvertTo-Json -Depth 10 -Compress))

  $control = New-Object Windows.Controls.Image
  $control.Source = $bitmap; $control.Stretch = [Windows.Media.Stretch]::Uniform
  $control.Width = $width; $control.Height = $height
  [Windows.Controls.Canvas]::SetLeft($control, $x); [Windows.Controls.Canvas]::SetTop($control, $y)
  $page = New-Object Windows.Documents.FixedPage
  $page.Width = $pageWidth; $page.Height = $pageHeight; $page.ClipToBounds = $true; [void]$page.Children.Add($control)
  $result.wpfGeometry = [ordered]@{
    image = [ordered]@{ width = $control.Width; height = $control.Height; canvasLeft = [Windows.Controls.Canvas]::GetLeft($control); canvasTop = [Windows.Controls.Canvas]::GetTop($control); stretch = EnumName $control.Stretch; renderTransform = $null; layoutTransform = $null }
    fixedPage = [ordered]@{ width = $page.Width; height = $page.Height; clipToBounds = $page.ClipToBounds }
  }
  $content = New-Object Windows.Documents.PageContent
  ([Windows.Markup.IAddChild]$content).AddChild($page)
  $document = New-Object Windows.Documents.FixedDocument
  $document.DocumentPaginator.PageSize = New-Object Windows.Size -ArgumentList $pageWidth, $pageHeight
  [void]$document.Pages.Add($content)
  } else { Warn 'Destination geometry unavailable because media dimensions are missing' }
  if (-not $DiagnosticOnly) {
    $writer = [System.Printing.PrintQueue]::CreateXpsDocumentWriter($queue)
    $writer.Write($document.DocumentPaginator, $ticket)
    $result.submitted = $true
  }
  $result.ok = $true
} catch { $result.error = [ordered]@{ name = $_.Exception.GetType().FullName; message = $_.Exception.Message; stack = $_.Exception.StackTrace; stage = $Stage } }
$result.warnings = @($Warnings)
$result | ConvertTo-Json -Depth 10 -Compress
`;
}

function runPowerShellJson(script, timeoutMs = WINDOWS_CP1500_JOB_TIMEOUT_MS, onTicketValidated = null) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    let stdout = ''; let stderr = ''; let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ ok: false, submitted: false, backend: WINDOWS_CP1500_BACKEND, error: `Windows print submission timed out after ${timeoutMs}ms` }); }, timeoutMs);
    let lineBuffer = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('AFTERIMAGE_CP1500_TICKET:')) continue;
        try { onTicketValidated?.(JSON.parse(line.slice('AFTERIMAGE_CP1500_TICKET:'.length))); } catch {}
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish({ ok: false, submitted: false, backend: WINDOWS_CP1500_BACKEND, error: error.message }));
    child.on('close', () => {
      try { finish({ ...JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)), stderr: stderr.trim() || null }); }
      catch { finish({ ok: false, submitted: false, backend: WINDOWS_CP1500_BACKEND, error: stderr.trim() || 'Windows print backend returned invalid output', stdout: stdout.slice(-2000) }); }
    });
  });
}

async function printUsingWindowsCp1500({ dataUrl, printerName, jobName, tempDirectory, onTicketValidated = null }) {
  if (process.platform !== 'win32') throw new Error('Windows CP1500 backend called on a non-Windows platform');
  const { bytes, extension } = decodeImageDataUrl(dataUrl);
  const imagePath = path.join(tempDirectory, `afterimage-cp1500-${process.pid}-${Date.now()}${extension}`);
  await fs.promises.writeFile(imagePath, bytes, { flag: 'wx' });
  try {
    return await runPowerShellJson(buildWindowsCp1500PrintScript({ printerName, imagePath, jobName, calibration: getWindowsCp1500Calibration() }), WINDOWS_CP1500_JOB_TIMEOUT_MS, onTicketValidated);
  } finally {
    await fs.promises.unlink(imagePath).catch(() => {});
  }
}

async function getWindowsCp1500GeometryDiagnostics({ dataUrl = null, imagePath: providedImagePath = null, printerName, tempDirectory, calibration = getWindowsCp1500Calibration() }) {
  if (process.platform !== 'win32') throw new Error('Windows CP1500 diagnostics called on a non-Windows platform');
  const diagnosticCalibration = normalizeCalibration(calibration);
  let imagePath = providedImagePath;
  let ownsImagePath = false;
  if (!imagePath) {
    const { bytes, extension } = decodeImageDataUrl(dataUrl);
    imagePath = path.join(tempDirectory, `afterimage-cp1500-diagnostic-${process.pid}-${Date.now()}${extension}`);
    await fs.promises.writeFile(imagePath, bytes, { flag: 'wx' });
    ownsImagePath = true;
  }
  try {
    const result = await runPowerShellJson(buildWindowsCp1500PrintScript({
      printerName,
      imagePath,
      jobName: 'Afterimage CP1500 Geometry Diagnostic',
      calibration: diagnosticCalibration,
      diagnosticOnly: true,
    }));
    if (result?.error && typeof result.error !== 'object') {
      result.error = { name: 'Error', message: String(result.error), stack: null, stage: 'powershell-diagnostic' };
    }
    const pageWidth = result?.media?.widthDip;
    const pageHeight = result?.media?.heightDip;
    const sourceWidth = result?.source?.widthPx;
    const sourceHeight = result?.source?.heightPx;
    const comparisons = {};
    if ([pageWidth, pageHeight, sourceWidth, sourceHeight].every((value) => Number.isFinite(Number(value)))) {
      for (const scale of [1, 1.005, 1.01]) {
        const geometry = calculateCenteredContentRectangle({ sourceWidth, sourceHeight, pageWidth, pageHeight, scale, offsetXmm: 0, offsetYmm: 0 });
        const toMm = (value) => value * 25.4 / 96;
        const toPrinterPixels = (value) => toMm(value) * 300 / 25.4;
        comparisons[String(scale)] = {
          calibration: geometry.calibration,
          baseDip: geometry.base,
          destinationDip: geometry.final,
          destinationMm: Object.fromEntries(Object.entries(geometry.final).map(([key, value]) => [key, toMm(value)])),
          destination300DpiPixels: Object.fromEntries(Object.entries(geometry.final).map(([key, value]) => [key, toPrinterPixels(value)])),
          overflowDip: geometry.cropBeyondPage,
          unusedDip: geometry.unused,
          finalXpsImage: { width: geometry.final.width, height: geometry.final.height, left: geometry.final.x, top: geometry.final.y },
          fixedPage: { width: Number(pageWidth), height: Number(pageHeight) },
          renderTransform: null,
          layoutTransform: null,
        };
      }
    }
    return {
      ...result,
      source: result?.source || null,
      media: result?.media || null,
      imageableArea: result?.pageImageableArea ? {
        ...result.pageImageableArea,
        widthDip: result.pageImageableArea.extentWidthDip ?? null,
        heightDip: result.pageImageableArea.extentHeightDip ?? null,
        widthMm: result.pageImageableArea.extentWidthMm ?? null,
        heightMm: result.pageImageableArea.extentHeightMm ?? null,
        aspect: result.pageImageableArea.extentWidthDip && result.pageImageableArea.extentHeightDip
          ? result.pageImageableArea.extentWidthDip / result.pageImageableArea.extentHeightDip
          : null,
      } : null,
      calibration: diagnosticCalibration,
      destinationRectDip: result?.contentCalibration?.finalDestination ? {
        x: result.contentCalibration.finalDestination.xDiu,
        y: result.contentCalibration.finalDestination.yDiu,
        width: result.contentCalibration.finalDestination.widthDiu,
        height: result.contentCalibration.finalDestination.heightDiu,
      } : null,
      destinationRectMm: result?.contentCalibration?.finalDestination ? {
        x: result.contentCalibration.finalDestination.xMm,
        y: result.contentCalibration.finalDestination.yMm,
        width: result.contentCalibration.finalDestination.widthMm,
        height: result.contentCalibration.finalDestination.heightMm,
      } : null,
      fixedPage: result?.wpfGeometry?.fixedPage ? {
        widthDip: result.wpfGeometry.fixedPage.width,
        heightDip: result.wpfGeometry.fixedPage.height,
        widthMm: result.wpfGeometry.fixedPage.width * 25.4 / 96,
        heightMm: result.wpfGeometry.fixedPage.height * 25.4 / 96,
      } : null,
      destination: result?.contentCalibration?.finalDestination || null,
      xpsImage: result?.wpfGeometry?.image ? {
        widthDip: result.wpfGeometry.image.width,
        heightDip: result.wpfGeometry.image.height,
        leftDip: result.wpfGeometry.image.canvasLeft,
        topDip: result.wpfGeometry.image.canvasTop,
      } : null,
      printTicket: result?.ticket ? {
        pageMediaSize: result.ticket.mediaName ?? null,
        pageBorderless: result.ticket.validatedBorderless ?? null,
        pageScaling: result.ticket.validatedScaling ?? null,
        outputQuality: result.ticket.outputQuality ?? null,
      } : null,
      raw: {
        printerName: result?.printerName || printerName || null,
        mediaName: result?.media?.name || null,
        rawMediaWidthDip: result?.media?.widthDip ?? null,
        rawMediaHeightDip: result?.media?.heightDip ?? null,
        mediaWidthMm: result?.media?.widthMm ?? null,
        mediaHeightMm: result?.media?.heightMm ?? null,
        rawImageableOriginX: result?.pageImageableArea?.originXDip ?? null,
        rawImageableOriginY: result?.pageImageableArea?.originYDip ?? null,
        rawImageableWidth: result?.pageImageableArea?.extentWidthDip ?? null,
        rawImageableHeight: result?.pageImageableArea?.extentHeightDip ?? null,
        validatedBorderless: result?.ticket?.validatedBorderless ?? null,
        validatedScaling: result?.ticket?.validatedScaling ?? null,
        sourcePixelWidth: result?.source?.widthPx ?? null,
        sourcePixelHeight: result?.source?.heightPx ?? null,
        sourceDpiX: result?.source?.dpiX ?? null,
        sourceDpiY: result?.source?.dpiY ?? null,
        calibration: diagnosticCalibration,
        destinationRectDip: result?.contentCalibration?.finalDestination || null,
      },
      comparisons,
      serializedXpsGeometry: null,
      serializedXpsGeometryReason: 'Diagnostic mode constructs the identical WPF geometry but intentionally does not spool or serialize a job.',
      canonPaperSpecification: {
        completeSheetMm: { width: 100, height: 177, aspect: 100 / 177 },
        finalTrimmedMm: { width: 100, height: 148, aspect: 100 / 148 },
        totalPerforationMm: 29,
        individualTabMm: null,
        source: 'Canon SELPHY CP1500 specifications; individual top/bottom split is not specified',
      },
    };
  } finally {
    if (ownsImagePath) await fs.promises.unlink(imagePath).catch(() => {});
  }
}

module.exports = {
  WINDOWS_CP1500_BACKEND,
  WINDOWS_CP1500_CALIBRATION,
  buildWindowsCp1500PrintScript,
  calculateCenteredContentRectangle,
  createSolidDiagnosticPng,
  decodeImageDataUrl,
  getWindowsCp1500Calibration,
  getWindowsCp1500GeometryDiagnostics,
  printUsingWindowsCp1500,
  resetWindowsCp1500Calibration,
  setWindowsCp1500Calibration,
};
