import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  DEFAULT_ELECTRON_PRINT_PAGE,
  WINDOWS_PHYSICAL_PRINT_ENTRY_POINTS,
  WINDOWS_SELPHY_CP1500_OVERSCAN_PERCENT,
  WINDOWS_SELPHY_CP1500_PRINT_PAGE,
  WINDOWS_SELPHY_CP1500_SCALE_FACTOR,
  ZERO_PHYSICAL_PRINT_MARGINS,
  buildCanonicalElectronPrintOptions,
  buildCanonicalPrintShell,
  buildWindowsPrintSnapshot,
  getCanonicalPrintPageConfig,
  validateWindowsPrintInvariants,
} = require('../printPipeline.cjs');
const {
  WINDOWS_CP1500_BACKEND,
  WINDOWS_CP1500_CALIBRATION,
  buildWindowsCp1500PrintScript,
  calculateCenteredContentRectangle,
  createSolidDiagnosticPng,
  decodeImageDataUrl,
} = require('../windowsPrintBackend.cjs');

test('Windows Canon SELPHY CP1500 resolves to the zero-margin canonical 4x6 profile', () => {
  const printer = { name: 'Canon SELPHY CP1500' };
  const config = getCanonicalPrintPageConfig({ platform: 'win32', printer });

  assert.equal(config, WINDOWS_SELPHY_CP1500_PRINT_PAGE);
  assert.equal(config.cssWidth, '4in');
  assert.equal(config.cssHeight, '6in');
  assert.equal(config.usePrinterDefaultPageSize, true);
  assert.equal(config.zeroMarginDocument, true);
  assert.equal(config.scaleFactor, WINDOWS_SELPHY_CP1500_SCALE_FACTOR);
  assert.equal(config.borderlessOverscanPercent, WINDOWS_SELPHY_CP1500_OVERSCAN_PERCENT);
  assert.deepEqual(config.applicationMargins, ZERO_PHYSICAL_PRINT_MARGINS);
  assert.deepEqual(config.electronMargins, { marginType: 'none' });
});

