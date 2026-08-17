import { createClient } from '@supabase/supabase-js';

const windowsSupabaseConfig = globalThis.window?.afterimageWindowsSupabaseConfig || null;
const isWindowsRuntime = globalThis.window?.printApi?.platform === 'win32'
  || windowsSupabaseConfig?.platform === 'win32';
const windowsConfigAvailable = isWindowsRuntime && windowsSupabaseConfig;

const viteSupabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const viteSupabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const viteStorageBucket = import.meta.env.VITE_SUPABASE_STORAGE_BUCKET;
const viteSoftcopyPageBaseUrl = import.meta.env.VITE_SOFTCOPY_PAGE_BASE_URL;
const viteSupabaseEdgeBaseUrl = import.meta.env.VITE_SUPABASE_EDGE_BASE_URL;

const supabaseUrl = viteSupabaseUrl || (windowsConfigAvailable ? windowsSupabaseConfig.supabaseUrl : '');
const supabaseAnonKey = viteSupabaseAnonKey || (windowsConfigAvailable ? windowsSupabaseConfig.supabaseAnonKey : '');
const softcopyBucket = viteStorageBucket || (windowsConfigAvailable ? windowsSupabaseConfig.storageBucket : '') || 'softcopies';
const softcopyPageBaseUrl = viteSoftcopyPageBaseUrl || (windowsConfigAvailable ? windowsSupabaseConfig.softcopyPageBaseUrl : '') || '';
const supabaseEdgeBaseUrl = viteSupabaseEdgeBaseUrl || (windowsConfigAvailable ? windowsSupabaseConfig.edgeBaseUrl : '') || '';
const requiredSupabaseEnv = {
  VITE_SUPABASE_URL: supabaseUrl,
  VITE_SUPABASE_ANON_KEY: supabaseAnonKey,
};
const missingSupabaseEnv = Object.entries(requiredSupabaseEnv)
  .filter(([, value]) => !value)
  .map(([name]) => name);

function keyPrefix(value) {
  const text = String(value || '');
  return text ? text.slice(0, 8) : null;
}

if (missingSupabaseEnv.length > 0) {
  if (isWindowsRuntime) {
    console.warn('[SUPABASE CONFIG ERROR]', {
      missing: missingSupabaseEnv,
      hasSupabaseUrl: Boolean(supabaseUrl),
      hasSupabaseAnonKey: Boolean(supabaseAnonKey),
      anonKeyPrefix: keyPrefix(supabaseAnonKey),
      platform: globalThis.window?.printApi?.platform || null,
      windowsFallbackAvailable: Boolean(windowsConfigAvailable),
      message: 'QR functionality will be unavailable until the missing Vite environment variables are available when the dev server/build starts.',
    });
  } else {
    console.warn('[Supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY', {
      hasSupabaseUrl: Boolean(supabaseUrl),
      hasSupabaseAnonKey: Boolean(supabaseAnonKey),
      anonKeyPrefix: keyPrefix(supabaseAnonKey),
    });
  }
} else if (isWindowsRuntime) {
  console.log('[SUPABASE CONFIG]', {
    urlPresent: true,
    anonKeyPresent: true,
    anonKeyPrefix: keyPrefix(supabaseAnonKey),
    bucket: softcopyBucket,
    hasSoftcopyPageBaseUrl: Boolean(softcopyPageBaseUrl),
    source: {
      url: viteSupabaseUrl ? 'vite-env' : 'windows-preload-fallback',
      anonKey: viteSupabaseAnonKey ? 'vite-env' : 'windows-preload-fallback',
      bucket: viteStorageBucket ? 'vite-env' : 'windows-preload-fallback',
      softcopyPageBaseUrl: viteSoftcopyPageBaseUrl ? 'vite-env' : 'windows-preload-fallback',
    },
  });
}

export const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    })
  : null;

export const SOFTCOPY_BUCKET = softcopyBucket;

export const SUPABASE_EDGE_BASE_URL =
  supabaseEdgeBaseUrl;

export const SOFTCOPY_PAGE_BASE_URL = softcopyPageBaseUrl;

export const SUPABASE_CLIENT_DIAGNOSTICS = Object.freeze({
  clientInitialized: Boolean(supabaseUrl && supabaseAnonKey),
  hasSupabaseUrl: Boolean(supabaseUrl),
  supabaseUrlHost: supabaseUrl ? (() => {
    try {
      return new URL(supabaseUrl).host;
    } catch {
      return 'invalid-url';
    }
  })() : null,
  hasSupabaseAnonKey: Boolean(supabaseAnonKey),
  anonKeyPresent: Boolean(supabaseAnonKey),
  anonKeyPrefix: keyPrefix(supabaseAnonKey),
  requiredVariables: Object.keys(requiredSupabaseEnv),
  missingVariables: missingSupabaseEnv,
  isWindowsRuntime,
  windowsFallbackAvailable: Boolean(windowsConfigAvailable),
  configSource: {
    supabaseUrl: viteSupabaseUrl ? 'vite-env' : (windowsConfigAvailable && supabaseUrl ? 'windows-preload-fallback' : 'missing'),
    supabaseAnonKey: viteSupabaseAnonKey ? 'vite-env' : (windowsConfigAvailable && supabaseAnonKey ? 'windows-preload-fallback' : 'missing'),
    storageBucket: viteStorageBucket ? 'vite-env' : (windowsConfigAvailable && windowsSupabaseConfig.storageBucket ? 'windows-preload-fallback' : 'default'),
    softcopyPageBaseUrl: viteSoftcopyPageBaseUrl ? 'vite-env' : (windowsConfigAvailable && softcopyPageBaseUrl ? 'windows-preload-fallback' : 'missing'),
    edgeBaseUrl: viteSupabaseEdgeBaseUrl ? 'vite-env' : (windowsConfigAvailable && supabaseEdgeBaseUrl ? 'windows-preload-fallback' : 'missing'),
  },
  bucket: softcopyBucket,
  hasSoftcopyPageBaseUrl: Boolean(softcopyPageBaseUrl),
  softcopyPageBaseUrl: softcopyPageBaseUrl || null,
});
