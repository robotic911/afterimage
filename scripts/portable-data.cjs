#!/usr/bin/env node

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 1;
const APP_NAME = 'Afterimage';
const PORTABLE_DIR_NAME = 'portable-data';
const PORTABLE_SEP = '/';
const TEMPLATE_ASSET_NAMES = ['overlay.png', 'preview.png', 'background.png', 'template.png'];
const EVENT_ASSET_PATTERN = /^landing-background\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i;

const SECRET_FIELD_PATTERN = /^(serviceRoleKey|service_role|accessToken|refreshToken|apiSecret|privateKey|password|authorization|SUPABASE_SERVICE_ROLE_KEY|CLEANUP_SOFTCOPIES_SECRET)$/i;
const SECRET_TEXT_PATTERN = /(SUPABASE_SERVICE_ROLE_KEY|CLEANUP_SOFTCOPIES_SECRET|service_role|access_token|refresh_token|private_key|api_secret|authorization\s*[:=])/i;
const ABSOLUTE_PATH_PATTERN = /(?:^|["\s])(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/|\/var\/folders\/|\/private\/var\/|\/tmp\/)/;

const MACHINE_SPECIFIC_SETTINGS = new Set([
  'selectedPrinterName',
]);

const SESSION_MEDIA_FIELDS = [
  'softcopySessionToken',
  'softcopyPhotoPath',
  'softcopyGifPath',
  'softcopyVideoPath',
  'softcopyExpiresAt',
  'finalPrintPath',
  'printImagePath',
  'localPhotoPath',
  'photoPath',
  'videoPath',
  'gifPath',
  'keychainPath',
  'keychainFilename',
];

function portablePath(...segments) {
  return segments
    .filter(Boolean)
    .join(PORTABLE_SEP)
    .replace(/\\/g, PORTABLE_SEP)
    .replace(/\/+/g, PORTABLE_SEP);
}

function toNativePortablePath(projectRoot, portableRelativePath) {
  const safe = String(portableRelativePath || '')
    .split(/[\\/]+/)
    .filter(part => part && part !== '.' && part !== '..');
  return path.join(projectRoot, PORTABLE_DIR_NAME, ...safe);
}

function normalizeId(value, fallback = 'item') {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128) || fallback;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((out, key) => {
      out[key] = sortObject(value[key]);
      return out;
    }, {});
}

function stableJson(value) {
  return `${JSON.stringify(sortObject(value), null, 2)}\n`;
}

function stableJsonLine(value) {
  return JSON.stringify(sortObject(value));
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw new Error(`Invalid JSON at ${filePath}: ${error.message}`);
  }
}

async function writeJsonFile(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, stableJson(value), 'utf8');
}

async function copyFileIfExists(sourcePath, destinationPath) {
  if (!sourcePath || !(await pathExists(sourcePath))) return false;
  await ensureDir(path.dirname(destinationPath));
  await fsp.copyFile(sourcePath, destinationPath);
  return true;
}

async function copyDirIfExists(sourceDir, destinationDir) {
  if (!(await pathExists(sourceDir))) return false;
  await fsp.cp(sourceDir, destinationDir, { recursive: true, force: true });
  return true;
}

async function removeIfExists(targetPath) {
  await fsp.rm(targetPath, { recursive: true, force: true });
}

function getProjectRoot() {
  return path.resolve(__dirname, '..');
}

function resolveUserDataDir() {
  if (process.env.AFTERIMAGE_USER_DATA_DIR) {
    return path.resolve(process.env.AFTERIMAGE_USER_DATA_DIR);
  }

  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_NAME);
}

function getRuntimePaths(userDataDir = resolveUserDataDir()) {
  return {
    userDataDir,
    settingsFile: path.join(userDataDir, 'settings.json'),
    templatesDir: path.join(userDataDir, 'templates'),
    templatesIndexFile: path.join(userDataDir, 'templates', 'index.json'),
    eventsDir: path.join(userDataDir, 'events'),
    eventsIndexFile: path.join(userDataDir, 'events', 'index.json'),
    sessionsFile: path.join(userDataDir, 'sessions.jsonl'),
  };
}

function getPortablePaths(projectRoot = getProjectRoot()) {
  const root = path.join(projectRoot, PORTABLE_DIR_NAME);
  return {
    root,
    manifestFile: path.join(root, 'manifest.json'),
    schemaVersionFile: path.join(root, 'schema-version.json'),
    readmeFile: path.join(root, 'README.md'),
    settingsDir: path.join(root, 'settings'),
    settingsFile: path.join(root, 'settings', 'app-settings.json'),
    pricingFile: path.join(root, 'settings', 'pricing.json'),
    templatesDir: path.join(root, 'templates'),
    templatesFile: path.join(root, 'templates', 'templates.json'),
    templateAssetsDir: path.join(root, 'templates', 'assets'),
    eventsDir: path.join(root, 'events'),
    eventsFile: path.join(root, 'events', 'events.json'),
    eventAssetsDir: path.join(root, 'events', 'assets'),
    recordsDir: path.join(root, 'records'),
    sessionsFile: path.join(root, 'records', 'sessions.jsonl'),
    keychainSalesFile: path.join(root, 'records', 'keychain-sales.json'),
    migrationsDir: path.join(root, 'migrations'),
  };
}

