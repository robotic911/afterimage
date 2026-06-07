import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('[Supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');
}

export const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

export const SOFTCOPY_BUCKET =
  import.meta.env.VITE_SUPABASE_STORAGE_BUCKET || 'softcopies';

export const SUPABASE_EDGE_BASE_URL =
  import.meta.env.VITE_SUPABASE_EDGE_BASE_URL || '';

export const SOFTCOPY_PAGE_BASE_URL =
  import.meta.env.VITE_SOFTCOPY_PAGE_BASE_URL || '';
