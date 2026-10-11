'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || '';
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() || '';

export const supabaseConfigured = Boolean(url && publishableKey);

let browserClient: SupabaseClient | undefined;

export function getSupabase() {
  if (!supabaseConfigured) {
    throw new Error('Configura NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.');
  }
  browserClient ??= createBrowserClient(url, publishableKey);
  return browserClient;
}
