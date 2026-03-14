// lib/supabase.mjs — Supabase client singleton + helpers
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

let _client = null;

export function getSupabase() {
  if (!_client) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    }
    _client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: { persistSession: false }
      }
    );
  }
  return _client;
}

export const supabase = new Proxy({}, {
  get(_, prop) {
    return getSupabase()[prop];
  }
});

export default supabase;
