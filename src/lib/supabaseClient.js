import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const softcopyBucket = import.meta.env.VITE_SUPABASE_STORAGE_BUCKET || 'softcopies';
const softcopyPageBaseUrl = import.meta.env.VITE_SOFTCOPY_PAGE_BASE_URL || '';
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
  console.warn('[SUPABASE CONFIG ERROR]', {
    missing: missingSupabaseEnv,
    hasSupabaseUrl: Boolean(supabaseUrl),
    hasSupabaseAnonKey: Boolean(supabaseAnonKey),
    anonKeyPrefix: keyPrefix(supabaseAnonKey),
    message: 'QR functionality will be unavailable until the missing Vite environment variables are available when the dev server/build starts.',
  });
} else {
  console.log('[SUPABASE CONFIG]', {
    urlPresent: true,
    anonKeyPresent: true,
    anonKeyPrefix: keyPrefix(supabaseAnonKey),
    bucket: softcopyBucket,
    hasSoftcopyPageBaseUrl: Boolean(softcopyPageBaseUrl),
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
  import.meta.env.VITE_SUPABASE_EDGE_BASE_URL || '';

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
  bucket: softcopyBucket,
  hasSoftcopyPageBaseUrl: Boolean(softcopyPageBaseUrl),
  softcopyPageBaseUrl: softcopyPageBaseUrl || null,
});