test('Windows CP1500 Electron options keep scale locked and do not pass a custom pageSize', () => {
  const printerName = 'Canon SELPHY CP1500';
  const printer = { name: printerName };
  const config = getCanonicalPrintPageConfig({ platform: 'win32', printer });
  const printOptions = buildCanonicalElectronPrintOptions(config, {
    silent: true,
    printerName,
  });

  assert.equal(printOptions.scaleFactor, WINDOWS_SELPHY_CP1500_SCALE_FACTOR);
  assert.equal(printOptions.margins.marginType, 'none');
  assert.equal(printOptions.usePrinterDefaultPageSize, true);
  assert.equal(Object.prototype.hasOwnProperty.call(printOptions, 'pageSize'), false);
  assert.equal(printOptions.landscape, false);
  assert.equal(printOptions.printBackground, true);

  const report = validateWindowsPrintInvariants(config, printOptions, {
    platform: 'win32',
    printer,
    printerName,
    readiness: {
      bodyMargin: '0px',
      bodyPadding: '0px',
      rootMargin: '0px',
      rootPadding: '0px',
      naturalWidth: 1200,
      naturalHeight: 1800,
      renderedWidth: 384,
      renderedHeight: 576,
    },
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.violations, []);
});

test('Windows CP1500 print shell uses isolated zero-margin CSS', () => {
  const shell = buildCanonicalPrintShell('Afterimage Windows CP1500', WINDOWS_SELPHY_CP1500_PRINT_PAGE);

  assert.match(shell, /@page \{ size: 4in 6in; margin: 0; \}/);
  assert.match(shell, /html \{[\s\S]*margin: 0 !important;[\s\S]*padding: 0 !important;/);
  assert.match(shell, /body \{[\s\S]*margin: 0 !important;[\s\S]*padding: 0 !important;/);
  assert.match(shell, /#print-root \{[\s\S]*margin: 0 !important;[\s\S]*padding: 0 !important;[\s\S]*border: 0;/);
  assert.match(shell, /#print-root img \{[\s\S]*max-width: none;[\s\S]*max-height: none;[\s\S]*object-fit: fill;/);
  assert.doesNotMatch(shell, /100vh|100vw|object-fit:\s*contain|max-width:\s*100%|max-height:\s*100%/);
});

test('Windows print snapshot reports physical page, printable area, and hardware margins', () => {
  const snapshot = buildWindowsPrintSnapshot({
    jobType: 'customer_print',
    printerName: 'Canon SELPHY CP1500',
    printer: { name: 'Canon SELPHY CP1500' },
    printPageConfig: WINDOWS_SELPHY_CP1500_PRINT_PAGE,
    printOptions: buildCanonicalElectronPrintOptions(WINDOWS_SELPHY_CP1500_PRINT_PAGE, {
      silent: true,
      printerName: 'Canon SELPHY CP1500',
    }),
    readiness: {
      naturalWidth: 1200,
      naturalHeight: 1800,
      bodyMargin: '0px',
      rootMargin: '0px',
      rootPadding: '0px',
    },
    windowsPrintPrep: {
      borderlessSupported: true,
      borderlessSelectedBefore: false,
      borderlessSelectedAfter: true,
      pageImageableAreaAfter: {
        physicalWidthMm: 101.6,
        physicalHeightMm: 152.4,
        originXMm: 0,
        originYMm: 0,
        extentWidthMm: 101.6,
        extentHeightMm: 152.4,
        printableScalePercent: 100,
        hardwareMarginsMm: {
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
        },
      },
    },
  });

  assert.deepEqual(snapshot.requestedPaper, {
    width: '4in',
    height: '6in',
    widthMm: 101.6,
    heightMm: 152.4,
    widthMicrons: 101600,
    heightMicrons: 152400,
  });
  assert.deepEqual(snapshot.physicalPage, {
    widthMm: 101.6,
    heightMm: 152.4,
    source: 'windows_print_ticket_imageable_area',
  });
  assert.deepEqual(snapshot.printableArea, {
    xMm: 0,
    yMm: 0,
    widthMm: 101.6,
    heightMm: 152.4,
    source: 'windows_print_ticket_imageable_area',
  });
  assert.deepEqual(snapshot.hardwareMargins, {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  });
  assert.equal(snapshot.printableScalePercent, 100);
});

test('Darwin and non-SELPHY printers keep the existing default print path values', () => {
  const config = getCanonicalPrintPageConfig({
    platform: 'darwin',
    printer: { name: 'Canon SELPHY CP1500' },
  });
  const printOptions = buildCanonicalElectronPrintOptions(config, {
    silent: true,
    printerName: 'Canon SELPHY CP1500',
  });

  assert.equal(config, DEFAULT_ELECTRON_PRINT_PAGE);
  assert.equal(config.zeroMarginDocument, false);
  assert.equal(config.usePrinterDefaultPageSize, false);
  assert.equal(printOptions.scaleFactor, 100);
  assert.deepEqual(printOptions.pageSize, {
    width: 101600,
    height: 152400,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(printOptions, 'usePrinterDefaultPageSize'), false);
});

test('Darwin/default print shell keeps the existing fixed 4x6 document sizing', () => {
  const shell = buildCanonicalPrintShell('Afterimage Darwin', DEFAULT_ELECTRON_PRINT_PAGE);

  assert.match(shell, /@page \{ size: 4in 6in; margin: 0; \}/);
  assert.match(shell, /html, body \{ margin: 0; padding: 0; width: 4in; height: 6in;/);
  assert.match(shell, /img \{[\s\S]*width: 4in;[\s\S]*height: 6in;/);
  assert.doesNotMatch(shell, /zero-margin template|WINDOWS|100vh|100vw/);
});

test('all physical print entry points are documented as using the same low-level helper', () => {
  assert.deepEqual(
    WINDOWS_PHYSICAL_PRINT_ENTRY_POINTS.map((entry) => entry.lowLevelHelper),
    ['submitSinglePrintCopy', 'submitSinglePrintCopy', 'submitSinglePrintCopy'],
  );
});

test('main process keeps one physical webContents.print implementation', () => {
  const source = readFileSync(new URL('../electron.cjs', import.meta.url), 'utf8');
  const printCalls = source.match(/\.webContents\.print\(/g) || [];
  assert.equal(printCalls.length, 1);
  assert.doesNotMatch(source, /function buildPrintShell/);
  assert.match(source, /buildCanonicalPrintShell/);
  assert.match(source, /\[WINDOWS CP1500 PRINT\]/);
  assert.match(source, /process\.platform === 'win32' && isSelphyPrinter\(printer\)/);
  assert.match(source, /printUsingWindowsCp1500\(\{/);
  assert.match(source, /else \{[\s\S]*printWin\.webContents\.print\(printOptions/);

  const extraPrintBlock = source.slice(
    source.indexOf("ipcMain.handle('today-monitor:print-extra-session-copy'"),
    source.indexOf("console.log('[main ipc] registered today-monitor:print-extra-session-copy'"),
  );
  assert.match(extraPrintBlock, /submitSinglePrintCopy\(\{[\s\S]*printer:\s*target\.printer/);
  assert.match(extraPrintBlock, /submitSinglePrintCopy\(\{[\s\S]*printerList:\s*target\.printerList/);

  const keychainBlock = source.slice(
    source.indexOf("ipcMain.handle('today-monitor:generate-and-print-keychain'"),
    source.indexOf("console.log('[main ipc] registered today-monitor:generate-and-print-keychain'"),
  );
  assert.match(keychainBlock, /submitSinglePrintCopy\(\{[\s\S]*printer:\s*target\.printer/);
  assert.match(keychainBlock, /submitSinglePrintCopy\(\{[\s\S]*printerList:\s*target\.printerList/);

  const queueBlock = source.slice(
    source.indexOf('async function runPrintJob'),
    source.indexOf('function processNextPrintJob'),
  );
  assert.match(queueBlock, /submitSinglePrintCopy\(\{[\s\S]*printer:\s*target\.printer/);
  assert.match(queueBlock, /submitSinglePrintCopy\(\{[\s\S]*printerList:\s*target\.printerList/);
});

test('native Windows backend sends an explicit per-job borderless PrintTicket', () => {
  const script = buildWindowsCp1500PrintScript({
    printerName: 'Canon SELPHY CP1500',
    imagePath: 'C:\\Temp\\afterimage.png',
    jobName: 'Afterimage calibration',
  });

  assert.equal(WINDOWS_CP1500_BACKEND, 'Native Windows PrintTicket/XPS');
  assert.match(script, /PageBorderless\]::Borderless/);
  assert.match(script, /PageScaling\]::None/);
  assert.match(script, /OutputQuality\]::Photographic/);
  assert.match(script, /MergeAndValidatePrintTicket/);
  assert.match(script, /CreateXpsDocumentWriter/);
  assert.match(script, /Stretch\]::Uniform/);
  assert.match(script, /\$ContentScale = \[double\]1/);
  assert.match(script, /\$OffsetXmm = \[double\]0/);
  assert.match(script, /\$OffsetYmm = \[double\]0/);
  assert.match(script, /maximum inset/);
  assert.doesNotMatch(script, /DefaultPrintTicket\s*=/);
});

test('Windows CP1500 1.00 baseline uniformly maps and centers complete 4x6 artwork', () => {
  const geometry = calculateCenteredContentRectangle({
    sourceWidth: 1200,
    sourceHeight: 1800,
    pageWidth: 384,
    pageHeight: 576,
  });
  const center = (rectangle) => ({
    x: rectangle.x + rectangle.width / 2,
    y: rectangle.y + rectangle.height / 2,
  });
  const baseCenter = center(geometry.base);
  const finalCenter = center(geometry.final);

  assert.deepEqual(WINDOWS_CP1500_CALIBRATION, { scale: 1, offsetXmm: 0, offsetYmm: 0 });
  assert.equal(geometry.base.x, 0);
  assert.equal(geometry.base.y, 0);
  assert.equal(geometry.base.width, 384);
  assert.equal(geometry.base.height, 576);
  assert.ok(Math.abs(geometry.final.width - 384) < 1e-10);
  assert.ok(Math.abs(geometry.final.height - 576) < 1e-10);
  assert.ok(Math.abs(geometry.final.x) < 1e-10);
  assert.ok(Math.abs(geometry.final.y) < 1e-10);
  assert.ok(Math.abs(baseCenter.x - finalCenter.x) < 1e-10);
  assert.ok(Math.abs(baseCenter.y - finalCenter.y) < 1e-10);
  assert.ok(Math.abs((geometry.final.width / geometry.final.height) - (1200 / 1800)) < 1e-10);
  assert.equal(geometry.cropBeyondPage.left, 0);
  assert.equal(geometry.cropBeyondPage.right, 0);
  assert.equal(geometry.cropBeyondPage.top, 0);
  assert.equal(geometry.cropBeyondPage.bottom, 0);
});

test('Windows CP1500 scale presets remain uniform and centered', () => {
  for (const scale of [0.98, 0.99, 1, 1.01, 1.02]) {
    const geometry = calculateCenteredContentRectangle({
      sourceWidth: 1200,
      sourceHeight: 1800,
      pageWidth: 384,
      pageHeight: 576,
      scale,
      offsetXmm: 0,
      offsetYmm: 0,
    });
    assert.ok(Math.abs((geometry.final.x + geometry.final.width / 2) - 192) < 1e-10);
    assert.ok(Math.abs((geometry.final.y + geometry.final.height / 2) - 288) < 1e-10);
    assert.ok(Math.abs((geometry.final.width / geometry.final.height) - (2 / 3)) < 1e-10);
    assert.ok(Math.abs(geometry.final.width - (384 * scale)) < 1e-10);
    assert.ok(Math.abs(geometry.final.height - (576 * scale)) < 1e-10);
  }
});

test('Windows CP1500 millimeter offsets move position without changing scale or size', () => {
  const base = calculateCenteredContentRectangle({ sourceWidth: 1200, sourceHeight: 1800, pageWidth: 384, pageHeight: 576 });
  const moved = calculateCenteredContentRectangle({
    sourceWidth: 1200,
    sourceHeight: 1800,
    pageWidth: 384,
    pageHeight: 576,
    scale: 1,
    offsetXmm: 1.5,
    offsetYmm: -2,
  });
  assert.equal(moved.final.width, base.final.width);
  assert.equal(moved.final.height, base.final.height);
  assert.ok(Math.abs((moved.final.x - base.final.x) - (1.5 * 96 / 25.4)) < 1e-10);
  assert.ok(Math.abs((moved.final.y - base.final.y) - (-2 * 96 / 25.4)) < 1e-10);
});

test('Windows content scale is confined to the native Windows backend', () => {
  const main = readFileSync(new URL('../electron.cjs', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
  const pipeline = readFileSync(new URL('../printPipeline.cjs', import.meta.url), 'utf8');

  assert.doesNotMatch(main, /WINDOWS_CP1500_CALIBRATION/);
  assert.doesNotMatch(preload, /WINDOWS_CP1500_CALIBRATION/);
  assert.doesNotMatch(pipeline, /WINDOWS_CP1500_CALIBRATION/);
});

test('native Windows backend accepts the existing PNG without recomposition', () => {
  const decoded = decodeImageDataUrl('data:image/png;base64,iVBORw0KGgo=');
  assert.equal(decoded.extension, '.png');
  assert.deepEqual(decoded.bytes, Buffer.from('iVBORw0KGgo=', 'base64'));
  assert.throws(() => decodeImageDataUrl('data:text/plain;base64,SGVsbG8='), /PNG or JPEG/);
});

test('calibration IPC is bridged through preload to the matching main handler', () => {
  const preload = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../electron.cjs', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  assert.match(preload, /printWindowsCp1500Calibration:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('print:windows-cp1500-calibration'\)/);
  assert.match(preload, /getWindowsCp1500ContentCalibration:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('print:windows-cp1500-calibration:get'\)/);
  assert.match(preload, /setWindowsCp1500ContentCalibration:\s*\(calibration\)\s*=>\s*ipcRenderer\.invoke\('print:windows-cp1500-calibration:set', calibration\)/);
  assert.match(preload, /resetWindowsCp1500ContentCalibration:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('print:windows-cp1500-calibration:reset'\)/);
  assert.match(preload, /getWindowsCp1500GeometryDiagnostics:\s*\(options = \{\}\)\s*=>\s*ipcRenderer\.invoke\('print:windows-cp1500-geometry-diagnostics', options\)/);
  assert.match(preload, /preloadBridgeVersion:\s*'cp1500-geometry-diagnostics-v4'/);
  assert.match(main, /ipcMain\.handle\('print:windows-cp1500-calibration'/);
  assert.match(main, /ipcMain\.handle\('print:windows-cp1500-calibration:get'[\s\S]*return getWindowsCp1500Calibration\(\)/);
  assert.match(main, /ipcMain\.handle\('print:windows-cp1500-calibration:set'[\s\S]*return setWindowsCp1500Calibration\(calibration\)/);
  assert.match(main, /ipcMain\.handle\('print:windows-cp1500-calibration:reset'[\s\S]*return resetWindowsCp1500Calibration\(\)/);
  assert.match(main, /ipcMain\.handle\('print:windows-cp1500-geometry-diagnostics'[\s\S]*getWindowsCp1500GeometryDiagnostics\(\{/);
  assert.match(main, /print:windows-cp1500-calibration[\s\S]*submitSinglePrintCopy\(\{/);
  assert.match(main, /submitSinglePrintCopy[\s\S]*printUsingWindowsCp1500\(\{/);
  assert.ok(packageJson.build.files.includes('preload.cjs'));
  assert.ok(packageJson.build.files.includes('windowsPrintBackend.cjs'));
  assert.ok(packageJson.build.files.includes('printPipeline.cjs'));
});

test('CP1500 diagnostic scales remain numerically distinct at 300 DPI', () => {
  const pageWidth = 100 * 96 / 25.4;
  const pageHeight = 148 * 96 / 25.4;
  const at1005 = calculateCenteredContentRectangle({ sourceWidth: 1200, sourceHeight: 1800, pageWidth, pageHeight, scale: 1.005 });
  const at101 = calculateCenteredContentRectangle({ sourceWidth: 1200, sourceHeight: 1800, pageWidth, pageHeight, scale: 1.01 });
  const dipToMm = (value) => value * 25.4 / 96;
  const dipTo300Dpi = (value) => value * 300 / 96;

  assert.ok(Math.abs(dipToMm(at101.final.width - at1005.final.width) - 0.49333333333333335) < 1e-10);
  assert.ok(Math.abs(dipToMm(at101.final.height - at1005.final.height) - 0.74) < 1e-10);
  assert.ok(Math.abs(dipTo300Dpi(at101.final.width - at1005.final.width) - 5.826771653543307) < 1e-10);
  assert.ok(Math.abs(dipTo300Dpi(at101.final.height - at1005.final.height) - 8.740157480314961) < 1e-10);
});

test('CP1500 diagnostic source is a non-empty 1200x1800 valid PNG', () => {
  const png = createSolidDiagnosticPng(1200, 1800);
  assert.ok(png.length > 0);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 1800);
});

test('CP1500 geometry diagnostic is best-effort for partial Canon capabilities', () => {
  const script = buildWindowsCp1500PrintScript({
    printerName: 'Canon SELPHY CP1500',
    imagePath: 'C:\\Temp\\diagnostic.png',
    jobName: 'Read-only diagnostic',
    diagnosticOnly: true,
  });

  assert.match(script, /if \(\$DiagnosticOnly\) \{ Warn 'PageImageableArea unavailable from Canon driver' \}/);
  assert.match(script, /if \(\$DiagnosticOnly\) \{ Warn 'PageBorderless capability unavailable from Canon driver' \}/);
  assert.match(script, /Warn 'PageMediaSize dimensions unavailable from Canon driver'/);
  assert.match(script, /Warn 'Validated PageBorderless value unavailable or not Borderless'/);
  assert.match(script, /validatedScaling = EnumName \$ticket\.PageScaling/);
  assert.match(script, /if \(-not \$DiagnosticOnly\) \{[\s\S]*CreateXpsDocumentWriter/);
  assert.match(script, /stage = \$Stage/);
});

test('CP1500 geometry diagnostic IPC returns structured errors instead of rejecting', () => {
  const main = readFileSync(new URL('../electron.cjs', import.meta.url), 'utf8');
  const registrations = main.match(/ipcMain\.handle\('print:windows-cp1500-geometry-diagnostics'/g) || [];
  assert.equal(registrations.length, 1);
  assert.match(main, /\[WINDOWS CP1500 GEOMETRY DIAGNOSTIC ERROR\]/);
  assert.match(main, /return \{[\s\S]*ok: false,[\s\S]*submitted: false,[\s\S]*error: structuredError/);
});
