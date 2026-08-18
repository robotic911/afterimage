const { app, BrowserWindow, ipcMain, protocol, nativeImage, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { spawn, execFileSync } = require('child_process');
const {
  getKeychainPrice,
  isValidKeychainCopies,
} = require('./keychainPricing.cjs');
const {
  maybeInitializeFromPortableData,
} = require('./scripts/portable-data.cjs');

const APP_ID = 'com.kennethpatino.kukuphotobooth';
const SOFTCOPY_SAVE_CHANNEL = 'softcopy-local:save-session-media';
const SOFTCOPY_READ_CHANNEL = 'softcopy-local:read-saved-media-file';
const KEYCHAIN_SAVE_CHANNEL = 'keychain:save-4x6-to-downloads';
const mainProcessStartedAt = Date.now();
let localSoftcopyIpcRegistered = false;
let diagnosticsDir = null;

function getBundledResourceRoot() {
  return app.isPackaged ? process.resourcesPath : __dirname;
}

function getDiagnosticsDir() {
  if (diagnosticsDir) return diagnosticsDir;
  try {
    diagnosticsDir = path.join(app.getPath('userData'), 'diagnostics');
  } catch {
    diagnosticsDir = path.join(__dirname, 'diagnostics');
  }
  return diagnosticsDir;
}

function compactDiagnosticValue(value) {
  if (value == null) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

async function writeDiagnosticEvent(type, details = {}) {
  try {
    const dir = getDiagnosticsDir();
    await fsp.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `afterimage-${timestampForFilename(new Date())}.log`);
    const payload = {
      at: new Date().toISOString(),
      type,
      platform: process.platform,
      version: app.getVersion?.() || null,
      isPackaged: app.isPackaged,
      details: compactDiagnosticValue(details),
    };
    await fsp.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch (error) {
    console.warn('[diagnostics] failed to write event', error?.message || String(error));
  }
}

function safeAppPathValue(getter) {
  try {
    return getter();
  } catch {
    return null;
  }
}

function readMainGitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || null;
  } catch {
    return null;
  }
}

function getRuntimeDiagnostics() {
  return {
    productName: app.getName?.() || 'Afterimage',
    version: app.getVersion?.() || null,
    gitCommit: readMainGitCommit(),
    buildTimestamp: null,
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    defaultApp: process.defaultApp === true,
    cwd: process.cwd(),
    appPath: safeAppPathValue(() => app.getAppPath()),
    dirname: __dirname,
    resourcesPath: process.resourcesPath || null,
    execPath: process.execPath,
    userDataPath: safeAppPathValue(() => app.getPath('userData')),
    diagnosticsDir: getDiagnosticsDir(),
    mainProcessStartedAt: new Date(mainProcessStartedAt).toISOString(),
    argv: process.argv.slice(0, 8),
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
  };
}

console.log('[DIAG main] electron.cjs loaded with downloads test handler');

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}

if (process.env.AFTERIMAGE_USER_DATA_DIR) {
  const overrideUserDataDir = path.resolve(process.env.AFTERIMAGE_USER_DATA_DIR);
  fs.mkdirSync(overrideUserDataDir, { recursive: true });
  app.setPath('userData', overrideUserDataDir);
  console.log('[portable-data] using overridden userData directory', overrideUserDataDir);
}

process.on('uncaughtException', (error) => {
  console.error('[diagnostics] uncaught exception', error);
  writeDiagnosticEvent('main:uncaught-exception', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[diagnostics] unhandled rejection', reason);
  writeDiagnosticEvent('main:unhandled-rejection', reason);
});

app.on('render-process-gone', (_event, webContents, details) => {
  const owner = BrowserWindow.fromWebContents(webContents);
  console.error('[diagnostics] renderer process gone', details);
  writeDiagnosticEvent('electron:render-process-gone', {
    windowTitle: owner?.getTitle?.() || null,
    windowBounds: owner?.getBounds?.() || null,
    url: webContents?.getURL?.() || null,
    details,
  });
});

app.on('child-process-gone', (_event, details) => {
  console.error('[diagnostics] child process gone', details);
  writeDiagnosticEvent('electron:child-process-gone', details);
});

// ─────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────
//
// Everything the admin manages lives in Electron's per-machine userData
// folder so it persists across app updates and isn't overwritten by
// reinstalls. We don't call app.getPath('userData') at module load time
// because it's only reliable after app.ready, so these are lazy-resolved.

let templatesDir = null;
let templatesIndexFile = null;
let eventsDir = null;
let eventsIndexFile = null;
let settingsFile = null;
let adminFile    = null;
let sessionsFile = null;
let printsDir = null;
let mainWindow = null;
let todayMonitorWindow = null;

const DEFAULT_PRINTER_PROFILE_ID = 'selphy_cp1500';
const DEFAULT_SAFE_MARGIN_OVERRIDE = {
  top: 33,
  right: 33,
  bottom: 75,
  left: 33,
};
const DEFAULT_SOFTCOPY_SETTINGS = {
  qrEnabled: true,
  photoEnabled: true,
  gifEnabled: true,
  videoEnabled: true,
};
const DEFAULT_CAMERA_ORIENTATION = 'mirrored';
const CAMERA_ORIENTATIONS = new Set([DEFAULT_CAMERA_ORIENTATION, 'alternate']);
const LEGACY_SAFE_MARGIN_OVERRIDE = {
  top: 33,
  right: 33,
  bottom: 75,
  left: 33,
};
const LEGACY_LAYOUT_ID_ALIASES = {
  'big-duo-2': 'portrait-grid',
  'quad-grid-landscape': 'studio-quad',
};
const LAYOUT_IDS = ['classic-strip-4', 'classic-strip-3', 'portrait-grid', 'studio-quad'];
const DEFAULT_LAYOUT_SETTINGS = LAYOUT_IDS.reduce((settings, layoutId) => ({
  ...settings,
  [layoutId]: { enabled: true },
}), {});
const DEFAULT_BEAUTIFICATION_SETTINGS = Object.freeze({
  enabled: true,
  intensity: 35,
});
const COLOR_THEME_IDS = new Set(['editorialMono', 'champagneNoir', 'roseVelvet', 'oceanMist', 'forestFilm']);
let templateIndexCache = null;

function normalizeSessionCameraOrientation(value) {
  return CAMERA_ORIENTATIONS.has(value) ? value : DEFAULT_CAMERA_ORIENTATION;
}

function cloneTemplateRecords(records = []) {
  return records.map((record) => ({ ...record }));
}

function invalidateTemplateIndexCache() {
  templateIndexCache = null;
}

function readTemplateCountFromIndex(indexPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return getTemplateArray(parsed).length;
  } catch {
    return 0;
  }
}

function readTemplateRecordsFromIndex(indexPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return getTemplateArray(parsed)
      .map((record) => normalizeTemplateRecord(record))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getTemplateArray(indexData) {
  if (Array.isArray(indexData)) return indexData;
  if (Array.isArray(indexData?.templates)) return indexData.templates;
  if (Array.isArray(indexData?.items)) return indexData.items;
  if (Array.isArray(indexData?.records)) return indexData.records;
  return [];
}

function timestampForFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

async function backupTemplateIndexForAssetReplace(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const parsed = path.parse(filePath);
  let backupPath = path.join(
    parsed.dir,
    `${parsed.name}.backup-assetreplace-${timestampForFilename()}${parsed.ext || ''}`,
  );
  let counter = 1;
  while (fs.existsSync(backupPath)) {
    backupPath = path.join(
      parsed.dir,
      `${parsed.name}.backup-assetreplace-${timestampForFilename()}-${counter}${parsed.ext || ''}`,
    );
    counter += 1;
  }
  await fsp.copyFile(filePath, backupPath);
  return backupPath;
}

async function backupTemplateIndexForDedupe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const parsed = path.parse(filePath);
  let backupPath = path.join(
    parsed.dir,
    `${parsed.name}.backup-dedupe-${timestampForFilename()}${parsed.ext || ''}`,
  );
  let counter = 1;
  while (fs.existsSync(backupPath)) {
    backupPath = path.join(
      parsed.dir,
      `${parsed.name}.backup-dedupe-${timestampForFilename()}-${counter}${parsed.ext || ''}`,
    );
    counter += 1;
  }
  await fsp.copyFile(filePath, backupPath);
  return backupPath;
}

function getCurrentTemplateIndexPath() {
  return templatesIndexFile;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeSafeMarginOverride(margin = {}, profileId = DEFAULT_PRINTER_PROFILE_ID) {
  if (profileId !== 'selphy_cp1500') {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }

  const left = clamp(Number(margin.left) || 0, 0, 300);
  const right = clamp(Number(margin.right) || 0, 0, 300);
  const top = clamp(Number(margin.top) || 0, 0, 300);
  const bottom = clamp(Number(margin.bottom) || 0, 0, 300);

  return {
    left,
    right: clamp(right, 0, 1199 - left),
    top,
    bottom: clamp(bottom, 0, 1799 - top),
  };
}

function isLegacySafeMarginOverride(margin) {
  return Number(margin?.top) === LEGACY_SAFE_MARGIN_OVERRIDE.top
    && Number(margin?.right) === LEGACY_SAFE_MARGIN_OVERRIDE.right
    && Number(margin?.bottom) === LEGACY_SAFE_MARGIN_OVERRIDE.bottom
    && Number(margin?.left) === LEGACY_SAFE_MARGIN_OVERRIDE.left;
}

function normalizeBundledTemplateOverrides(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [id, value] of Object.entries(input)) {
    const migratedId = remapLegacyTemplateId(id);
    if (!/^[A-Za-z0-9_-]+$/.test(migratedId)) continue;
    if (!value || typeof value !== 'object') continue;
    const normalized = {};
    if (typeof value.enabled === 'boolean') normalized.enabled = value.enabled;
    if (typeof value.deleted === 'boolean') normalized.deleted = value.deleted;
    if (typeof value.type === 'string') normalized.type = value.type.trim().slice(0, 64) || 'Original';
    if (typeof value.name === 'string') normalized.name = value.name.trim().slice(0, 64);
    if (typeof value.desc === 'string') normalized.desc = value.desc.trim().slice(0, 256);
    if (Object.keys(normalized).length) out[migratedId] = normalized;
  }
  return out;
}

function normalizeSoftcopySettings(input = {}) {
  const settings = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    qrEnabled: settings.qrEnabled ?? DEFAULT_SOFTCOPY_SETTINGS.qrEnabled,
    photoEnabled: settings.photoEnabled ?? DEFAULT_SOFTCOPY_SETTINGS.photoEnabled,
    gifEnabled: settings.gifEnabled ?? DEFAULT_SOFTCOPY_SETTINGS.gifEnabled,
    videoEnabled: settings.videoEnabled ?? DEFAULT_SOFTCOPY_SETTINGS.videoEnabled,
  };
}

function normalizeBeautificationSettings(input = {}) {
  const settings = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const parsedIntensity = Number(settings.intensity);
  return {
    enabled: settings.enabled !== false,
    intensity: Number.isFinite(parsedIntensity)
      ? Math.min(100, Math.max(0, Math.round(parsedIntensity)))
      : DEFAULT_BEAUTIFICATION_SETTINGS.intensity,
  };
}

function normalizeLayoutSettings(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return LAYOUT_IDS.reduce((settings, layoutId) => {
    const saved = source[layoutId];
    const savedObject = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    return {
      ...settings,
      [layoutId]: {
        enabled: savedObject.enabled ?? DEFAULT_LAYOUT_SETTINGS[layoutId].enabled,
      },
    };
  }, {});
}

function normalizeEventDate(value = '') {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (!raw) return '';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeLayoutId(layoutId) {
  return LEGACY_LAYOUT_ID_ALIASES[layoutId] || layoutId || null;
}

function remapLegacyTemplateId(id) {
  if (typeof id !== 'string') return id;
  for (const [oldId, nextId] of Object.entries(LEGACY_LAYOUT_ID_ALIASES)) {
    if (id === oldId || id.startsWith(`${oldId}-`)) {
      return `${nextId}${id.slice(oldId.length)}`;
    }
  }
  return id;
}

function normalizeTemplateRecord(record = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const id = typeof record.id === 'string' ? record.id.trim().slice(0, 128) : '';
  if (!id) return null;

  const mode = record.mode === 'event' ? 'event' : 'daily';
  const rawLayoutId = typeof record.layoutId === 'string' && record.layoutId.trim()
    ? record.layoutId.trim().slice(0, 128)
    : null;
  const layoutId = rawLayoutId ? normalizeLayoutId(rawLayoutId) : null;
  const createdAt = typeof record.createdAt === 'string' && record.createdAt
    ? record.createdAt
    : new Date().toISOString();
  const updatedAt = typeof record.updatedAt === 'string' && record.updatedAt
    ? record.updatedAt
    : createdAt;

  return {
    ...record,
    id,
    layoutId,
    mode,
    eventId: mode === 'event'
      ? (typeof record.eventId === 'string' && record.eventId.trim()
        ? record.eventId.trim().slice(0, 128)
        : null)
      : null,
    name: typeof record.name === 'string' && record.name.trim()
      ? record.name.trim().slice(0, 64)
      : 'Untitled',
    type: typeof record.type === 'string' && record.type.trim()
      ? record.type.trim().slice(0, 64)
      : 'Uncategorized',
    desc: typeof record.desc === 'string' ? record.desc.trim().slice(0, 256) : '',
    enabled: record.enabled ?? true,
    createdAt,
    updatedAt,
    storageMode: record.storageMode === 'legacy' ? 'legacy' : record.storageMode,
  };
}

function normalizeTemplateNameForDuplicates(value = '') {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function getTemplateDuplicateKey(record = {}) {
  const layoutId = record?.layoutId || '';
  const normalizedName = normalizeTemplateNameForDuplicates(record?.name || '');
  return `${layoutId}::${normalizedName}`;
}

function isBuiltInTemplateRecord(record = {}) {
  return record?.storageSource === 'bundled' || record?.source === 'bundled';
}

function parseTemplateTimestamp(record = {}) {
  const candidates = [record.updatedAt, record.createdAt];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function getTemplateAssetReport(record = {}) {
  const dir = getTemplateDir(record);
  const legacyFile = path.join(dir, 'template.png');
  const overlayFile = path.join(dir, 'overlay.png');
  const previewFile = path.join(dir, 'preview.png');
  const getSize = (filePath) => {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  };
  const overlayExists = fs.existsSync(overlayFile);
  const previewExists = fs.existsSync(previewFile);
  const legacyTemplateExists = fs.existsSync(legacyFile);
  return {
    directory: dir,
    overlayExists,
    previewExists,
    legacyTemplateExists,
    overlaySize: getSize(overlayFile),
    previewSize: getSize(previewFile),
    legacyTemplateSize: getSize(legacyFile),
    overlayUsable: overlayExists || legacyTemplateExists,
    previewUsable: previewExists || legacyTemplateExists,
    bothUsable: (overlayExists || legacyTemplateExists) && (previewExists || legacyTemplateExists),
    anyExists: overlayExists || previewExists || legacyTemplateExists,
  };
}

function getTemplateAssetQualityScore(record = {}) {
  const report = getTemplateAssetReport(record);
  if (report.bothUsable) return 3;
  if (report.previewUsable || report.overlayUsable) return 2;
  if (report.anyExists) return 1;
  return 0;
}

function getTemplateSourceRank(record = {}) {
  if (record?.storageSource === 'current') return 3;
  if (record?.storageSource === 'legacy' || record?.storageMode === 'legacy') return 2;
  if (record?.storageSource === 'bundled' || record?.source === 'bundled') return 1;
  return 0;
}

function chooseDuplicateTemplateWinner(existing, incoming) {
  const existingBuiltIn = isBuiltInTemplateRecord(existing);
  const incomingBuiltIn = isBuiltInTemplateRecord(incoming);
  if (existingBuiltIn !== incomingBuiltIn) {
    return existingBuiltIn ? incoming : existing;
  }

  const existingSourceRank = getTemplateSourceRank(existing);
  const incomingSourceRank = getTemplateSourceRank(incoming);
  if (existingSourceRank !== incomingSourceRank) {
    return incomingSourceRank > existingSourceRank ? incoming : existing;
  }

  const existingAssetScore = getTemplateAssetQualityScore(existing);
  const incomingAssetScore = getTemplateAssetQualityScore(incoming);
  if (existingAssetScore !== incomingAssetScore) {
    return incomingAssetScore > existingAssetScore ? incoming : existing;
  }

  const existingEnabled = existing?.enabled !== false;
  const incomingEnabled = incoming?.enabled !== false;
  if (existingEnabled !== incomingEnabled) {
    return incomingEnabled ? incoming : existing;
  }

  const existingHidden = existing?.hidden === true || existing?.deleted === true;
  const incomingHidden = incoming?.hidden === true || incoming?.deleted === true;
  if (existingHidden !== incomingHidden) {
    return incomingHidden ? existing : incoming;
  }

  const existingTime = parseTemplateTimestamp(existing);
  const incomingTime = parseTemplateTimestamp(incoming);
  if (existingTime !== null || incomingTime !== null) {
    const existingScore = existingTime ?? Number.NEGATIVE_INFINITY;
    const incomingScore = incomingTime ?? Number.NEGATIVE_INFINITY;
    if (incomingScore !== existingScore) {
      return incomingScore > existingScore ? incoming : existing;
    }
  }

  const existingCreated = typeof existing?.createdAt === 'string' ? Date.parse(existing.createdAt) : null;
  const incomingCreated = typeof incoming?.createdAt === 'string' ? Date.parse(incoming.createdAt) : null;
  if ((existingCreated !== null && !Number.isNaN(existingCreated)) || (incomingCreated !== null && !Number.isNaN(incomingCreated))) {
    const existingCreatedScore = Number.isNaN(existingCreated) || existingCreated === null ? Number.NEGATIVE_INFINITY : existingCreated;
    const incomingCreatedScore = Number.isNaN(incomingCreated) || incomingCreated === null ? Number.NEGATIVE_INFINITY : incomingCreated;
    if (incomingCreatedScore !== existingCreatedScore) {
      return incomingCreatedScore > existingCreatedScore ? incoming : existing;
    }
  }

  return existing;
}

function buildDuplicateTemplateGroups(records = []) {
  const groups = new Map();
  records.forEach((record, index) => {
    if (!record?.id) return;
    const key = getTemplateDuplicateKey(record);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push({ ...record, _index: index });
  });

  return [...groups.entries()]
    .filter(([, groupRecords]) => groupRecords.length > 1)
    .map(([key, groupRecords]) => {
      const [layoutId = '', normalizedName = ''] = key.split('::');
      let winner = groupRecords[0];
      for (let i = 1; i < groupRecords.length; i += 1) {
        winner = chooseDuplicateTemplateWinner(winner, groupRecords[i]);
      }
      const removeTemplateIds = groupRecords
        .filter((record) => record.id !== winner.id)
        .map((record) => record.id);
      return {
        layoutId,
        normalizedName,
        displayName: winner.name || groupRecords[0]?.name || '',
        keepTemplateId: winner.id,
        removeTemplateIds,
        templates: groupRecords.map((record) => ({
          id: record.id,
          name: record.name,
          layoutId: record.layoutId || null,
          mode: record.mode || 'daily',
          eventId: record.eventId || null,
          enabled: record.enabled !== false,
          hidden: record.hidden === true || record.deleted === true,
          createdAt: record.createdAt || null,
          updatedAt: record.updatedAt || null,
          previewSrc: record.previewSrc || null,
          overlaySrc: record.overlaySrc || null,
          source: record.storageSource || record.source || 'current',
          isBuiltIn: isBuiltInTemplateRecord(record),
          storageSource: record.storageSource || null,
          assetExists: getTemplateAssetReport(record),
        })),
      };
    });
}

async function copyDuplicateAssetIfMissing(winner, duplicate, fileName) {
  const winnerDir = getTemplateDir(winner);
  const duplicateDir = getTemplateDir(duplicate);
  const winnerPath = path.join(winnerDir, fileName);
  if (fs.existsSync(winnerPath)) return false;

  const candidates = [
    path.join(duplicateDir, fileName),
    path.join(duplicateDir, 'template.png'),
  ];
  const sourcePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!sourcePath) return false;

  await fsp.mkdir(winnerDir, { recursive: true });
  await fsp.copyFile(sourcePath, winnerPath);
  return true;
}

async function buildCleanedTemplateRecords(records = []) {
  const groups = buildDuplicateTemplateGroups(records);
  const duplicateKeys = new Set(groups.map((group) => `${group.layoutId}::${group.normalizedName}`));
  const winnerByKey = new Map(groups.map((group) => [`${group.layoutId}::${group.normalizedName}`, group.keepTemplateId]));
  const cleaned = [];
  const skipped = [];
  const seenKeys = new Set();
  const keptTemplateIds = [];
  const removedTemplateIds = [];
  let copiedAssetFieldsCount = 0;

  for (const record of records) {
    const key = getTemplateDuplicateKey(record);
    if (!duplicateKeys.has(key)) {
      cleaned.push(record);
      keptTemplateIds.push(record.id);
      continue;
    }
    const group = groups.find((item) => `${item.layoutId}::${item.normalizedName}` === key);
    if (!group) {
      cleaned.push(record);
      keptTemplateIds.push(record.id);
      continue;
    }
    if (record.id === winnerByKey.get(key)) {
      if (!seenKeys.has(key)) {
        const winner = { ...record };
        const duplicateRecords = records.filter((candidate) =>
          candidate.id !== winner.id && getTemplateDuplicateKey(candidate) === key
        );
        for (const duplicate of duplicateRecords) {
          if (await copyDuplicateAssetIfMissing(winner, duplicate, 'preview.png')) {
            copiedAssetFieldsCount += 1;
          }
          if (await copyDuplicateAssetIfMissing(winner, duplicate, 'overlay.png')) {
            copiedAssetFieldsCount += 1;
          }
        }
        cleaned.push(winner);
        keptTemplateIds.push(winner.id);
        seenKeys.add(key);
      }
    } else {
      skipped.push(record);
      removedTemplateIds.push(record.id);
    }
  }

  return {
    cleaned,
    groups,
    removedCount: skipped.length,
    keptCount: cleaned.length,
    copiedAssetFieldsCount,
    removedTemplateIds,
    keptTemplateIds,
  };
}

function stripTransientTemplateFields(record = {}) {
  const {
    storageSource,
    templateSourcePath,
    ...rest
  } = record || {};
  return rest;
}

function collectTemplateSourceSummary() {
  const currentIndexPath = getCurrentTemplateIndexPath();
  const currentRecords = readTemplateRecordsFromIndex(currentIndexPath);
  return {
    currentRuntimeCount: currentRecords.length,
    legacyCount: 0,
    mergedRuntimeCount: currentRecords.length,
    finalCount: currentRecords.length,
  };
}

function resolvePaths() {
  if (templatesDir) return;
  const base = app.getPath('userData');
  templatesDir = path.join(base, 'templates');
  templatesIndexFile = path.join(templatesDir, 'index.json');
  eventsDir = path.join(base, 'events');
  eventsIndexFile = path.join(eventsDir, 'index.json');
  settingsFile = path.join(base, 'settings.json');
  adminFile    = path.join(base, 'admin.json');
  sessionsFile = path.join(base, 'sessions.jsonl');
  printsDir = app.getPath('downloads');
}

// ─────────────────────────────────────────────────────────────────────────
// Custom protocol — kuku-template://
// ─────────────────────────────────────────────────────────────────────────
//
// Renderer uses <img src="kuku-template://<id>"> to load template PNGs
// from userData without running into CORS / file:// restrictions. We
// must declare the scheme as privileged BEFORE app.ready, then attach
// the actual handler inside the ready callback.

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kuku-template',
    privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, corsEnabled: true },
  },
  {
    scheme: 'kuku-event',
    privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, corsEnabled: true },
  },
]);

// ─────────────────────────────────────────────────────────────────────────
// App boot
// ─────────────────────────────────────────────────────────────────────────

// In dev (`npm start`) we load Vite's dev server so hot-reload works.
// In a packaged build `app.isPackaged` is true and Vite isn't running — we
// load the static bundle from `dist/index.html` that `vite build` produced.
// An explicit VITE_DEV_SERVER_URL env var lets us override either way.
function resolveAppEntry() {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) return { kind: 'url', target: devUrl };
  if (!app.isPackaged) return { kind: 'url', target: 'http://localhost:5173' };
  return { kind: 'file', target: path.join(__dirname, 'dist', 'index.html') };
}

function buildRendererUrl(entry, windowType = null) {
  const suffix = windowType ? `${entry.target.includes('?') ? '&' : '?'}window=${encodeURIComponent(windowType)}` : '';
  if (entry.kind === 'url') {
    return `${entry.target}${suffix}`;
  }
  return `${pathToFileURL(entry.target).toString()}${suffix}`;
}

function buildLocalAssetHeaders(contentType) {
  return {
    'Content-Type': contentType || 'application/octet-stream',
    'Cache-Control': 'no-store, max-age=0',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
}

function loadRendererWindow(win, windowType = null) {
  const entry = resolveAppEntry();
  const target = buildRendererUrl(entry, windowType);
  return win.loadURL(target);
}

function attachWindowDiagnostics(win, label) {
  const createdAt = Date.now();
  win.webContents.once('did-finish-load', () => {
    const payload = {
      label,
      sinceMainStartMs: Date.now() - mainProcessStartedAt,
      loadMs: Date.now() - createdAt,
      url: win.webContents.getURL(),
    };
    console.log('[perf] renderer ready', payload);
    writeDiagnosticEvent('perf:renderer-ready', payload);
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[diagnostics] renderer load failed', {
      label,
      errorCode,
      errorDescription,
      validatedURL,
    });
    writeDiagnosticEvent('renderer:did-fail-load', {
      label,
      errorCode,
      errorDescription,
      validatedURL,
    });
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    writeDiagnosticEvent('window:render-process-gone', {
      label,
      title: win.getTitle(),
      bounds: win.getBounds(),
      url: win.webContents.getURL(),
      details,
    });
  });

  win.on('unresponsive', () => {
    console.warn('[diagnostics] window unresponsive', { label });
    writeDiagnosticEvent('window:unresponsive', {
      label,
      title: win.getTitle(),
      bounds: win.getBounds(),
      url: win.webContents.getURL(),
    });
  });

  win.on('responsive', () => {
    writeDiagnosticEvent('window:responsive', {
      label,
      title: win.getTitle(),
    });
  });
}

