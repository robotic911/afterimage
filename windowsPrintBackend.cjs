const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const WINDOWS_CP1500_BACKEND = 'Native Windows PrintTicket/XPS';
const WINDOWS_CP1500_JOB_TIMEOUT_MS = 60000;

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

function buildWindowsCp1500PrintScript({ printerName, imagePath, jobName }) {
  const printer = encodedPowerShellValue(printerName);
  const image = encodedPowerShellValue(imagePath);
  const job = encodedPowerShellValue(jobName);
  return String.raw`
$ErrorActionPreference = 'Stop'
$PrinterName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${printer}'))
$ImagePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${image}'))
$JobName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${job}'))

function EnumName($value) { if ($null -eq $value) { return $null }; return $value.ToString() }
function ToMm($value) { if ($null -eq $value) { return $null }; return [Math]::Round(([double]$value * 25.4 / 96), 3) }
function MediaRecord($media) {
  if ($null -eq $media) { return $null }
  return [ordered]@{ name = EnumName $media.PageMediaSizeName; widthMm = ToMm $media.Width; heightMm = ToMm $media.Height }
}
function AreaRecord($cap, $ticket) {
  if ($null -eq $cap.PageImageableArea) { return $null }
  $area = $cap.PageImageableArea
  $pw = $cap.OrientedPageMediaWidth; $ph = $cap.OrientedPageMediaHeight
  if (($null -eq $pw -or $pw -le 0) -and $null -ne $ticket.PageMediaSize) { $pw = $ticket.PageMediaSize.Width }
  if (($null -eq $ph -or $ph -le 0) -and $null -ne $ticket.PageMediaSize) { $ph = $ticket.PageMediaSize.Height }
  $right = [Math]::Max(0, [double]$pw - [double]$area.OriginWidth - [double]$area.ExtentWidth)
  $bottom = [Math]::Max(0, [double]$ph - [double]$area.OriginHeight - [double]$area.ExtentHeight)
  return [ordered]@{
    physicalWidthMm = ToMm $pw; physicalHeightMm = ToMm $ph
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

$result = [ordered]@{ ok = $false; submitted = $false; backend = '${WINDOWS_CP1500_BACKEND}'; printerName = $PrinterName; borderlessSupported = $false; borderlessSelected = $false; media = $null; pageImageableArea = $null; conflictStatus = $null; error = $null }
try {
  Add-Type -AssemblyName System.Printing
  Add-Type -AssemblyName ReachFramework
  Add-Type -AssemblyName PresentationCore
  Add-Type -AssemblyName PresentationFramework
  $server = New-Object System.Printing.LocalPrintServer
  $queue = $server.GetPrintQueue($PrinterName); $queue.Refresh()
  $baseTicket = $queue.DefaultPrintTicket
  $baseCapabilities = $queue.GetPrintCapabilities($baseTicket)
  $borderlessValues = @($baseCapabilities.PageBorderlessCapability | ForEach-Object { EnumName $_ })
  $result.borderlessSupported = $borderlessValues -contains 'Borderless'
  if (-not $result.borderlessSupported) { throw 'The selected Windows printer queue does not expose PageBorderless=Borderless.' }

  $bestMedia = $baseCapabilities.PageMediaSizeCapability | ForEach-Object {
    [pscustomobject]@{ Media = $_; Score = MediaScore $_ }
  } | Sort-Object Score -Descending | Select-Object -First 1
  if ($null -eq $bestMedia -or $bestMedia.Score -lt 40) { throw 'The selected Windows printer queue does not expose a Postcard/4x6 media size.' }

  $jobTicket = $baseTicket.Clone()
  $jobTicket.PageBorderless = [System.Printing.PageBorderless]::Borderless
  $jobTicket.PageMediaSize = $bestMedia.Media
  if (@($baseCapabilities.PageScalingCapability | ForEach-Object { EnumName $_ }) -contains 'None') {
    $jobTicket.PageScaling = [System.Printing.PageScaling]::None
  }
  if (@($baseCapabilities.OutputQualityCapability | ForEach-Object { EnumName $_ }) -contains 'Photographic') {
    $jobTicket.OutputQuality = [System.Printing.OutputQuality]::Photographic
  }
  $validation = $queue.MergeAndValidatePrintTicket($baseTicket, $jobTicket)
  $ticket = $validation.ValidatedPrintTicket
  $result.conflictStatus = EnumName $validation.ConflictStatus
  $result.borderlessSelected = ((EnumName $ticket.PageBorderless) -eq 'Borderless')
  $result.media = MediaRecord $ticket.PageMediaSize
  $result.scalingRequested = 'None'
  $result.scalingValidated = EnumName $ticket.PageScaling
  if (-not $result.borderlessSelected) { throw 'Windows rejected PageBorderless=Borderless for the selected media.' }

  $cap = $queue.GetPrintCapabilities($ticket)
  $result.pageImageableArea = AreaRecord $cap $ticket
  $area = $result.pageImageableArea
  if ($null -eq $area) { throw 'Windows did not report a printable area for the validated borderless ticket.' }
  $maxInsetMm = (@($area.hardwareMarginsMm.left, $area.hardwareMarginsMm.right, $area.hardwareMarginsMm.top, $area.hardwareMarginsMm.bottom) | Measure-Object -Maximum).Maximum
  if ([double]$maxInsetMm -gt 0.3) { throw ('Validated borderless ticket still reports a reduced printable area (maximum inset {0} mm).' -f $maxInsetMm) }

  $ticketDiagnostic = [ordered]@{
    backend = $result.backend; printerName = $PrinterName; media = $result.media
    borderlessRequested = $true; borderlessValidated = $result.borderlessSelected
    scalingRequested = $result.scalingRequested; scalingValidated = $result.scalingValidated
    pageImageableArea = $result.pageImageableArea
  }
  Write-Output ('AFTERIMAGE_CP1500_TICKET:' + ($ticketDiagnostic | ConvertTo-Json -Depth 8 -Compress))

  $bitmap = New-Object Windows.Media.Imaging.BitmapImage
  $bitmap.BeginInit(); $bitmap.CacheOption = [Windows.Media.Imaging.BitmapCacheOption]::OnLoad
  $bitmap.UriSource = New-Object Uri -ArgumentList $ImagePath, ([UriKind]::Absolute); $bitmap.EndInit(); $bitmap.Freeze()
  $width = [double]$ticket.PageMediaSize.Width; $height = [double]$ticket.PageMediaSize.Height
  if ($width -gt $height -and $bitmap.PixelWidth -lt $bitmap.PixelHeight) { $swap = $width; $width = $height; $height = $swap }
  if ($height -gt $width -and $bitmap.PixelWidth -gt $bitmap.PixelHeight) { $swap = $width; $width = $height; $height = $swap }

  $control = New-Object Windows.Controls.Image
  $control.Source = $bitmap; $control.Stretch = [Windows.Media.Stretch]::Fill
  $control.Width = $width; $control.Height = $height
  [Windows.Controls.Canvas]::SetLeft($control, 0); [Windows.Controls.Canvas]::SetTop($control, 0)
  $page = New-Object Windows.Documents.FixedPage
  $page.Width = $width; $page.Height = $height; [void]$page.Children.Add($control)
  $content = New-Object Windows.Documents.PageContent
  ([Windows.Markup.IAddChild]$content).AddChild($page)
  $document = New-Object Windows.Documents.FixedDocument
  $document.DocumentPaginator.PageSize = New-Object Windows.Size -ArgumentList $width, $height
  [void]$document.Pages.Add($content)
  $writer = [System.Printing.PrintQueue]::CreateXpsDocumentWriter($queue)
  $writer.Write($document.DocumentPaginator, $ticket)
  $result.ok = $true; $result.submitted = $true
} catch { $result.error = $_.Exception.Message }
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
    return await runPowerShellJson(buildWindowsCp1500PrintScript({ printerName, imagePath, jobName }), WINDOWS_CP1500_JOB_TIMEOUT_MS, onTicketValidated);
  } finally {
    await fs.promises.unlink(imagePath).catch(() => {});
  }
}

module.exports = { WINDOWS_CP1500_BACKEND, buildWindowsCp1500PrintScript, decodeImageDataUrl, printUsingWindowsCp1500 };
