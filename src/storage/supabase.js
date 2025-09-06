// src/storage/supabase.js
import { createClient } from '@supabase/supabase-js';

const hasSupabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabase = hasSupabase
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

/** Дублируем события в Postgres (для SQL-аналитики) — по желанию */
export async function logEventSql(ev) {
  if (!supabase) return;
  const { error } = await supabase.from('events').insert(ev);
  if (error) console.error('[Supabase] insert error:', error);
}
