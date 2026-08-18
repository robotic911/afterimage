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
  getCanonicalPrintPageConfig,
  validateWindowsPrintInvariants,
} = require('../printPipeline.cjs');

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
