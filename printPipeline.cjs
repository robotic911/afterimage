const MICRONS_PER_INCH = 25400;
const WINDOWS_BORDERLESS_PREF_CACHE_MS = 5 * 60 * 1000;
const WINDOWS_SELPHY_CP1500_SCALE_FACTOR = 108;
const WINDOWS_SELPHY_CP1500_OVERSCAN_PERCENT = 0;
const ZERO_PHYSICAL_PRINT_MARGINS = Object.freeze({
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
});

const DEFAULT_ELECTRON_PRINT_PAGE = Object.freeze({
  id: 'default_4x6',
  platform: 'default',
  cssWidth: '4in',
  cssHeight: '6in',
  widthMicrons: 4 * MICRONS_PER_INCH,
  heightMicrons: 6 * MICRONS_PER_INCH,
  widthMm: 101.6,
  heightMm: 152.4,
  imageFit: 'fill',
  preferCSSPageSize: false,
  usePrinterDefaultPageSize: false,
  zeroMarginDocument: false,
  windowsCompensation: null,
});

const WINDOWS_SELPHY_CP1500_PRINT_PAGE = Object.freeze({
  id: 'canon_selphy_cp1500_windows_zero_margin_4x6',
  platform: 'win32',
  printerFamily: 'canon_selphy_cp1500',
  cssWidth: '4in',
  cssHeight: '6in',
  widthMicrons: 4 * MICRONS_PER_INCH,
  heightMicrons: 6 * MICRONS_PER_INCH,
  widthMm: 101.6,
  heightMm: 152.4,
  imageFit: 'fill',
  preferCSSPageSize: false,
  usePrinterDefaultPageSize: true,
  scaleFactor: WINDOWS_SELPHY_CP1500_SCALE_FACTOR,
  dpi: Object.freeze({ horizontal: 300, vertical: 300 }),
  zeroMarginDocument: true,
  applicationMargins: ZERO_PHYSICAL_PRINT_MARGINS,
  documentMargins: Object.freeze({
    page: 0,
    html: 0,
    body: 0,
    root: 0,
    image: 0,
  }),
  electronMargins: Object.freeze({ marginType: 'none' }),
  borderlessIntent: true,
  borderlessOverscanPercent: WINDOWS_SELPHY_CP1500_OVERSCAN_PERCENT,
  physicalPageLayer: 'windows_driver_native_4x6_borderless',
  windowsCompensation: 'Windows Canon SELPHY CP1500 must use the generated artwork as the source of truth, add zero software margin, and rely on the driver native 4x6/borderless media instead of shrinking into a custom Electron page.',
});

const WINDOWS_PHYSICAL_PRINT_ENTRY_POINTS = Object.freeze([
  Object.freeze({
    name: 'Customer Print Photos',
    renderer: 'PrintScreen -> window.printApi.printStrip',
    ipc: 'print-strip',
    mainHandler: 'ipcMain.handle(print-strip)',
    queue: 'runPrintJob',
    lowLevelHelper: 'submitSinglePrintCopy',
    artworkSource: 'final rendered JPEG data URL from generated artwork',
  }),
  Object.freeze({
    name: 'Print Another Copy / Today Monitor Reprint',
    renderer: 'TodayMonitor -> printExtraSessionCopy',
    ipc: 'today-monitor:print-extra-session-copy',
    mainHandler: 'ipcMain.handle(today-monitor:print-extra-session-copy)',
    queue: 'direct single copy',
    lowLevelHelper: 'submitSinglePrintCopy',
    artworkSource: 'saved session print image from local media metadata',
  }),
  Object.freeze({
    name: 'Keychain Print',
    renderer: 'TodayMonitor -> generateAndPrintKeychain',
    ipc: 'today-monitor:generate-and-print-keychain',
    mainHandler: 'ipcMain.handle(today-monitor:generate-and-print-keychain)',
    queue: 'direct single copy',
    lowLevelHelper: 'submitSinglePrintCopy',
    artworkSource: 'saved or newly generated 4x6 keychain PNG',
  }),
]);

function isSelphyPrinter(printer = {}) {
  const label = `${printer.name || ''} ${printer.displayName || ''} ${printer.description || ''}`.toLowerCase();
  return label.includes('canon selphy') || label.includes('selphy cp1500') || label.includes('cp1500') || label.includes('selphy');
}

function getCanonicalPrintPageConfig({ platform = process.platform, printer = null } = {}) {
  if (platform === 'win32' && isSelphyPrinter(printer || {})) {
    return WINDOWS_SELPHY_CP1500_PRINT_PAGE;
  }
  return DEFAULT_ELECTRON_PRINT_PAGE;
}