function sanitizeSecretFields(value, report, location = '') {
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeSecretFields(item, report, `${location}[${index}]`));
  }
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const nextLocation = location ? `${location}.${key}` : key;
    if (SECRET_FIELD_PATTERN.test(key)) {
      report.skippedSecretFields += 1;
      report.secretFieldNames.add(key);
      continue;
    }
    out[key] = sanitizeSecretFields(item, report, nextLocation);
  }
  return out;
}

function stripRuntimeTemplateFields(record = {}) {
  const {
    src,
    previewSrc,
    overlaySrc,
    backgroundSrc,
    storageSource,
    templateSourcePath,
    ...rest
  } = record || {};
  return rest;
}

function getTemplateRuntimeDir(runtimePaths, record = {}) {
  if (record.storageMode === 'legacy' || record.storageSource === 'legacy' || !record.layoutId) {
    return path.join(runtimePaths.templatesDir, record.id);
  }
  return path.join(runtimePaths.templatesDir, record.layoutId, record.id);
}

function buildTemplateUrls(record = {}, copiedAssetNames = []) {
  const hasPreview = copiedAssetNames.includes('preview.png');
  const legacy = record.storageMode === 'legacy' || !record.layoutId;
  const base = `kuku-template://${record.id}`;
  if (legacy) {
    const overlayName = copiedAssetNames.includes('overlay.png') ? 'overlay.png' : 'template.png';
    const overlaySrc = `${base}/${overlayName}`;
    return {
      src: overlaySrc,
      previewSrc: hasPreview ? `${base}/preview.png` : null,
      overlaySrc,
      backgroundSrc: overlaySrc,
    };
  }
  const overlaySrc = `${base}/overlay.png`;
  return {
    src: overlaySrc,
    previewSrc: hasPreview ? `${base}/preview.png` : null,
    overlaySrc,
    backgroundSrc: overlaySrc,
  };
}

function sanitizeSettingsForExport(settings = {}, report) {
  const clean = sanitizeSecretFields(settings && typeof settings === 'object' ? settings : {}, report);
  for (const field of MACHINE_SPECIFIC_SETTINGS) {
    if (Object.prototype.hasOwnProperty.call(clean, field) && clean[field] !== null) {
      report.skippedMachineFields += 1;
    }
    clean[field] = null;
  }
  return clean;
}

function sanitizeKeychainSaleForExport(sale = {}, report) {
  const clean = sanitizeSecretFields(sale && typeof sale === 'object' ? sale : {}, report);
  const out = {
    id: typeof clean.id === 'string' && clean.id ? clean.id : null,
    createdAt: typeof clean.createdAt === 'string' ? clean.createdAt : null,
    copies: Number.isFinite(Number(clean.copies)) ? Math.max(0, Math.floor(Number(clean.copies))) : 0,
    amount: Number.isFinite(Number(clean.amount)) ? Math.max(0, Number(clean.amount)) : 0,
    printStatus: typeof clean.printStatus === 'string' ? clean.printStatus : 'completed',
    keychainPath: null,
    keychainFilename: null,
    mediaAvailable: false,
  };
  if (clean.keychainPath || clean.keychainFilename) report.skippedGeneratedMediaFields += 1;
  return out.id ? out : null;
}

function sanitizeSessionForExport(session = {}, report) {
  const clean = sanitizeSecretFields(session && typeof session === 'object' ? session : {}, report);
  const out = { ...clean };

  for (const field of SESSION_MEDIA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(out, field) && out[field]) {
      report.skippedGeneratedMediaFields += 1;
    }
    out[field] = null;
  }

  if (Array.isArray(clean.keychainSales)) {
    out.keychainSales = clean.keychainSales
      .map(sale => sanitizeKeychainSaleForExport(sale, report))
      .filter(Boolean)
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || (a.id || '').localeCompare(b.id || ''));
  } else {
    out.keychainSales = [];
  }

  out.mediaAvailable = false;
  out.portableMediaExcluded = true;
  out.portableMediaNote = 'Generated customer media is not included in portable-data.';
  return out;
}

async function readSessionsJsonl(filePath) {
  if (!(await pathExists(filePath))) return { records: [], malformed: 0 };
  const raw = await fsp.readFile(filePath, 'utf8');
  const records = [];
  let malformed = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed);
      } else {
        malformed += 1;
      }
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
}

function dedupeById(records = [], fallbackPrefix = 'record') {
  const byId = new Map();
  let generated = 0;
  for (const record of records) {
    const id = typeof record.id === 'string' && record.id ? record.id : `${fallbackPrefix}-${generated += 1}`;
    byId.set(id, { ...record, id });
  }
  return Array.from(byId.values());
}

