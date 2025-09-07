// src/lib/db.ts
// Minimal Supabase client for server-side usage with Service Role key.
// Be sure NOT to expose Service Role to the client/browser.
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL as string;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  // Fail fast to avoid silent misconfigurations
  // eslint-disable-next-line no-console
  console.error('[db] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  throw new Error('Missing Supabase env vars');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  db: { schema: 'public' },
});