function buildCanonicalElectronPrintOptions(printPageConfig, { silent = false, printerName = null } = {}) {
  const options = {
    silent: silent === true,
    printBackground: true,
    copies: 1,
    margins: { marginType: 'none' },
    landscape: false,
    scaleFactor: printPageConfig.scaleFactor || 100,
  };
  if (printPageConfig.usePrinterDefaultPageSize) {
    options.usePrinterDefaultPageSize = true;
  } else {
    options.pageSize = {
      width: printPageConfig.widthMicrons,
      height: printPageConfig.heightMicrons,
    };
  }
  if (printPageConfig.dpi) {
    options.dpi = printPageConfig.dpi;
  }
  if (printPageConfig.preferCSSPageSize) {
    options.preferCSSPageSize = true;
  }
  if (printerName) {
    options.deviceName = printerName;
  }
  return options;
}

function isZeroElectronMargin(margins) {
  if (!margins || typeof margins !== 'object') return false;
  if (margins.marginType === 'none') return true;
  return margins.marginType === 'custom'
    && Number(margins.top) === 0
    && Number(margins.right) === 0
    && Number(margins.bottom) === 0
    && Number(margins.left) === 0;
}

function cssValueIsZero(value) {
  if (value == null || value === '') return true;
  const text = String(value).trim().toLowerCase();
  return text === '0' || text === '0px' || text === '0px 0px' || text === '0px 0px 0px 0px';
}

function marginsAreZero(margins = {}) {
  return Number(margins.top) === 0
    && Number(margins.right) === 0
    && Number(margins.bottom) === 0
    && Number(margins.left) === 0;
}

function validateWindowsPrintInvariants(printPageConfig, printOptions, {
  platform = process.platform,
  printer = null,
  printerName = null,
  readiness = null,
} = {}) {
  const applies = platform === 'win32' && printPageConfig?.id === WINDOWS_SELPHY_CP1500_PRINT_PAGE.id;
  if (!applies) {
    return {
      ok: true,
      skipped: true,
      reason: 'not_windows_cp1500_profile',
      platform,
      profileId: printPageConfig?.id || null,
    };
  }

  const violations = [];
  const warnings = [];
  const addViolation = (condition, message) => {
    if (condition) violations.push(message);
  };
  const addWarning = (condition, message) => {
    if (condition) warnings.push(message);
  };

  addViolation(!isSelphyPrinter(printer || { name: printerName }), 'selected printer is not recognized as Canon SELPHY/CP1500');
  addViolation(!printerName, 'missing deviceName/printerName');
  addViolation(printPageConfig.zeroMarginDocument !== true, 'Windows CP1500 print document must use the zero-margin template');
  addViolation(!marginsAreZero(printPageConfig.applicationMargins), 'Windows CP1500 application margins must be zero');
  addViolation(!isZeroElectronMargin(printOptions?.margins), 'Electron margins must be zero');
  addViolation(printOptions?.landscape !== false, 'Windows CP1500 4x6 print must use portrait orientation');
  addViolation(printOptions?.printBackground !== true, 'printBackground must be enabled');
  addViolation(printOptions?.scaleFactor !== WINDOWS_SELPHY_CP1500_SCALE_FACTOR, `Windows CP1500 scaleFactor must stay ${WINDOWS_SELPHY_CP1500_SCALE_FACTOR}`);
  addViolation(printPageConfig.borderlessOverscanPercent !== WINDOWS_SELPHY_CP1500_OVERSCAN_PERCENT, `Windows CP1500 overscan must stay ${WINDOWS_SELPHY_CP1500_OVERSCAN_PERCENT}`);
  addViolation(printPageConfig.imageFit !== 'fill', 'Windows CP1500 image fit must remain fill for the already-composed 4x6 artwork');
  addViolation(printPageConfig.cssWidth !== '4in' || printPageConfig.cssHeight !== '6in', 'Windows CP1500 CSS page size must remain 4in x 6in');
  addViolation(printPageConfig.widthMicrons !== 4 * MICRONS_PER_INCH || printPageConfig.heightMicrons !== 6 * MICRONS_PER_INCH, 'Windows CP1500 physical page must remain 4in x 6in');
  addViolation(printPageConfig.usePrinterDefaultPageSize !== true, 'Windows CP1500 must use the driver native/default 4x6 media');
  addViolation(Boolean(printOptions?.pageSize), 'Windows CP1500 print options must not pass a custom Electron pageSize');
  addViolation(printOptions?.usePrinterDefaultPageSize !== true, 'Windows CP1500 print options must request the printer default page size');

  if (readiness) {
    addViolation(!cssValueIsZero(readiness.bodyMargin), `print body margin is not zero: ${readiness.bodyMargin}`);
    addViolation(!cssValueIsZero(readiness.bodyPadding), `print body padding is not zero: ${readiness.bodyPadding}`);
    addViolation(!cssValueIsZero(readiness.rootMargin), `print root margin is not zero: ${readiness.rootMargin}`);
    addViolation(!cssValueIsZero(readiness.rootPadding), `print root padding is not zero: ${readiness.rootPadding}`);
    addWarning(Number(readiness.naturalWidth) <= 0 || Number(readiness.naturalHeight) <= 0, 'source artwork dimensions were not available');
    addWarning(Number(readiness.renderedWidth) <= 0 || Number(readiness.renderedHeight) <= 0, 'rendered artwork dimensions were not available');
  }

  return {
    ok: violations.length === 0,
    skipped: false,
    platform,
    profileId: printPageConfig.id,
    expectedScaleFactor: WINDOWS_SELPHY_CP1500_SCALE_FACTOR,
    expectedOverscanPercent: WINDOWS_SELPHY_CP1500_OVERSCAN_PERCENT,
    expectedMargins: ZERO_PHYSICAL_PRINT_MARGINS,
    violations,
    warnings,
  };
}

