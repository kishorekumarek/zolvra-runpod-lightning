// lib/settings.mjs — getSetting() / setSetting() + isFeedbackCollectionMode()
import { getSupabase } from './supabase.mjs';

export async function getSetting(key) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('pipeline_settings')
    .select('value')
    .eq('key', key)
    .single();

  if (error) throw new Error(`getSetting(${key}) failed: ${error.message}`);
  return data.value;
}

export async function setSetting(key, value) {
  const sb = getSupabase();
  const { error } = await sb
    .from('pipeline_settings')
    .upsert({ key, value }, { onConflict: 'key' });

  if (error) throw new Error(`setSetting(${key}) failed: ${error.message}`);
}

export async function isFeedbackCollectionMode() {
  const [mode, target, completed] = await Promise.all([
    getSetting('feedback_collection_mode'),
    getSetting('feedback_collection_target'),
    getSetting('feedback_collection_completed'),
  ]);

  return mode === true && parseInt(completed) < parseInt(target);
}

export async function getVideoType() {
  try { return await getSetting('video_type'); } catch { return 'long'; }
}

export async function getAllSettings() {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('pipeline_settings')
    .select('key, value');

  if (error) throw new Error(`getAllSettings failed: ${error.message}`);
  return Object.fromEntries(data.map(r => [r.key, r.value]));
}
