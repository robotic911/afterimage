#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js';

const DEFAULT_BUCKET = 'softcopies';
const SESSION_PREFIX = 'sessions';
const LIST_LIMIT = 1000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_PASSES = 20;
const MAX_DEPTH = 20;
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 1000;

function printUsage() {
  console.log(`
One-time Supabase Storage wipe for QR softcopies.

This deletes Storage objects only. It does not update database rows, revenue,
print history, keychains, analytics, settings, templates, or local Downloads.

Required environment:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

Optional environment:
  SOFTCOPY_BUCKET=softcopies

Usage:
  node scripts/wipe-softcopies.mjs --dry-run
  node scripts/wipe-softcopies.mjs --confirm

Options:
  --dry-run              Scan and report without deleting. This is the default.
  --confirm              Actually delete every object under softcopies/sessions/.
  --bucket <name>        Storage bucket to wipe. Defaults to SOFTCOPY_BUCKET or softcopies.
  --batch-size <count>   Delete batch size. Defaults to 100.
  --max-passes <count>   Maximum scan/delete verification passes. Defaults to 20.
  --help                 Show this help.
`);
}

function parseArgs(argv) {
  const options = {
    confirm: false,
    bucket: process.env.SOFTCOPY_BUCKET || process.env.VITE_SUPABASE_STORAGE_BUCKET || DEFAULT_BUCKET,
    batchSize: DEFAULT_BATCH_SIZE,
    maxPasses: DEFAULT_MAX_PASSES,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--dry-run') {
      options.confirm = false;
      continue;
    }

    if (arg === '--confirm') {
      options.confirm = true;
      continue;
    }

    if (arg === '--bucket') {
      options.bucket = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith('--bucket=')) {
      options.bucket = arg.slice('--bucket='.length);
      continue;
    }

    if (arg === '--batch-size') {
      options.batchSize = parsePositiveInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith('--batch-size=')) {
      options.batchSize = parsePositiveInteger(arg.slice('--batch-size='.length), '--batch-size');
      continue;
    }

    if (arg === '--max-passes') {
      options.maxPasses = parsePositiveInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith('--max-passes=')) {
      options.maxPasses = parsePositiveInteger(arg.slice('--max-passes='.length), '--max-passes');
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  options.bucket = String(options.bucket || '').trim();
  if (!options.bucket) {
    throw new Error('Storage bucket is required.');
  }

  return options;
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  return parsed;
}

function getRequiredEnv(name, fallbackName) {
  const value = process.env[name] || (fallbackName ? process.env[fallbackName] : '');
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getProjectLabel(supabaseUrl) {
  try {
    return new URL(supabaseUrl).host;
  } catch {
    return 'invalid-url';
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function describeError(error) {
  if (!error) return 'unknown error';

  const parts = [];
  if (error.status || error.statusCode) {
    parts.push(`status=${error.status || error.statusCode}`);
  }
  if (error.name) {
    parts.push(`name=${error.name}`);
  }
  if (error.message) {
    parts.push(error.message);
  } else {
    parts.push(String(error));
  }
  return parts.join(' ');
}

function joinStoragePath(folder, name) {
  const cleanFolder = String(folder || '').replace(/\/+$/, '');
  const cleanName = String(name || '').replace(/^\/+/, '');
  return cleanFolder ? `${cleanFolder}/${cleanName}` : cleanName;
}

function isFolder(item) {
  const hasId = Boolean(item?.id);
  const metadata = item?.metadata;
  const hasMetadata = metadata && Object.keys(metadata).length > 0;
  return !hasId && !hasMetadata;
}

function normalizeListedName(item) {
  const name = String(item?.name || '').trim();
  if (!name || name === '.' || name === '..') return '';
  return name.replace(/\/+$/, '');
}

async function withStorageRetries(label, operation) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const result = await operation();
      if (!result?.error) {
        return result;
      }
      lastError = result.error;
    } catch (error) {
      lastError = error;
    }

    const delayMs = RETRY_BASE_DELAY_MS * attempt;
    console.warn(`[wipe-softcopies] ${label} failed on attempt ${attempt}/${MAX_RETRIES}: ${describeError(lastError)}`);
    if (attempt < MAX_RETRIES) {
      await sleep(delayMs);
    }
  }

  throw lastError || new Error(`${label} failed`);
}

async function listFilesRecursively(storage, bucket, folder, depth = 0, state = null) {
  if (depth > MAX_DEPTH) {
    throw new Error(`Storage traversal exceeded depth limit at ${folder}`);
  }

  const result = state || {
    files: [],
    folders: new Set(),
  };

  let offset = 0;
  for (;;) {
    const { data } = await withStorageRetries(`list ${bucket}/${folder} offset ${offset}`, () => (
      storage
        .from(bucket)
        .list(folder, {
          limit: LIST_LIMIT,
          offset,
          sortBy: { column: 'name', order: 'asc' },
        })
    ));

    const items = Array.isArray(data) ? data : [];
    if (items.length === 0) break;

    for (const item of items) {
      const name = normalizeListedName(item);
      if (!name) continue;

      const path = joinStoragePath(folder, name);
      if (isFolder(item)) {
        result.folders.add(path);
        await listFilesRecursively(storage, bucket, path, depth + 1, result);
      } else {
        result.files.push(path);
      }
    }

    if (items.length < LIST_LIMIT) break;
    offset += LIST_LIMIT;
  }

  return result;
}

function splitIntoBatches(values, batchSize) {
  const batches = [];
  for (let index = 0; index < values.length; index += batchSize) {
    batches.push(values.slice(index, index + batchSize));
  }
  return batches;
}

function summarizeFiles(files) {
  const summary = {
    photos: 0,
    gifs: 0,
    videos: 0,
    metadata: 0,
    orphanFiles: 0,
    sessionFolders: new Set(),
  };

  for (const path of files) {
    const parts = path.split('/').filter(Boolean);
    if (parts[0] === SESSION_PREFIX && parts[1]) {
      summary.sessionFolders.add(parts[1]);
    }

    const fileName = parts[parts.length - 1]?.toLowerCase() || '';
    if (/\.(jpe?g|png|webp|heic)$/.test(fileName)) {
      summary.photos += 1;
    } else if (fileName.endsWith('.gif')) {
      summary.gifs += 1;
    } else if (/\.(mp4|webm|mov|m4v)$/.test(fileName)) {
      summary.videos += 1;
    } else if (fileName.endsWith('.json')) {
      summary.metadata += 1;
    } else {
      summary.orphanFiles += 1;
    }
  }

  return summary;
}

function printScanSummary(scan) {
  const summary = summarizeFiles(scan.files);

  console.log('Found:');
  console.log(`- ${summary.sessionFolders.size} session folders`);
  console.log(`- ${scan.folders.size} total folders under ${SESSION_PREFIX}/`);
  console.log(`- ${scan.files.length} files`);
  console.log(`- ${summary.photos} photos`);
  console.log(`- ${summary.gifs} GIFs`);
  console.log(`- ${summary.videos} videos`);
  console.log(`- ${summary.metadata} metadata files`);
  console.log(`- ${summary.orphanFiles} orphan or future files`);

  return summary;
}

async function removeBatch(storage, bucket, batch, batchIndex, batchCount) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const label = `Deleting batch ${batchIndex}/${batchCount}`;
    try {
      console.log(`${label}${attempt > 1 ? ` retry ${attempt}` : ''}...`);
      const { data, error } = await storage.from(bucket).remove(batch);
      if (!error) {
        return {
          ok: true,
          requested: batch.length,
          removed: Array.isArray(data) ? data.length : batch.length,
          paths: batch,
        };
      }
      lastError = error;
    } catch (error) {
      lastError = error;
    }

    console.warn(`[wipe-softcopies] ${label} failed on attempt ${attempt}/${MAX_RETRIES}: ${describeError(lastError)}`);
    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_BASE_DELAY_MS * attempt);
    }
  }

  return {
    ok: false,
    requested: batch.length,
    removed: 0,
    paths: batch,
    error: describeError(lastError),
  };
}

