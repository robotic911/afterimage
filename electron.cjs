const { app, BrowserWindow, ipcMain, protocol, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

const APP_ID = 'com.kennethpatino.kukuphotobooth';

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}

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
const COLOR_THEME_IDS = new Set(['editorialMono', 'champagneNoir', 'roseVelvet', 'oceanMist', 'forestFilm']);
let templateIndexCache = null;

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
    privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true },
  },
  {
    scheme: 'kuku-event',
    privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true },
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

function loadRendererWindow(win, windowType = null) {
  const entry = resolveAppEntry();
  const target = buildRendererUrl(entry, windowType);
  return win.loadURL(target);
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
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('close', () => {
    if (todayMonitorWindow && !todayMonitorWindow.isDestroyed()) {
      todayMonitorWindow.close();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

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
  todayMonitorWindow = new BrowserWindow({
    width: monitorWidth,
    height: monitorHeight,
    x: Math.min(Math.max(workArea.x + 16, nextX), workArea.x + workArea.width - monitorWidth - 16),
    y: Math.min(Math.max(workArea.y + 16, nextY), workArea.y + workArea.height - monitorHeight - 16),
    title: 'Afterimage Today Monitor',
    resizable: true,
    alwaysOnTop: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
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

  loadRendererWindow(todayMonitorWindow, 'today-monitor');
  console.log('[monitor] today monitor window created');
  return todayMonitorWindow;
}

app.whenReady().then(async () => {
  resolvePaths();

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
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store, max-age=0',
        },
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
      return new Response(data, { headers: { 'Content-Type': contentType } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  createWindow();
  createTodayMonitorWindow();
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
const MAX_COUNTDOWN_SECONDS = 10;
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
    printerProfileId: DEFAULT_PRINTER_PROFILE_ID,
    safeMarginOverride: DEFAULT_SAFE_MARGIN_OVERRIDE,
    softcopySettings: DEFAULT_SOFTCOPY_SETTINGS,
    layoutSettings: DEFAULT_LAYOUT_SETTINGS,
    bundledTemplateOverrides: {},
    countdownSeconds: DEFAULT_COUNTDOWN_SECONDS,
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
        testModeEnabled: false,
        printerProfileId: DEFAULT_PRINTER_PROFILE_ID,
        safeMarginOverride: DEFAULT_SAFE_MARGIN_OVERRIDE,
        softcopySettings: DEFAULT_SOFTCOPY_SETTINGS,
        layoutSettings: DEFAULT_LAYOUT_SETTINGS,
        countdownSeconds: DEFAULT_COUNTDOWN_SECONDS,
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
    };

    if (next.mode === 'event' && next.activeEventId) {
      const events = await readEventsIndex();
      if (!events.some((event) => event.id === next.activeEventId && event.enabled !== false)) {
        return { ok: false, error: 'active event does not exist or is disabled' };
      }
    }

    await writeSettings(next);
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

const SESSION_PRINT_STATUSES = new Set(['completed', 'failed', 'cancelled', 'partial']);

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
    testMode:      input.testMode === true || input.isTest === true,
    copies,
    printStatus,
    printCopiesRequested,
    printCopiesCompleted,
    unitPrice,
    totalAmount,
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
  if (!fs.existsSync(sessionsFile)) return [];
  const raw = await fsp.readFile(sessionsFile, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
  }
  return out;
}

ipcMain.handle('sessions:log', async (_ev, payload = {}) => {
  try {
    const record = sanitizeSession(payload);
    await fsp.appendFile(sessionsFile, JSON.stringify(record) + '\n', 'utf8');
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
    const agg = () => ({ sessions: 0, copies: 0, revenue: 0, failed: 0 });
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
      byDay[key] = { date: key, sessions: 0, copies: 0, revenue: 0 };
    }

    // By-template breakdown (revenue + copies, all-time only)
    const byTemplate = {};

    for (const s of all) {
      if (!s || !s.dateLocal) continue;
      const d = s.dateLocal;
      const failed = s.status === 'failed';
      const add = (b) => {
        b.sessions += 1;
        if (!failed) {
          b.copies  += s.copies || 0;
          b.revenue += s.totalAmount || 0;
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
        byDay[d].copies   += s.copies || 0;
        byDay[d].revenue  += s.totalAmount || 0;
      }

      if (s.templateId && !failed) {
        const t = byTemplate[s.templateId] || {
          templateId: s.templateId,
          templateName: s.templateName || s.templateId,
          sessions: 0, copies: 0, revenue: 0,
        };
        t.sessions += 1;
        t.copies   += s.copies || 0;
        t.revenue  += s.totalAmount || 0;
        byTemplate[s.templateId] = t;
      }
    }

    return {
      ok: true,
      totals: buckets,
      byDay: Object.values(byDay),              // chronological, oldest → newest
      byTemplate: Object.values(byTemplate)
        .sort((a, b) => b.revenue - a.revenue), // ranked by revenue desc
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
    // Tell every renderer so an open dashboard re-pulls its (now empty) state.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try { win.webContents.send('sessions:cleared'); } catch { /* renderer gone */ }
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

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
const printQueue = [];
const pendingPrintJobs = new Map();
let activePrintJobId = null;

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
    copies: job.copies,
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
  jobId = null,
} = {}) {
  const finalStatus = ['completed', 'failed', 'cancelled', 'partial'].includes(status) ? status : 'failed';
  const safeRequested = Math.max(0, Math.floor(Number(copiesRequested) || 0));
  const safePrinted = Math.max(0, Math.min(safeRequested || Number.MAX_SAFE_INTEGER, Math.floor(Number(copiesPrinted) || 0)));
  const safeError = typeof error === 'string' && error.trim() ? error.trim().slice(0, 256) : null;
  return {
    ok: finalStatus === 'completed',
    success: finalStatus === 'completed',
    status: finalStatus,
    copiesRequested: safeRequested,
    copiesPrinted: safePrinted,
    requestedCopies: safeRequested,
    completedCopies: safePrinted,
    error: safeError,
    failureReason: finalStatus === 'failed' ? safeError : null,
    jobId,
  };
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

function createPrintJob(payload = {}, copyCount) {
  const job = {
    id: newPrintJobId(),
    sessionId: safeQueueText(payload.sessionId, 128),
    templateName: safeQueueText(payload.templateName, 128),
    layoutName: safeQueueText(payload.layoutName, 128),
    copies: copyCount,
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
  updatePrintJob(job, {
    status: 'printing',
    startedAt: new Date().toISOString(),
    error: null,
  });
  console.log('[print-queue] job started', { id: job.id });

  const { dataUrl, silent, sender } = pending;
  const printWin = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: false,
    },
  });

  const shell = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: 4in 6in; margin: 0; }
  html, body { margin: 0; padding: 0; width: 4in; height: 6in; background: #fff; }
  img {
    width: 4in;
    height: 6in;
    display: block;
    image-rendering: -webkit-optimize-contrast;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
</style>
</head>
<body></body>
</html>`;

  try {
    await printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(shell));
    await printWin.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const img = document.createElement('img');
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = ${JSON.stringify(dataUrl)};
        document.body.appendChild(img);
      });
    `);
    await new Promise(r => setTimeout(r, 80));

    const dataUrlFormat = typeof dataUrl === 'string'
      ? (dataUrl.split(';')[0] || '').replace('data:', '')
      : 'unknown';
    const printOptions = {
      silent: silent === true,
      printBackground: true,
      copies: 1,
      pageSize: { width: 4 * MICRONS_PER_INCH, height: 6 * MICRONS_PER_INCH },
      margins: { marginType: 'none' },
      landscape: false,
      scaleFactor: 100,
    };
    console.log('[print] starting print job', {
      format: dataUrlFormat,
      sizeKb: Math.round(dataUrl.length / 1024),
      copies: job.copies,
      printerName: printOptions.deviceName || null,
      scaleFactor: printOptions.scaleFactor,
      queueJobId: job.id,
    });

    let completedCopies = 0;
    for (let copyIndex = 0; copyIndex < job.copies; copyIndex += 1) {
      if (job.cancelRequested) {
        const status = completedCopies > 0 ? 'partial' : 'cancelled';
        updatePrintJob(job, {
          status,
          completedAt: new Date().toISOString(),
          error: completedCopies > 0 ? 'Stopped remaining copies.' : null,
        });
        console.log('[print-queue] job cancelled', { id: job.id });
        return normalizePrintResult({
          status,
          copiesRequested: job.copies,
          copiesPrinted: completedCopies,
          error: completedCopies > 0 ? 'Stopped remaining copies.' : null,
          jobId: job.id,
        });
      }

      const currentCopy = copyIndex + 1;
      updatePrintJob(job, { currentCopy });
      console.log('[print-queue] printing copy', { id: job.id, currentCopy, copies: job.copies });
      try {
        sender?.send('print-strip-progress', { current: currentCopy, total: job.copies, jobId: job.id });
      } catch {
        // Renderer may already be gone; queue state remains authoritative.
      }

      const result = await new Promise((resolve) => {
        printWin.webContents.print(printOptions, (success, failureReason) => {
          resolve({ success, failureReason: failureReason || null });
        });
      });

      if (!result.success) {
        const failureReason = result.failureReason || `copy ${currentCopy} failed`;
        updatePrintJob(job, {
          status: 'failed',
          error: failureReason,
          completedAt: new Date().toISOString(),
        });
        console.log('[print-queue] job failed', { id: job.id, error: failureReason });
        return normalizePrintResult({
          status: 'failed',
          copiesRequested: job.copies,
          copiesPrinted: completedCopies,
          error: failureReason,
          jobId: job.id,
        });
      }

      completedCopies = currentCopy;

      if (copyIndex < job.copies - 1) {
        await wait(350);
      }
    }

    updatePrintJob(job, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      currentCopy: job.copies,
      error: null,
    });
    console.log('[print-queue] job completed', { id: job.id });
    return normalizePrintResult({
      status: 'completed',
      copiesRequested: job.copies,
      copiesPrinted: job.copies,
      jobId: job.id,
    });
  } catch (err) {
    const failureReason = err?.message || String(err);
    updatePrintJob(job, {
      status: 'failed',
      error: failureReason,
      completedAt: new Date().toISOString(),
    });
    console.log('[print-queue] job failed', { id: job.id, error: failureReason });
    return normalizePrintResult({
      status: 'failed',
      copiesRequested: job.copies,
      copiesPrinted: Math.max(0, Math.min(job.currentCopy || 0, job.copies || 0)),
      error: failureReason,
      jobId: job.id,
    });
  } finally {
    if (!printWin.isDestroyed()) printWin.close();
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
      completedAt: new Date().toISOString(),
    });
    pendingPrintJobs.delete(nextJob.id);
    console.log('[print-queue] job cancelled', { id: nextJob.id });
    pending.resolve(normalizePrintResult({
      status: 'cancelled',
      copiesRequested: nextJob.copies,
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
    await fsp.writeFile(filePath, pngBuffer);
    console.log('[print] autosaved PNG:', filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    console.warn('[print] autosave failed:', err?.message || String(err));
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('print-strip', async (event, payload = {}) => {
  const {
    dataUrl,
    copies = 1,
    silent = true,
  } = payload;
  const copyCount = clampPrintCopies(copies);
  if (!dataUrl || typeof dataUrl !== 'string') {
    return normalizePrintResult({ status: 'failed', error: 'missing dataUrl' });
  }

  try {
    const settings = await readSettings();
    if (settings.printEnabled === false) {
      return normalizePrintResult({ status: 'failed', copiesRequested: copyCount, error: 'printing disabled by admin' });
    }
  } catch (err) {
    return normalizePrintResult({ status: 'failed', copiesRequested: copyCount, error: err?.message || 'failed to read settings' });
  }

  const job = createPrintJob(payload, copyCount);
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
        completedAt: new Date().toISOString(),
      });
      const pending = pendingPrintJobs.get(job.id);
      if (pending) {
        pendingPrintJobs.delete(job.id);
        pending.resolve(normalizePrintResult({
          status: 'cancelled',
          copiesRequested: job.copies,
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