function configureMediaPermissions() {
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
      return;
    }
    callback(false);
  });
  defaultSession.setPermissionCheckHandler((_webContents, permission) => (
    permission === 'media'
  ));
}

function broadcastToAllWindows(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send(channel, payload);
      } catch {
        // Renderer may already be gone.
      }
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('close', () => {
    if (todayMonitorWindow && !todayMonitorWindow.isDestroyed()) {
      todayMonitorWindow.destroy();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  attachWindowDiagnostics(mainWindow, 'main');

  loadRendererWindow(mainWindow);
  return mainWindow;
}

function createTodayMonitorWindow() {
  const parentBounds = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : { x: 80, y: 80, width: 1200, height: 800 };
  const display = screen.getPrimaryDisplay();
  const workArea = display?.workArea || { x: 0, y: 0, width: 1600, height: 900 };
  const monitorWidth = 420;
  const monitorHeight = 620;
  const nextX = parentBounds.x + parentBounds.width + 16;
  const nextY = parentBounds.y + 24;
  const todayMonitorPreloadPath = path.join(__dirname, 'preload.cjs');
  console.log('[today-monitor window] preload config', {
    preload: todayMonitorPreloadPath,
    contextIsolation: true,
    nodeIntegration: false,
  });
  todayMonitorWindow = new BrowserWindow({
    width: monitorWidth,
    height: monitorHeight,
    x: Math.min(Math.max(workArea.x + 16, nextX), workArea.x + workArea.width - monitorWidth - 16),
    y: Math.min(Math.max(workArea.y + 16, nextY), workArea.y + workArea.height - monitorHeight - 16),
    title: 'Afterimage Today Monitor',
    resizable: true,
    alwaysOnTop: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: todayMonitorPreloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  todayMonitorWindow.on('close', (event) => {
    if (app.isQuitting) return;
    event.preventDefault();
    try {
      todayMonitorWindow.webContents.send('monitor:exit-request');
    } catch {}
  });
  todayMonitorWindow.on('closed', () => {
    todayMonitorWindow = null;
  });
  attachWindowDiagnostics(todayMonitorWindow, 'today-monitor');

  loadRendererWindow(todayMonitorWindow, 'today-monitor');
  console.log('[monitor] today monitor window created');
  return todayMonitorWindow;
}

function scheduleTodayMonitorWindow() {
  let scheduled = false;
  const openMonitor = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      if (app.isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
      if (todayMonitorWindow && !todayMonitorWindow.isDestroyed()) return;
      createTodayMonitorWindow();
    }, 2000);
  };

  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.once('did-finish-load', openMonitor);
  mainWindow.webContents.once('did-fail-load', openMonitor);
}

app.whenReady().then(async () => {
  console.log('[perf] electron ready', {
    readyMs: Date.now() - mainProcessStartedAt,
    platform: process.platform,
    isPackaged: app.isPackaged,
  });
  resolvePaths();
  await maybeInitializeFromPortableData({
    projectRoot: getBundledResourceRoot(),
    userDataDir: app.getPath('userData'),
    logger: console,
  });
  configureMediaPermissions();

  // Bootstrap filesystem
  await fsp.mkdir(templatesDir, { recursive: true });
  await fsp.mkdir(eventsDir, { recursive: true });
  await ensureTemplatesIndex();
  await ensureEventsIndex();
  await ensureSettingsFile();
  await ensureAdminFile();

  // Protocol handler — serves overlay / preview images from
  // userData/templates/<layout-id>/<id>/ for custom templates.
  protocol.handle('kuku-template', async (req) => {
    try {
      const url = new URL(req.url);
      const id = url.hostname || url.pathname.replace(/^\//, '').split('/')[0];
      const requestedName = path.basename(url.pathname || '') || 'overlay.png';
      if (!/^[A-Za-z0-9_-]+$/.test(id || '')) {
        return new Response('bad id', { status: 400 });
      }
      const records = await readTemplatesIndex();
      const record = records.find((template) => template.id === id);
      if (!record) return new Response('not found', { status: 404 });
      const filePath = resolveTemplateAssetPath(record, requestedName);
      const data = await fsp.readFile(filePath);
      return new Response(data, {
        headers: buildLocalAssetHeaders('image/png'),
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  protocol.handle('kuku-event', async (req) => {
    try {
      const url = new URL(req.url);
      const id = url.hostname || url.pathname.replace(/^\//, '').split('/')[0];
      const requestedName = path.basename(url.pathname || '') || '';
      if (!/^[A-Za-z0-9_-]+$/.test(id || '')) {
        return new Response('bad id', { status: 400 });
      }
      if (!/^landing-background\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i.test(requestedName)) {
        return new Response('bad asset', { status: 400 });
      }
      const filePath = path.join(eventsDir, id, requestedName);
      const data = await fsp.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const contentType = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime',
      }[ext] || 'application/octet-stream';
      return new Response(data, { headers: buildLocalAssetHeaders(contentType) });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  createWindow();
  scheduleTodayMonitorWindow();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─────────────────────────────────────────────────────────────────────────
// Template index / legacy migration
// ─────────────────────────────────────────────────────────────────────────

const LAYOUT_DIMENSIONS = {
  'classic-strip-4': { w: 1200, h: 1800, name: 'Classic Strip' },
  'classic-strip-3': { w: 1200, h: 1800, name: 'Mini Strip' },
  'portrait-grid': { w: 1200, h: 1800, name: 'Portrait Grid' },
  'studio-quad': { w: 1200, h: 1800, name: 'Studio Quad' },
};

const MIN_COUNTDOWN_SECONDS = 1;
const MAX_COUNTDOWN_SECONDS = 20;
const DEFAULT_COUNTDOWN_SECONDS = 3;

function normalizeCountdownSeconds(value, fallback = DEFAULT_COUNTDOWN_SECONDS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    const safeFallback = Number(fallback) || DEFAULT_COUNTDOWN_SECONDS;
    return Math.min(MAX_COUNTDOWN_SECONDS, Math.max(MIN_COUNTDOWN_SECONDS, safeFallback));
  }
  return Math.min(MAX_COUNTDOWN_SECONDS, Math.max(MIN_COUNTDOWN_SECONDS, Math.round(parsed)));
}

async function ensureTemplatesIndex() {
  if (fs.existsSync(templatesIndexFile)) return;
  await fsp.writeFile(templatesIndexFile, JSON.stringify({ templates: [] }, null, 2));
  invalidateTemplateIndexCache();
}

async function ensureEventsIndex() {
  if (fs.existsSync(eventsIndexFile)) return;
  await fsp.writeFile(eventsIndexFile, JSON.stringify({ events: [] }, null, 2));
}

async function ensureSettingsFile() {
  if (fs.existsSync(settingsFile)) return;
  await fsp.writeFile(settingsFile, JSON.stringify({
    mode: 'daily',
    activeEventId: null,
    printEnabled: true,
    printCopiesEnabled: false,
    selectedPrinterName: null,
    printerProfileId: DEFAULT_PRINTER_PROFILE_ID,
    safeMarginOverride: DEFAULT_SAFE_MARGIN_OVERRIDE,
    softcopySettings: DEFAULT_SOFTCOPY_SETTINGS,
    layoutSettings: DEFAULT_LAYOUT_SETTINGS,
    bundledTemplateOverrides: {},
    countdownSeconds: DEFAULT_COUNTDOWN_SECONDS,
    beautificationSettings: DEFAULT_BEAUTIFICATION_SETTINGS,
    testModeEnabled: false,
  }, null, 2));
}

async function readTemplatesIndex() {
  await ensureTemplatesIndex();
  const currentIndexPath = getCurrentTemplateIndexPath();
  const currentStats = fs.existsSync(currentIndexPath) ? fs.statSync(currentIndexPath) : null;
  if (
    templateIndexCache
    && templateIndexCache.path === currentIndexPath
    && templateIndexCache.mtimeMs === currentStats?.mtimeMs
    && templateIndexCache.size === currentStats?.size
  ) {
    return cloneTemplateRecords(templateIndexCache.records);
  }

  const currentRecords = readTemplateRecordsFromIndex(currentIndexPath).map((record) => ({
    ...record,
    storageSource: 'current',
    templateSourcePath: currentIndexPath,
  }));
  console.log('[templates] final template source summary', {
    currentRuntimeCount: currentRecords.length,
    legacyCount: 0,
    mergedRuntimeCount: currentRecords.length,
    finalCount: currentRecords.length,
  });
  const latestStats = fs.existsSync(currentIndexPath) ? fs.statSync(currentIndexPath) : currentStats;
  templateIndexCache = {
    path: currentIndexPath,
    mtimeMs: latestStats?.mtimeMs ?? null,
    size: latestStats?.size ?? null,
    records: cloneTemplateRecords(currentRecords),
  };
  return cloneTemplateRecords(currentRecords);
}

async function readEventsIndex() {
  await ensureEventsIndex();
  const raw = await fsp.readFile(eventsIndexFile, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed?.events) ? parsed.events : [];
}

async function readSettings() {
  await ensureSettingsFile();
  const raw = await fsp.readFile(settingsFile, 'utf8');
  const parsed = JSON.parse(raw);
  const printerProfileId = parsed?.printerProfileId === 'dnp_4x6' ? 'dnp_4x6' : DEFAULT_PRINTER_PROFILE_ID;
  const rawSafeMargin = isLegacySafeMarginOverride(parsed?.safeMarginOverride)
    ? DEFAULT_SAFE_MARGIN_OVERRIDE
    : (parsed?.safeMarginOverride ?? DEFAULT_SAFE_MARGIN_OVERRIDE);
  return {
    mode: parsed?.mode === 'event' ? 'event' : 'daily',
    activeEventId: typeof parsed?.activeEventId === 'string' && parsed.activeEventId.trim()
      ? parsed.activeEventId.trim()
      : null,
    printEnabled: parsed?.printEnabled !== false,
    printCopiesEnabled: parsed?.printCopiesEnabled === true,
    selectedPrinterName: typeof parsed?.selectedPrinterName === 'string' && parsed.selectedPrinterName.trim()
      ? parsed.selectedPrinterName.trim()
      : null,
    testModeEnabled: parsed?.testModeEnabled === true,
    printerProfileId,
    safeMarginOverride: normalizeSafeMarginOverride(
      rawSafeMargin,
      printerProfileId,
    ),
    softcopySettings: normalizeSoftcopySettings(parsed?.softcopySettings),
    layoutSettings: normalizeLayoutSettings(parsed?.layoutSettings),
    bundledTemplateOverrides: normalizeBundledTemplateOverrides(parsed?.bundledTemplateOverrides),
    countdownSeconds: normalizeCountdownSeconds(parsed?.countdownSeconds),
    beautificationSettings: normalizeBeautificationSettings(parsed?.beautificationSettings),
  };
}

async function writeTemplatesIndex(records) {
  const normalized = records
    .map((record) => stripTransientTemplateFields(record))
    .map((record) => normalizeTemplateRecord(record))
    .filter(Boolean)
    .map((record) => ({ ...record, ...buildTemplateUrls(record) }));
  await fsp.writeFile(templatesIndexFile, JSON.stringify({ templates: normalized }, null, 2));
  invalidateTemplateIndexCache();
}

function getTemplateIndexSummary(indexPath) {
  const exists = fs.existsSync(indexPath);
  const stats = exists ? fs.statSync(indexPath) : null;
  const count = readTemplateCountFromIndex(indexPath);
  return {
    path: indexPath,
    exists,
    count,
    size: stats?.size ?? 0,
    mtimeMs: stats?.mtimeMs ?? null,
  };
}

async function writeEventsIndex(records) {
  await fsp.writeFile(eventsIndexFile, JSON.stringify({ events: records }, null, 2));
}

async function writeSettings(settings) {
  const normalized = {
    mode: settings?.mode === 'event' ? 'event' : 'daily',
    activeEventId: typeof settings?.activeEventId === 'string' && settings.activeEventId.trim()
      ? settings.activeEventId.trim()
      : null,
    printEnabled: settings?.printEnabled !== false,
    printCopiesEnabled: settings?.printCopiesEnabled === true,
    selectedPrinterName: typeof settings?.selectedPrinterName === 'string' && settings.selectedPrinterName.trim()
      ? settings.selectedPrinterName.trim()
      : null,
    testModeEnabled: settings?.testModeEnabled === true,
    printerProfileId: settings?.printerProfileId === 'dnp_4x6' ? 'dnp_4x6' : DEFAULT_PRINTER_PROFILE_ID,
    safeMarginOverride: normalizeSafeMarginOverride(
      settings?.safeMarginOverride ?? DEFAULT_SAFE_MARGIN_OVERRIDE,
      settings?.printerProfileId === 'dnp_4x6' ? 'dnp_4x6' : DEFAULT_PRINTER_PROFILE_ID,
    ),
    softcopySettings: normalizeSoftcopySettings(settings?.softcopySettings),
    layoutSettings: normalizeLayoutSettings(settings?.layoutSettings),
    bundledTemplateOverrides: normalizeBundledTemplateOverrides(settings?.bundledTemplateOverrides),
    countdownSeconds: normalizeCountdownSeconds(settings?.countdownSeconds),
    beautificationSettings: normalizeBeautificationSettings(settings?.beautificationSettings),
  };
  await fsp.writeFile(settingsFile, JSON.stringify(normalized, null, 2));
  console.log('[settings] saved', { group: 'appSettings', settings: normalized });
}

// ─────────────────────────────────────────────────────────────────────────
// Admin PIN
// ─────────────────────────────────────────────────────────────────────────
//
// Stored as a salted SHA-256 hash in userData/admin.json. Default PIN
// on first boot is 0997.

const DEFAULT_PIN = '0997';

function hashPin(pin, salt) {
  return crypto.createHash('sha256').update(salt + ':' + pin).digest('hex');
}

async function ensureAdminFile() {
  if (fs.existsSync(adminFile)) return;
  const salt = crypto.randomBytes(16).toString('hex');
  const record = { salt, hash: hashPin(DEFAULT_PIN, salt), updatedAt: new Date().toISOString() };
  await fsp.writeFile(adminFile, JSON.stringify(record, null, 2));
}

async function readAdmin() {
  const raw = await fsp.readFile(adminFile, 'utf8');
  return JSON.parse(raw);
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function newTemplateId() {
  return crypto.randomBytes(4).toString('hex');
}

function sanitizePatch(patch = {}) {
  const out = {};
  if (typeof patch.layoutId === 'string') out.layoutId = normalizeLayoutId(patch.layoutId.trim().slice(0, 64));
  if (typeof patch.name    === 'string') out.name    = patch.name.trim().slice(0, 64);
  if (typeof patch.type    === 'string') out.type    = patch.type.trim().slice(0, 64) || 'Uncategorized';
  if (typeof patch.mode    === 'string') out.mode    = patch.mode === 'event' ? 'event' : 'daily';
  if (typeof patch.eventId === 'string') out.eventId = patch.eventId.trim().slice(0, 128) || null;
  if (patch.eventId === null) out.eventId = null;
  if (typeof patch.desc    === 'string') out.desc    = patch.desc.trim().slice(0, 256);
  if (typeof patch.enabled === 'boolean') out.enabled = patch.enabled;
  return out;
}

function slugifyTemplateName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function makeTemplateId(layoutId, name, existingIds = new Set()) {
  const base = `${layoutId}-${slugifyTemplateName(name) || 'template'}`;
  let id = base;
  let counter = 2;
  while (existingIds.has(id)) {
    id = `${base}-${counter}`;
    counter += 1;
  }
  return id;
}

function getLayoutDimensions(layoutId) {
  return LAYOUT_DIMENSIONS[normalizeLayoutId(layoutId)] || null;
}

function getTemplateDir(record) {
  if (record?.storageSource === 'legacy' || record?.storageMode === 'legacy' || !record?.layoutId) {
    return path.join(templatesDir, record.id);
  }
  return path.join(templatesDir, record.layoutId, record.id);
}

function buildTemplateUrls(record) {
  if (record?.storageSource === 'bundled' || record?.source === 'bundled') {
    return {
      src: record.src || record.overlaySrc || null,
      previewSrc: record.previewSrc || null,
      overlaySrc: record.overlaySrc || record.src || null,
      backgroundSrc: record.backgroundSrc || record.src || null,
    };
  }
  if (record?.storageSource === 'legacy' || record?.storageMode === 'legacy' || !record?.layoutId) {
    const legacySrc = `kuku-template://${record.id}/template.png`;
    return {
      src: legacySrc,
      previewSrc: fs.existsSync(path.join(getTemplateDir(record), 'preview.png'))
        ? `kuku-template://${record.id}/preview.png`
        : null,
      overlaySrc: legacySrc,
      backgroundSrc: legacySrc,
    };
  }
  const overlaySrc = `kuku-template://${record.id}/overlay.png`;
  return {
    src: overlaySrc,
    previewSrc: fs.existsSync(path.join(getTemplateDir(record), 'preview.png'))
      ? `kuku-template://${record.id}/preview.png`
      : null,
    overlaySrc,
    backgroundSrc: overlaySrc,
  };
}

function resolveTemplateAssetPath(record, requestedName = 'overlay.png') {
  const dir = getTemplateDir(record);
  if (record?.storageSource === 'legacy' || record?.storageMode === 'legacy' || !record?.layoutId) {
    if (requestedName === 'preview.png') {
      return fs.existsSync(path.join(dir, 'preview.png'))
        ? path.join(dir, 'preview.png')
        : path.join(dir, 'template.png');
    }
    if (requestedName === 'background.png') {
      return fs.existsSync(path.join(dir, 'background.png'))
        ? path.join(dir, 'background.png')
        : (fs.existsSync(path.join(dir, 'overlay.png'))
          ? path.join(dir, 'overlay.png')
          : path.join(dir, 'template.png'));
    }
    return fs.existsSync(path.join(dir, 'overlay.png'))
      ? path.join(dir, 'overlay.png')
      : path.join(dir, 'template.png');
  }
  const allowedName = requestedName === 'preview.png'
    ? 'preview.png'
    : (requestedName === 'background.png' ? 'background.png' : 'overlay.png');
  return path.join(dir, allowedName);
}

function toRendererTemplate(record) {
  return {
    ...record,
    type: record.type || 'Uncategorized',
    mode: record.mode === 'event' ? 'event' : 'daily',
    eventId: record.eventId || null,
    ...buildTemplateUrls(record),
    source: 'runtime',
  };
}

function sanitizeEventRecord(input = {}, existingId = null) {
  const landingBackground = input.landingBackground && typeof input.landingBackground === 'object'
    ? {
        type: ['image', 'video'].includes(input.landingBackground.type) ? input.landingBackground.type : 'none',
        src: typeof input.landingBackground.src === 'string' && input.landingBackground.src.trim()
          ? input.landingBackground.src.trim()
          : null,
      }
    : { type: 'none', src: null };
  if (!landingBackground.src) landingBackground.type = 'none';

  return {
    id: existingId || String(input.id || '').trim().slice(0, 128),
    name: String(input.name || '').trim().slice(0, 128),
    clientName: String(input.clientName || '').trim().slice(0, 128),
    eventDate: normalizeEventDate(input.eventDate),
    enabled: input.enabled !== false,
    colorThemeId: COLOR_THEME_IDS.has(input.colorThemeId) ? input.colorThemeId : 'editorialMono',
    landingBackground,
    createdAt: typeof input.createdAt === 'string' && input.createdAt ? input.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function newEventId(name = '') {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || `event-${crypto.randomBytes(3).toString('hex')}`;
  return `${base}-${crypto.randomBytes(2).toString('hex')}`;
}

async function removeEventLandingBackground(eventId) {
  const dir = path.join(eventsDir, eventId);
  if (!fs.existsSync(dir)) return;
  const entries = await fsp.readdir(dir).catch(() => []);
  await Promise.all(entries
    .filter((name) => /^landing-background\./i.test(name))
    .map((name) => fsp.rm(path.join(dir, name), { force: true })));
}

async function applyEventBrandingPayload(event, payload = {}) {
  const next = { ...event };
  if (payload.removeLandingBackground === true) {
    await removeEventLandingBackground(next.id);
    next.landingBackground = { type: 'none', src: null };
  }

  if (typeof payload.landingBackgroundDataUrl === 'string' && payload.landingBackgroundDataUrl) {
    const decoded = decodeBase64DataUrl(payload.landingBackgroundDataUrl);
    if (!decoded) throw new Error('invalid landing background file');
    const backgroundType = decoded.mimeType.startsWith('video/') ? 'video' : 'image';
    await removeEventLandingBackground(next.id);
    const dir = path.join(eventsDir, next.id);
    await fsp.mkdir(dir, { recursive: true });
    const fileName = `landing-background.${decoded.extension}`;
    await fsp.writeFile(path.join(dir, fileName), decoded.buffer);
    next.landingBackground = {
      type: backgroundType,
      src: eventAssetUrl(next.id, decoded.extension),
    };
  }

  return {
    ...next,
    updatedAt: new Date().toISOString(),
  };
}

// Decode a base64 data URL like "data:image/png;base64,AAA..." → Buffer.
// FileReader can produce different MIME labels for valid PNG files, so image
// validation happens after decoding instead of in the data URL header regex.
function decodeImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:([^,]*),(.*)$/i.exec(dataUrl);
  if (!m) return null;
  if (!/base64/i.test(m[1])) return null;
  try {
    const buffer = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

function decodeBase64DataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:([^;,]+)(;[^,]*)?,(.*)$/i.exec(dataUrl);
  if (!m || !/base64/i.test(m[2] || '')) return null;
  try {
    const mimeType = String(m[1] || '').toLowerCase();
    const buffer = Buffer.from(m[3].replace(/\s/g, ''), 'base64');
    if (!buffer.length) return null;
    const extension = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
    }[mimeType];
    if (!extension) return null;
    return { buffer, mimeType, extension };
  } catch {
    return null;
  }
}

function eventAssetUrl(eventId, extension) {
  return `kuku-event://${eventId}/landing-background.${extension}`;
}

function normalizeImageBufferToPng(buffer) {
  if (!buffer) return null;
  const img = nativeImage.createFromBuffer(buffer);
  if (img.isEmpty()) return null;
  return img.toPNG();
}

function readPngDimensions(buffer) {
  const img = nativeImage.createFromBuffer(buffer);
  if (img.isEmpty()) return null;
  return img.getSize();
}

function validateOverlayDimensions(layoutId, buffer) {
  const layout = getLayoutDimensions(layoutId);
  if (!layout) return { ok: false, error: 'invalid layoutId' };
  const size = readPngDimensions(buffer);
  if (!size) return { ok: false, error: 'invalid PNG image' };
  if (size.width !== layout.w || size.height !== layout.h) {
    return {
      ok: false,
      error: `overlay must be ${layout.w}×${layout.h}px for ${layout.name}`,
    };
  }
  return { ok: true };
}

function sanitizeRuntimeTemplateId(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

function makeRuntimeRecordFromSourceTemplate(sourceTemplate = {}, fallbackLayoutId = '') {
  const cleanLayoutId = normalizeLayoutId(String(sourceTemplate.layoutId || fallbackLayoutId || '').trim());
  const id = sanitizeRuntimeTemplateId(sourceTemplate.id);
  if (!id) return null;
  const now = new Date().toISOString();
  const mode = sourceTemplate.mode === 'event' ? 'event' : 'daily';
  const eventId = mode === 'event' && typeof sourceTemplate.eventId === 'string' && sourceTemplate.eventId.trim()
    ? sourceTemplate.eventId.trim().slice(0, 128)
    : null;
  const record = {
    id,
    layoutId: cleanLayoutId,
    mode,
    eventId: mode === 'event' ? eventId : null,
    name: String(sourceTemplate.name || 'Untitled').trim().slice(0, 64) || 'Untitled',
    type: String(sourceTemplate.type || 'Uncategorized').trim().slice(0, 64) || 'Uncategorized',
    desc: String(sourceTemplate.desc || '').trim().slice(0, 256),
    enabled: sourceTemplate.enabled !== false,
    createdAt: now,
    updatedAt: now,
  };
  if (sourceTemplate.hidden === true) record.hidden = true;
  if (sourceTemplate.deleted === true) record.deleted = true;
  return record;
}

async function readReplacementFallbackAssetBuffer(webContents, sourceTemplate = {}, assetType) {
  const candidates = assetType === 'preview'
    ? [sourceTemplate.previewSrc]
    : [sourceTemplate.overlaySrc, sourceTemplate.backgroundSrc];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate) continue;
    try {
      const buffer = normalizeImageBufferToPng(await readRendererPngBuffer(webContents, candidate));
      if (buffer) return buffer;
    } catch {}
  }
  return null;
}

async function readRendererPngBuffer(webContents, url) {
  if (!webContents || typeof url !== 'string' || !url) return null;
  const script = `
    (async () => {
      const res = await fetch(${JSON.stringify(url)});
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const bytes = new Uint8Array(await res.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    })()
  `;
  const base64 = await webContents.executeJavaScript(script, true);
  return Buffer.from(base64, 'base64');
}

function getTemplateProtocolUrl(templateId, assetType) {
  return `kuku-template://${templateId}/${assetType === 'preview' ? 'preview.png' : 'overlay.png'}`;
}

// ─────────────────────────────────────────────────────────────────────────
// IPC: templates
// ─────────────────────────────────────────────────────────────────────────

ipcMain.handle('templates:list', async () => {
  try {
    const results = (await readTemplatesIndex()).map(toRendererTemplate);
    // Sort oldest-first so default order is stable
    results.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    return {
      ok: true,
      templates: results,
      sourceSummary: collectTemplateSourceSummary(),
    };
  } catch (err) {
    return { ok: false, error: err.message, templates: [] };
  }
});

ipcMain.handle('templates:create', async (_ev, payload = {}) => {
  try {
    const {
      layoutId = '',
      name = 'Untitled',
      type = 'Uncategorized',
      mode = 'daily',
      eventId = null,
      desc = '',
      overlayDataUrl,
      previewDataUrl,
      enabled = true,
    } = payload;
    const cleanLayoutId = normalizeLayoutId(String(layoutId).trim());
    if (!getLayoutDimensions(cleanLayoutId)) return { ok: false, error: 'layoutId is required' };
    const overlayBuf = normalizeImageBufferToPng(decodeImageDataUrl(overlayDataUrl));
    const previewBuf = normalizeImageBufferToPng(decodeImageDataUrl(previewDataUrl));
    if (overlayDataUrl && !overlayBuf) return { ok: false, error: 'invalid uploaded overlay PNG' };
    if (previewDataUrl && !previewBuf) return { ok: false, error: 'invalid uploaded preview PNG' };
    if (!overlayBuf) return { ok: false, error: 'overlay PNG is required' };
    if (!previewBuf) return { ok: false, error: 'preview PNG is required' };
    const overlayCheck = validateOverlayDimensions(cleanLayoutId, overlayBuf);
    if (!overlayCheck.ok) return { ok: false, error: overlayCheck.error };
    const cleanMode = mode === 'event' ? 'event' : 'daily';
    const cleanEventId = typeof eventId === 'string' && eventId.trim() ? eventId.trim() : null;
    if (cleanMode === 'event') {
      if (!cleanEventId) return { ok: false, error: 'eventId is required for event templates' };
      const events = await readEventsIndex();
      if (!events.some((event) => event.id === cleanEventId && event.enabled !== false)) {
        return { ok: false, error: 'selected event does not exist or is disabled' };
      }
    }

    const records = await readTemplatesIndex();
    const id = makeTemplateId(cleanLayoutId, name, new Set(records.map((record) => record.id)));
    const meta = {
      id,
      layoutId: cleanLayoutId,
      mode: cleanMode,
      eventId: cleanMode === 'event' ? cleanEventId : null,
      name: String(name).trim().slice(0, 64) || 'Untitled',
      type: String(type).trim().slice(0, 64) || 'Uncategorized',
      desc: String(desc).trim().slice(0, 256),
      enabled: enabled !== false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const dir = getTemplateDir(meta);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'overlay.png'), overlayBuf);
    await fsp.writeFile(path.join(dir, 'preview.png'), previewBuf);

    records.push(meta);
    await writeTemplatesIndex(records);

    return { ok: true, template: toRendererTemplate(meta) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('templates:create-from-bundled', async (ev, payload = {}) => {
  try {
    const {
      sourceTemplate = {},
      overlayDataUrl = null,
      previewDataUrl = null,
      enabled = true,
      type = 'Uncategorized',
    } = payload;

    const cleanLayoutId = normalizeLayoutId(String(sourceTemplate.layoutId || '').trim());
    if (!getLayoutDimensions(cleanLayoutId)) return { ok: false, error: 'layoutId is required' };

    const hasUploadedOverlay = Boolean(overlayDataUrl);
    const hasUploadedPreview = Boolean(previewDataUrl);
    const overlayBuf = normalizeImageBufferToPng(overlayDataUrl
      ? decodeImageDataUrl(overlayDataUrl)
      : await readRendererPngBuffer(ev.sender, sourceTemplate.src));
    const previewBuf = normalizeImageBufferToPng(previewDataUrl
      ? decodeImageDataUrl(previewDataUrl)
      : await readRendererPngBuffer(ev.sender, sourceTemplate.previewSrc));

    if (hasUploadedOverlay && !overlayBuf) return { ok: false, error: 'invalid uploaded overlay PNG' };
    if (hasUploadedPreview && !previewBuf) return { ok: false, error: 'invalid uploaded preview PNG' };
    if (!overlayBuf) return { ok: false, error: 'existing bundled overlay PNG could not be reused' };
    if (!previewBuf) return { ok: false, error: 'existing bundled preview PNG could not be reused' };

    const overlayCheck = validateOverlayDimensions(cleanLayoutId, overlayBuf);
    if (!overlayCheck.ok) return { ok: false, error: overlayCheck.error };

    const cleanMode = sourceTemplate.mode === 'event' ? 'event' : 'daily';
    const cleanEventId = typeof sourceTemplate.eventId === 'string' && sourceTemplate.eventId.trim()
      ? sourceTemplate.eventId.trim()
      : null;
    if (cleanMode === 'event') {
      if (!cleanEventId) return { ok: false, error: 'eventId is required for event templates' };
      const events = await readEventsIndex();
      if (!events.some((event) => event.id === cleanEventId && event.enabled !== false)) {
        return { ok: false, error: 'selected event does not exist or is disabled' };
      }
    }

    const records = await readTemplatesIndex();
    const name = String(sourceTemplate.name || 'Untitled').trim().slice(0, 64) || 'Untitled';
    const meta = {
      id: makeTemplateId(cleanLayoutId, name, new Set(records.map((record) => record.id))),
      layoutId: cleanLayoutId,
      mode: cleanMode,
      eventId: cleanMode === 'event' ? cleanEventId : null,
      name,
      type: String(type).trim().slice(0, 64) || 'Uncategorized',
      desc: String(sourceTemplate.desc || '').trim().slice(0, 256),
      enabled: enabled !== false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const dir = getTemplateDir(meta);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'overlay.png'), overlayBuf);
    await fsp.writeFile(path.join(dir, 'preview.png'), previewBuf);

    records.push(meta);
    await writeTemplatesIndex(records);

    return { ok: true, template: toRendererTemplate(meta) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('templates:replace-asset', async (ev, payload = {}) => {
  try {
    const {
      templateId = '',
      layoutId = '',
      assetType = '',
      dataUrl = '',
      sourceTemplate = {},
    } = payload;
    const cleanAssetType = assetType === 'preview' ? 'preview' : assetType === 'overlay' ? 'overlay' : null;
    const cleanTemplateId = sanitizeRuntimeTemplateId(templateId || sourceTemplate.id);
    const cleanLayoutId = normalizeLayoutId(String(layoutId || sourceTemplate.layoutId || '').trim());
    console.log('[templates:replace] requested', {
      templateId: cleanTemplateId,
      layoutId: cleanLayoutId,
      assetType: cleanAssetType,
    });
    if (!cleanTemplateId) return { ok: false, error: 'missing templateId' };
    if (!cleanAssetType) return { ok: false, error: 'assetType must be preview or overlay' };
    if (!getLayoutDimensions(cleanLayoutId)) return { ok: false, error: 'layoutId is required' };

    const assetBuf = normalizeImageBufferToPng(decodeImageDataUrl(dataUrl));
    if (!assetBuf) return { ok: false, error: `invalid ${cleanAssetType} PNG` };
    if (cleanAssetType === 'overlay') {
      const overlayCheck = validateOverlayDimensions(cleanLayoutId, assetBuf);
      if (!overlayCheck.ok) return { ok: false, error: overlayCheck.error };
    }

    await ensureTemplatesIndex();
    const indexPath = getCurrentTemplateIndexPath();
    const records = readTemplateRecordsFromIndex(indexPath);
    let index = records.findIndex((record) => record.id === cleanTemplateId);
    let meta = index >= 0
      ? { ...records[index] }
      : makeRuntimeRecordFromSourceTemplate({ ...sourceTemplate, id: cleanTemplateId }, cleanLayoutId);
    if (!meta) return { ok: false, error: 'template not found' };
    meta = {
      ...meta,
      id: cleanTemplateId,
      layoutId: cleanLayoutId,
      mode: meta.mode === 'event' ? 'event' : 'daily',
      eventId: meta.mode === 'event' ? (meta.eventId || null) : null,
    };
    delete meta.source;
    delete meta.storageSource;
    delete meta.templateSourcePath;
    if (meta.enabled === undefined) meta.enabled = true;

    if (meta.mode === 'event') {
      if (!meta.eventId) return { ok: false, error: 'eventId is required for event templates' };
      const events = await readEventsIndex();
      if (!events.some((event) => event.id === meta.eventId && event.enabled !== false)) {
        return { ok: false, error: 'selected event does not exist or is disabled' };
      }
    }

    const dir = getTemplateDir(meta);
    await fsp.mkdir(dir, { recursive: true });

    const destinationName = cleanAssetType === 'preview' ? 'preview.png' : 'overlay.png';
    const destinationPath = path.join(dir, destinationName);
    console.log('[templates:replace] before', {
      templateId: cleanTemplateId,
      assetType: cleanAssetType,
      previewSrc: meta.previewSrc || null,
      overlaySrc: meta.overlaySrc || null,
    });
    await fsp.writeFile(destinationPath, assetBuf);
    const destinationStats = await fsp.stat(destinationPath);
    console.log('[templates:replace] destination', {
      assetType: cleanAssetType,
      destinationPath,
      exists: fs.existsSync(destinationPath),
      size: destinationStats.size,
      mtimeMs: destinationStats.mtimeMs,
    });

    if (index === -1) {
      const otherType = cleanAssetType === 'preview' ? 'overlay' : 'preview';
      const otherName = otherType === 'preview' ? 'preview.png' : 'overlay.png';
      const otherPath = path.join(dir, otherName);
      if (!fs.existsSync(otherPath)) {
        const otherBuf = await readReplacementFallbackAssetBuffer(ev.sender, sourceTemplate, otherType);
      if (!otherBuf) return { ok: false, error: `existing bundled ${otherType} PNG could not be reused` };
      if (otherType === 'overlay') {
        const otherCheck = validateOverlayDimensions(cleanLayoutId, otherBuf);
        if (!otherCheck.ok) return { ok: false, error: otherCheck.error };
      }
        await fsp.writeFile(otherPath, otherBuf);
      }
    }

    meta.updatedAt = new Date().toISOString();
    if (!meta.createdAt) meta.createdAt = meta.updatedAt;
    const previewAssetUrl = getTemplateProtocolUrl(cleanTemplateId, 'preview');
    const overlayAssetUrl = getTemplateProtocolUrl(cleanTemplateId, 'overlay');
    if (cleanAssetType === 'preview') {
      meta.previewSrc = previewAssetUrl;
      if (!meta.overlaySrc) meta.overlaySrc = overlayAssetUrl;
    } else {
      meta.overlaySrc = overlayAssetUrl;
      if (!meta.previewSrc) meta.previewSrc = previewAssetUrl;
    }
    meta.backgroundSrc = meta.backgroundSrc || meta.overlaySrc || overlayAssetUrl;
    meta.src = meta.overlaySrc || overlayAssetUrl;
    if (index === -1) {
      records.push(meta);
      index = records.length - 1;
    } else {
      records[index] = meta;
    }

    const backupPath = await backupTemplateIndexForAssetReplace(indexPath);
    await writeTemplatesIndex(records);
    const template = toRendererTemplate(meta);
    const assetUrl = cleanAssetType === 'preview'
      ? template.previewSrc
      : template.overlaySrc;
    const previewPath = path.join(dir, 'preview.png');
    const overlayPath = path.join(dir, 'overlay.png');
    const previewFileStats = fs.existsSync(previewPath) ? await fsp.stat(previewPath) : null;
    const overlayFileStats = fs.existsSync(overlayPath) ? await fsp.stat(overlayPath) : null;
    const cacheVersion = meta.updatedAt;
    console.log('[templates:replace] index updated', {
      templateId: cleanTemplateId,
      assetType: cleanAssetType,
      assetUrl,
      updatedAt: meta.updatedAt,
    });
    console.log('[templates:replace] after', {
      templateId: cleanTemplateId,
      assetType: cleanAssetType,
      previewSrc: template.previewSrc || null,
      overlaySrc: template.overlaySrc || null,
    });
    return {
      ok: true,
      template,
      assetType: cleanAssetType,
      assetPath: destinationPath,
      destinationPath,
      assetUrl,
      previewSrc: template.previewSrc || null,
      overlaySrc: template.overlaySrc || null,
      previewFileExists: Boolean(previewFileStats),
      overlayFileExists: Boolean(overlayFileStats),
      previewFileSize: previewFileStats?.size || 0,
      overlayFileSize: overlayFileStats?.size || 0,
      fileSize: destinationStats.size,
      updatedAt: meta.updatedAt,
      cacheVersion,
      indexPath,
      backupPath,
    };
  } catch (error) {
    console.error('[templates] asset replace failed', error);
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('templates:update', async (_ev, { id, patch = {} } = {}) => {
  try {
    if (!id) return { ok: false, error: 'missing id' };
    const records = await readTemplatesIndex();
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) return { ok: false, error: 'not found' };

    const meta = records[index];
    const cleanPatch = sanitizePatch(patch);
    const nextMeta = { ...meta, ...cleanPatch, id };
    const layoutChanged = cleanPatch.layoutId && cleanPatch.layoutId !== meta.layoutId;
    const nextLayout = nextMeta.layoutId;
    if (!getLayoutDimensions(nextLayout)) return { ok: false, error: 'layoutId is required' };
    nextMeta.mode = nextMeta.mode === 'event' ? 'event' : 'daily';
    nextMeta.eventId = nextMeta.mode === 'event'
      ? (typeof nextMeta.eventId === 'string' && nextMeta.eventId.trim() ? nextMeta.eventId.trim() : null)
      : null;
    if (nextMeta.mode === 'event') {
      if (!nextMeta.eventId) return { ok: false, error: 'eventId is required for event templates' };
      const events = await readEventsIndex();
      if (!events.some((event) => event.id === nextMeta.eventId && event.enabled !== false)) {
        return { ok: false, error: 'selected event does not exist or is disabled' };
      }
    }

    const overlayBuf = patch.overlayDataUrl ? normalizeImageBufferToPng(decodeImageDataUrl(patch.overlayDataUrl)) : null;
    const previewBuf = patch.previewDataUrl ? normalizeImageBufferToPng(decodeImageDataUrl(patch.previewDataUrl)) : null;

    if (patch.overlayDataUrl && !overlayBuf) return { ok: false, error: 'invalid overlay PNG' };
    if (patch.previewDataUrl && !previewBuf) return { ok: false, error: 'invalid preview PNG' };
    if (layoutChanged && (!overlayBuf || !previewBuf)) {
      return { ok: false, error: 'changing layout requires new overlay and preview PNGs' };
    }
    if (overlayBuf) {
      const overlayCheck = validateOverlayDimensions(nextLayout, overlayBuf);
      if (!overlayCheck.ok) return { ok: false, error: overlayCheck.error };
    }

    nextMeta.updatedAt = new Date().toISOString();
    const oldDir = getTemplateDir(meta);
    const nextDir = getTemplateDir(nextMeta);
    await fsp.mkdir(nextDir, { recursive: true });

    if (overlayBuf) {
      await fsp.writeFile(path.join(nextDir, 'overlay.png'), overlayBuf);
    } else if (nextDir !== oldDir) {
      await fsp.copyFile(path.join(oldDir, 'overlay.png'), path.join(nextDir, 'overlay.png'));
    }

    if (previewBuf) {
      await fsp.writeFile(path.join(nextDir, 'preview.png'), previewBuf);
    } else if (nextDir !== oldDir) {
      const prevPath = fs.existsSync(path.join(oldDir, 'preview.png'))
        ? path.join(oldDir, 'preview.png')
        : path.join(oldDir, 'overlay.png');
      await fsp.copyFile(prevPath, path.join(nextDir, 'preview.png'));
    }

    records[index] = nextMeta;
    await writeTemplatesIndex(records);

    return { ok: true, template: toRendererTemplate(nextMeta) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('templates:delete', async (_ev, { id } = {}) => {
  try {
    if (!id) return { ok: false, error: 'missing id' };
    const records = await readTemplatesIndex();
    const record = records.find((template) => template.id === id);
    if (!record) return { ok: false, error: 'not found' };
    const dir = getTemplateDir(record);
    await fsp.rm(dir, { recursive: true, force: true });
    await writeTemplatesIndex(records.filter((template) => template.id !== id));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('templates:audit-duplicates', async () => {
  try {
    await ensureTemplatesIndex();
    const currentIndexPath = getCurrentTemplateIndexPath();
    const currentRecords = readTemplateRecordsFromIndex(currentIndexPath).map((record) => ({
      ...record,
      storageSource: 'current',
      templateSourcePath: currentIndexPath,
    }));
    const duplicateGroups = buildDuplicateTemplateGroups(currentRecords);
    const duplicateCount = duplicateGroups.reduce((sum, group) => sum + group.removeTemplateIds.length, 0);
    console.log('[templates:dedupe] audit completed', {
      currentIndexPath,
      duplicateGroups: duplicateGroups.length,
      duplicateCount,
    });
    return {
      ok: true,
      duplicateGroups,
      duplicateCount,
    };
  } catch (error) {
    console.error('[templates:dedupe] audit failed', error);
    return {
      ok: false,
      error: error?.message || String(error),
      duplicateGroups: [],
      duplicateCount: 0,
    };
  }
});

ipcMain.handle('templates:clean-duplicates', async () => {
  try {
    await ensureTemplatesIndex();
    const currentIndexPath = getCurrentTemplateIndexPath();
    const currentSummary = getTemplateIndexSummary(currentIndexPath);
    const currentRecords = readTemplateRecordsFromIndex(currentIndexPath).map((record) => ({
      ...record,
      storageSource: 'current',
      templateSourcePath: currentIndexPath,
    }));
    const {
      cleaned,
      groups,
      removedCount,
      keptCount,
      copiedAssetFieldsCount,
      removedTemplateIds,
      keptTemplateIds,
    } = await buildCleanedTemplateRecords(currentRecords);
    const duplicateGroupsFound = groups.length;
    const duplicateCount = groups.reduce((sum, group) => sum + group.removeTemplateIds.length, 0);
    console.log('[templates:dedupe] duplicate groups found', {
      duplicateGroupsFound,
      duplicateCount,
      currentCountBefore: currentSummary.count,
    });

    if (groups.length === 0) {
      return {
        ok: true,
        currentCountBefore: currentSummary.count,
        currentCountAfter: currentSummary.count,
        duplicateGroupsFound: 0,
        duplicateGroupsCleaned: 0,
        removedCount: 0,
        keptCount: currentRecords.length,
        copiedAssetFieldsCount: 0,
        backupPath: null,
        removedTemplateIds: [],
        keptTemplateIds: currentRecords.map((record) => record.id),
      };
    }

    const backupPath = await backupTemplateIndexForDedupe(currentIndexPath);
    await writeTemplatesIndex(cleaned);
    const finalCount = readTemplateCountFromIndex(currentIndexPath);

    console.log('[templates:dedupe] cleanup completed', {
      currentIndexPath,
      duplicateGroupsCleaned: groups.length,
      removedCount,
      keptCount,
      copiedAssetFieldsCount,
      backupPath,
      currentCountBefore: currentSummary.count,
      currentCountAfter: finalCount,
    });

    return {
      ok: true,
      currentCountBefore: currentSummary.count,
      currentCountAfter: finalCount,
      duplicateGroupsFound,
      duplicateGroupsCleaned: groups.length,
      removedCount,
      keptCount,
      copiedAssetFieldsCount,
      backupPath,
      removedTemplateIds,
      keptTemplateIds,
    };
  } catch (error) {
    console.error('[templates:dedupe] cleanup failed', error);
    return {
      ok: false,
      error: error?.message || String(error),
      duplicateGroupsCleaned: 0,
      duplicateGroupsFound: 0,
      removedCount: 0,
      keptCount: 0,
      copiedAssetFieldsCount: 0,
      backupPath: null,
      currentCountBefore: 0,
      currentCountAfter: 0,
      removedTemplateIds: [],
      keptTemplateIds: [],
    };
  }
});

ipcMain.handle('settings:get', async () => {
  try {
    const settings = await readSettings();
    return { ok: true, settings };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      settings: {
        mode: 'daily',
        activeEventId: null,
        printEnabled: true,
        printCopiesEnabled: false,
        selectedPrinterName: null,
        testModeEnabled: false,
        printerProfileId: DEFAULT_PRINTER_PROFILE_ID,
        safeMarginOverride: DEFAULT_SAFE_MARGIN_OVERRIDE,
        softcopySettings: DEFAULT_SOFTCOPY_SETTINGS,
        layoutSettings: DEFAULT_LAYOUT_SETTINGS,
        countdownSeconds: DEFAULT_COUNTDOWN_SECONDS,
        beautificationSettings: DEFAULT_BEAUTIFICATION_SETTINGS,
      },
    };
  }
});

ipcMain.handle('settings:update', async (_ev, patch = {}) => {
  try {
    const current = await readSettings();
    const printerProfileId = patch?.printerProfileId === 'dnp_4x6' ? 'dnp_4x6' : (
      patch?.printerProfileId === 'selphy_cp1500' ? 'selphy_cp1500' : current.printerProfileId
    );
    const next = {
      mode: patch?.mode === 'event' ? 'event' : (patch?.mode === 'daily' ? 'daily' : current.mode),
      activeEventId: Object.prototype.hasOwnProperty.call(patch, 'activeEventId')
        ? (typeof patch.activeEventId === 'string' && patch.activeEventId.trim() ? patch.activeEventId.trim() : null)
        : current.activeEventId,
      printEnabled: typeof patch?.printEnabled === 'boolean' ? patch.printEnabled : current.printEnabled,
      printCopiesEnabled: typeof patch?.printCopiesEnabled === 'boolean'
        ? patch.printCopiesEnabled
        : current.printCopiesEnabled === true,
      selectedPrinterName: Object.prototype.hasOwnProperty.call(patch, 'selectedPrinterName')
        ? (typeof patch.selectedPrinterName === 'string' && patch.selectedPrinterName.trim()
            ? patch.selectedPrinterName.trim()
            : null)
        : current.selectedPrinterName,
      testModeEnabled: typeof patch?.testModeEnabled === 'boolean' ? patch.testModeEnabled : current.testModeEnabled === true,
      printerProfileId,
      safeMarginOverride: Object.prototype.hasOwnProperty.call(patch, 'safeMarginOverride')
        ? normalizeSafeMarginOverride(patch.safeMarginOverride ?? {}, printerProfileId)
        : normalizeSafeMarginOverride(current.safeMarginOverride ?? DEFAULT_SAFE_MARGIN_OVERRIDE, printerProfileId),
      bundledTemplateOverrides: Object.prototype.hasOwnProperty.call(patch, 'bundledTemplateOverrides')
        ? normalizeBundledTemplateOverrides(patch.bundledTemplateOverrides)
        : normalizeBundledTemplateOverrides(current.bundledTemplateOverrides),
      softcopySettings: Object.prototype.hasOwnProperty.call(patch, 'softcopySettings')
        ? normalizeSoftcopySettings(patch.softcopySettings)
        : normalizeSoftcopySettings(current.softcopySettings),
      layoutSettings: Object.prototype.hasOwnProperty.call(patch, 'layoutSettings')
        ? normalizeLayoutSettings(patch.layoutSettings)
        : normalizeLayoutSettings(current.layoutSettings),
      countdownSeconds: Object.prototype.hasOwnProperty.call(patch, 'countdownSeconds')
        ? normalizeCountdownSeconds(patch.countdownSeconds)
        : normalizeCountdownSeconds(current.countdownSeconds),
      beautificationSettings: Object.prototype.hasOwnProperty.call(patch, 'beautificationSettings')
        ? normalizeBeautificationSettings(patch.beautificationSettings)
        : normalizeBeautificationSettings(current.beautificationSettings),
    };

    if (next.mode === 'event' && next.activeEventId) {
      const events = await readEventsIndex();
      if (!events.some((event) => event.id === next.activeEventId && event.enabled !== false)) {
        return { ok: false, error: 'active event does not exist or is disabled' };
      }
    }

    await writeSettings(next);
    if (Object.prototype.hasOwnProperty.call(patch, 'selectedPrinterName')) {
      console.log('[printers] selected printer saved', next.selectedPrinterName);
    }
    broadcastToAllWindows('settings:changed', next);
    return { ok: true, settings: next };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('events:list', async () => {
  try {
    const events = await readEventsIndex();
    events.sort((a, b) => (a.eventDate || '').localeCompare(b.eventDate || '') || a.name.localeCompare(b.name));
    return { ok: true, events };
  } catch (err) {
    return { ok: false, error: err.message, events: [] };
  }
});

ipcMain.handle('events:create', async (_ev, payload = {}) => {
  try {
    let event = sanitizeEventRecord(payload, newEventId(payload.name));
    if (!event.name) return { ok: false, error: 'event name is required' };
    if (!event.eventDate) return { ok: false, error: 'event date is required' };
    event = await applyEventBrandingPayload(event, payload);
    const events = await readEventsIndex();
    events.push(event);
    await writeEventsIndex(events);
    broadcastToAllWindows('events:changed');
    return { ok: true, event };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('events:update', async (_ev, { id, patch = {} } = {}) => {
  try {
    if (!id) return { ok: false, error: 'missing id' };
    const events = await readEventsIndex();
    const index = events.findIndex((event) => event.id === id);
    if (index === -1) return { ok: false, error: 'not found' };
    let next = {
      ...events[index],
      ...sanitizeEventRecord({ ...events[index], ...patch }, id),
      id,
    };
    if (!next.name) return { ok: false, error: 'event name is required' };
    if (!next.eventDate) return { ok: false, error: 'event date is required' };
    next = await applyEventBrandingPayload(next, patch);
    events[index] = next;
    await writeEventsIndex(events);
    broadcastToAllWindows('events:changed');

    const settings = await readSettings();
    if (settings.activeEventId === id && next.enabled === false) {
      const nextSettings = { ...settings, activeEventId: null };
      await writeSettings(nextSettings);
      broadcastToAllWindows('settings:changed', nextSettings);
    }

    return { ok: true, event: next };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('events:delete', async (_ev, { id } = {}) => {
  try {
    if (!id) return { ok: false, error: 'missing id' };
    const events = await readEventsIndex();
    const exists = events.some((event) => event.id === id);
    if (!exists) return { ok: false, error: 'not found' };
    const templates = await readTemplatesIndex();
    const attachedCount = templates.filter((template) => template.mode === 'event' && template.eventId === id).length;
    if (attachedCount > 0) {
      return { ok: false, error: 'delete blocked: templates are still attached to this event' };
    }
    await writeEventsIndex(events.filter((event) => event.id !== id));
    await fsp.rm(path.join(eventsDir, id), { recursive: true, force: true });
    broadcastToAllWindows('events:changed');
    const settings = await readSettings();
    if (settings.activeEventId === id) {
      const nextSettings = { ...settings, activeEventId: null };
      await writeSettings(nextSettings);
      broadcastToAllWindows('settings:changed', nextSettings);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─────────────────────────────────────────────────────────────────────────
// IPC: admin PIN
// ─────────────────────────────────────────────────────────────────────────

ipcMain.handle('admin:checkPin', async (_ev, { pin } = {}) => {
  try {
    const rec = await readAdmin();
    const ok = typeof pin === 'string' && hashPin(pin, rec.salt) === rec.hash;
    return { ok };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('admin:setPin', async (_ev, { currentPin, newPin } = {}) => {
  try {
    const rec = await readAdmin();
    if (hashPin(currentPin || '', rec.salt) !== rec.hash) {
      return { ok: false, error: 'wrong current PIN' };
    }
    if (!/^\d{4}$/.test(newPin || '')) {
      return { ok: false, error: 'new PIN must be 4 digits' };
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const next = { salt, hash: hashPin(newPin, salt), updatedAt: new Date().toISOString() };
    await fsp.writeFile(adminFile, JSON.stringify(next, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─────────────────────────────────────────────────────────────────────────
// IPC: sessions (print analytics)
// ─────────────────────────────────────────────────────────────────────────
//
// Every successful (or failed) print appends one JSON line to
// userData/sessions.jsonl. Append-only keeps writes cheap and means a
// crash can't corrupt prior history. Stats queries stream the file,
// parse each line, and aggregate in memory — plenty fast for tens of
// thousands of sessions.

function newSessionId() {
  return `sess_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function toLocalDateYmd(dateIso) {
  // Converts an ISO timestamp to a local YYYY-MM-DD string. Used for
  // day-bucketing so "today" matches the operator's wall clock, not UTC.
  const d = dateIso ? new Date(dateIso) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getSessionLocalDate(session) {
  if (!session || typeof session !== 'object') return null;
  if (typeof session.dateLocal === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(session.dateLocal)) {
    return session.dateLocal;
  }
  if (typeof session.timestamp === 'string') {
    const date = new Date(session.timestamp);
    if (!Number.isNaN(date.getTime())) {
      return toLocalDateYmd(date.toISOString());
    }
  }
  return null;
}

function broadcastToRenderers(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send(channel, payload);
      } catch {
        /* renderer gone */
      }
    }
  }
}

const SESSION_PRINT_STATUSES = new Set(['completed', 'failed', 'cancelled', 'partial']);
let sessionsCache = {
  size: null,
  mtimeMs: null,
  records: null,
};

function invalidateSessionsCache() {
  sessionsCache = {
    size: null,
    mtimeMs: null,
    records: null,
  };
}

async function setSessionsCacheFromRecords(records = []) {
  const signature = await getSessionsFileSignature();
  sessionsCache = {
    ...signature,
    records: Array.isArray(records) ? records : [],
  };
}

async function getSessionsFileSignature() {
  try {
    const stats = await fsp.stat(sessionsFile);
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return { size: 0, mtimeMs: 0 };
  }
}

function normalizeKeychainCopies(value) {
  const count = Number(value);
  if (isValidKeychainCopies(count)) return count;
  return null;
}

function getKeychainSaleAmount(copies) {
  return getKeychainPrice(copies);
}

function newKeychainSaleId() {
  return `keychain_sale_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function sanitizeKeychainSale(input = {}) {
  if (input.printStatus && input.printStatus !== 'completed') return null;
  const copies = normalizeKeychainCopies(input.copies);
  if (!copies) return null;
  const explicitAmount = Number(input.amount);
  const amount = Number.isFinite(explicitAmount) && explicitAmount > 0
    ? Math.max(0, explicitAmount)
    : getKeychainSaleAmount(copies);
  return {
    id: typeof input.id === 'string' && input.id ? input.id.slice(0, 96) : newKeychainSaleId(),
    createdAt: typeof input.createdAt === 'string' ? input.createdAt.slice(0, 64) : new Date().toISOString(),
    copies,
    amount,
    keychainPath: typeof input.keychainPath === 'string' ? input.keychainPath.slice(0, 256) : null,
    keychainFilename: typeof input.keychainFilename === 'string' ? input.keychainFilename.slice(0, 180) : null,
    printStatus: 'completed',
  };
}

function getKeychainSales(session = {}) {
  if (!Array.isArray(session.keychainSales)) return [];
  return session.keychainSales
    .map(sanitizeKeychainSale)
    .filter(Boolean);
}

function summarizeKeychainSales(sales = []) {
  return sales.reduce((summary, sale) => ({
    unitsSold: summary.unitsSold + sale.copies,
    revenue: +(summary.revenue + sale.amount).toFixed(2),
    sheetsPrinted: summary.sheetsPrinted + 1,
  }), {
    unitsSold: 0,
    revenue: 0,
    sheetsPrinted: 0,
  });
}

function sanitizeLocalSoftcopyAsset(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const pathValue = input.path || input.targetPath || input.filePath;
  const filenameValue = input.filename || input.name;
  const sizeBytes = Number(input.sizeBytes);
  return {
    path: typeof pathValue === 'string' ? pathValue.slice(0, 512) : null,
    filename: typeof filenameValue === 'string' ? safeLocalMediaFilename(filenameValue, '').slice(0, 180) : null,
    savedAt: typeof input.savedAt === 'string' ? input.savedAt.slice(0, 64) : null,
    sizeBytes: Number.isFinite(sizeBytes) && sizeBytes >= 0 ? Math.floor(sizeBytes) : null,
  };
}

function sanitizeLocalSoftcopies(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const normalized = {};
  for (const key of ['png', 'gif', 'video']) {
    const asset = sanitizeLocalSoftcopyAsset(source[key]);
    if (asset?.path || asset?.filename) normalized[key] = asset;
  }
  return Object.keys(normalized).length ? normalized : null;
}

function sanitizeSession(input = {}) {
  const now = new Date();
  const ts  = typeof input.timestamp === 'string' ? input.timestamp : now.toISOString();
  const unitPrice  = Number.isFinite(+input.unitPrice)  ? Math.max(0, +input.unitPrice)  : 0;
  const rawPrintStatus = input.printStatus || input.status;
  const printStatus = SESSION_PRINT_STATUSES.has(rawPrintStatus) ? rawPrintStatus : 'completed';
  const printCopiesRequested = clampPrintCopies(input.printCopiesRequested ?? input.copies);
  const hasCompletedCopies = Number.isFinite(+input.printCopiesCompleted);
  const printCopiesCompleted = hasCompletedCopies
    ? Math.max(0, Math.min(printCopiesRequested, Math.floor(+input.printCopiesCompleted)))
    : clampPrintCopies(input.copies);
  const copies = printCopiesCompleted;
  const totalAmount = Number.isFinite(+input.totalAmount)
    ? Math.max(0, +input.totalAmount)
    : +(unitPrice * copies).toFixed(2);
  const extraPrintCount = Number.isFinite(+input.extraPrintCount)
    ? Math.max(0, Math.floor(+input.extraPrintCount))
    : 0;
  const originalCopies = Number.isFinite(+input.originalCopies)
    ? Math.max(0, Math.floor(+input.originalCopies))
    : copies;
  const totalPrintCopies = Number.isFinite(+input.totalPrintCopies)
    ? Math.max(0, Math.floor(+input.totalPrintCopies))
    : originalCopies + extraPrintCount;
  const extraPrintRevenue = Number.isFinite(+input.extraPrintRevenue)
    ? Math.max(0, +input.extraPrintRevenue)
    : +(unitPrice * extraPrintCount).toFixed(2);
  const keychainSales = getKeychainSales(input);
  const keychainSummary = summarizeKeychainSales(keychainSales);
  console.log('[sessions] preserving softcopyVideoPath', Boolean(input.softcopyVideoPath));

  return {
    id:            typeof input.id === 'string' && input.id ? input.id : newSessionId(),
    timestamp:     ts,
    dateLocal:     toLocalDateYmd(ts),
    layoutId:      typeof input.layoutId     === 'string' ? input.layoutId.slice(0, 64)     : null,
    layoutName:    typeof input.layoutName   === 'string' ? input.layoutName.slice(0, 64)   : null,
    mode:          input.mode === 'event' ? 'event' : 'daily',
    eventId:       typeof input.eventId      === 'string' ? input.eventId.slice(0, 128)     : null,
    eventName:     typeof input.eventName    === 'string' ? input.eventName.slice(0, 128)   : null,
    templateId:    typeof input.templateId   === 'string' ? input.templateId.slice(0, 64)   : null,
    templateName:  typeof input.templateName === 'string' ? input.templateName.slice(0, 64) : null,
    cameraOrientation: normalizeSessionCameraOrientation(input.cameraOrientation),
    testMode:      input.testMode === true || input.isTest === true,
    copies,
    printStatus,
    printCopiesRequested,
    printCopiesCompleted,
    unitPrice,
    totalAmount,
    originalCopies,
    extraPrintCount,
    totalPrintCopies,
    extraPrintRevenue,
    lastExtraPrintAt: typeof input.lastExtraPrintAt === 'string' ? input.lastExtraPrintAt.slice(0, 64) : null,
    retriesUsed:   Number.isFinite(+input.retriesUsed) ? Math.max(0, Math.floor(+input.retriesUsed)) : 0,
    durationMs:    Number.isFinite(+input.durationMs)  ? Math.max(0, Math.floor(+input.durationMs))  : null,
    status:        printStatus,
    failureReason: printStatus === 'failed' && typeof input.failureReason === 'string' ? input.failureReason.slice(0, 256) : null,
    softcopySessionToken: typeof input.softcopySessionToken === 'string' ? input.softcopySessionToken.slice(0, 128) : null,
    softcopyPhotoPath: typeof input.softcopyPhotoPath === 'string' ? input.softcopyPhotoPath.slice(0, 256) : null,
    softcopyGifPath: typeof input.softcopyGifPath === 'string' ? input.softcopyGifPath.slice(0, 256) : null,
    softcopyVideoPath: typeof input.softcopyVideoPath === 'string' ? input.softcopyVideoPath.slice(0, 256) : null,
    softcopyExpiresAt: typeof input.softcopyExpiresAt === 'string' ? input.softcopyExpiresAt.slice(0, 64) : null,
    softcopyStatus: typeof input.softcopyStatus === 'string' ? input.softcopyStatus.slice(0, 32) : null,
    finalPrintPath: typeof input.finalPrintPath === 'string' ? input.finalPrintPath.slice(0, 256) : null,
    printImagePath: typeof input.printImagePath === 'string' ? input.printImagePath.slice(0, 256) : null,
    localSoftcopies: sanitizeLocalSoftcopies(input.localSoftcopies),
    keychainPath: typeof input.keychainPath === 'string' ? input.keychainPath.slice(0, 256) : null,
    keychainFilename: typeof input.keychainFilename === 'string' ? input.keychainFilename.slice(0, 180) : null,
    keychainGeneratedAt: typeof input.keychainGeneratedAt === 'string' ? input.keychainGeneratedAt.slice(0, 64) : null,
    keychainSales,
    keychainUnitsSold: keychainSummary.unitsSold,
    keychainRevenue: keychainSummary.revenue,
    keychainSheetsPrinted: keychainSummary.sheetsPrinted,
    keychainTransactions: keychainSummary.sheetsPrinted,
    keychainPrintCount: keychainSummary.sheetsPrinted || (Number.isFinite(+input.keychainPrintCount) ? Math.max(0, Math.floor(+input.keychainPrintCount)) : 0),
    lastKeychainPrintedAt: typeof input.lastKeychainPrintedAt === 'string' ? input.lastKeychainPrintedAt.slice(0, 64) : null,
    keychainLastError: typeof input.keychainLastError === 'string' ? input.keychainLastError.slice(0, 256) : null,
  };
}

function filterSessionsByEvent(all = [], filter = {}) {
  if (filter?.mode === 'daily') {
    return all.filter((session) => (session.mode || 'daily') === 'daily' || !session.eventId);
  }
  if (filter?.eventId) {
    return all.filter((session) => session.eventId === filter.eventId);
  }
  return all;
}

function filterSessionsByType(all = [], filter = {}) {
  if (filter?.sessionType === 'test') {
    return all.filter((session) => session.testMode === true);
  }
  if (filter?.sessionType === 'real') {
    return all.filter((session) => session.testMode !== true);
  }
  return all;
}

function normalizeSessionText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function filterSessionsByQuery(all = [], filter = {}) {
  const templateName = normalizeSessionText(filter.templateName);
  const status = normalizeSessionText(filter.status);
  const search = normalizeSessionText(filter.search);
  const from = typeof filter.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(filter.from) ? filter.from : null;
  const to = typeof filter.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(filter.to) ? filter.to : null;

  return all.filter((session) => {
    if (templateName && normalizeSessionText(session.templateName || session.templateId) !== templateName) return false;
    if (status && normalizeSessionText(session.status) !== status) return false;
    if (from && (session.dateLocal || '') < from) return false;
    if (to && (session.dateLocal || '') > to) return false;
    if (!search) return true;

    const searchable = [
      session.id,
      session.timestamp,
      session.dateLocal,
      session.templateId,
      session.templateName,
      session.testMode ? 'test' : 'real',
      session.status,
      session.failureReason,
      session.eventId,
      session.eventName,
      session.layoutId,
      session.layoutName,
    ]
      .filter(Boolean)
      .map(normalizeSessionText)
      .join(' ');
    return searchable.includes(search);
  });
}

async function readAllSessions() {
  const signature = await getSessionsFileSignature();
  if (sessionsCache.records
    && sessionsCache.size === signature.size
    && sessionsCache.mtimeMs === signature.mtimeMs) {
    return sessionsCache.records;
  }
  if (!signature.size) {
    sessionsCache = { ...signature, records: [] };
    return sessionsCache.records;
  }
  const raw = await fsp.readFile(sessionsFile, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
  }
  sessionsCache = { ...signature, records: out };
  return out;
}

async function writeAllSessions(records = []) {
  if (!Array.isArray(records) || records.length === 0) {
    if (fs.existsSync(sessionsFile)) await fsp.unlink(sessionsFile);
    sessionsCache = { size: 0, mtimeMs: 0, records: [] };
    return;
  }
  const nextContents = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  await fsp.writeFile(sessionsFile, nextContents, 'utf8');
  await setSessionsCacheFromRecords(records);
}

function getIntegerField(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

function getMoneyField(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function resolveSessionUnitPrice(session = {}) {
  const explicit = Number(session.unitPrice);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const totalAmount = Number(session.totalAmount);
  const totalCopies = getIntegerField(session.totalPrintCopies ?? session.copies ?? session.printCopiesCompleted, 0);
  if (Number.isFinite(totalAmount) && totalAmount > 0 && totalCopies > 0) {
    return +(totalAmount / totalCopies).toFixed(2);
  }

  return 0;
}

function applySuccessfulExtraPrint(session = {}) {
  const nowIso = new Date().toISOString();
  const previousExtraPrintCount = getIntegerField(session.extraPrintCount, 0);
  const previousTotalPrintCopies = getIntegerField(
    session.totalPrintCopies ?? session.copies ?? session.printCopiesCompleted,
    0,
  );
  const originalCopies = getIntegerField(
    session.originalCopies,
    Math.max(0, previousTotalPrintCopies - previousExtraPrintCount),
  );
  const unitPrice = resolveSessionUnitPrice(session);
  const nextExtraPrintCount = previousExtraPrintCount + 1;
  const nextTotalPrintCopies = originalCopies + nextExtraPrintCount;
  const nextExtraPrintRevenue = +(getMoneyField(session.extraPrintRevenue, 0) + unitPrice).toFixed(2);
  const nextTotalAmount = +(getMoneyField(session.totalAmount, 0) + unitPrice).toFixed(2);

  return {
    ...session,
    copies: nextTotalPrintCopies,
    printCopiesCompleted: nextTotalPrintCopies,
    totalAmount: nextTotalAmount,
    unitPrice,
    originalCopies,
    extraPrintCount: nextExtraPrintCount,
    totalPrintCopies: nextTotalPrintCopies,
    extraPrintRevenue: nextExtraPrintRevenue,
    lastExtraPrintAt: nowIso,
  };
}

function buildSessionKeychainFilename(session = {}, keychainCopies = 3, timestamp = Date.now()) {
  const copies = normalizeKeychainCopies(keychainCopies) || 3;
  const safeSessionId = sanitizeSoftcopySegment(session.id || session.softcopySessionToken, 'session')
    .slice(0, 64) || 'session';
  return `Afterimage-keychain-4x6-${copies}copies-${softcopyTimestamp(timestamp || Date.now())}-session-${safeSessionId}.png`;
}

function resolveStoredKeychainPath(session = {}, keychainCopies = null) {
  const downloadsDir = app.getPath('downloads');
  const copies = normalizeKeychainCopies(keychainCopies);
  const matchingSales = copies
    ? getKeychainSales(session).filter((sale) => sale.copies === copies)
    : getKeychainSales(session);
  const legacyCandidates = [
    session.keychainPath,
    session.keychainFilename,
  ].filter((value) => {
    if (typeof value !== 'string' || !value.trim()) return false;
    if (!copies) return true;
    return path.basename(value).includes(`${copies}copies`);
  });
  const candidates = [
    ...matchingSales
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .flatMap((sale) => [sale.keychainPath, sale.keychainFilename]),
    ...legacyCandidates,
  ].filter((value) => typeof value === 'string' && value.trim());

  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.join(downloadsDir, path.basename(candidate));
    if (fs.existsSync(resolved)) {
      const verification = verifyWrittenFile(resolved);
      if (verification.exists && verification.sizeBytes > 0) {
        return {
          path: resolved,
          filename: path.basename(resolved),
          sizeBytes: verification.sizeBytes,
        };
      }
    }
  }

  return null;
}

function applyKeychainGenerated(session = {}, {
  keychainPath,
  keychainFilename,
  keychainGeneratedAt,
  keychainWidth = null,
  keychainHeight = null,
  keychainPlacementCount = null,
} = {}) {
  return {
    ...session,
    keychainPath,
    keychainFilename,
    keychainGeneratedAt: keychainGeneratedAt || session.keychainGeneratedAt || new Date().toISOString(),
    keychainWidth: Number.isFinite(Number(keychainWidth)) ? Number(keychainWidth) : (session.keychainWidth || null),
    keychainHeight: Number.isFinite(Number(keychainHeight)) ? Number(keychainHeight) : (session.keychainHeight || null),
    keychainPlacementCount: Number.isFinite(Number(keychainPlacementCount))
      ? Math.max(0, Math.floor(Number(keychainPlacementCount)))
      : (session.keychainPlacementCount || null),
    keychainLastError: null,
  };
}

function applySuccessfulKeychainPrint(session = {}, keychainInfo = {}) {
  const nowIso = new Date().toISOString();
  const copies = normalizeKeychainCopies(keychainInfo.keychainCopies) || 3;
  const amount = getKeychainSaleAmount(copies);
  const sale = sanitizeKeychainSale({
    id: keychainInfo.saleId || newKeychainSaleId(),
    createdAt: nowIso,
    copies,
    amount,
    keychainPath: keychainInfo.keychainPath,
    keychainFilename: keychainInfo.keychainFilename,
    printStatus: 'completed',
  });
  const keychainSales = [
    ...getKeychainSales(session),
    sale,
  ].filter(Boolean);
  const summary = summarizeKeychainSales(keychainSales);
  return {
    ...applyKeychainGenerated(session, keychainInfo),
    keychainSales,
    keychainUnitsSold: summary.unitsSold,
    keychainRevenue: summary.revenue,
    keychainSheetsPrinted: summary.sheetsPrinted,
    keychainTransactions: summary.sheetsPrinted,
    keychainPrintCount: summary.sheetsPrinted,
    lastKeychainPrintedAt: nowIso,
    keychainLastError: null,
  };
}

function applyFailedKeychainPrint(session = {}, message = '') {
  return {
    ...session,
    keychainLastError: String(message || 'Keychain print failed').slice(0, 256),
  };
}

async function updateSessionRecord(sessionId, updater) {
  const records = await readAllSessions();
  const index = records.findIndex((record) => record && record.id === sessionId);
  if (index < 0) return null;

  const updated = updater(records[index]);
  records[index] = updated;
  await writeAllSessions(records);
  return updated;
}

ipcMain.handle('sessions:log', async (_ev, payload = {}) => {
  try {
    const record = sanitizeSession(payload);
    await fsp.appendFile(sessionsFile, JSON.stringify(record) + '\n', 'utf8');
    if (Array.isArray(sessionsCache.records)) {
      await setSessionsCacheFromRecords([...sessionsCache.records, record]);
    } else {
      invalidateSessionsCache();
    }
    // Broadcast to every renderer so any open admin dashboard refreshes
    // immediately — no need for the admin to click refresh.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try { win.webContents.send('sessions:logged', record); } catch { /* renderer gone */ }
      }
    }
    return { ok: true, session: record };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function sanitizeSessionSoftcopyPatch(input = {}) {
  const patch = {};
  const stringFields = [
    'softcopySessionToken',
    'softcopyPhotoPath',
    'softcopyGifPath',
    'softcopyVideoPath',
    'softcopyExpiresAt',
    'softcopyStatus',
    'finalPrintPath',
    'printImagePath',
    'cameraOrientation',
  ];
  for (const field of stringFields) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    if (field === 'cameraOrientation') {
      patch[field] = normalizeSessionCameraOrientation(input[field]);
    } else {
      patch[field] = typeof input[field] === 'string' ? input[field].slice(0, field === 'softcopyStatus' ? 32 : 256) : null;
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, 'localSoftcopies')) {
    patch.localSoftcopies = sanitizeLocalSoftcopies(input.localSoftcopies);
  }
  return patch;
}

ipcMain.handle('sessions:update-softcopy', async (_ev, { id, patch = {} } = {}) => {
  try {
    const sessionId = typeof id === 'string' ? id.trim() : '';
    if (!sessionId) return { ok: false, error: 'missing session id' };
    const cleanPatch = sanitizeSessionSoftcopyPatch(patch);
    if (Object.keys(cleanPatch).length === 0) return { ok: false, error: 'empty softcopy patch' };
    const updatedSession = await updateSessionRecord(sessionId, (record) => ({
      ...record,
      ...cleanPatch,
    }));
    if (!updatedSession) return { ok: false, error: 'session not found' };
    broadcastToRenderers('sessions:updated', updatedSession);
    broadcastToRenderers('today-monitor:sessions-updated', updatedSession);
    return { ok: true, session: updatedSession };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('sessions:list', async (_ev, {
  limit = 50,
  offset = 0,
  eventId = null,
  mode = null,
  sessionType = null,
  status = null,
  templateName = null,
  from = null,
  to = null,
  search = null,
} = {}) => {
  try {
    const all = filterSessionsByQuery(
      filterSessionsByType(filterSessionsByEvent(await readAllSessions(), { eventId, mode }), { sessionType }),
      { status, templateName, from, to, search }
    );
    // Newest first
    all.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    const safeLimit  = Math.max(1, Math.min(500, Number(limit)  || 50));
    const safeOffset = Math.max(0,            Number(offset) || 0);
    return {
      ok: true,
      total: all.length,
      sessions: all.slice(safeOffset, safeOffset + safeLimit),
    };
  } catch (err) {
    return { ok: false, error: err.message, sessions: [] };
  }
});

ipcMain.handle('sessions:stats', async (_ev, { eventId = null, mode = null, sessionType = null } = {}) => {
  try {
    const all = filterSessionsByType(filterSessionsByEvent(await readAllSessions(), { eventId, mode }), { sessionType });
    const today = toLocalDateYmd();
    const now = new Date();
    const daysAgo = (n) => {
      const d = new Date(now); d.setDate(d.getDate() - n);
      return toLocalDateYmd(d.toISOString());
    };
    const sevenAgo  = daysAgo(6);   // inclusive 7-day window
    const thirtyAgo = daysAgo(29);  // inclusive 30-day window

    // Aggregate totals across all-time + windows
    const agg = () => ({
      sessions: 0,
      copies: 0,
      revenue: 0,
      stripRevenue: 0,
      keychainRevenue: 0,
      totalRevenue: 0,
      keychainUnits: 0,
      keychainSheets: 0,
      keychainTransactions: 0,
      failed: 0,
    });
    const buckets = {
      today:    agg(),
      week:     agg(),
      month:    agg(),
      allTime:  agg(),
    };

    // By-day map for the last 30 days, keyed by YYYY-MM-DD.
    // Pre-seed with zeros so charts don't have gaps.
    const byDay = {};
    for (let i = 29; i >= 0; i--) {
      const key = daysAgo(i);
      byDay[key] = {
        date: key,
        sessions: 0,
        copies: 0,
        revenue: 0,
        stripRevenue: 0,
        keychainRevenue: 0,
        totalRevenue: 0,
        keychainUnits: 0,
        keychainSheets: 0,
        keychainTransactions: 0,
      };
    }

    // By-template breakdown (revenue + copies, all-time only)
    const byTemplate = {};
    const keychainSales = [];

    for (const s of all) {
      if (!s || !s.dateLocal) continue;
      const d = s.dateLocal;
      const failed = s.status === 'failed';
      const sessionKeychainSales = !failed ? getKeychainSales(s) : [];
      const sessionKeychainSummary = summarizeKeychainSales(sessionKeychainSales);
      const stripRevenue = !failed ? getMoneyField(s.totalAmount, 0) : 0;
      const keychainRevenue = !failed ? sessionKeychainSummary.revenue : 0;
      const totalRevenue = +(stripRevenue + keychainRevenue).toFixed(2);
      const add = (b) => {
        b.sessions += 1;
        if (!failed) {
          b.copies  += getIntegerField(s.totalPrintCopies ?? s.copies, 0);
          b.stripRevenue += stripRevenue;
          b.keychainRevenue += keychainRevenue;
          b.keychainUnits += sessionKeychainSummary.unitsSold;
          b.keychainSheets += sessionKeychainSummary.sheetsPrinted;
          b.keychainTransactions += sessionKeychainSummary.sheetsPrinted;
          b.revenue += totalRevenue;
          b.totalRevenue += totalRevenue;
        } else {
          b.failed  += 1;
        }
      };
      add(buckets.allTime);
      if (d >= thirtyAgo) add(buckets.month);
      if (d >= sevenAgo)  add(buckets.week);
      if (d === today)    add(buckets.today);

      if (byDay[d] && !failed) {
        byDay[d].sessions += 1;
        byDay[d].copies   += getIntegerField(s.totalPrintCopies ?? s.copies, 0);
        byDay[d].stripRevenue += stripRevenue;
        byDay[d].keychainRevenue += keychainRevenue;
        byDay[d].keychainUnits += sessionKeychainSummary.unitsSold;
        byDay[d].keychainSheets += sessionKeychainSummary.sheetsPrinted;
        byDay[d].keychainTransactions += sessionKeychainSummary.sheetsPrinted;
        byDay[d].revenue += totalRevenue;
        byDay[d].totalRevenue += totalRevenue;
      }

      if (s.templateId && !failed) {
        const t = byTemplate[s.templateId] || {
          templateId: s.templateId,
          templateName: s.templateName || s.templateId,
          sessions: 0,
          copies: 0,
          revenue: 0,
          stripRevenue: 0,
          keychainRevenue: 0,
          totalRevenue: 0,
          keychainUnits: 0,
          keychainSheets: 0,
        };
        t.sessions += 1;
        t.copies   += getIntegerField(s.totalPrintCopies ?? s.copies, 0);
        t.stripRevenue += stripRevenue;
        t.keychainRevenue += keychainRevenue;
        t.keychainUnits += sessionKeychainSummary.unitsSold;
        t.keychainSheets += sessionKeychainSummary.sheetsPrinted;
        t.revenue += stripRevenue;
        t.totalRevenue += totalRevenue;
        byTemplate[s.templateId] = t;
      }

      if (!failed) {
        for (const sale of sessionKeychainSales) {
          keychainSales.push({
            ...sale,
            sessionId: s.id,
            templateId: s.templateId || null,
            templateName: s.templateName || s.templateId || 'Unknown Template',
            layoutId: s.layoutId || null,
            layoutName: s.layoutName || s.layoutId || 'Unknown Layout',
            sessionTimestamp: s.timestamp || null,
            eventId: s.eventId || null,
            eventName: s.eventName || null,
            mode: s.mode || 'daily',
          });
        }
      }
    }
    const allKeychainSummary = summarizeKeychainSales(keychainSales);
    keychainSales.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    return {
      ok: true,
      totals: buckets,
      byDay: Object.values(byDay),              // chronological, oldest → newest
      byTemplate: Object.values(byTemplate)
        .sort((a, b) => b.revenue - a.revenue), // ranked by revenue desc
      keychains: {
        unitsSold: allKeychainSummary.unitsSold,
        revenue: allKeychainSummary.revenue,
        sheetsPrinted: allKeychainSummary.sheetsPrinted,
        transactions: allKeychainSummary.sheetsPrinted,
        recentSales: keychainSales.slice(0, 12),
      },
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('sessions:clear', async () => {
  // Destructive: wipes the JSONL so analytics restart from zero.
  // Only reachable from the admin dashboard behind a confirm modal.
  try {
    if (fs.existsSync(sessionsFile)) await fsp.unlink(sessionsFile);
    invalidateSessionsCache();
    // Tell every renderer so an open dashboard re-pulls its (now empty) state.
    broadcastToRenderers('sessions:cleared');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('today-monitor:reset-today-records', async () => {
  try {
    console.log('[today-monitor reset main] handler called');
    const today = toLocalDateYmd();
    const allSessions = await readAllSessions();
    const remainingSessions = allSessions.filter((session) => getSessionLocalDate(session) !== today);
    const removedCount = allSessions.length - remainingSessions.length;

    await writeAllSessions(remainingSessions);

    const payload = {
      ok: true,
      today,
      removedCount,
      remainingCount: remainingSessions.length,
    };
    broadcastToRenderers('today-monitor:records-reset', payload);
    return payload;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.removeHandler('today-monitor:print-extra-session-copy');
ipcMain.handle('today-monitor:print-extra-session-copy', async (event, payload = {}) => {
  try {
    console.log('[main ipc] print extra handler called', payload);
    console.log('[extra print main] today-monitor:print-extra-session-copy called', payload);
    console.log('[today-monitor print-extra main] handler called', {
      sessionId: payload?.sessionId || null,
      copies: payload?.copies,
    });

    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!sessionId) {
      return { ok: false, error: 'Missing sessionId' };
    }

    const sessionCopies = clampPrintCopies(payload.copies ?? 1);
    if (sessionCopies !== 1) {
      console.log('[today-monitor print-extra main] forcing single copy', { requestedCopies: sessionCopies });
    }

    const allSessions = await readAllSessions();
    const session = allSessions.find((record) => record && record.id === sessionId) || null;
    console.log('[extra print main] session lookup result', {
      sessionId,
      session,
      keys: session ? Object.keys(session) : null,
    });
    if (!session) {
      return { ok: false, error: 'Session not found' };
    }
    if (session.status !== 'completed') {
      return { ok: false, error: 'Session is not completed' };
    }

    const settings = await readSettings();
    if (settings.printEnabled === false) {
      return { ok: false, error: 'Printing is disabled by admin' };
    }

    const printImage = await resolveReprintImagePath(session);
    console.log('[extra print path audit]', {
      sessionId,
      expectedImagePath: printImage?.expectedImagePath || null,
      isAbsolute: path.isAbsolute(printImage?.expectedImagePath || ''),
      resolvedPath: printImage?.resolvedPath || null,
      exists: printImage?.resolvedPath ? fs.existsSync(printImage.resolvedPath) : false,
      userDataDir: app.getPath('userData'),
      downloadsDir: app.getPath('downloads'),
      source: printImage?.source || null,
      metadataPath: printImage?.metadataPath || null,
    });
    if (!printImage?.resolvedPath) {
      return { ok: false, error: 'Media unavailable on this device. No saved print image was found for this session.' };
    }
    if (!fs.existsSync(printImage.resolvedPath)) {
      return { ok: false, error: `Reprint image file does not exist: ${printImage.resolvedPath}` };
    }
    const stats = fs.statSync(printImage.resolvedPath);
    if (!stats || stats.size <= 0) {
      return { ok: false, error: `Reprint image file is empty: ${printImage.resolvedPath}` };
    }

    const target = await resolveTargetPrinter(event.sender);
    const printerName = target.printer.name;
    const dataUrl = filePathToDataUrl(printImage.resolvedPath);
    const job = {
      id: `reprint_${sessionId}_${Date.now()}`,
      sessionId,
      cameraOrientation: normalizeSessionCameraOrientation(session.cameraOrientation),
      finalCopies: 1,
    };

    const result = await submitSinglePrintCopy({
      dataUrl,
      silent: true,
      job,
      copyIndex: 1,
      printerName,
    });

    const normalized = normalizePrintResult({
      status: result.success ? 'completed' : 'failed',
      copiesRequested: 1,
      copiesPrinted: result.success ? 1 : 0,
      error: result.success ? null : (result.failureReason || 'print failed'),
      jobId: job.id,
      printerName,
    });

    console.log('[today-monitor print-extra main] result', {
      sessionId,
      printerName,
      ok: normalized.ok,
      status: normalized.status,
      copiesPrinted: normalized.copiesPrinted,
      error: normalized.error,
    });

    let updatedSession = null;
    if (normalized.ok) {
      updatedSession = await updateSessionRecord(sessionId, applySuccessfulExtraPrint);
      console.log('[today-monitor print-extra main] session metrics updated', {
        sessionId,
        extraPrintCount: updatedSession?.extraPrintCount,
        totalPrintCopies: updatedSession?.totalPrintCopies,
        extraPrintRevenue: updatedSession?.extraPrintRevenue,
        totalAmount: updatedSession?.totalAmount,
        lastExtraPrintAt: updatedSession?.lastExtraPrintAt,
      });
      if (updatedSession) {
        broadcastToRenderers('sessions:updated', updatedSession);
        broadcastToRenderers('today-monitor:sessions-updated', updatedSession);
      }
    }

    return {
      ...normalized,
      sessionId,
      printerName,
      sourcePath: printImage.resolvedPath,
      updatedSession,
    };
  } catch (err) {
    console.error('[today-monitor print-extra main] failed', err);
    return { ok: false, error: err?.message || String(err) };
  }
});
console.log('[main ipc] registered today-monitor:print-extra-session-copy');

ipcMain.removeHandler('today-monitor:generate-and-print-keychain');
ipcMain.handle('today-monitor:generate-and-print-keychain', async (event, payload = {}) => {
  try {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
    const keychainCopies = normalizeKeychainCopies(payload.keychainCopies);
    const keychainAmount = keychainCopies ? getKeychainSaleAmount(keychainCopies) : 0;
    console.log('[main ipc] keychain handler called', payload);
    console.log('[keychain main] today-monitor:generate-and-print-keychain called', payload);
    console.log('[today-monitor keychain main] handler called', {
      sessionId,
      hasGeneratedPng: Boolean(payload.arrayBuffer || payload.data || payload.dataUrl),
      filename: payload.filename || null,
      keychainCopies,
      keychainAmount,
    });

    if (!sessionId) {
      return { ok: false, error: 'Missing sessionId' };
    }
    if (!keychainCopies) {
      return { ok: false, error: 'Invalid keychain quantity. Choose 2 or 3 keychains.' };
    }

    const allSessions = await readAllSessions();
    const session = allSessions.find((record) => record && record.id === sessionId) || null;
    console.log('[KEYCHAIN SALES AUDIT] session before', {
      sessionId,
      session,
      keys: session ? Object.keys(session) : null,
    });
    if (!session) {
      return { ok: false, error: 'Session not found' };
    }
    if (session.status !== 'completed') {
      return { ok: false, error: 'Session is not completed' };
    }

    const settings = await readSettings();
    if (settings.printEnabled === false) {
      return { ok: false, error: 'Printing is disabled by admin' };
    }

    const filename = typeof payload.filename === 'string' && payload.filename.toLowerCase().endsWith('.png')
      ? path.basename(payload.filename)
      : buildSessionKeychainFilename(session, keychainCopies, payload.generatedAt || Date.now());
    const downloadsDir = app.getPath('downloads');
    const targetPath = path.join(downloadsDir, filename);
    const existingKeychain = resolveStoredKeychainPath(session, keychainCopies);

    const printExistingKeychain = async (keychainFile, reusedExisting = true) => {
      const target = await resolveTargetPrinter(event.sender);
      const printerName = target.printer.name;
      const dataUrl = filePathToDataUrl(keychainFile.path);
      const job = {
        id: `keychain_${sessionId}_${Date.now()}`,
        sessionId,
        templateName: session.templateName || null,
        layoutName: session.layoutName || null,
        cameraOrientation: normalizeSessionCameraOrientation(session.cameraOrientation),
        finalCopies: 1,
        keychainCopies,
      };

      const result = await submitSinglePrintCopy({
        dataUrl,
        silent: true,
        job,
        copyIndex: 1,
        printerName,
      });

      const normalized = normalizePrintResult({
        status: result.success ? 'completed' : 'failed',
        copiesRequested: 1,
        copiesPrinted: result.success ? 1 : 0,
        error: result.success ? null : (result.failureReason || 'keychain print failed'),
        jobId: job.id,
        printerName,
      });

      if (!normalized.ok) {
        const failedSession = await updateSessionRecord(sessionId, (record) => applyFailedKeychainPrint(record, normalized.error));
        if (failedSession) {
          broadcastToRenderers('sessions:updated', failedSession);
          broadcastToRenderers('today-monitor:sessions-updated', failedSession);
        }
        return {
          ...normalized,
          sessionId,
          printerName,
          keychainPath: keychainFile.path,
          filename: keychainFile.filename,
          reusedExisting,
          updatedSession: failedSession,
        };
      }

      console.log('[KEYCHAIN SALES] recording sale', {
        sessionId,
        keychainCopies,
        amount: keychainAmount,
        keychainPath: keychainFile.path,
      });
      console.log('[KEYCHAIN SALES AUDIT] sale result', {
        keychainCopies,
        amount: keychainAmount,
        keychainPath: keychainFile.path,
        printStatus: 'completed',
      });
      const updatedSession = await updateSessionRecord(sessionId, (record) => applySuccessfulKeychainPrint(record, {
        keychainPath: keychainFile.path,
        keychainFilename: keychainFile.filename,
        keychainGeneratedAt: record.keychainGeneratedAt || payload.generatedAt || new Date().toISOString(),
        keychainWidth: payload.width,
        keychainHeight: payload.height,
        keychainPlacementCount: payload.placementCount,
        keychainCopies,
      }));
      if (!updatedSession) {
        return {
          ok: false,
          error: 'Keychain printed, but the session sale record could not be updated.',
          sessionId,
          printerName,
          keychainPath: keychainFile.path,
          filename: keychainFile.filename,
          keychainCopies,
          keychainAmount,
          reusedExisting,
        };
      }
      if (updatedSession) {
        broadcastToRenderers('sessions:updated', updatedSession);
        broadcastToRenderers('today-monitor:sessions-updated', updatedSession);
      }
      console.log('[KEYCHAIN SALES AUDIT] session after', {
        sessionId,
        updatedSession,
        keychainSales: updatedSession?.keychainSales,
        keychainUnitsSold: updatedSession?.keychainUnitsSold,
        keychainRevenue: updatedSession?.keychainRevenue,
        keychainSheetsPrinted: updatedSession?.keychainSheetsPrinted,
      });
      console.log('[KEYCHAIN SALES] updated session totals', {
        sessionId,
        keychainUnitsSold: updatedSession.keychainUnitsSold,
        keychainRevenue: updatedSession.keychainRevenue,
        keychainSheetsPrinted: updatedSession.keychainSheetsPrinted,
      });

      console.log('[today-monitor keychain main] printed', {
        sessionId,
        printerName,
        keychainPath: keychainFile.path,
        reusedExisting,
        keychainCopies,
        keychainAmount,
        keychainPrintCount: updatedSession?.keychainPrintCount || null,
        keychainUnitsSold: updatedSession?.keychainUnitsSold || null,
        keychainRevenue: updatedSession?.keychainRevenue || null,
        keychainSheetsPrinted: updatedSession?.keychainSheetsPrinted || null,
      });

      return {
        ...normalized,
        sessionId,
        printerName,
        keychainPath: keychainFile.path,
        filename: keychainFile.filename,
        keychainCopies,
        keychainAmount,
        reusedExisting,
        updatedSession,
      };
    };

    if (existingKeychain && !payload.forceRegenerate) {
      console.log('[today-monitor keychain main] reusing existing keychain', {
        sessionId,
        keychainPath: existingKeychain.path,
        filename: existingKeychain.filename,
        keychainCopies,
      });
      return printExistingKeychain(existingKeychain, true);
    }

    const generatedBuffer = normalizeRendererBinaryPayload(payload);
    if (!generatedBuffer?.length) {
      if (!session.layoutId) {
        return { ok: false, error: 'Session has no layout id for keychain generation.' };
      }
      const printImage = await resolveReprintImagePath(session);
      console.log('[today-monitor keychain main] source lookup', {
        sessionId,
        source: printImage?.source || null,
        sourcePath: printImage?.resolvedPath || null,
        filename,
      });
      if (!printImage?.resolvedPath) {
        return { ok: false, error: 'Media unavailable on this device. No saved final photo was found for this session.' };
      }
      return {
        ok: true,
        needsGeneration: true,
        sessionId,
        filename,
        keychainCopies,
        keychainAmount,
        layoutId: session.layoutId || null,
        layoutName: session.layoutName || null,
        templateId: session.templateId || null,
        templateName: session.templateName || null,
        selectedFilterCss: session.selectedFilterCss || '',
        sourcePath: printImage.resolvedPath,
        sourceDataUrl: filePathToDataUrl(printImage.resolvedPath),
      };
    }

    const mimeType = String(payload.mimeType || 'image/png').toLowerCase().split(';')[0];
    if (mimeType !== 'image/png') {
      return { ok: false, error: `Invalid keychain MIME type: ${mimeType}` };
    }

    await fsp.mkdir(downloadsDir, { recursive: true });
    let keychainFile = null;
    if (fs.existsSync(targetPath)) {
      const verification = verifyWrittenFile(targetPath);
      if (!verification.exists || verification.sizeBytes <= 0) {
        return { ok: false, error: `Existing keychain file is invalid: ${targetPath}` };
      }
      keychainFile = {
        path: targetPath,
        filename,
        sizeBytes: verification.sizeBytes,
      };
      console.log('[today-monitor keychain main] target exists; reusing generated file', {
        sessionId,
        targetPath,
        sizeBytes: verification.sizeBytes,
      });
    } else {
      console.log('[LOCAL SAVE AUDIT] saving media file', {
        type: 'keychain4x6',
        filename,
        targetPath,
        source: 'today-monitor:generate-and-print-keychain',
        reason: 'operator-triggered keychain local save',
      });
      console.log('[LOCAL SAVE AUDIT PNG]', {
        filename,
        isKeychain: true,
        isNormalPhoto: false,
        caller: 'electron today-monitor:generate-and-print-keychain',
      });
      await fsp.writeFile(targetPath, generatedBuffer, { flag: 'wx' });
      const verification = verifyWrittenFile(targetPath);
      if (!verification.exists || verification.sizeBytes <= 0) {
        return { ok: false, error: `Keychain file verification failed for ${targetPath}` };
      }
      keychainFile = {
        path: targetPath,
        filename,
        sizeBytes: verification.sizeBytes,
      };
      console.log('[today-monitor keychain main] saved keychain', {
        sessionId,
        filename,
        targetPath,
        sizeBytes: verification.sizeBytes,
      });
    }

    return printExistingKeychain(keychainFile, false);
  } catch (err) {
    console.error('[today-monitor keychain main] failed', err);
    return { ok: false, error: err?.message || String(err) };
  }
});
console.log('[main ipc] registered today-monitor:generate-and-print-keychain');

ipcMain.handle('session:reset', async () => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('session:reset');
    }
    console.log('[session] reset requested');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('monitor:status', async () => ({
  ok: true,
  running: Boolean(todayMonitorWindow && !todayMonitorWindow.isDestroyed()),
}));

ipcMain.handle('app:quit', async () => {
  try {
    app.isQuitting = true;
    app.quit();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Print pipeline
// ─────────────────────────────────────────────────────────────────────────
const MICRONS_PER_INCH = 25400;
const MIN_PRINT_COPIES = 1;
const MAX_PRINT_COPIES = 3;
const DEFAULT_PRINT_COPIES = 1;
const MAX_PRINT_QUEUE_JOBS = 50;
const FINAL_PRINT_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled', 'partial']);
const WINDOWS_SELPHY_CP1500_SCALE_FACTOR = 108;
const printQueue = [];
const pendingPrintJobs = new Map();
let activePrintJobId = null;
const PRINTER_DISCOVERY_CACHE_MS = 10_000;
let printerDiscoveryCache = {
  expiresAt: 0,
  printers: null,
};
const DEFAULT_ELECTRON_PRINT_PAGE = Object.freeze({
  id: 'default_4x6',
  cssWidth: '4in',
  cssHeight: '6in',
  widthMicrons: 4 * MICRONS_PER_INCH,
  heightMicrons: 6 * MICRONS_PER_INCH,
  widthMm: 101.6,
  heightMm: 152.4,
  imageFit: 'fill',
  preferCSSPageSize: false,
  windowsCompensation: null,
});
const WINDOWS_SELPHY_CP1500_PRINT_PAGE = Object.freeze({
  id: 'canon_selphy_cp1500_windows_zero_margin_4x6',
  cssWidth: '4in',
  cssHeight: '6in',
  widthMicrons: 4 * MICRONS_PER_INCH,
  heightMicrons: 6 * MICRONS_PER_INCH,
  widthMm: 101.6,
  heightMm: 152.4,
  imageFit: 'fill',
  preferCSSPageSize: false,
  scaleFactor: WINDOWS_SELPHY_CP1500_SCALE_FACTOR,
  dpi: { horizontal: 300, vertical: 300 },
  zeroMarginDocument: true,
  borderlessIntent: true,
  borderlessOverscanPercent: 0,
  windowsCompensation: 'Windows Canon SELPHY CP1500 driver shrinks the rendered page to its printable area. Keep the generated PNG unchanged and compensate only in the Windows print transform.',
});

function normalizePrinterStatus(status) {
  if (status == null || status === '') {
    return { label: 'Unknown', available: true, reason: null };
  }
  if (typeof status === 'number') {
    const unavailableMask = 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 512 | 1024 | 2048 | 4096 | 8192;
    return {
      label: status === 0 ? 'Idle' : `Status ${status}`,
      available: status === 0 || (status & unavailableMask) === 0,
      reason: status === 0 || (status & unavailableMask) === 0 ? null : 'unavailable status',
    };
  }

  const label = String(status).trim() || 'Unknown';
  const lower = label.toLowerCase();
  const avoid = ['offline', 'stopped', 'error', 'paused', 'not available', 'unavailable'];
  const unavailable = avoid.some((term) => lower.includes(term));
  return {
    label,
    available: !unavailable,
    reason: unavailable ? label : null,
  };
}

function isSelphyPrinter(printer = {}) {
  const label = `${printer.name || ''} ${printer.displayName || ''} ${printer.description || ''}`.toLowerCase();
  return label.includes('canon selphy') || label.includes('selphy cp1500') || label.includes('cp1500') || label.includes('selphy');
}

function getPrintPageConfig(printer = null) {
  if (process.platform === 'win32' && isSelphyPrinter(printer || {})) {
    return WINDOWS_SELPHY_CP1500_PRINT_PAGE;
  }
  return DEFAULT_ELECTRON_PRINT_PAGE;
}

function buildPrintShell(printDocumentTitle, printPageConfig) {
  if (printPageConfig.zeroMarginDocument) {
    const fitCss = printPageConfig.imageFit === 'cover'
      ? `
    object-fit: cover;
    object-position: center center;`
      : `
    object-fit: fill;`;
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${printDocumentTitle}</title>
<style>
  @page { size: ${printPageConfig.cssWidth} ${printPageConfig.cssHeight}; margin: 0; }
  * { box-sizing: border-box; }
  html {
    margin: 0 !important;
    padding: 0 !important;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #fff;
  }
  body {
    margin: 0 !important;
    padding: 0 !important;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #fff;
  }
  #print-root {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0 !important;
    padding: 0 !important;
    border: 0;
    outline: 0;
    overflow: hidden;
    line-height: 0;
    background: #fff;
  }
  #print-root img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    max-width: none;
    max-height: none;
    display: block;
    margin: 0 !important;
    padding: 0 !important;
    border: 0;
    outline: 0;${fitCss}
    image-rendering: -webkit-optimize-contrast;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
</style>
</head>
<body><div id="print-root"></div></body>
</html>`;
  }

  const coverCss = printPageConfig.imageFit === 'cover'
    ? `
    object-fit: cover;
    object-position: center center;`
    : '';
  const overflowCss = printPageConfig.imageFit === 'cover' ? ' overflow: hidden;' : '';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${printDocumentTitle}</title>
<style>
  @page { size: ${printPageConfig.cssWidth} ${printPageConfig.cssHeight}; margin: 0; }
  html, body { margin: 0; padding: 0; width: ${printPageConfig.cssWidth}; height: ${printPageConfig.cssHeight}; background: #fff;${overflowCss} }
  img {
    width: ${printPageConfig.cssWidth};
    height: ${printPageConfig.cssHeight};
    display: block;${coverCss}
    image-rendering: -webkit-optimize-contrast;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
</style>
</head>
<body></body>
</html>`;
}

function normalizePrinterInfo(printer = {}) {
  const statusInfo = normalizePrinterStatus(printer.status);
  return {
    name: typeof printer.name === 'string' ? printer.name : '',
    displayName: typeof printer.displayName === 'string' ? printer.displayName : null,
    description: typeof printer.description === 'string' ? printer.description : null,
    status: printer.status ?? null,
    statusLabel: statusInfo.label,
    isDefault: printer.isDefault === true,
    options: printer.options && typeof printer.options === 'object' ? printer.options : null,
    isSelphy: isSelphyPrinter(printer),
    isAvailable: statusInfo.available,
    unavailableReason: statusInfo.reason,
  };
}

async function getDetectedPrinters(webContents, { force = false } = {}) {
  const now = Date.now();
  if (!force && printerDiscoveryCache.printers && printerDiscoveryCache.expiresAt > now) {
    return printerDiscoveryCache.printers.map((printer) => ({ ...printer }));
  }
  const printers = await webContents.getPrintersAsync();
  console.log('[printers] detected', printers.map((printer) => ({
    name: printer.name,
    displayName: printer.displayName,
    status: printer.status,
    isDefault: printer.isDefault,
  })));
  const normalized = printers.map(normalizePrinterInfo).filter((printer) => printer.name);
  printerDiscoveryCache = {
    expiresAt: now + PRINTER_DISCOVERY_CACHE_MS,
    printers: normalized,
  };
  return normalized.map((printer) => ({ ...printer }));
}

async function getPrinterListForRenderer(webContents, options = {}) {
  const printers = await getDetectedPrinters(webContents, options);
  const selphyPrinters = printers.filter((printer) => printer.isSelphy);
  const defaultPrinter = printers.find((printer) => printer.isDefault) || null;
  const defaultSelphyOffline = defaultPrinter?.isSelphy && defaultPrinter.isAvailable === false;
  const onlineSelphyExists = selphyPrinters.some((printer) => printer.isAvailable);
  const guidance = defaultSelphyOffline && onlineSelphyExists
    ? 'Your default Canon SELPHY appears offline, but another SELPHY queue is online. Select an online printer before printing.'
    : null;
  return { printers, selphyPrinters, defaultPrinter, guidance };
}

async function persistSelectedPrinterName(selectedPrinterName) {
  const current = await readSettings();
  if (current.selectedPrinterName === selectedPrinterName) return current;
  const next = { ...current, selectedPrinterName };
  await writeSettings(next);
  console.log('[printers] selected printer saved', selectedPrinterName);
  broadcastToAllWindows('settings:changed', next);
  return next;
}

async function resolveTargetPrinter(webContents) {
  const settings = await readSettings();
  const printerList = await getPrinterListForRenderer(webContents);
  const { printers, selphyPrinters } = printerList;
  const availableSelphyPrinters = selphyPrinters.filter((printer) => printer.isAvailable);
  const selectedPrinterName = settings.selectedPrinterName || null;
  const selectedPrinter = selectedPrinterName
    ? printers.find((printer) => printer.name === selectedPrinterName)
    : null;

  console.log('[print] resolving printer', {
    selectedPrinterName,
    availablePrinterNames: printers.map((printer) => printer.name),
    selphyPrinterNames: selphyPrinters.map((printer) => printer.name),
  });

  if (selphyPrinters.length > 1) {
    console.log('[print] duplicate SELPHY queues found; using one', {
      selectedPrinterName,
      selphyPrinterNames: selphyPrinters.map((printer) => printer.name),
    });
  }

  if (selectedPrinterName) {
    if (!selectedPrinter) {
      const diagnostics = buildPrintDiagnostics({
        selectedDevice: selectedPrinterName,
        selectedPrinterName,
        printer: null,
        printerList,
        staleSavedSelection: true,
        message: 'Saved printer selection is not present on this machine.',
      });
      logPrintDiagnostics(diagnostics);
      await persistSelectedPrinterName(null);
      if (availableSelphyPrinters.length === 1) {
        const targetPrinter = availableSelphyPrinters[0];
        const nextSettings = await persistSelectedPrinterName(targetPrinter.name);
        console.log('[print] stale selected printer replaced with local printer queue', {
          staleSelectedPrinterName: selectedPrinterName,
          targetPrinterName: targetPrinter.name,
          platform: process.platform,
        });
        return { printer: targetPrinter, settings: nextSettings, printerList };
      }
      throw createPrintDiagnosticError(
        'Saved printer selection is missing on this machine. Select the actual Windows Canon SELPHY printer in Today Monitor or Admin Settings.',
        diagnostics,
      );
    }
    if (selectedPrinter.isAvailable === false) {
      const diagnostics = buildPrintDiagnostics({
        selectedDevice: selectedPrinter.name,
        selectedPrinterName,
        printer: selectedPrinter,
        printerList,
        message: 'Selected printer is marked unavailable by the operating system.',
      });
      logPrintDiagnostics(diagnostics);
      throw createPrintDiagnosticError(
        'Selected printer is offline. Choose an online Canon SELPHY printer in Today Monitor or Admin Settings.',
        diagnostics,
      );
    }
    console.log('[print] target printer resolved', {
      selectedPrinterName,
      targetPrinterName: selectedPrinter.name,
      isDefault: selectedPrinter.isDefault,
      status: selectedPrinter.status,
    });
    return { printer: selectedPrinter, settings, printerList };
  }

  if (availableSelphyPrinters.length === 0) {
    const diagnostics = buildPrintDiagnostics({
      selectedDevice: null,
      selectedPrinterName,
      printer: null,
      printerList,
      message: 'No online Canon SELPHY printer queue was found.',
    });
    logPrintDiagnostics(diagnostics);
    throw createPrintDiagnosticError(
      'No online Canon SELPHY printer queue was found. Select or reconnect a Canon SELPHY printer in Admin Settings.',
      diagnostics,
    );
  }

  const targetPrinter = availableSelphyPrinters[0];
  const nextSettings = await persistSelectedPrinterName(targetPrinter.name);
  console.log('[print] target printer resolved', {
    selectedPrinterName: null,
    targetPrinterName: targetPrinter.name,
    isDefault: targetPrinter.isDefault,
    status: targetPrinter.status,
  });
  return { printer: targetPrinter, settings: nextSettings, printerList };
}

function clampPrintCopies(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return DEFAULT_PRINT_COPIES;
  return Math.min(MAX_PRINT_COPIES, Math.max(MIN_PRINT_COPIES, Math.floor(numericValue)));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safePrintFilename(input = '') {
  const base = String(input || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return base || `afterimage-strip-${Date.now()}.png`;
}

function newPrintJobId() {
  return `print_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function safeQueueText(value, max = 128) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function serializePrintJob(job) {
  return {
    id: job.id,
    sessionId: job.sessionId || null,
    templateName: job.templateName || null,
    layoutName: job.layoutName || null,
    cameraOrientation: normalizeSessionCameraOrientation(job.cameraOrientation),
    copies: job.copies,
    printerName: job.printerName || null,
    requestedCopies: job.requestedCopies,
    finalCopies: job.finalCopies,
    completedCopies: job.completedCopies,
    currentCopy: job.currentCopy,
    status: job.status,
    cancelRequested: Boolean(job.cancelRequested),
    error: job.error || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
  };
}

function normalizePrintResult({
  status = 'failed',
  copiesRequested = 0,
  copiesPrinted = 0,
  error = null,
  failureReason = null,
  rawFailureReason = null,
  jobId = null,
  printerName = null,
  deviceName = null,
  printerDiagnostics = null,
  availablePrinters = null,
  printOptions = null,
} = {}) {
  const finalStatus = ['completed', 'failed', 'cancelled', 'partial'].includes(status) ? status : 'failed';
  const safeRequested = Math.max(0, Math.floor(Number(copiesRequested) || 0));
  const safePrinted = Math.max(0, Math.min(safeRequested || Number.MAX_SAFE_INTEGER, Math.floor(Number(copiesPrinted) || 0)));
  const safeError = typeof error === 'string' && error.trim() ? error.trim().slice(0, 256) : null;
  const safeFailureReason = typeof failureReason === 'string' && failureReason.trim()
    ? failureReason.trim().slice(0, 512)
    : null;
  const safeRawFailureReason = typeof rawFailureReason === 'string' && rawFailureReason.trim()
    ? rawFailureReason.trim().slice(0, 512)
    : safeFailureReason;
  const safeDeviceName = typeof deviceName === 'string' && deviceName.trim()
    ? deviceName.trim().slice(0, 256)
    : printerName;
  const serializedDiagnostics = printerDiagnostics && typeof printerDiagnostics === 'object'
    ? compactDiagnosticValue(printerDiagnostics)
    : null;
  const serializedPrinters = Array.isArray(availablePrinters)
    ? availablePrinters.slice(0, 30).map((printer) => compactDiagnosticValue(printer))
    : null;
  return {
    ok: finalStatus === 'completed',
    success: finalStatus === 'completed',
    status: finalStatus,
    copiesRequested: safeRequested,
    copiesPrinted: safePrinted,
    requestedCopies: safeRequested,
    completedCopies: safePrinted,
    error: safeError,
    failureReason: finalStatus === 'failed' || finalStatus === 'partial' ? (safeRawFailureReason || safeError) : null,
    rawFailureReason: safeRawFailureReason,
    jobId,
    printerName: safeDeviceName,
    deviceName: safeDeviceName,
    printerDiagnostics: serializedDiagnostics,
    availablePrinters: serializedPrinters,
    printOptions: printOptions && typeof printOptions === 'object' ? compactDiagnosticValue(printOptions) : null,
  };
}

function summarizePrinterForDiagnostics(printer = {}) {
  return {
    name: printer.name || null,
    displayName: printer.displayName || null,
    description: printer.description || null,
    status: printer.status ?? null,
    statusLabel: printer.statusLabel || null,
    options: printer.options && typeof printer.options === 'object' ? compactDiagnosticValue(printer.options) : null,
    isDefault: printer.isDefault === true,
    isSelphy: printer.isSelphy === true,
    isAvailable: printer.isAvailable ?? null,
    unavailableReason: printer.unavailableReason || null,
  };
}

function sanitizePrintOptions(options = {}) {
  return {
    silent: options.silent === true,
    printBackground: options.printBackground === true,
    copies: options.copies || null,
    deviceName: options.deviceName || null,
    pageSize: options.pageSize || null,
    margins: options.margins || null,
    landscape: options.landscape === true,
    scaleFactor: options.scaleFactor || null,
    dpi: options.dpi || null,
    preferCSSPageSize: options.preferCSSPageSize === true,
  };
}

function roundDiagnosticNumber(value, decimals = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** decimals;
  return Math.round(number * factor) / factor;
}

function micronsToMm(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number / 1000 : null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function findObjectWithMicronPageSize(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);

  const widthMicrons = firstFiniteNumber(
    value.width_microns,
    value.widthMicrons,
    value.widthMicron,
    value.page_width_microns,
    value.pageWidthMicrons,
  );
  const heightMicrons = firstFiniteNumber(
    value.height_microns,
    value.heightMicrons,
    value.heightMicron,
    value.page_height_microns,
    value.pageHeightMicrons,
  );
  if (widthMicrons && heightMicrons) {
    return value;
  }

  for (const child of Object.values(value)) {
    const found = findObjectWithMicronPageSize(child, seen);
    if (found) return found;
  }
  return null;
}

function extractPrinterMediaMetrics(printer = {}) {
  const source = findObjectWithMicronPageSize(printer.options || {});
  if (!source) {
    return {
      pageSize: null,
      printableArea: null,
      printableScalePercent: null,
      source: null,
      available: false,
    };
  }

  const widthMicrons = firstFiniteNumber(
    source.width_microns,
    source.widthMicrons,
    source.widthMicron,
    source.page_width_microns,
    source.pageWidthMicrons,
  );
  const heightMicrons = firstFiniteNumber(
    source.height_microns,
    source.heightMicrons,
    source.heightMicron,
    source.page_height_microns,
    source.pageHeightMicrons,
  );
  const imageableLeftMicrons = firstFiniteNumber(source.imageable_area_left_microns, source.imageableAreaLeftMicrons);
  const imageableRightMicrons = firstFiniteNumber(source.imageable_area_right_microns, source.imageableAreaRightMicrons);
  const imageableTopMicrons = firstFiniteNumber(source.imageable_area_top_microns, source.imageableAreaTopMicrons);
  const imageableBottomMicrons = firstFiniteNumber(source.imageable_area_bottom_microns, source.imageableAreaBottomMicrons);
  const printableWidthMicrons = imageableLeftMicrons != null && imageableRightMicrons != null
    ? Math.max(0, imageableRightMicrons - imageableLeftMicrons)
    : null;
  const printableHeightMicrons = imageableBottomMicrons != null && imageableTopMicrons != null
    ? Math.max(0, imageableTopMicrons - imageableBottomMicrons)
    : null;
  const printableScalePercent = widthMicrons && heightMicrons && printableWidthMicrons && printableHeightMicrons
    ? Math.min(printableWidthMicrons / widthMicrons, printableHeightMicrons / heightMicrons) * 100
    : null;

  return {
    pageSize: {
      widthMicrons,
      heightMicrons,
      widthMm: roundDiagnosticNumber(micronsToMm(widthMicrons), 3),
      heightMm: roundDiagnosticNumber(micronsToMm(heightMicrons), 3),
    },
    printableArea: printableWidthMicrons && printableHeightMicrons
      ? {
          leftMicrons: imageableLeftMicrons,
          rightMicrons: imageableRightMicrons,
          topMicrons: imageableTopMicrons,
          bottomMicrons: imageableBottomMicrons,
          widthMicrons: printableWidthMicrons,
          heightMicrons: printableHeightMicrons,
          widthMm: roundDiagnosticNumber(micronsToMm(printableWidthMicrons), 3),
          heightMm: roundDiagnosticNumber(micronsToMm(printableHeightMicrons), 3),
        }
      : null,
    printableScalePercent: roundDiagnosticNumber(printableScalePercent, 2),
    source: source.name || source.custom_display_name || source.display_name || null,
    available: true,
  };
}

function collectPrinterOptionMatches(value, terms, pathName = 'options', out = [], seen = new Set()) {
  if (out.length >= 30) return out;
  if (value == null) return out;

  if (typeof value === 'object') {
    if (seen.has(value)) return out;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        collectPrinterOptionMatches(item, terms, `${pathName}[${index}]`, out, seen);
      });
      return out;
    }
    Object.entries(value).forEach(([key, child]) => {
      const nextPath = `${pathName}.${key}`;
      const keyText = String(key).toLowerCase();
      const childText = typeof child === 'object' ? '' : String(child || '').toLowerCase();
      const matchedTerms = terms.filter((term) => keyText.includes(term) || childText.includes(term));
      if (matchedTerms.length && out.length < 30) {
        out.push({
          path: nextPath,
          value: typeof child === 'object' ? '[object]' : String(child).slice(0, 160),
          matchedTerms,
        });
      }
      collectPrinterOptionMatches(child, terms, nextPath, out, seen);
    });
    return out;
  }

  const valueText = String(value).toLowerCase();
  const matchedTerms = terms.filter((term) => valueText.includes(term));
  if (matchedTerms.length && out.length < 30) {
    out.push({
      path: pathName,
      value: String(value).slice(0, 160),
      matchedTerms,
    });
  }
  return out;
}

function optionPathLooksSelected(pathName = '') {
  const pathText = String(pathName).toLowerCase();
  return ['selected', 'current', 'default', 'active'].some((term) => pathText.includes(term));
}

function buildBorderlessPrintDiagnostics(printer = {}, printPageConfig = {}, printOptions = {}) {
  const borderlessTerms = ['borderless', 'border-less', 'full bleed', 'full-bleed', 'edge-to-edge', 'edge to edge'];
  const paperTerms = ['postcard', '4x6', '4 x 6', '100x148', '100 x 148', 'photo', 'bordered', 'media', 'paper'];
  const borderlessMatches = collectPrinterOptionMatches(printer.options || {}, borderlessTerms);
  const paperMatches = collectPrinterOptionMatches(printer.options || {}, paperTerms);
  const selectedBorderlessMatches = borderlessMatches.filter((match) => optionPathLooksSelected(match.path));
  const selectedPaperMatches = paperMatches.filter((match) => optionPathLooksSelected(match.path));
  const knownSelphy = isSelphyPrinter(printer);

  return {
    supportedByKnownPrinterProfile: knownSelphy,
    exposedInPrinterOptions: borderlessMatches.length > 0,
    selectedInPrinterOptions: selectedBorderlessMatches.length > 0
      ? true
      : (borderlessMatches.length > 0 ? false : null),
    selectedByElectronOption: false,
    electronBorderlessOptionAvailable: false,
    appRequestedZeroMargins: printOptions?.margins?.marginType === 'none'
      || (printOptions?.margins?.marginType === 'custom'
        && Number(printOptions?.margins?.top) === 0
        && Number(printOptions?.margins?.right) === 0
        && Number(printOptions?.margins?.bottom) === 0
        && Number(printOptions?.margins?.left) === 0),
    appRequestedBorderlessIntent: printPageConfig.borderlessIntent === true,
    overscanPercent: Number(printPageConfig.borderlessOverscanPercent) || 0,
    driverPreferenceRequired: true,
    borderlessMatches,
    selectedBorderlessMatches,
    paperMatches,
    selectedPaperMatches,
  };
}

function buildPrintFitDiagnostics(printPageConfig, readiness = {}, printOptions = {}, printer = {}) {
  const sourceWidth = Number(readiness?.naturalWidth) || null;
  const sourceHeight = Number(readiness?.naturalHeight) || null;
  const sourceAspect = sourceWidth && sourceHeight ? sourceWidth / sourceHeight : null;
  const pageAspect = printPageConfig.widthMm / printPageConfig.heightMm;
  const printerMedia = extractPrinterMediaMetrics(printer);
  const borderless = buildBorderlessPrintDiagnostics(printer, printPageConfig, printOptions);
  const scaleFactor = Number(printOptions?.scaleFactor) || 100;
  const scaleMultiplier = scaleFactor / 100;
  let effectiveRenderedWidthMm = printPageConfig.widthMm;
  let effectiveRenderedHeightMm = printPageConfig.heightMm;
  let cropLeftMm = 0;
  let cropRightMm = 0;
  let cropTopMm = 0;
  let cropBottomMm = 0;

  if (printPageConfig.imageFit === 'cover' && sourceAspect) {
    if (sourceAspect > pageAspect) {
      effectiveRenderedWidthMm = printPageConfig.heightMm * sourceAspect;
      const cropMm = Math.max(0, effectiveRenderedWidthMm - printPageConfig.widthMm) / 2;
      cropLeftMm = cropMm;
      cropRightMm = cropMm;
    } else {
      effectiveRenderedHeightMm = printPageConfig.widthMm / sourceAspect;
      const cropMm = Math.max(0, effectiveRenderedHeightMm - printPageConfig.heightMm) / 2;
      cropTopMm = cropMm;
      cropBottomMm = cropMm;
    }
  }

  return {
    sourceImage: {
      widthPx: sourceWidth,
      heightPx: sourceHeight,
      aspect: sourceAspect,
      renderedWidthPx: Number(readiness?.renderedWidth) || null,
      renderedHeightPx: Number(readiness?.renderedHeight) || null,
    },
    printDocument: {
      devicePixelRatio: Number(readiness?.devicePixelRatio) || null,
      htmlWidthPx: Number(readiness?.htmlWidth) || null,
      htmlHeightPx: Number(readiness?.htmlHeight) || null,
      bodyWidthPx: Number(readiness?.bodyWidth) || null,
      bodyHeightPx: Number(readiness?.bodyHeight) || null,
      rootWidthPx: Number(readiness?.rootWidth) || null,
      rootHeightPx: Number(readiness?.rootHeight) || null,
      imageCssWidth: readiness?.imageCssWidth || null,
      imageCssHeight: readiness?.imageCssHeight || null,
      imageRenderedWidthPx: Number(readiness?.renderedWidth) || null,
      imageRenderedHeightPx: Number(readiness?.renderedHeight) || null,
      bodyMargin: readiness?.bodyMargin || null,
      bodyPadding: readiness?.bodyPadding || null,
      rootMargin: readiness?.rootMargin || null,
      rootPadding: readiness?.rootPadding || null,
      rootBorderWidth: readiness?.rootBorderWidth || null,
    },
    expectedPhysicalDimensions: {
      widthMm: printPageConfig.widthMm,
      heightMm: printPageConfig.heightMm,
      widthIn: printPageConfig.widthMm / 25.4,
      heightIn: printPageConfig.heightMm / 25.4,
    },
    requestedPageSize: {
      widthMicrons: printPageConfig.widthMicrons,
      heightMicrons: printPageConfig.heightMicrons,
      widthMm: printPageConfig.widthMm,
      heightMm: printPageConfig.heightMm,
    },
    reportedPrinterPageSize: printerMedia.pageSize,
    reportedPrinterPrintableArea: printerMedia.printableArea,
    reportedPrintableScalePercent: printerMedia.printableScalePercent,
    printerMediaSource: printerMedia.source,
    borderless,
    cssPageSize: {
      width: printPageConfig.cssWidth,
      height: printPageConfig.cssHeight,
      margin: '0',
    },
    cssImageFit: printPageConfig.imageFit,
    cssMargins: {
      page: 0,
      html: 0,
      body: 0,
      root: 0,
      image: 0,
    },
    applicationMargins: {
      page: 0,
      document: 0,
      container: 0,
      electronMarginType: 'none',
      safeMarginAppliedInGeneratedImageOnly: true,
    },
    pageAspect,
    calculatedScale: {
      electronScaleFactorPercent: scaleFactor,
      preDriverScalePercent: roundDiagnosticNumber(scaleFactor, 2),
      reportedPrintableScalePercent: printerMedia.printableScalePercent,
      predictedAfterPrintableFitScalePercent: printerMedia.printableScalePercent
        ? roundDiagnosticNumber(scaleFactor * (printerMedia.printableScalePercent / 100), 2)
        : null,
      scaleNeededToNeutralizeReportedPrintableFit: printerMedia.printableScalePercent
        ? roundDiagnosticNumber(10000 / printerMedia.printableScalePercent, 2)
        : null,
    },
    effectivePrintDimensions: {
      renderedWidthMm: roundDiagnosticNumber(effectiveRenderedWidthMm * scaleMultiplier, 3),
      renderedHeightMm: roundDiagnosticNumber(effectiveRenderedHeightMm * scaleMultiplier, 3),
      unscaledRenderedWidthMm: roundDiagnosticNumber(effectiveRenderedWidthMm, 3),
      unscaledRenderedHeightMm: roundDiagnosticNumber(effectiveRenderedHeightMm, 3),
      horizontalUnusedMm: roundDiagnosticNumber(Math.max(0, printPageConfig.widthMm - (effectiveRenderedWidthMm * scaleMultiplier)), 3),
      verticalUnusedMm: roundDiagnosticNumber(Math.max(0, printPageConfig.heightMm - (effectiveRenderedHeightMm * scaleMultiplier)), 3),
      horizontalOverflowMm: roundDiagnosticNumber(Math.max(0, (effectiveRenderedWidthMm * scaleMultiplier) - printPageConfig.widthMm), 3),
      verticalOverflowMm: roundDiagnosticNumber(Math.max(0, (effectiveRenderedHeightMm * scaleMultiplier) - printPageConfig.heightMm), 3),
      cropLeftMm: roundDiagnosticNumber(cropLeftMm, 3),
      cropRightMm: roundDiagnosticNumber(cropRightMm, 3),
      cropTopMm: roundDiagnosticNumber(cropTopMm, 3),
      cropBottomMm: roundDiagnosticNumber(cropBottomMm, 3),
    },
    windowsCompensation: process.platform === 'win32' ? printPageConfig.windowsCompensation : null,
  };
}

function buildPrintDiagnostics({
  selectedDevice = null,
  selectedPrinterName = null,
  printer = null,
  printerList = null,
  printOptions = null,
  job = null,
  copyIndex = null,
  artworkReady = null,
  htmlLoaded = null,
  imageLoaded = null,
  imageDecoded = null,
  layoutReady = null,
  webContentsPrintSuccess = null,
  failureReason = null,
  rawFailureReason = null,
  staleSavedSelection = false,
  message = null,
  printFit = null,
} = {}) {
  const availablePrinters = Array.isArray(printerList?.printers)
    ? printerList.printers.map(summarizePrinterForDiagnostics)
    : [];
  const selectedName = selectedDevice || selectedPrinterName || printer?.name || null;
  return {
    selectedDevice: selectedName,
    storedSelectedPrinterName: selectedPrinterName || null,
    found: Boolean(printer),
    availablePrinters,
    printerStatus: printer ? summarizePrinterForDiagnostics(printer) : null,
    staleSavedSelection: staleSavedSelection === true,
    artworkReady: artworkReady ?? null,
    htmlLoaded: htmlLoaded ?? null,
    imageLoaded: imageLoaded ?? null,
    imageDecoded: imageDecoded ?? null,
    layoutReady: layoutReady ?? null,
    printOptions: printOptions ? sanitizePrintOptions(printOptions) : null,
    sourceImage: printFit?.sourceImage || null,
    requestedPageSize: printFit?.requestedPageSize || null,
    expectedPhysicalDimensions: printFit?.expectedPhysicalDimensions || null,
    orientation: printOptions?.landscape === true ? 'landscape' : 'portrait',
    scaleFactor: printOptions?.scaleFactor ?? null,
    cssPageSize: printFit?.cssPageSize || null,
    cssMargins: printFit?.cssMargins || null,
    applicationMargins: printFit?.applicationMargins || null,
    cssImageFit: printFit?.cssImageFit || null,
    borderless: printFit?.borderless || null,
    windowsCompensation: printFit?.windowsCompensation || null,
    effectivePrintDimensions: printFit?.effectivePrintDimensions || null,
    printerDriverOptions: printer?.options && typeof printer.options === 'object' ? compactDiagnosticValue(printer.options) : null,
    webContentsPrintSuccess,
    failureReason: failureReason || null,
    rawFailureReason: rawFailureReason || failureReason || null,
    message: message || null,
    jobId: job?.id || null,
    sessionId: job?.sessionId || null,
    copyIndex,
    finalCopies: job?.finalCopies || null,
    platform: process.platform,
    isPackaged: app.isPackaged,
  };
}

function createPrintDiagnosticError(message, diagnostics) {
  const error = new Error(message);
  error.printDiagnostics = diagnostics;
  error.rawFailureReason = message;
  return error;
}

function logPrintDiagnostics(diagnostics) {
  console.log('[PRINT DIAGNOSTICS]', compactDiagnosticValue(diagnostics));
  writeDiagnosticEvent('PRINT DIAGNOSTICS', diagnostics);
}

function filePathToDataUrl(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('Missing session image path');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Session image not found: ${filePath}`);
  }
  const stats = fs.statSync(filePath);
  if (!stats || stats.size <= 0) {
    throw new Error(`Session image is empty: ${filePath}`);
  }

  const image = nativeImage.createFromPath(filePath);
  if (!image || image.isEmpty()) {
    throw new Error(`Could not load session image: ${filePath}`);
  }

  const dataUrl = image.toDataURL();
  if (!dataUrl || typeof dataUrl !== 'string') {
    throw new Error('Could not encode session image for printing');
  }
  return dataUrl;
}

async function resolveReprintImagePath(session) {
  const directCandidates = [
    session?.finalPrintPath,
    session?.printImagePath,
    session?.localPhotoPath,
    session?.photoPath,
  ].filter((value) => typeof value === 'string' && value.trim());

  for (const candidate of directCandidates) {
    const resolvedCandidate = path.isAbsolute(candidate) ? candidate : path.join(app.getPath('downloads'), candidate);
    if (fs.existsSync(resolvedCandidate)) {
      return {
        source: 'direct',
        expectedImagePath: candidate,
        resolvedPath: resolvedCandidate,
      };
    }
  }

  const sessionToken = typeof session?.softcopySessionToken === 'string' ? session.softcopySessionToken.trim() : '';
  if (!sessionToken) {
    return null;
  }

  const shortToken = sessionToken.replace(/-/g, '').slice(0, 8);
  const downloadsDir = app.getPath('downloads');
  const entries = await fsp.readdir(downloadsDir, { withFileTypes: true }).catch(() => []);
  const metadataFiles = entries
    .filter((entry) => (
      entry.isFile()
      && entry.name.startsWith('Afterimage-')
      && /-(data|metadata)\.json$/i.test(entry.name)
      && entry.name.includes(`-${shortToken}-`)
    ))
    .map((entry) => entry.name);

  let bestMatch = null;
  for (const metadataName of metadataFiles) {
    const metadataPath = path.join(downloadsDir, metadataName);
    try {
      const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
      if (metadata.sessionId && metadata.sessionId !== sessionToken && metadata.token !== sessionToken) {
        continue;
      }
      const filePrefix = metadataName.replace(/-(data|metadata)\.json$/i, '');
      const localFiles = Array.isArray(metadata.localFiles) ? metadata.localFiles.filter(Boolean) : [];
      const photoNames = metadata.photoSaved === false ? [] : Array.from(new Set([
        `${filePrefix}.png`,
        `${filePrefix}-photo.png`,
        ...localFiles.filter(isLocalPhotoFilename),
      ]));
      for (const photoName of photoNames) {
        const candidatePath = path.join(downloadsDir, path.basename(photoName));
        if (fs.existsSync(candidatePath)) {
          const candidate = {
            source: 'metadata',
            expectedImagePath: candidatePath,
            resolvedPath: candidatePath,
            metadataPath,
          };
          if (!bestMatch) {
            bestMatch = candidate;
          }
          break;
        }
      }
    } catch {
      // ignore malformed metadata and continue scanning
    }
  }

  return bestMatch;
}

function getSerializedPrintQueue() {
  return printQueue.map(serializePrintJob);
}

function trimPrintQueue() {
  while (printQueue.length > MAX_PRINT_QUEUE_JOBS) {
    let removableIndex = -1;
    for (let index = printQueue.length - 1; index >= 0; index -= 1) {
      if (FINAL_PRINT_JOB_STATUSES.has(printQueue[index].status)) {
        removableIndex = index;
        break;
      }
    }
    if (removableIndex === -1) break;
    const [removed] = printQueue.splice(removableIndex, 1);
    pendingPrintJobs.delete(removed.id);
  }
}

function broadcastPrintQueueChanged() {
  trimPrintQueue();
  broadcastToAllWindows('print-queue:changed', getSerializedPrintQueue());
}

function updatePrintJob(job, patch = {}) {
  Object.assign(job, patch);
  broadcastPrintQueueChanged();
}

function createPrintJob(payload = {}, requestedCopies, finalCopies) {
  const job = {
    id: newPrintJobId(),
    sessionId: safeQueueText(payload.sessionId, 128),
    templateName: safeQueueText(payload.templateName, 128),
    layoutName: safeQueueText(payload.layoutName, 128),
    cameraOrientation: normalizeSessionCameraOrientation(payload.cameraOrientation),
    copies: finalCopies,
    printerName: null,
    requestedCopies,
    finalCopies,
    completedCopies: 0,
    currentCopy: 0,
    status: 'queued',
    cancelRequested: false,
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  };
  printQueue.unshift(job);
  console.log('[print-queue] job queued', serializePrintJob(job));
  broadcastPrintQueueChanged();
  return job;
}

async function submitSinglePrintCopy({
  dataUrl,
  silent,
  job,
  copyIndex,
  printerName,
  printer,
  printerList,
  selectedPrinterName,
}) {
  const printWin = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: false,
    },
  });
  const printDocumentTitle = `Afterimage ${job.id} Copy ${copyIndex} of ${job.finalCopies}`;
  printWin.setTitle(printDocumentTitle);
  const printPageConfig = getPrintPageConfig(printer);
  const shell = buildPrintShell(printDocumentTitle, printPageConfig);

  try {
    await printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(shell));
    const readiness = await printWin.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const startedAt = Date.now();
        const finish = (payload) => resolve({
          htmlLoaded: document.readyState !== 'loading',
          elapsedMs: Date.now() - startedAt,
          ...payload,
        });
        const timeout = setTimeout(() => {
          finish({
            imageLoaded: false,
            imageDecoded: false,
            layoutReady: false,
            error: 'print image load timed out',
          });
        }, 15000);
        const img = document.createElement('img');
        img.onload = async () => {
          let imageDecoded = false;
          let decodeError = null;
          try {
            if (typeof img.decode === 'function') {
              await img.decode();
            }
            imageDecoded = true;
          } catch (error) {
            decodeError = error?.message || String(error);
          }
          requestAnimationFrame(() => requestAnimationFrame(() => {
            clearTimeout(timeout);
            const rect = img.getBoundingClientRect();
            const root = document.getElementById('print-root') || document.body;
            const bodyRect = document.body.getBoundingClientRect();
            const htmlRect = document.documentElement.getBoundingClientRect();
            const rootRect = root.getBoundingClientRect();
            const imgStyle = window.getComputedStyle(img);
            const bodyStyle = window.getComputedStyle(document.body);
            const rootStyle = window.getComputedStyle(root);
            finish({
              imageLoaded: true,
              imageDecoded,
              decodeError,
              layoutReady: rect.width > 0 && rect.height > 0,
              naturalWidth: img.naturalWidth,
              naturalHeight: img.naturalHeight,
              renderedWidth: rect.width,
              renderedHeight: rect.height,
              htmlWidth: htmlRect.width,
              htmlHeight: htmlRect.height,
              bodyWidth: bodyRect.width,
              bodyHeight: bodyRect.height,
              rootWidth: rootRect.width,
              rootHeight: rootRect.height,
              imageCssWidth: imgStyle.width,
              imageCssHeight: imgStyle.height,
              bodyMargin: bodyStyle.margin,
              bodyPadding: bodyStyle.padding,
              rootMargin: rootStyle.margin,
              rootPadding: rootStyle.padding,
              rootBorderWidth: rootStyle.borderWidth,
              devicePixelRatio: window.devicePixelRatio,
            });
          }));
        };
        img.onerror = () => {
          clearTimeout(timeout);
          finish({
            imageLoaded: false,
            imageDecoded: false,
            layoutReady: false,
            error: 'print image failed to load',
          });
        };
        img.src = ${JSON.stringify(dataUrl)};
        (document.getElementById('print-root') || document.body).appendChild(img);
      });
    `);
    const artworkReady = readiness?.imageLoaded === true
      && readiness?.imageDecoded === true
      && readiness?.layoutReady === true;

    const printOptions = {
      silent: silent === true,
      printBackground: true,
      copies: 1,
      pageSize: { width: printPageConfig.widthMicrons, height: printPageConfig.heightMicrons },
      margins: { marginType: 'none' },
      landscape: false,
      scaleFactor: printPageConfig.scaleFactor || 100,
    };
    if (printPageConfig.dpi) {
      printOptions.dpi = printPageConfig.dpi;
    }
    if (printPageConfig.preferCSSPageSize) {
      printOptions.preferCSSPageSize = true;
    }
    if (printerName) {
      printOptions.deviceName = printerName;
    }
    const printFit = buildPrintFitDiagnostics(printPageConfig, readiness, printOptions, printer);

    if (process.platform === 'win32' && !app.isPackaged) {
      console.log('[WINDOWS BORDERLESS PRINT]', compactDiagnosticValue({
        platform: process.platform,
        printer: summarizePrinterForDiagnostics(printer),
        sourceImage: printFit.sourceImage,
        printDocument: printFit.printDocument,
        requestedPageSize: printFit.requestedPageSize,
        reportedPrinterPageSize: printFit.reportedPrinterPageSize,
        reportedPrinterPrintableArea: printFit.reportedPrinterPrintableArea,
        reportedPrintableScalePercent: printFit.reportedPrintableScalePercent,
        orientation: printOptions.landscape ? 'landscape' : 'portrait',
        scaleFactor: printOptions.scaleFactor,
        cssPageSize: printFit.cssPageSize,
        cssMargins: printFit.cssMargins,
        applicationMargins: printFit.applicationMargins,
        borderless: printFit.borderless,
        calculatedScale: printFit.calculatedScale,
        windowsCompensation: printFit.windowsCompensation,
        effectivePrintDimensions: printFit.effectivePrintDimensions,
        printOptions: sanitizePrintOptions(printOptions),
      }));
    }

    if (!artworkReady) {
      const failureReason = readiness?.error || readiness?.decodeError || 'print artwork was not ready';
      const printerDiagnostics = buildPrintDiagnostics({
        selectedDevice: printerName,
        selectedPrinterName,
        printer,
        printerList,
        printOptions,
        job,
        copyIndex,
        artworkReady,
        htmlLoaded: readiness?.htmlLoaded ?? null,
        imageLoaded: readiness?.imageLoaded ?? null,
        imageDecoded: readiness?.imageDecoded ?? null,
        layoutReady: readiness?.layoutReady ?? null,
        webContentsPrintSuccess: false,
        failureReason,
        rawFailureReason: failureReason,
        message: failureReason,
        printFit,
      });
      logPrintDiagnostics(printerDiagnostics);
      return {
        success: false,
        failureReason,
        rawFailureReason: failureReason,
        deviceName: printerName,
        printerDiagnostics,
        availablePrinters: printerDiagnostics.availablePrinters,
        printOptions: printerDiagnostics.printOptions,
      };
    }

    if (!app.isPackaged) {
      console.log('[print] submitting copy', {
        jobId: job.id,
        sessionId: job.sessionId,
        printerName,
        copyIndex,
        finalCopies: job.finalCopies,
      });
    }

    const result = await new Promise((resolve) => {
      printWin.webContents.print(printOptions, (success, failureReason) => {
        resolve({
          success,
          failureReason: failureReason || null,
          rawFailureReason: failureReason || null,
        });
      });
    });
    const printerDiagnostics = buildPrintDiagnostics({
      selectedDevice: printerName,
      selectedPrinterName,
      printer,
      printerList,
      printOptions,
      job,
      copyIndex,
      artworkReady,
      htmlLoaded: readiness?.htmlLoaded ?? null,
      imageLoaded: readiness?.imageLoaded ?? null,
      imageDecoded: readiness?.imageDecoded ?? null,
      layoutReady: readiness?.layoutReady ?? null,
      webContentsPrintSuccess: result.success,
      failureReason: result.failureReason,
      rawFailureReason: result.rawFailureReason,
      printFit,
    });
    logPrintDiagnostics(printerDiagnostics);

    if (!app.isPackaged) {
      console.log('[print] copy result', {
        jobId: job.id,
        printerName,
        copyIndex,
        finalCopies: job.finalCopies,
        success: result.success,
        failureReason: result.failureReason,
      });
    }
    if (result.success) {
      // Give Chromium time to hand the single-copy document to the OS spooler
      // before its dedicated print window is destroyed.
      await wait(250);
    }
    return {
      ...result,
      deviceName: printerName,
      printerDiagnostics,
      availablePrinters: printerDiagnostics.availablePrinters,
      printOptions: printerDiagnostics.printOptions,
    };
  } finally {
    if (!printWin.isDestroyed()) printWin.destroy();
  }
}

function settlePendingPrintJob(jobId, result) {
  const pending = pendingPrintJobs.get(jobId);
  if (!pending) return;
  pendingPrintJobs.delete(jobId);
  pending.resolve(result);
}

function failPendingPrintJob(jobId, err) {
  const pending = pendingPrintJobs.get(jobId);
  if (!pending) return;
  pendingPrintJobs.delete(jobId);
  pending.resolve({
    success: false,
    failureReason: err?.message || String(err),
  });
}

async function runPrintJob(job, pending) {
  activePrintJobId = job.id;

  const { dataUrl, silent, sender } = pending;
  let completedCopies = 0;
  try {
    const target = await resolveTargetPrinter(sender);
    const printerName = target.printer.name;
    const selectedPrinterName = target.settings?.selectedPrinterName || printerName;
    updatePrintJob(job, {
      status: 'printing',
      startedAt: new Date().toISOString(),
      printerName,
      error: null,
    });
    console.log('[print-queue] job started', { id: job.id, printerName });
    const dataUrlFormat = typeof dataUrl === 'string'
      ? (dataUrl.split(';')[0] || '').replace('data:', '')
      : 'unknown';
    console.log('[print] starting print job', {
      format: dataUrlFormat,
      sizeKb: Math.round(dataUrl.length / 1024),
      requestedCopies: job.requestedCopies,
      finalCopies: job.finalCopies,
      printerName,
      queueJobId: job.id,
    });

    for (let copyIndex = 0; copyIndex < job.finalCopies; copyIndex += 1) {
      if (job.cancelRequested) {
        const status = completedCopies > 0 ? 'partial' : 'cancelled';
        updatePrintJob(job, {
          status,
          completedCopies,
          completedAt: new Date().toISOString(),
          error: completedCopies > 0 ? 'Stopped remaining copies.' : null,
        });
        console.log('[print-queue] job cancelled', { id: job.id });
        return normalizePrintResult({
          status,
          copiesRequested: job.finalCopies,
          copiesPrinted: completedCopies,
        error: completedCopies > 0 ? 'Stopped remaining copies.' : null,
        jobId: job.id,
        printerName,
        deviceName: printerName,
      });
      }

      const currentCopy = copyIndex + 1;
      updatePrintJob(job, { currentCopy });
      console.log('[print-queue] printing copy', { id: job.id, currentCopy, copies: job.finalCopies });
      try {
        sender?.send('print-strip-progress', { current: currentCopy, total: job.finalCopies, jobId: job.id });
      } catch {
        // Renderer may already be gone; queue state remains authoritative.
      }

      const result = await submitSinglePrintCopy({
        dataUrl,
        silent,
        job,
        copyIndex: currentCopy,
        printerName,
        printer: target.printer,
        printerList: target.printerList,
        selectedPrinterName,
      });

      if (!result.success) {
        const failureReason = result.failureReason || `copy ${currentCopy} failed`;
        const status = completedCopies > 0 ? 'partial' : 'failed';
        updatePrintJob(job, {
          status,
          completedCopies,
          error: failureReason,
          completedAt: new Date().toISOString(),
        });
        console.log('[print-queue] job failed', { id: job.id, status, completedCopies, error: failureReason });
        return normalizePrintResult({
          status,
          copiesRequested: job.finalCopies,
          copiesPrinted: completedCopies,
          error: failureReason,
          failureReason,
          rawFailureReason: result.rawFailureReason || failureReason,
          jobId: job.id,
          printerName,
          deviceName: result.deviceName || printerName,
          printerDiagnostics: result.printerDiagnostics || null,
          availablePrinters: result.availablePrinters || null,
          printOptions: result.printOptions || null,
        });
      }

      completedCopies = currentCopy;
      updatePrintJob(job, { completedCopies });
      console.log('[print] print submitted to printer', {
        jobId: job.id,
        printerName,
        copyIndex: currentCopy,
        finalCopies: job.finalCopies,
      });

      if (copyIndex < job.finalCopies - 1) {
        await wait(500);
      }
    }

    updatePrintJob(job, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      currentCopy: job.finalCopies,
      completedCopies,
      error: null,
    });
    console.log('[print-queue] job completed', { id: job.id });
    return normalizePrintResult({
      status: 'completed',
      copiesRequested: job.finalCopies,
      copiesPrinted: completedCopies,
      jobId: job.id,
      printerName,
      deviceName: printerName,
    });
  } catch (err) {
    const failureReason = err?.message || String(err);
    const printerDiagnostics = err?.printDiagnostics || buildPrintDiagnostics({
      failureReason,
      rawFailureReason: err?.rawFailureReason || failureReason,
      message: failureReason,
      job,
    });
    logPrintDiagnostics(printerDiagnostics);
    const status = completedCopies > 0 ? 'partial' : 'failed';
    updatePrintJob(job, {
      status,
      completedCopies,
      error: failureReason,
      completedAt: new Date().toISOString(),
    });
    console.log('[print-queue] job failed', { id: job.id, status, completedCopies, error: failureReason });
    return normalizePrintResult({
      status,
      copiesRequested: job.finalCopies,
      copiesPrinted: completedCopies,
      error: failureReason,
      failureReason,
      rawFailureReason: err?.rawFailureReason || failureReason,
      jobId: job.id,
      printerName: printerDiagnostics.selectedDevice || null,
      deviceName: printerDiagnostics.selectedDevice || null,
      printerDiagnostics,
      availablePrinters: printerDiagnostics.availablePrinters || null,
      printOptions: printerDiagnostics.printOptions || null,
    });
  } finally {
    if (!app.isPackaged) {
      console.log('[print-queue] final status', {
        jobId: job.id,
        requestedCopies: job.requestedCopies,
        finalCopies: job.finalCopies,
        completedCopies,
        status: job.status,
      });
    }
    if (activePrintJobId === job.id) activePrintJobId = null;
    setImmediate(processNextPrintJob);
  }
}

function processNextPrintJob() {
  if (activePrintJobId) return;
  const nextJob = printQueue
    .slice()
    .reverse()
    .find((job) => job.status === 'queued');
  if (!nextJob) return;

  const pending = pendingPrintJobs.get(nextJob.id);
  if (!pending) {
    updatePrintJob(nextJob, {
      status: 'failed',
      error: 'print payload unavailable',
      completedAt: new Date().toISOString(),
    });
    console.log('[print-queue] job failed', { id: nextJob.id, error: 'print payload unavailable' });
    setImmediate(processNextPrintJob);
    return;
  }

  if (nextJob.cancelRequested) {
    updatePrintJob(nextJob, {
      status: 'cancelled',
      completedCopies: 0,
      completedAt: new Date().toISOString(),
    });
    pendingPrintJobs.delete(nextJob.id);
    console.log('[print-queue] job cancelled', { id: nextJob.id });
    pending.resolve(normalizePrintResult({
      status: 'cancelled',
      copiesRequested: nextJob.finalCopies,
      copiesPrinted: 0,
      jobId: nextJob.id,
    }));
    setImmediate(processNextPrintJob);
    return;
  }

  runPrintJob(nextJob, pending)
    .then((result) => settlePendingPrintJob(nextJob.id, result))
    .catch((err) => failPendingPrintJob(nextJob.id, err));
}

ipcMain.handle('printers:list', async (event) => {
  try {
    const settings = await readSettings();
    const printerList = await getPrinterListForRenderer(event.sender, { force: true });
    return {
      ok: true,
      selectedPrinterName: settings.selectedPrinterName || null,
      ...printerList,
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
      printers: [],
      selphyPrinters: [],
      selectedPrinterName: null,
      defaultPrinter: null,
      guidance: null,
    };
  }
});

ipcMain.handle('save-strip', async (_event, payload = {}) => {
  try {
    resolvePaths();
    const { dataUrl, filename = '' } = payload;
    const targetDir = app.getPath('downloads') || printsDir;
    const pngBuffer = normalizeImageBufferToPng(decodeImageDataUrl(dataUrl));
    if (!pngBuffer) {
      return { ok: false, error: 'invalid print PNG' };
    }

    await fsp.mkdir(targetDir, { recursive: true });
    const cleanFilename = safePrintFilename(filename).replace(/\.(?!png$)[^.]+$/i, '');
    const finalFilename = /\.png$/i.test(cleanFilename) ? cleanFilename : `${cleanFilename}.png`;
    const filePath = path.join(targetDir, finalFilename);
    console.log('[LOCAL SAVE AUDIT] saving media file', {
      type: 'photo',
      filename: finalFilename,
      targetPath: filePath,
      source: 'printApi.saveStrip',
      reason: 'legacy print PNG backup',
    });
    console.log('[LOCAL SAVE AUDIT PNG]', {
      filename: finalFilename,
      isKeychain: finalFilename.includes('keychain-4x6'),
      isNormalPhoto: finalFilename.includes('photo') || finalFilename.includes('strip'),
      caller: 'electron save-strip',
    });
    await fsp.writeFile(filePath, pngBuffer);
    console.log('[print] autosaved PNG:', filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    console.warn('[print] autosave failed:', err?.message || String(err));
    return { ok: false, error: err?.message || String(err) };
  }
});

const LOCAL_SOFTCOPY_FILE_TYPES = Object.freeze({
  'photo.png': 'image/png',
  'animation.gif': 'image/gif',
  'video.mp4': 'video/mp4',
  'video.webm': 'video/webm',
  'video.mov': 'video/quicktime',
  'keychain-4x6.png': 'image/png',
});

const LOCAL_SOFTCOPY_KINDS = Object.freeze({
  photo: {
    mimeTypes: ['image/png'],
    allowedNames: ['photo.png'],
  },
  gif: {
    mimeTypes: ['image/gif'],
    allowedNames: ['animation.gif'],
  },
  video: {
    mimeTypes: ['video/mp4', 'video/webm', 'video/quicktime'],
    allowedNames: ['video.mp4', 'video.webm', 'video.mov'],
  },
  keychain4x6: {
    mimeTypes: ['image/png'],
    preserveName: true,
  },
});

function sanitizeSoftcopySegment(value, fallback = '') {
  const normalized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
  return normalized || fallback;
}

function softcopyTimestamp(value) {
  const parsed = new Date(value || Date.now());
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const pad = number => String(number).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function buildSoftcopyFilePrefix(payload = {}) {
  const safeSessionId = sanitizeSoftcopySegment(payload.sessionId, 'session')
    .replace(/^session-+/i, '')
    .slice(0, 64) || 'session';
  const createdAt = payload.metadata?.createdAt || payload.createdAt;
  return `Afterimage-${softcopyTimestamp(createdAt)}-session-${safeSessionId}`;
}

function normalizeSoftcopyFilePrefix(value) {
  const prefix = String(value || '');
  return /^Afterimage-\d{8}-\d{6}-session-[A-Za-z0-9_-]{1,64}(?:-\d+)?$/.test(prefix)
    ? prefix
    : null;
}

function safeLocalMediaFilename(value, fallback = '') {
  const name = path.basename(String(value || '').trim())
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
  return name || fallback;
}

function getLocalSoftcopyOutputName(filePrefix, spec = {}) {
  if (spec.preserveName) return spec.name;
  if (spec.kind === 'photo') return `${filePrefix}.png`;
  if (spec.kind === 'gif') return `${filePrefix}.gif`;
  if (spec.kind === 'video') {
    const ext = path.extname(spec.name || '').toLowerCase().replace(/^\./, '');
    return `${filePrefix}.${['mp4', 'webm', 'mov'].includes(ext) ? ext : 'webm'}`;
  }
  return `${filePrefix}-${spec.name}`;
}

function isLocalPhotoFilename(name = '') {
  return /-photo\.png$/i.test(name)
    || /^Afterimage-\d{8}-\d{6}-session-[A-Za-z0-9_-]+(?:-\d+)?\.png$/i.test(name);
}

function isLocalGifFilename(name = '') {
  return /-animation\.gif$/i.test(name)
    || /^Afterimage-\d{8}-\d{6}-session-[A-Za-z0-9_-]+(?:-\d+)?\.gif$/i.test(name);
}

function isLocalVideoFilename(name = '') {
  return /-video\.(mp4|webm|mov)$/i.test(name)
    || /^Afterimage-\d{8}-\d{6}-session-[A-Za-z0-9_-]+(?:-\d+)?\.(mp4|webm|mov)$/i.test(name);
}

function normalizeLocalSoftcopyFile(file = {}) {
  const rawKind = String(file?.kind || '').trim();
  const kind = Object.prototype.hasOwnProperty.call(LOCAL_SOFTCOPY_KINDS, rawKind)
    ? rawKind
    : '';
  const name = safeLocalMediaFilename(file?.name, '');
  const mimeType = String(file?.mimeType || '').toLowerCase().split(';')[0];
  const kindSpec = kind ? LOCAL_SOFTCOPY_KINDS[kind] : null;
  const expectedMimeType = kindSpec
    ? (kindSpec.mimeTypes.includes(mimeType) ? mimeType : null)
    : LOCAL_SOFTCOPY_FILE_TYPES[name];

  if (!expectedMimeType || mimeType !== expectedMimeType) {
    return {
      ok: false,
      kind,
      name: name || 'unnamed',
      error: 'invalid local softcopy file',
    };
  }

  if (kindSpec?.allowedNames && !kindSpec.allowedNames.includes(name)) {
    return {
      ok: false,
      kind,
      name: name || 'unnamed',
      error: 'invalid local softcopy filename',
    };
  }

  if (kind === 'keychain4x6') {
    const fallbackName = `${buildSoftcopyFilePrefix({ sessionId: 'session', createdAt: Date.now() })}-keychain-4x6.png`;
    const keychainName = safeLocalMediaFilename(name, fallbackName);
    if (!/keychain-4x6\.png$/i.test(keychainName)) {
      return {
        ok: false,
        kind,
        name: keychainName,
        error: 'invalid keychain filename',
      };
    }
    return {
      ok: true,
      kind,
      name: keychainName,
      mimeType,
      preserveName: true,
    };
  }

  return {
    ok: true,
    kind: kind || null,
    name,
    mimeType,
    preserveName: false,
  };
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findAvailableSoftcopyPrefix(downloadsDir, basePrefix, normalizedFiles) {
  for (let suffix = 0; suffix < 10000; suffix += 1) {
    const prefix = suffix === 0 ? basePrefix : `${basePrefix}-${suffix}`;
    const targetNames = [
      ...normalizedFiles
        .map(({ spec }) => (spec?.ok ? getLocalSoftcopyOutputName(prefix, spec) : null))
        .filter(Boolean),
      `${prefix}-data.json`,
      `${prefix}-metadata.json`,
    ];
    const collisions = await Promise.all(
      targetNames.map(name => pathExists(path.join(downloadsDir, name))),
    );
    if (!collisions.some(Boolean)) return prefix;
  }
  throw new Error('Could not allocate unique softcopy filenames in Downloads.');
}

function normalizeRendererBinary(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function normalizeRendererBinaryPayload(payload = {}) {
  const direct = normalizeRendererBinary(payload.data || payload.arrayBuffer);
  if (direct?.length) return direct;
  const dataUrl = typeof payload.dataUrl === 'string' ? payload.dataUrl : '';
  if (dataUrl.startsWith('data:')) {
    const base64 = dataUrl.split(',')[1] || '';
    return base64 ? Buffer.from(base64, 'base64') : null;
  }
  return null;
}

function verifyWrittenFile(filePath) {
  const exists = fs.existsSync(filePath);
  const sizeBytes = exists ? fs.statSync(filePath).size : 0;
  return { exists, sizeBytes };
}

function isPathInsideDirectory(parentDir, childPath) {
  const parent = path.resolve(parentDir);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function getMimeTypeForSavedSoftcopy(kind, filename) {
  const lowerName = String(filename || '').toLowerCase();
  if (kind === 'photo' && isLocalPhotoFilename(lowerName)) return 'image/png';
  if (kind === 'gif' && isLocalGifFilename(lowerName)) return 'image/gif';
  if (kind === 'video' && isLocalVideoFilename(lowerName)) {
    if (lowerName.endsWith('.mp4')) return 'video/mp4';
    if (lowerName.endsWith('.mov')) return 'video/quicktime';
    return 'video/webm';
  }
  return null;
}

async function handleReadSavedSoftcopyMediaFile(_event, payload = {}) {
  const downloadsDir = app.getPath('downloads');
  const requestedPath = typeof payload.path === 'string' ? payload.path : '';
  const requestedKind = typeof payload.kind === 'string' ? payload.kind : '';
  const safeKind = ['photo', 'gif', 'video'].includes(requestedKind) ? requestedKind : '';
  const targetPath = path.resolve(requestedPath);
  const filename = path.basename(targetPath);
  try {
    if (!safeKind) {
      throw new Error('invalid saved media kind');
    }
    if (!requestedPath || !isPathInsideDirectory(downloadsDir, targetPath)) {
      throw new Error('saved media path is outside Downloads');
    }
    const mimeType = getMimeTypeForSavedSoftcopy(safeKind, filename);
    if (!mimeType) {
      throw new Error('saved media filename does not match its kind');
    }
    const buffer = await fsp.readFile(targetPath);
    if (!buffer.length) {
      throw new Error('saved media file is empty');
    }
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    console.log('[QR DEBUG] read saved media for retry', {
      kind: safeKind,
      filename,
      path: targetPath,
      sizeBytes: buffer.length,
      mimeType,
    });
    await writeDiagnosticEvent('QR read saved media for retry', {
      kind: safeKind,
      filename,
      path: targetPath,
      sizeBytes: buffer.length,
      mimeType,
    });
    return {
      ok: true,
      kind: safeKind,
      filename,
      path: targetPath,
      sizeBytes: buffer.length,
      mimeType,
      arrayBuffer,
    };
  } catch (error) {
    const message = error?.message || String(error);
    console.warn('[QR DEBUG] read saved media failed', {
      kind: requestedKind || null,
      filename,
      path: requestedPath || null,
      error: message,
    });
    await writeDiagnosticEvent('QR read saved media failed', {
      kind: requestedKind || null,
      filename,
      path: requestedPath || null,
      error: message,
    });
    return {
      ok: false,
      kind: requestedKind || null,
      filename,
      path: requestedPath || null,
      error: message,
    };
  }
}

async function handleWriteDownloadsTextFile() {
  console.log('[DIAG main] diag:write-downloads-text-file handler called');
  const downloadsDir = app.getPath('downloads');
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, '')
    .replace('T', '-');

  const filename = `Afterimage-DIAG-${timestamp}.txt`;
  const targetPath = path.join(downloadsDir, filename);

  const content = [
    'AFTERIMAGE DOWNLOADS WRITE TEST',
    `createdAt=${new Date().toISOString()}`,
    `downloadsDir=${downloadsDir}`,
    `platform=${process.platform}`,
    `cwd=${process.cwd()}`,
  ].join('\n');

  await fs.promises.writeFile(targetPath, content, 'utf8');

  const exists = fs.existsSync(targetPath);
  const sizeBytes = exists ? fs.statSync(targetPath).size : 0;

  console.log('[DIAG STEP 1] downloads write test', {
    downloadsDir,
    targetPath,
    exists,
    sizeBytes,
  });

  return {
    ok: exists && sizeBytes > 0,
    downloadsDir,
    targetPath,
    exists,
    sizeBytes,
  };
}

async function handleWriteDownloadsPngFile(_event, payload = {}) {
  console.log('[DIAG STEP 2 main] diag:write-downloads-png-file handler called');
  const downloadsDir = app.getPath('downloads');
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, '')
    .replace('T', '-');

  const defaultFilename = `Afterimage-DIAG-PNG-${timestamp}.png`;
  const requestedFilename = safeLocalMediaFilename(payload?.filename, defaultFilename);
  const filename = requestedFilename.includes('keychain-4x6') || requestedFilename.startsWith('Afterimage-DIAG-PNG-')
    ? requestedFilename
    : defaultFilename;
  const targetPath = path.join(downloadsDir, filename);

  const arrayBuffer = payload?.arrayBuffer;
  if (!arrayBuffer) {
    throw new Error('Missing PNG arrayBuffer');
  }

  const buffer = Buffer.from(arrayBuffer);

  console.log('[LOCAL SAVE AUDIT] saving media file', {
    type: filename.includes('keychain-4x6') ? 'keychain4x6' : 'png',
    filename,
    targetPath,
    source: 'diag:write-downloads-png-file',
    reason: filename.includes('keychain-4x6') ? 'keychain auto-save/test save' : 'diagnostic PNG save',
  });
  console.log('[LOCAL SAVE AUDIT PNG]', {
    filename,
    isKeychain: filename.includes('keychain-4x6'),
    isNormalPhoto: filename.includes('photo') || filename.includes('strip'),
    caller: 'electron diag:write-downloads-png-file',
  });
  await fs.promises.writeFile(targetPath, buffer);

  const exists = fs.existsSync(targetPath);
  const sizeBytes = exists ? fs.statSync(targetPath).size : 0;

  console.log('[DIAG STEP 2] png write test', {
    downloadsDir,
    targetPath,
    bufferSize: buffer.length,
    exists,
    sizeBytes,
  });

  return {
    ok: exists && sizeBytes > 0,
    filename,
    downloadsDir,
    targetPath,
    exists,
    sizeBytes,
  };
}

function makeKeychainDownloadsFilename(payload = {}) {
  const sessionId = sanitizeSoftcopySegment(payload.sessionId, 'session')
    .replace(/-/g, '')
    .slice(0, 8) || 'session';
  const fallbackName = `Afterimage-${softcopyTimestamp(payload.createdAt || Date.now())}-${sessionId}-keychain-4x6.png`;
  const requestedName = safeLocalMediaFilename(payload.filename || payload.name, fallbackName);
  if (/^Afterimage-\d{8}-\d{6}-[A-Za-z0-9_-]{1,16}-keychain-4x6\.png$/i.test(requestedName)) {
    return requestedName;
  }
  return fallbackName;
}

async function handleSaveKeychain4x6(_event, payload = {}) {
  const downloadsDir = app.getPath('downloads');
  const safeName = makeKeychainDownloadsFilename(payload);
  const targetPath = path.join(downloadsDir, safeName);
  try {
    const mimeType = String(payload.mimeType || '').toLowerCase().split(';')[0];
    if (mimeType && mimeType !== 'image/png') {
      throw new Error(`Invalid keychain MIME type: ${mimeType}`);
    }
    const buffer = normalizeRendererBinaryPayload(payload);
    if (!buffer?.length) {
      throw new Error('Missing keychain PNG data.');
    }

    console.log('[keychain-save electron] downloads path', {
      downloadsDir,
    });
    await fsp.mkdir(downloadsDir, { recursive: true });
    console.log('[keychain-save electron] writing', {
      filename: safeName,
      targetPath,
      bufferSize: buffer.length,
    });
    console.log('[LOCAL SAVE AUDIT] saving media file', {
      type: 'keychain4x6',
      filename: safeName,
      targetPath,
      source: 'keychain:save-4x6-to-downloads',
      reason: 'keychain local-only save',
    });
    console.log('[LOCAL SAVE AUDIT PNG]', {
      filename: safeName,
      isKeychain: true,
      isNormalPhoto: false,
      caller: 'electron keychain:save-4x6-to-downloads',
    });
    await fsp.writeFile(targetPath, buffer);
    const verification = verifyWrittenFile(targetPath);
    console.log('[keychain-save electron] verification', {
      targetPath,
      exists: verification.exists,
      sizeBytes: verification.sizeBytes,
    });
    if (!verification.exists || verification.sizeBytes <= 0) {
      throw new Error(`Keychain file verification failed for ${targetPath}`);
    }
    return {
      ok: true,
      filename: safeName,
      path: targetPath,
      downloadsDir,
      exists: verification.exists,
      sizeBytes: verification.sizeBytes,
    };
  } catch (error) {
    console.error('[keychain-save ERROR]', error);
    return {
      ok: false,
      filename: safeName,
      path: targetPath,
      downloadsDir,
      exists: false,
      sizeBytes: 0,
      error: error?.message || String(error),
    };
  }
}

async function handleSaveSessionMedia(_event, payload = {}) {
  const safeSessionId = sanitizeSoftcopySegment(payload.sessionId, `session-${Date.now()}`);
  const downloadsDir = app.getPath('downloads');
  const savedFiles = [];
  const fileErrors = [];
  try {
    console.log('[DIAG electron 1] save-session-media received', {
      sessionId: payload?.sessionId,
      fileCount: payload?.files?.length,
      files: payload?.files?.map(f => ({
        kind: f.kind,
        name: f.name,
        mimeType: f.mimeType,
        hasData: Boolean(f.data || f.arrayBuffer || f.dataUrl),
      })),
    });
    console.log('[DIAG electron 2] downloads path', {
      downloadsDir: app.getPath('downloads'),
    });
    console.log('[softcopy-local] Electron downloads path resolved', {
      downloadsDir,
    });
    console.log('[LOCAL SOFTCOPY] Downloads directory:', downloadsDir);
    await fsp.mkdir(downloadsDir, { recursive: true });
    const files = Array.isArray(payload.files) ? payload.files : [];
    const normalizedFiles = files.map(file => ({
      original: file,
      spec: normalizeLocalSoftcopyFile(file),
    }));
    const requestedPrefix = normalizeSoftcopyFilePrefix(payload.filePrefix);
    const filePrefix = requestedPrefix
      ? requestedPrefix
      : await findAvailableSoftcopyPrefix(
        downloadsDir,
        buildSoftcopyFilePrefix(payload),
        normalizedFiles,
      );

    if (!app.isPackaged) {
      console.log('[softcopy-local] saving to downloads', {
        sessionId: safeSessionId,
        downloadsDir,
        fileCount: files.length,
      });
    }

    const metadata = payload.metadata && typeof payload.metadata === 'object'
      && !Array.isArray(payload.metadata)
      ? payload.metadata
      : {};
    const metadataName = `${filePrefix}-data.json`;
    const metadataPath = path.join(downloadsDir, metadataName);
    const metadataFileNames = Array.isArray(metadata.localFiles)
      ? metadata.localFiles
        .map(file => typeof file === 'string' ? file : file?.name)
        .filter(Boolean)
      : [];
    const validRecords = [];

    for (const { original: file, spec } of normalizedFiles) {
      const buffer = normalizeRendererBinary(file?.data);
      if (!spec.ok || !buffer?.length) {
        fileErrors.push({
          kind: spec.kind || null,
          name: spec.name || 'unnamed',
          error: spec.error || 'invalid local softcopy file',
        });
        continue;
      }
      const savedName = getLocalSoftcopyOutputName(filePrefix, spec);
      validRecords.push({
        file,
        spec,
        buffer,
        savedName,
        filePath: path.join(downloadsDir, savedName),
      });
    }

    const plannedLocalFiles = validRecords.map(record => record.savedName);
    const getLocalFilesForMetadata = () => Array.from(new Set([
      ...metadataFileNames,
      ...plannedLocalFiles,
      ...savedFiles.map(file => file.name),
    ]));
    const getSavedKeychainFile = () => savedFiles
      .find(file => file.kind === 'keychain4x6' || file.name.includes('keychain-4x6'));
    const buildMetadataContents = () => {
      const localFiles = getLocalFilesForMetadata();
      const savedKeychainFile = getSavedKeychainFile();
      const localSoftcopies = {
        ...(metadata.localSoftcopies && typeof metadata.localSoftcopies === 'object' && !Array.isArray(metadata.localSoftcopies)
          ? metadata.localSoftcopies
          : {}),
      };
      for (const file of savedFiles) {
        const key = file.kind === 'photo' ? 'png' : file.kind;
        if (!['png', 'gif', 'video'].includes(key) || localSoftcopies[key]) continue;
        localSoftcopies[key] = {
          path: file.path,
          filename: file.name,
          savedAt: file.savedAt || new Date().toISOString(),
          sizeBytes: file.sizeBytes,
        };
      }
      return JSON.stringify({
        ...metadata,
        sessionId: safeSessionId,
        savedAt: new Date().toISOString(),
        photoSaved: localFiles.some(isLocalPhotoFilename),
        gifSaved: localFiles.some(isLocalGifFilename),
        videoSaved: localFiles.some(isLocalVideoFilename),
        keychain4x6Generated: metadata.keychain4x6Generated === true,
        keychain4x6Saved: metadata.keychain4x6Saved === true || Boolean(savedKeychainFile),
        keychain4x6Filename: savedKeychainFile?.name || localFiles.find(name => name.endsWith('-keychain-4x6.png')) || metadata.keychain4x6Filename || null,
        keychain4x6SavedPath: savedKeychainFile?.path || metadata.keychain4x6SavedPath || null,
        keychain4x6Exists: savedKeychainFile ? savedKeychainFile.exists === true : metadata.keychain4x6Exists === true,
        keychain4x6SizeBytes: savedKeychainFile && Number.isFinite(Number(savedKeychainFile.sizeBytes))
          ? Number(savedKeychainFile.sizeBytes)
          : (Number.isFinite(Number(metadata.keychain4x6SizeBytes)) ? Number(metadata.keychain4x6SizeBytes) : 0),
        keychain4x6CanvasWidth: Number.isFinite(Number(metadata.keychain4x6CanvasWidth)) ? Number(metadata.keychain4x6CanvasWidth) : null,
        keychain4x6CanvasHeight: Number.isFinite(Number(metadata.keychain4x6CanvasHeight)) ? Number(metadata.keychain4x6CanvasHeight) : null,
        keychain4x6PlacementCount: Number.isFinite(Number(metadata.keychain4x6PlacementCount)) ? Number(metadata.keychain4x6PlacementCount) : 0,
        keychain4x6LocalOnly: true,
        keychain4x6Uploaded: false,
        keychain4x6Error: metadata.keychain4x6Error || null,
        localSoftcopies: sanitizeLocalSoftcopies(localSoftcopies),
        localFiles,
        localFileErrors: [
          ...(Array.isArray(metadata.localFileErrors) ? metadata.localFileErrors : []),
          ...fileErrors,
        ],
      }, null, 2);
    };
    const writeMetadataFile = async () => {
      await fsp.writeFile(
        metadataPath,
        buildMetadataContents(),
        payload.metadataOnly === true || requestedPrefix ? undefined : { flag: 'wx' },
      );
      const verification = verifyWrittenFile(metadataPath);
      const logPayload = {
        filename: metadataName,
        targetPath: metadataPath,
      };
      if (payload.metadataOnly === true) {
        console.log('[LOCAL SAVE ORDER] json updated', logPayload);
      } else {
        console.log('[LOCAL SAVE ORDER] 2 json saved', logPayload);
      }
      if (!verification.exists || verification.sizeBytes <= 0) {
        throw new Error(`Local metadata verification failed for ${metadataName}`);
      }
    };
    const writeMediaRecord = async (record, orderNumber, orderType) => {
      if (!record) return;
      const { file, spec, buffer, savedName, filePath } = record;
      const logType = spec.kind === 'photo'
        ? 'PNG'
        : spec.kind === 'gif'
          ? 'GIF'
          : spec.kind === 'video'
            ? 'VIDEO'
            : String(spec.kind || 'MEDIA').toUpperCase();
      try {
        console.log(`[LOCAL SOFTCOPY] ${logType} save started`, {
          type: spec.kind || file.kind || null,
          filename: savedName,
          path: filePath,
          bytes: buffer.length,
        });
        console.log('[LOCAL SAVE AUDIT] saving media file', {
          type: spec.kind || file.kind || null,
          filename: savedName,
          targetPath: filePath,
          source: 'softcopy-local:save-session-media',
          reason: spec.kind === 'photo' ? 'canonical final photo softcopy' : 'enabled local softcopy media',
        });
        if (spec.mimeType === 'image/png' || /\.png$/i.test(savedName)) {
          console.log('[LOCAL SAVE AUDIT PNG]', {
            filename: savedName,
            isKeychain: savedName.includes('keychain-4x6'),
            isNormalPhoto: isLocalPhotoFilename(savedName) || savedName.includes('strip'),
            caller: 'electron softcopy-local:save-session-media',
          });
        }
        console.log('[DIAG electron 3] writing file', {
          kind: file.kind,
          originalName: file.name,
          safeName: savedName,
          targetPath: filePath,
          dataType: typeof file.data,
          hasArrayBuffer: Boolean(file.arrayBuffer),
          hasDataUrl: Boolean(file.dataUrl),
        });
        await fsp.writeFile(filePath, buffer, { flag: 'wx' });
        const verification = verifyWrittenFile(filePath);
        console.log('[DIAG electron 4] write verification', {
          kind: file.kind,
          name: savedName,
          targetPath: filePath,
          exists: verification.exists,
          sizeBytes: verification.sizeBytes,
        });
        if (spec.kind === 'keychain4x6') {
          console.log('[keychain] saved file verification', {
            expectedPath: filePath,
            exists: verification.exists,
            sizeBytes: verification.sizeBytes,
          });
        }
        if (!verification.exists || verification.sizeBytes <= 0) {
          throw new Error(`Local file verification failed for ${savedName}`);
        }
        console.log(`[LOCAL SOFTCOPY] ${logType} saved`, {
          type: spec.kind || file.kind || null,
          path: filePath,
          bytes: verification.sizeBytes,
        });
        savedFiles.push({
          kind: spec.kind || null,
          name: savedName,
          path: filePath,
          sizeBytes: verification.sizeBytes,
          exists: verification.exists,
          savedAt: new Date().toISOString(),
        });
        if (orderNumber && orderType) {
          console.log(`[LOCAL SAVE ORDER] ${orderNumber} ${orderType} saved`, {
            filename: savedName,
            targetPath: filePath,
          });
        }
      } catch (error) {
        if (error?.code === 'EEXIST') {
          const verification = verifyWrittenFile(filePath);
          if (verification.exists && verification.sizeBytes > 0) {
            savedFiles.push({
              kind: spec.kind || null,
              name: savedName,
              path: filePath,
              sizeBytes: verification.sizeBytes,
              exists: verification.exists,
              savedAt: new Date().toISOString(),
              alreadyExisted: true,
            });
            console.log('[LOCAL SOFTCOPY] existing file reused', {
              type: spec.kind || file.kind || null,
              filename: savedName,
              targetPath: filePath,
              bytes: verification.sizeBytes,
            });
            return;
          }
        }
        fileErrors.push({
          kind: spec.kind || null,
          name: spec.name,
          error: error?.message || String(error),
        });
        console.error('[DIAG local-save ERROR]', error);
      }
    };

    console.log(payload.metadataOnly === true ? '[LOCAL SAVE ORDER] metadata update start' : '[LOCAL SAVE ORDER] start', {
      sessionId: safeSessionId,
      filePrefix,
      metadataOnly: payload.metadataOnly === true,
    });

    if (payload.metadataOnly === true) {
      await writeMetadataFile();
    } else {
      const findRecord = kind => validRecords.find(record => record.spec.kind === kind);
      const orderedRecords = new Set();
      const photoRecord = findRecord('photo');
      const gifRecord = findRecord('gif');
      const videoRecord = findRecord('video');

      await writeMediaRecord(photoRecord, 1, 'png');
      if (photoRecord) orderedRecords.add(photoRecord);
      await writeMediaRecord(gifRecord, 2, 'gif');
      if (gifRecord) orderedRecords.add(gifRecord);
      await writeMediaRecord(videoRecord, 3, 'video');
      if (videoRecord) orderedRecords.add(videoRecord);

      for (const record of validRecords) {
        if (!orderedRecords.has(record)) {
          await writeMediaRecord(record);
        }
      }
      await writeMetadataFile();
    }

    console.log(payload.metadataOnly === true ? '[LOCAL SAVE ORDER] metadata update complete' : '[LOCAL SAVE ORDER] normal softcopy complete', {
      sessionId: safeSessionId,
      filePrefix,
    });

    if (!app.isPackaged) {
      console.log('[softcopy-local] saved files', {
        sessionId: safeSessionId,
        savedFiles,
        fileErrors,
      });
    }
    console.log('[softcopy-local] final saved file names', {
      downloadsDir,
      folderPath: downloadsDir,
      savedFiles: savedFiles.map(file => ({
        kind: file.kind || null,
        name: file.name,
        path: file.path,
        sizeBytes: file.sizeBytes,
        exists: file.exists === true,
      })),
    });
    console.log('[DIAG electron 5] savedFiles result', {
      downloadsDir,
      savedFiles,
    });
    return {
      ok: savedFiles.length > 0 || payload.metadataOnly === true,
      partial: savedFiles.length > 0 && fileErrors.length > 0,
      sessionId: safeSessionId,
      folderPath: downloadsDir,
      filePrefix,
      savedFiles,
      fileErrors,
      mediaResults: [
        ...savedFiles.map(file => ({
          ok: true,
          type: file.kind || null,
          targetPath: file.path,
          sizeBytes: file.sizeBytes,
        })),
        ...fileErrors.map(error => ({
          ok: false,
          type: error.kind || null,
          error: error.error,
        })),
      ],
      metadataPath,
      error: fileErrors.length ? 'One or more local softcopy files could not be saved.' : null,
    };
	  } catch (error) {
    console.error('[DIAG local-save ERROR]', error);
	    if (!app.isPackaged) {
      console.log('[softcopy-local] save failed', {
        sessionId: safeSessionId,
        error: error?.message || String(error),
      });
    }
    return {
      ok: false,
      sessionId: safeSessionId,
      folderPath: downloadsDir,
      savedFiles,
      error: error?.message || String(error),
    };
  }
}

function registerLocalSoftcopyIpc() {
  if (localSoftcopyIpcRegistered) return;

  ipcMain.removeHandler(SOFTCOPY_SAVE_CHANNEL);
  ipcMain.handle(SOFTCOPY_SAVE_CHANNEL, handleSaveSessionMedia);
  ipcMain.removeHandler(SOFTCOPY_READ_CHANNEL);
  ipcMain.handle(SOFTCOPY_READ_CHANNEL, handleReadSavedSoftcopyMediaFile);
  ipcMain.removeHandler(KEYCHAIN_SAVE_CHANNEL);
  ipcMain.handle(KEYCHAIN_SAVE_CHANNEL, handleSaveKeychain4x6);
  localSoftcopyIpcRegistered = true;

  if (!app.isPackaged) {
    console.log('[softcopy-local] handler registered');
    console.log('[keychain-save] handler registered');
  }
}

registerLocalSoftcopyIpc();

ipcMain.removeHandler('diag:write-downloads-text-file');
ipcMain.handle('diag:write-downloads-text-file', handleWriteDownloadsTextFile);
console.log('[DIAG main] diag:write-downloads-text-file handler registered', {
  preloadPath: path.join(__dirname, 'preload.cjs'),
});
ipcMain.removeHandler('diag:write-downloads-png-file');
ipcMain.handle('diag:write-downloads-png-file', handleWriteDownloadsPngFile);
console.log('[DIAG main] diag:write-downloads-png-file handler registered', {
  preloadPath: path.join(__dirname, 'preload.cjs'),
});
ipcMain.removeHandler('diag:log-event');
ipcMain.handle('diag:log-event', async (_event, payload = {}) => {
  const type = typeof payload.type === 'string'
    ? payload.type.slice(0, 120)
    : 'renderer-diagnostic';
  await writeDiagnosticEvent(type, payload.details || {});
  return { ok: true };
});
ipcMain.removeHandler('diag:get-runtime-info');
ipcMain.handle('diag:get-runtime-info', async () => {
  const info = getRuntimeDiagnostics();
  console.log('[AFTERIMAGE BUILD]', info);
  await writeDiagnosticEvent('AFTERIMAGE BUILD', info);
  return { ok: true, info };
});

ipcMain.handle('print-strip', async (event, payload = {}) => {
  const {
    dataUrl,
    copies = 1,
    silent = true,
  } = payload;
  const requestedCopyCount = clampPrintCopies(copies);
  let copyCount = requestedCopyCount;
  let printCopiesEnabled = false;
  if (!dataUrl || typeof dataUrl !== 'string') {
    return normalizePrintResult({ status: 'failed', error: 'missing dataUrl' });
  }

  try {
    const settings = await readSettings();
    if (settings.printEnabled === false) {
      return normalizePrintResult({ status: 'failed', copiesRequested: requestedCopyCount, error: 'printing disabled by admin' });
    }
    printCopiesEnabled = settings.printCopiesEnabled === true;
    copyCount = printCopiesEnabled ? requestedCopyCount : 1;
    if (!app.isPackaged) {
      console.log('[print] resolved copies', {
        requestedCopies: requestedCopyCount,
        printCopiesEnabled,
        finalCopies: copyCount,
      });
    }
  } catch (err) {
    return normalizePrintResult({ status: 'failed', copiesRequested: requestedCopyCount, error: err?.message || 'failed to read settings' });
  }

  if (!app.isPackaged) {
    console.log('[print-copies] config resolved', {
      printCopiesEnabled,
      requestedCopies: requestedCopyCount,
      maxCopies: MAX_PRINT_COPIES,
      finalCopies: copyCount,
    });
  }
  const job = createPrintJob(payload, requestedCopyCount, copyCount);
  return new Promise((resolve) => {
    pendingPrintJobs.set(job.id, {
      dataUrl,
      silent,
      sender: event.sender,
      resolve,
    });
    processNextPrintJob();
  });
});

ipcMain.handle('print-queue:get', async () => {
  return { ok: true, jobs: getSerializedPrintQueue() };
});

ipcMain.handle('print-queue:cancel', async (_event, { id } = {}) => {
  try {
    const job = printQueue.find((item) => item.id === id);
    if (!job) return { ok: false, error: 'print job not found' };
    if (FINAL_PRINT_JOB_STATUSES.has(job.status)) {
      return { ok: false, error: `print job is already ${job.status}` };
    }
    job.cancelRequested = true;
    console.log('[print-queue] cancel requested', { id: job.id });
    if (job.status === 'queued') {
      updatePrintJob(job, {
        status: 'cancelled',
        completedCopies: 0,
        completedAt: new Date().toISOString(),
      });
      const pending = pendingPrintJobs.get(job.id);
      if (pending) {
        pendingPrintJobs.delete(job.id);
        pending.resolve(normalizePrintResult({
          status: 'cancelled',
          copiesRequested: job.finalCopies,
          copiesPrinted: 0,
          jobId: job.id,
        }));
      }
      console.log('[print-queue] job cancelled', { id: job.id });
      setImmediate(processNextPrintJob);
    } else {
      broadcastPrintQueueChanged();
    }
    return { ok: true, job: serializePrintJob(job) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('print-queue:delete', async (_event, { id } = {}) => {
  try {
    const index = printQueue.findIndex((item) => item.id === id);
    if (index === -1) return { ok: false, error: 'print job not found' };
    const job = printQueue[index];
    if (!FINAL_PRINT_JOB_STATUSES.has(job.status)) {
      return { ok: false, error: 'only completed, failed, cancelled, or partial print jobs can be deleted' };
    }
    printQueue.splice(index, 1);
    pendingPrintJobs.delete(job.id);
    console.log('[print-queue] job deleted', { id: job.id });
    broadcastPrintQueueChanged();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('print-queue:clear-completed', async () => {
  try {
    const before = printQueue.length;
    for (let index = printQueue.length - 1; index >= 0; index -= 1) {
      if (FINAL_PRINT_JOB_STATUSES.has(printQueue[index].status)) {
        pendingPrintJobs.delete(printQueue[index].id);
        printQueue.splice(index, 1);
      }
    }
    const count = before - printQueue.length;
    console.log('[print-queue] completed jobs cleared', { count });
    broadcastPrintQueueChanged();
    return { ok: true, count };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('print-center:open', async () => {
  try {
    if (process.platform !== 'darwin') {
      return { ok: false, error: 'Print Center is only available on macOS' };
    }
    const child = spawn('open', ['-a', 'Print Center'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log('[print-center] open requested');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