function sortSessions(records = []) {
  return [...records].sort((a, b) => (
    (a.timestamp || '').localeCompare(b.timestamp || '')
    || (a.id || '').localeCompare(b.id || '')
  ));
}

function sortTemplates(records = []) {
  return [...records].sort((a, b) => (
    (a.layoutId || '').localeCompare(b.layoutId || '')
    || (a.mode || '').localeCompare(b.mode || '')
    || (a.eventId || '').localeCompare(b.eventId || '')
    || (a.name || '').localeCompare(b.name || '')
    || (a.id || '').localeCompare(b.id || '')
  ));
}

function sortEvents(records = []) {
  return [...records].sort((a, b) => (
    (a.eventDate || '').localeCompare(b.eventDate || '')
    || (a.name || '').localeCompare(b.name || '')
    || (a.id || '').localeCompare(b.id || '')
  ));
}

function getPricingSnapshot() {
  let keychain = {};
  let defaultKeychainCopies = 3;
  try {
    const pricing = require('../keychainPricing.cjs');
    keychain = pricing.KEYCHAIN_PRICING || {};
    defaultKeychainCopies = pricing.DEFAULT_KEYCHAIN_COPIES || defaultKeychainCopies;
  } catch {
    keychain = { 2: 150, 3: 199 };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    currency: 'PHP',
    stripPricePerCopy: 99,
    stripPriceSource: 'src/components/screens/PrintScreen.jsx PRICE_PER_COPY',
    keychainPricing: keychain,
    defaultKeychainCopies,
    keychainPriceSource: 'keychainPricing.cjs',
  };
}

async function writePortableReadme(portablePaths) {
  await ensureDir(path.dirname(portablePaths.readmeFile));
  const text = [
    '# Afterimage Portable Data',
    '',
    'This directory is intentionally version-controlled. It contains portable app configuration, template/event assets, and scrubbed business records exported from Electron userData.',
    '',
    'Do not place `.env` files, Supabase service role keys, generated customer media, Downloads output, cache files, or machine-specific printer/camera settings here.',
    '',
    'Use `npm run data:export` on the source laptop and `npm run data:import` on the destination laptop.',
    '',
  ].join('\n');
  await fsp.writeFile(portablePaths.readmeFile, text, 'utf8');
}

async function exportTemplates(runtimePaths, portablePaths, report, exportedAt) {
  const index = await readJsonFile(runtimePaths.templatesIndexFile, { templates: [] });
  const sourceRecords = Array.isArray(index?.templates) ? index.templates : [];
  const templates = [];
  await removeIfExists(portablePaths.templateAssetsDir);
  await ensureDir(portablePaths.templateAssetsDir);

  for (const sourceRecord of sourceRecords) {
    const id = normalizeId(sourceRecord.id, 'template');
    const clean = sanitizeSecretFields(stripRuntimeTemplateFields({ ...sourceRecord, id }), report);
    const assetRoot = path.join(portablePaths.templateAssetsDir, id);
    const relativeAssetRoot = portablePath('assets', id);
    const runtimeDir = getTemplateRuntimeDir(runtimePaths, sourceRecord);
    const assets = {};
    const copiedAssetNames = [];

    for (const assetName of TEMPLATE_ASSET_NAMES) {
      const sourcePath = path.join(runtimeDir, assetName);
      const destinationPath = path.join(assetRoot, assetName);
      if (await copyFileIfExists(sourcePath, destinationPath)) {
        assets[assetName.replace(/\.png$/i, '')] = portablePath(relativeAssetRoot, assetName);
        copiedAssetNames.push(assetName);
        report.templateAssets += 1;
        report.templateAssetBytes += (await fsp.stat(destinationPath)).size;
      }
    }

    templates.push({
      ...clean,
      id,
      assets,
      copiedAssetNames,
    });
  }

  const sorted = sortTemplates(templates);
  await writeJsonFile(portablePaths.templatesFile, {
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    templates: sorted,
  });
  report.templates = sorted.length;
  return sorted;
}

async function exportEvents(runtimePaths, portablePaths, report, exportedAt) {
  const index = await readJsonFile(runtimePaths.eventsIndexFile, { events: [] });
  const sourceRecords = Array.isArray(index?.events) ? index.events : [];
  const events = [];
  await removeIfExists(portablePaths.eventAssetsDir);
  await ensureDir(portablePaths.eventAssetsDir);

  for (const sourceEvent of sourceRecords) {
    const id = normalizeId(sourceEvent.id, 'event');
    const clean = sanitizeSecretFields({ ...sourceEvent, id }, report);
    const eventDir = path.join(runtimePaths.eventsDir, sourceEvent.id || id);
    const assetRoot = path.join(portablePaths.eventAssetsDir, id);
    const assets = {};

    if (await pathExists(eventDir)) {
      const entries = await fsp.readdir(eventDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !EVENT_ASSET_PATTERN.test(entry.name)) continue;
        const sourcePath = path.join(eventDir, entry.name);
        const destinationPath = path.join(assetRoot, entry.name);
        if (await copyFileIfExists(sourcePath, destinationPath)) {
          assets.landingBackground = portablePath('assets', id, entry.name);
          report.eventAssets += 1;
          report.eventAssetBytes += (await fsp.stat(destinationPath)).size;
        }
      }
    }

    if (clean.landingBackground?.src) {
      clean.landingBackground = {
        ...clean.landingBackground,
        src: assets.landingBackground || null,
      };
    }
    events.push({ ...clean, assets });
  }

  const sorted = sortEvents(events);
  await writeJsonFile(portablePaths.eventsFile, {
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    events: sorted,
  });
  report.events = sorted.length;
  return sorted;
}

