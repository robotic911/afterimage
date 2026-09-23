const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const archivePath = path.resolve(process.argv[2] || 'release/win-unpacked/resources/app.asar');
if (!fs.existsSync(archivePath)) {
  throw new Error(`Windows app.asar not found: ${archivePath}`);
}

const required = {
  'preload.cjs': [
    'printWindowsCp1500Calibration',
    'setWindowsCp1500ContentCalibration',
    'getWindowsCp1500ContentCalibration',
    'resetWindowsCp1500ContentCalibration',
    'getWindowsCp1500GeometryDiagnostics',
    'cp1500-runtime-calibration-v3',
  ],
  'electron.cjs': ['print:windows-cp1500-calibration', 'print:windows-cp1500-geometry-diagnostics', 'app:build-info'],
  'windowsPrintBackend.cjs': ['Native Windows PrintTicket/XPS', 'PageBorderless', 'WINDOWS_CP1500_CALIBRATION', 'offsetXmm: 0', 'offsetYmm: 0', 'Stretch]::Uniform'],
  'printPipeline.cjs': ['native_windows_printticket_xps'],
};

for (const [filename, markers] of Object.entries(required)) {
  let source;
  try {
    source = asar.extractFile(archivePath, filename).toString('utf8');
  } catch {
    throw new Error(`Packaged Windows app is missing ${filename}`);
  }
  for (const marker of markers) {
    if (!source.includes(marker)) {
      throw new Error(`Packaged ${filename} is stale: missing ${marker}`);
    }
  }
}

console.log(JSON.stringify({
  ok: true,
  archivePath,
  archiveModifiedAt: fs.statSync(archivePath).mtime.toISOString(),
  preloadBridgeVersion: 'cp1500-runtime-calibration-v3',
  windowsPrintBackendId: 'native-windows-printticket-xps-v2',
  files: Object.keys(required),
}, null, 2));
