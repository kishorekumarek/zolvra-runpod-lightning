// lib/supabase.mjs — Supabase client singleton + helpers
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

let _client = null;

export function getSupabase() {
  if (!_client) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    }
    // Custom fetch with 30s timeout + Connection:close to prevent Node 23 keep-alive hangs
    const customFetch = (url, opts = {}) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const headers = {};
      if (opts.headers) {
        if (typeof opts.headers.forEach === 'function') {
          opts.headers.forEach((v, k) => { headers[k] = v; });
        } else {
          Object.assign(headers, opts.headers);
        }
      }
      headers['Connection'] = 'close';
      return fetch(url, { ...opts, headers, signal: controller.signal })
        .finally(() => clearTimeout(timer));
    };
    _client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: { persistSession: false },
        global: { fetch: customFetch },
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