async function exportSessions(runtimePaths, portablePaths, report) {
  const { records, malformed } = await readSessionsJsonl(runtimePaths.sessionsFile);
  report.malformedSessionsSkipped = malformed;
  const deduped = dedupeById(records, 'session')
    .map(record => sanitizeSessionForExport(record, report));
  const sessions = sortSessions(deduped);
  await ensureDir(portablePaths.recordsDir);
  await fsp.writeFile(
    portablePaths.sessionsFile,
    sessions.map(stableJsonLine).join('\n') + (sessions.length ? '\n' : ''),
    'utf8',
  );

  const keychainSales = sessions
    .flatMap(session => (Array.isArray(session.keychainSales) ? session.keychainSales.map(sale => ({
      ...sale,
      sessionId: session.id,
      templateId: session.templateId || null,
      templateName: session.templateName || null,
      layoutId: session.layoutId || null,
      layoutName: session.layoutName || null,
      mode: session.mode || 'daily',
      eventId: session.eventId || null,
      eventName: session.eventName || null,
    })) : []))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || (a.id || '').localeCompare(b.id || ''));

  await writeJsonFile(portablePaths.keychainSalesFile, {
    schemaVersion: SCHEMA_VERSION,
    sales: keychainSales,
  });

  report.sessions = sessions.length;
  report.keychainSales = keychainSales.length;
  return { sessions, keychainSales };
}

async function validatePortableData(projectRoot = getProjectRoot()) {
  const portablePaths = getPortablePaths(projectRoot);
  const problems = [];

  if (!(await pathExists(portablePaths.manifestFile))) {
    problems.push('portable-data/manifest.json is missing');
  }

  const files = [];
  async function collect(dir) {
    if (!(await pathExists(dir))) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await collect(filePath);
      } else {
        files.push(filePath);
      }
    }
  }
  await collect(portablePaths.root);

  for (const filePath of files) {
    const relative = path.relative(portablePaths.root, filePath).replace(/\\/g, '/');
    if (/\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i.test(filePath)) continue;
    const text = await fsp.readFile(filePath, 'utf8');
    if (SECRET_TEXT_PATTERN.test(text)) {
      problems.push(`${relative} contains a known secret-looking token or key name`);
    }
    if (/\.(json|jsonl)$/i.test(filePath) && ABSOLUTE_PATH_PATTERN.test(text)) {
      problems.push(`${relative} contains an absolute local path`);
    }
    if (/\.json$/i.test(filePath)) {
      try {
        const parsed = JSON.parse(text);
        const secretKeys = [];
        (function walk(value) {
          if (Array.isArray(value)) {
            value.forEach(walk);
            return;
          }
          if (!value || typeof value !== 'object') return;
          for (const [key, item] of Object.entries(value)) {
            if (SECRET_FIELD_PATTERN.test(key)) secretKeys.push(key);
            walk(item);
          }
        })(parsed);
        if (secretKeys.length) {
          problems.push(`${relative} contains secret fields: ${Array.from(new Set(secretKeys)).join(', ')}`);
        }
      } catch (error) {
        problems.push(`${relative} is invalid JSON: ${error.message}`);
      }
    }
    if (/\.jsonl$/i.test(filePath)) {
      const lines = text.split(/\r?\n/).filter(Boolean);
      lines.forEach((line, index) => {
        try {
          JSON.parse(line);
        } catch (error) {
          problems.push(`${relative}:${index + 1} is invalid JSONL: ${error.message}`);
        }
      });
    }
  }

  if (problems.length) {
    throw new Error(`Portable data validation failed:\n- ${problems.join('\n- ')}`);
  }
}

