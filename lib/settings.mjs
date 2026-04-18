// lib/settings.mjs — getSetting() / setSetting() + isFeedbackCollectionMode()
import { getSupabase } from './supabase.mjs';
import { DEFAULT_VIDEO_TYPE } from './video-config.mjs';

// In-memory cache: { key: { value, expiresAt } }
const _cache = {};
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getSetting(key) {
  const cached = _cache[key];
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const sb = getSupabase();
  const { data, error } = await sb
    .from('pipeline_settings')
    .select('value')
    .eq('key', key)
    .single();

  if (error) throw new Error(`getSetting(${key}) failed: ${error.message}`);
  _cache[key] = { value: data.value, expiresAt: Date.now() + CACHE_TTL_MS };
  return data.value;
}

export async function setSetting(key, value) {
  const sb = getSupabase();
  const { error } = await sb
    .from('pipeline_settings')
    .upsert({ key, value }, { onConflict: 'key' });

  if (error) throw new Error(`setSetting(${key}) failed: ${error.message}`);
  // Update cache immediately
  _cache[key] = { value, expiresAt: Date.now() + CACHE_TTL_MS };
}

export async function isFeedbackCollectionMode() {
  // Default: auto-mode (no Telegram approval gates — only progress notifications).
  // Set FEEDBACK_MODE=true (or 1/yes/on) to re-enable approval gates.
  const raw = process.env.FEEDBACK_MODE;
  if (raw === undefined) return false;
  const v = String(raw).trim().toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(v);
}

export async function getVideoType() {
  try { return await getSetting('video_type'); } catch { return DEFAULT_VIDEO_TYPE; }
}

export async function getAllSettings() {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('pipeline_settings')
    .select('key, value');

  if (error) throw new Error(`getAllSettings failed: ${error.message}`);
  return Object.fromEntries(data.map(r => [r.key, r.value]));
}
