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
  // HARDCODED: always require Telegram approval for now
  return true;
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