async function exportPortableData(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || getProjectRoot());
  const runtimePaths = getRuntimePaths(path.resolve(options.userDataDir || resolveUserDataDir()));
  const portablePaths = getPortablePaths(projectRoot);
  const packageJson = await readJsonFile(path.join(projectRoot, 'package.json'), {});
  const exportedAt = new Date().toISOString();
  const report = {
    settings: 0,
    templates: 0,
    templateAssets: 0,
    templateAssetBytes: 0,
    events: 0,
    eventAssets: 0,
    eventAssetBytes: 0,
    sessions: 0,
    keychainSales: 0,
    malformedSessionsSkipped: 0,
    skippedMachineFields: 0,
    skippedGeneratedMediaFields: 0,
    skippedSecretFields: 0,
    secretFieldNames: new Set(),
    output: path.relative(projectRoot, portablePaths.root) || PORTABLE_DIR_NAME,
    runtimeUserDataDir: runtimePaths.userDataDir,
  };

  await ensureDir(portablePaths.root);
  await ensureDir(portablePaths.settingsDir);
  await ensureDir(portablePaths.templatesDir);
  await ensureDir(portablePaths.eventsDir);
  await ensureDir(portablePaths.recordsDir);
  await ensureDir(portablePaths.migrationsDir);
  await fsp.writeFile(path.join(portablePaths.migrationsDir, '.gitkeep'), '', 'utf8');
  await writePortableReadme(portablePaths);

  const settings = sanitizeSettingsForExport(
    await readJsonFile(runtimePaths.settingsFile, {}),
    report,
  );
  await writeJsonFile(portablePaths.settingsFile, {
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    settings,
  });
  report.settings = settings && Object.keys(settings).length ? 1 : 0;

  await writeJsonFile(portablePaths.pricingFile, {
    ...getPricingSnapshot(),
    exportedAt,
  });

  await exportTemplates(runtimePaths, portablePaths, report, exportedAt);
  await exportEvents(runtimePaths, portablePaths, report, exportedAt);
  await exportSessions(runtimePaths, portablePaths, report);

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    app: {
      name: packageJson.productName || APP_NAME,
      packageName: packageJson.name || null,
      version: packageJson.version || null,
    },
    source: {
      platform: process.platform,
      portableTool: 'scripts/portable-data.cjs',
    },
    files: {
      settings: portablePath('settings', 'app-settings.json'),
      pricing: portablePath('settings', 'pricing.json'),
      templates: portablePath('templates', 'templates.json'),
      templateAssets: portablePath('templates', 'assets'),
      events: portablePath('events', 'events.json'),
      eventAssets: portablePath('events', 'assets'),
      sessions: portablePath('records', 'sessions.jsonl'),
      keychainSales: portablePath('records', 'keychain-sales.json'),
    },
    counts: {
      settings: report.settings,
      templates: report.templates,
      templateAssets: report.templateAssets,
      events: report.events,
      eventAssets: report.eventAssets,
      sessions: report.sessions,
      keychainSales: report.keychainSales,
    },
    excluded: {
      adminPinHash: true,
      selectedPrinterName: true,
      cameraDeviceId: true,
      generatedCustomerMedia: true,
      downloadsOutput: true,
      supabaseSecrets: true,
      electronCache: true,
      localStorageInProgressShots: true,
    },
    skipped: {
      machineSpecificFields: report.skippedMachineFields,
      generatedMediaFields: report.skippedGeneratedMediaFields,
      secretFields: report.skippedSecretFields,
      malformedSessions: report.malformedSessionsSkipped,
    },
  };

  await writeJsonFile(portablePaths.schemaVersionFile, {
    schemaVersion: SCHEMA_VERSION,
  });
  await writeJsonFile(portablePaths.manifestFile, manifest);
  await validatePortableData(projectRoot);

  return {
    ...report,
    secretFieldNames: Array.from(report.secretFieldNames).sort(),
  };
}

async function loadPortableBundle(projectRoot = getProjectRoot()) {
  const portablePaths = getPortablePaths(projectRoot);
  const manifest = await readJsonFile(portablePaths.manifestFile, null);
  if (!manifest) throw new Error('portable-data/manifest.json does not exist. Run npm run data:export first.');
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported portable-data schemaVersion ${manifest.schemaVersion}; expected ${SCHEMA_VERSION}.`);
  }

  const settingsDoc = await readJsonFile(portablePaths.settingsFile, null);
  const templatesDoc = await readJsonFile(portablePaths.templatesFile, null);
  const eventsDoc = await readJsonFile(portablePaths.eventsFile, null);
  const sessionsData = await readSessionsJsonl(portablePaths.sessionsFile);
  const keychainSalesDoc = await readJsonFile(portablePaths.keychainSalesFile, { sales: [] });

  if (settingsDoc?.schemaVersion !== SCHEMA_VERSION) throw new Error('settings/app-settings.json has an unsupported schemaVersion.');
  if (templatesDoc?.schemaVersion !== SCHEMA_VERSION) throw new Error('templates/templates.json has an unsupported schemaVersion.');
  if (eventsDoc?.schemaVersion !== SCHEMA_VERSION) throw new Error('events/events.json has an unsupported schemaVersion.');
  if (!Array.isArray(templatesDoc.templates)) throw new Error('templates/templates.json must contain a templates array.');
  if (!Array.isArray(eventsDoc.events)) throw new Error('events/events.json must contain an events array.');
  if (!Array.isArray(keychainSalesDoc.sales)) throw new Error('records/keychain-sales.json must contain a sales array.');
  if (sessionsData.malformed > 0) throw new Error(`records/sessions.jsonl contains ${sessionsData.malformed} malformed line(s).`);

  return {
    portablePaths,
    manifest,
    settings: settingsDoc.settings || {},
    templates: templatesDoc.templates,
    events: eventsDoc.events,
    sessions: sessionsData.records,
    keychainSales: keychainSalesDoc.sales,
  };
}

function buildRuntimeTemplateRecord(template = {}) {
  const {
    assets,
    copiedAssetNames,
    ...rest
  } = stripRuntimeTemplateFields(template);
  const assetNames = Array.isArray(copiedAssetNames)
    ? copiedAssetNames
    : Object.values(assets || {}).map(value => path.basename(String(value)));
  return {
    ...rest,
    ...buildTemplateUrls(rest, assetNames),
  };
}

function comparableTemplateRecord(template = {}) {
  const {
    assets,
    copiedAssetNames,
    ...rest
  } = stripRuntimeTemplateFields(template);
  return rest;
}

function eventAssetUrl(eventId, fileName) {
  return `kuku-event://${eventId}/${fileName}`;
}