function buildWindowsPrintSnapshot({
  jobType = 'unknown',
  printerName = null,
  printer = null,
  printPageConfig = null,
  printOptions = null,
  readiness = null,
  printFit = null,
  windowsPrintPrep = null,
  invariantReport = null,
} = {}) {
  return {
    jobType,
    printer: printer?.name || printerName || null,
    deviceName: printOptions?.deviceName || printerName || null,
    profileId: printPageConfig?.id || null,
    sourceWidth: readiness?.naturalWidth ?? printFit?.sourceImage?.widthPx ?? null,
    sourceHeight: readiness?.naturalHeight ?? printFit?.sourceImage?.heightPx ?? null,
    pageWidth: printPageConfig?.cssWidth || null,
    pageHeight: printPageConfig?.cssHeight || null,
    pageWidthMm: printPageConfig?.widthMm || null,
    pageHeightMm: printPageConfig?.heightMm || null,
    cssPageMargin: printFit?.cssMargins?.page ?? 0,
    bodyMargin: readiness?.bodyMargin ?? null,
    bodyPadding: readiness?.bodyPadding ?? null,
    rootMargin: readiness?.rootMargin ?? null,
    rootPadding: readiness?.rootPadding ?? null,
    electronMargins: printOptions?.margins || null,
    scaleFactor: printOptions?.scaleFactor ?? null,
    overscan: printPageConfig?.borderlessOverscanPercent ?? null,
    usePrinterDefaultPageSize: printOptions?.usePrinterDefaultPageSize === true,
    electronPageSize: printOptions?.pageSize || null,
    borderlessProfile: {
      requested: printPageConfig?.borderlessIntent === true,
      supported: windowsPrintPrep?.borderlessSupported ?? null,
      selectedBefore: windowsPrintPrep?.borderlessSelectedBefore ?? null,
      selectedAfter: windowsPrintPrep?.borderlessSelectedAfter ?? null,
    },
    media: {
      selectedBefore: windowsPrintPrep?.mediaSelectedBefore ?? null,
      selectedAfter: windowsPrintPrep?.mediaSelectedAfter ?? null,
      selectedCandidate: windowsPrintPrep?.selectedMediaCandidate ?? null,
      reportedPageSize: printFit?.reportedPrinterPageSize || null,
      reportedPrintableArea: printFit?.reportedPrinterPrintableArea || null,
    },
    invariants: invariantReport || null,
  };
}

module.exports = {
  MICRONS_PER_INCH,
  WINDOWS_BORDERLESS_PREF_CACHE_MS,
  WINDOWS_SELPHY_CP1500_SCALE_FACTOR,
  WINDOWS_SELPHY_CP1500_OVERSCAN_PERCENT,
  ZERO_PHYSICAL_PRINT_MARGINS,
  DEFAULT_ELECTRON_PRINT_PAGE,
  WINDOWS_SELPHY_CP1500_PRINT_PAGE,
  WINDOWS_PHYSICAL_PRINT_ENTRY_POINTS,
  isSelphyPrinter,
  getCanonicalPrintPageConfig,
  buildCanonicalElectronPrintOptions,
  validateWindowsPrintInvariants,
  buildWindowsPrintSnapshot,
};
