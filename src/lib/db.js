
// src/lib/db.js (CommonJS)
// Минимальный Supabase-клиент для серверного использования с ключом Service Role.
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[db] Не задан SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY');
  throw new Error('Отсутствуют переменные окружения Supabase');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  db: { schema: 'public' },
});

module.exports = { supabase };