function buildRuntimeEventRecord(event = {}) {
  const { assets, ...rest } = event;
  const landingAsset = assets?.landingBackground || rest.landingBackground?.src || null;
  if (!landingAsset || !rest.landingBackground || rest.landingBackground.type === 'none') {
    return {
      ...rest,
      landingBackground: { type: 'none', src: null },
    };
  }
  return {
    ...rest,
    landingBackground: {
      ...rest.landingBackground,
      src: eventAssetUrl(rest.id, path.basename(String(landingAsset))),
    },
  };
}

function comparableEventRecord(event = {}) {
  const { assets, ...rest } = event || {};
  const landingBackground = rest.landingBackground && typeof rest.landingBackground === 'object'
    ? {
        ...rest.landingBackground,
        src: rest.landingBackground.src ? path.basename(String(rest.landingBackground.src)) : null,
      }
    : rest.landingBackground;
  return {
    ...rest,
    landingBackground,
  };
}

async function buildImportStage(bundle, runtimePaths, mode = 'replace') {
  const stageDir = path.join(runtimePaths.userDataDir, `.portable-import-staging-${Date.now()}`);
  const stageRuntimePaths = getRuntimePaths(stageDir);
  await ensureDir(stageDir);
  await ensureDir(stageRuntimePaths.templatesDir);
  await ensureDir(stageRuntimePaths.eventsDir);

  let settings = bundle.settings;
  let templates = bundle.templates;
  let events = bundle.events;
  let sessions = bundle.sessions;
  const conflicts = {
    templates: 0,
    events: 0,
    sessions: 0,
  };

  if (mode === 'merge') {
    const existingSettings = await readJsonFile(runtimePaths.settingsFile, {});
    settings = {
      ...existingSettings,
      ...bundle.settings,
      selectedPrinterName: existingSettings.selectedPrinterName || null,
    };

    const existingTemplates = (await readJsonFile(runtimePaths.templatesIndexFile, { templates: [] }))?.templates || [];
    const existingByTemplateId = new Map(existingTemplates.map(template => [template.id, comparableTemplateRecord(template)]));
    templates = [
      ...existingTemplates.map(stripRuntimeTemplateFields),
      ...bundle.templates.filter((template) => {
        const existing = existingByTemplateId.get(template.id);
        if (!existing) return true;
        const left = stableJson(comparableTemplateRecord(existing));
        const right = stableJson(comparableTemplateRecord(template));
        if (left !== right) {
          conflicts.templates += 1;
        }
        return false;
      }),
    ];

    const existingEvents = (await readJsonFile(runtimePaths.eventsIndexFile, { events: [] }))?.events || [];
    const existingByEventId = new Map(existingEvents.map(event => [event.id, event]));
    events = [
      ...existingEvents,
      ...bundle.events.filter((event) => {
        const existing = existingByEventId.get(event.id);
        if (!existing) return true;
        if (stableJson(comparableEventRecord(existing)) !== stableJson(comparableEventRecord(event))) {
          conflicts.events += 1;
        }
        return false;
      }),
    ];

    const existingSessions = (await readSessionsJsonl(runtimePaths.sessionsFile)).records;
    const existingBySessionId = new Map(existingSessions.map(session => [session.id, session]));
    sessions = [...existingSessions];
    for (const session of bundle.sessions) {
      const existing = existingBySessionId.get(session.id);
      if (!existing) {
        sessions.push(session);
        continue;
      }
      if (stableJson(existing) !== stableJson(session)) conflicts.sessions += 1;
    }
  }

  await writeJsonFile(stageRuntimePaths.settingsFile, sanitizeSecretFields(settings, {
    skippedSecretFields: 0,
    secretFieldNames: new Set(),
  }));

  const runtimeTemplateRecords = [];
  for (const template of sortTemplates(dedupeById(templates, 'template'))) {
    const record = buildRuntimeTemplateRecord(template);
    const destinationDir = getTemplateRuntimeDir(stageRuntimePaths, record);
    await ensureDir(destinationDir);
    const assets = template.assets || {};
    for (const relativePath of Object.values(assets)) {
      const assetName = path.basename(String(relativePath));
      const sourcePath = path.join(bundle.portablePaths.templatesDir, ...String(relativePath).split(/[\\/]+/));
      await copyFileIfExists(sourcePath, path.join(destinationDir, assetName));
    }
    if (Object.keys(assets).length === 0) {
      await copyDirIfExists(getTemplateRuntimeDir(runtimePaths, record), destinationDir);
    }
    runtimeTemplateRecords.push(record);
  }
  await writeJsonFile(stageRuntimePaths.templatesIndexFile, { templates: runtimeTemplateRecords });

  const runtimeEventRecords = [];
  for (const event of sortEvents(dedupeById(events, 'event'))) {
    const record = buildRuntimeEventRecord(event);
    const destinationDir = path.join(stageRuntimePaths.eventsDir, record.id);
    await ensureDir(destinationDir);
    const landingAsset = event.assets?.landingBackground || null;
    if (landingAsset) {
      const sourcePath = path.join(bundle.portablePaths.eventsDir, ...String(landingAsset).split(/[\\/]+/));
      await copyFileIfExists(sourcePath, path.join(destinationDir, path.basename(String(landingAsset))));
    } else if (event.landingBackground?.src) {
      await copyDirIfExists(path.join(runtimePaths.eventsDir, record.id), destinationDir);
    }
    runtimeEventRecords.push(record);
  }
  await writeJsonFile(stageRuntimePaths.eventsIndexFile, { events: runtimeEventRecords });

  const sessionRecords = sortSessions(dedupeById(sessions, 'session'));
  await fsp.writeFile(
    stageRuntimePaths.sessionsFile,
    sessionRecords.map(stableJsonLine).join('\n') + (sessionRecords.length ? '\n' : ''),
    'utf8',
  );

  return {
    stageDir,
    counts: {
      settings: Object.keys(settings || {}).length ? 1 : 0,
      templates: runtimeTemplateRecords.length,
      events: runtimeEventRecords.length,
      sessions: sessionRecords.length,
      keychainSales: sessionRecords.reduce((sum, session) => sum + (Array.isArray(session.keychainSales) ? session.keychainSales.length : 0), 0),
    },
    conflicts,
  };
}