async function deleteFiles(storage, bucket, files, batchSize) {
  const batches = splitIntoBatches(files, batchSize);
  const failed = [];
  let deleted = 0;

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const result = await removeBatch(storage, bucket, batch, index + 1, batches.length);
    if (result.ok) {
      deleted += result.requested;
      continue;
    }

    console.error(`[wipe-softcopies] Batch ${index + 1} failed after retries: ${result.error}`);
    for (const path of result.paths) {
      console.error(`  failed: ${path}`);
      failed.push(path);
    }
  }

  return { deleted, failed };
}

async function scan(storage, bucket) {
  console.log(`Scanning bucket ${bucket}/${SESSION_PREFIX}/...`);
  const scanResult = await listFilesRecursively(storage, bucket, SESSION_PREFIX);
  scanResult.files.sort();
  return scanResult;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  const supabaseUrl = getRequiredEnv('SUPABASE_URL', 'VITE_SUPABASE_URL');
  const serviceRoleKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  console.log('[wipe-softcopies] One-time developer maintenance utility');
  console.log(`[wipe-softcopies] Project: ${getProjectLabel(supabaseUrl)}`);
  console.log(`[wipe-softcopies] Bucket: ${options.bucket}`);
  console.log(`[wipe-softcopies] Prefix: ${SESSION_PREFIX}/`);
  console.log(`[wipe-softcopies] Mode: ${options.confirm ? 'DELETE' : 'DRY RUN'}`);

  const initialScan = await scan(supabase.storage, options.bucket);
  const initialSummary = printScanSummary(initialScan);

  if (initialScan.files.length === 0) {
    console.log('Remaining: 0 files');
    console.log('Storage cleanup completed successfully. Nothing needed deletion.');
    return;
  }

  if (!options.confirm) {
    console.log('');
    console.log('DRY RUN: no files were deleted.');
    console.log('To wipe this bucket prefix, rerun with:');
    console.log('  node scripts/wipe-softcopies.mjs --confirm');
    return;
  }

  let totalDeleted = 0;
  let lastRemainingCount = initialScan.files.length;
  const allFailedPaths = new Set();

  for (let pass = 1; pass <= options.maxPasses; pass += 1) {
    console.log('');
    console.log(`Delete pass ${pass}/${options.maxPasses}`);

    const currentScan = pass === 1 ? initialScan : await scan(supabase.storage, options.bucket);
    if (currentScan.files.length === 0) {
      break;
    }

    const { deleted, failed } = await deleteFiles(
      supabase.storage,
      options.bucket,
      currentScan.files,
      options.batchSize,
    );
    totalDeleted += deleted;
    for (const path of failed) {
      allFailedPaths.add(path);
    }

    const verificationScan = await scan(supabase.storage, options.bucket);
    const remainingCount = verificationScan.files.length;
    console.log(`Remaining: ${remainingCount} files`);

    if (remainingCount === 0) {
      break;
    }

    if (remainingCount >= lastRemainingCount && failed.length > 0) {
      console.warn('[wipe-softcopies] No progress on this pass; remaining files will be retried until max-passes is reached.');
    }

    lastRemainingCount = remainingCount;
  }

  const finalScan = await scan(supabase.storage, options.bucket);
  const finalSummary = summarizeFiles(finalScan.files);

  console.log('');
  console.log('Deleted:');
  console.log(`- ${initialSummary.photos - finalSummary.photos} photos`);
  console.log(`- ${initialSummary.gifs - finalSummary.gifs} GIFs`);
  console.log(`- ${initialSummary.videos - finalSummary.videos} videos`);
  console.log(`- ${initialSummary.metadata - finalSummary.metadata} metadata files`);
  console.log(`- ${initialSummary.orphanFiles - finalSummary.orphanFiles} orphan or future files`);
  console.log(`- ${totalDeleted} total delete requests succeeded`);
  console.log(`- ${initialSummary.sessionFolders.size - finalSummary.sessionFolders.size} session folders cleared`);

  if (finalScan.files.length === 0) {
    console.log('');
    console.log('Remaining: 0 files');
    console.log('Storage cleanup completed successfully.');
    return;
  }

  console.error('');
  console.error(`Storage cleanup finished with ${finalScan.files.length} remaining files.`);
  console.error('Remaining paths:');
  for (const path of finalScan.files) {
    console.error(`  remaining: ${path}`);
  }

  if (allFailedPaths.size > 0) {
    console.error('Previously failed paths:');
    for (const path of allFailedPaths) {
      console.error(`  failed: ${path}`);
    }
  }

  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[wipe-softcopies] Fatal error: ${describeError(error)}`);
  process.exitCode = 1;
});