async function createBackup(runtimePaths) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, '')
    .replace('T', '-');
  const backupDir = path.join(runtimePaths.userDataDir, 'backups', `data-import-${timestamp}`);
  await ensureDir(backupDir);
  await copyFileIfExists(runtimePaths.settingsFile, path.join(backupDir, 'settings.json'));
  await copyFileIfExists(runtimePaths.sessionsFile, path.join(backupDir, 'sessions.jsonl'));
  await copyDirIfExists(runtimePaths.templatesDir, path.join(backupDir, 'templates'));
  await copyDirIfExists(runtimePaths.eventsDir, path.join(backupDir, 'events'));
  await writeJsonFile(path.join(backupDir, 'backup-manifest.json'), {
    createdAt: new Date().toISOString(),
    sourceUserDataDir: runtimePaths.userDataDir,
    contents: ['settings.json', 'sessions.jsonl', 'templates/', 'events/'],
  });
  return backupDir;
}

async function restoreBackup(runtimePaths, backupDir) {
  await removeIfExists(runtimePaths.settingsFile);
  await removeIfExists(runtimePaths.sessionsFile);
  await removeIfExists(runtimePaths.templatesDir);
  await removeIfExists(runtimePaths.eventsDir);
  await copyFileIfExists(path.join(backupDir, 'settings.json'), runtimePaths.settingsFile);
  await copyFileIfExists(path.join(backupDir, 'sessions.jsonl'), runtimePaths.sessionsFile);
  await copyDirIfExists(path.join(backupDir, 'templates'), runtimePaths.templatesDir);
  await copyDirIfExists(path.join(backupDir, 'events'), runtimePaths.eventsDir);
}

async function commitStage(runtimePaths, stageDir) {
  const stageRuntimePaths = getRuntimePaths(stageDir);
  await removeIfExists(runtimePaths.settingsFile);
  await removeIfExists(runtimePaths.sessionsFile);
  await removeIfExists(runtimePaths.templatesDir);
  await removeIfExists(runtimePaths.eventsDir);
  await ensureDir(runtimePaths.userDataDir);
  await fsp.rename(stageRuntimePaths.settingsFile, runtimePaths.settingsFile);
  await fsp.rename(stageRuntimePaths.sessionsFile, runtimePaths.sessionsFile);
  await fsp.rename(stageRuntimePaths.templatesDir, runtimePaths.templatesDir);
  await fsp.rename(stageRuntimePaths.eventsDir, runtimePaths.eventsDir);
  await removeIfExists(stageDir);
}

async function importPortableData(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || getProjectRoot());
  const mode = options.mode === 'merge' ? 'merge' : 'replace';
  const runtimePaths = getRuntimePaths(path.resolve(options.userDataDir || resolveUserDataDir()));
  await validatePortableData(projectRoot);
  const bundle = await loadPortableBundle(projectRoot);
  await ensureDir(runtimePaths.userDataDir);
  const stage = await buildImportStage(bundle, runtimePaths, mode);
  const backupDir = await createBackup(runtimePaths);

  try {
    await commitStage(runtimePaths, stage.stageDir);
  } catch (error) {
    await restoreBackup(runtimePaths, backupDir);
    await removeIfExists(stage.stageDir);
    throw new Error(`Import failed and local data was restored from backup: ${error.message}`);
  }

  return {
    mode,
    backupDir,
    userDataDir: runtimePaths.userDataDir,
    counts: stage.counts,
    conflicts: stage.conflicts,
  };
}

async function hasLocalAppData(userDataDir) {
  const runtimePaths = getRuntimePaths(userDataDir);
  const appOwnedPaths = [
    runtimePaths.settingsFile,
    runtimePaths.sessionsFile,
    runtimePaths.templatesIndexFile,
    runtimePaths.eventsIndexFile,
  ];
  for (const item of appOwnedPaths) {
    if (await pathExists(item)) return true;
  }
  return false;
}

async function maybeInitializeFromPortableData(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || getProjectRoot());
  const userDataDir = path.resolve(options.userDataDir || resolveUserDataDir());
  const portablePaths = getPortablePaths(projectRoot);
  const logger = options.logger || console;

  if (!(await pathExists(portablePaths.manifestFile))) {
    return { ok: true, initialized: false, reason: 'portable-data manifest not found' };
  }
  if (await hasLocalAppData(userDataDir)) {
    return { ok: true, initialized: false, reason: 'local app data already exists' };
  }

  try {
    const result = await importPortableData({
      projectRoot,
      userDataDir,
      mode: 'replace',
    });
    logger.info?.('[portable-data] initialized missing local app data from portable-data', {
      userDataDir,
      counts: result.counts,
    });
    return { ok: true, initialized: true, result };
  } catch (error) {
    logger.warn?.('[portable-data] startup initialization failed', error);
    return { ok: false, initialized: false, error: error.message };
  }
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const [command = 'help', ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--mode') {
      options.mode = rest[index + 1];
      index += 1;
    } else if (arg.startsWith('--mode=')) {
      options.mode = arg.slice('--mode='.length);
    } else if (arg === '--user-data-dir') {
      options.userDataDir = rest[index + 1];
      index += 1;
    } else if (arg.startsWith('--user-data-dir=')) {
      options.userDataDir = arg.slice('--user-data-dir='.length);
    }
  }
  return { command, options };
}

function printExportReport(report) {
  console.log('Portable data export complete.');
  console.log('');
  console.log(`Settings: ${report.settings}`);
  console.log(`Templates: ${report.templates}`);
  console.log(`Template assets: ${report.templateAssets} (${(report.templateAssetBytes / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`Events: ${report.events}`);
  console.log(`Event assets: ${report.eventAssets} (${(report.eventAssetBytes / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`Sessions: ${report.sessions}`);
  console.log(`Keychain sales: ${report.keychainSales}`);
  console.log(`Skipped generated media/path fields: ${report.skippedGeneratedMediaFields}`);
  console.log(`Skipped machine-specific fields: ${report.skippedMachineFields}`);
  console.log(`Skipped secrets: ${report.skippedSecretFields}`);
  console.log(`Malformed sessions skipped: ${report.malformedSessionsSkipped}`);
  console.log(`Output: ${report.output}/`);
}

function printImportReport(result) {
  console.log('Portable data import complete.');
  console.log('');
  console.log(`Mode: ${result.mode}`);
  console.log(`Settings: ${result.counts.settings}`);
  console.log(`Templates: ${result.counts.templates}`);
  console.log(`Events: ${result.counts.events}`);
  console.log(`Sessions: ${result.counts.sessions}`);
  console.log(`Keychain sales: ${result.counts.keychainSales}`);
  if (result.mode === 'merge') {
    console.log(`Merge conflicts skipped: templates=${result.conflicts.templates}, events=${result.conflicts.events}, sessions=${result.conflicts.sessions}`);
  }
  console.log(`Backup: ${result.backupDir}`);
  console.log(`Restored userData: ${result.userDataDir}`);
}

async function runCli() {
  const { command, options } = parseCliArgs();
  if (command === 'export') {
    printExportReport(await exportPortableData(options));
    return;
  }
  if (command === 'import') {
    printImportReport(await importPortableData(options));
    return;
  }
  if (command === 'validate') {
    await validatePortableData(options.projectRoot || getProjectRoot());
    console.log('Portable data validation passed.');
    return;
  }
  console.log('Usage: node scripts/portable-data.cjs <export|import|validate> [--mode=replace|merge] [--user-data-dir <path>]');
}

module.exports = {
  SCHEMA_VERSION,
  exportPortableData,
  importPortableData,
  maybeInitializeFromPortableData,
  resolveUserDataDir,
  getRuntimePaths,
  getPortablePaths,
  validatePortableData,
};

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}
