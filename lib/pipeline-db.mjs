// lib/pipeline-db.mjs — Shared DB helpers for pipeline stages
// All stages use these instead of raw Supabase queries.
// See docs/pipeline-schema-rewrite.md for schema details.
import { getSupabase } from './supabase.mjs';

// ── Read helpers ────────────────────────────────────────────

export async function getPipelineState(taskId) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('pipeline_state')
    .select('*')
    .eq('task_id', taskId)
    .maybeSingle();
  if (error) throw new Error(`getPipelineState failed: ${error.message}`);
  return data; // null if not found
}

export async function getConcept(conceptId) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('concepts')
    .select('*')
    .eq('id', conceptId)
    .single();
  if (error) throw new Error(`getConcept failed: ${error.message}`);
  return data;
}

export async function getYoutubeSeo(seoId) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('youtube_seo')
    .select('*')
    .eq('id', seoId)
    .single();
  if (error) throw new Error(`getYoutubeSeo failed: ${error.message}`);
  return data;
}

export async function getVideoOutput(outputId) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('video_output')
    .select('*')
    .eq('id', outputId)
    .single();
  if (error) throw new Error(`getVideoOutput failed: ${error.message}`);
  return data;
}

export async function getScenes(taskId) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('scenes')
    .select('*')
    .eq('task_id', taskId)
    .order('scene_number', { ascending: true });
  if (error) throw new Error(`getScenes failed: ${error.message}`);
  return data || [];
}

export async function getScene(taskId, sceneNumber) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('scenes')
    .select('*')
    .eq('task_id', taskId)
    .eq('scene_number', sceneNumber)
    .single();
  if (error) throw new Error(`getScene(${sceneNumber}) failed: ${error.message}`);
  return data;
}

export async function getEpisodeCharacters(taskId) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('episode_characters')
    .select('*')
    .eq('task_id', taskId)
    .eq('status', 'approved');
  if (error) throw new Error(`getEpisodeCharacters failed: ${error.message}`);
  return data || [];
}

export async function getEpisodeCharacter(taskId, characterName) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('episode_characters')
    .select('*')
    .eq('task_id', taskId)
    .ilike('character_name', characterName)
    .maybeSingle();
  if (error) throw new Error(`getEpisodeCharacter(${characterName}) failed: ${error.message}`);
  return data; // null if not found
}

// ── Write helpers ───────────────────────────────────────────

export async function insertConcept({ title, theme, synopsis, characters, outline, art_style, video_type }) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('concepts')
    .insert({ title, theme, synopsis, characters, outline, art_style, video_type })
    .select('id')
    .single();
  if (error) throw new Error(`insertConcept failed: ${error.message}`);
  return data.id;
}

export async function insertPipelineState(taskId, conceptId) {
  const sb = getSupabase();
  const { error } = await sb
    .from('pipeline_state')
    .insert({ task_id: taskId, concept_id: conceptId });
  if (error) throw new Error(`insertPipelineState failed: ${error.message}`);
}

export async function updatePipelineState(taskId, fields) {
  const sb = getSupabase();
  const { error } = await sb
    .from('pipeline_state')
    .update(fields)
    .eq('task_id', taskId);
  if (error) throw new Error(`updatePipelineState failed: ${error.message}`);
}

export async function insertScenes(taskId, scenesArray) {
  const sb = getSupabase();
  const rows = scenesArray.map(s => ({
    task_id: taskId,
    scene_number: s.scene_number,
    speaker: s.speaker,
    emotion: s.emotion,
    text: s.text,
    visual_description: s.visual_description,
    characters: s.characters || [],
  }));
  const { error } = await sb.from('scenes').insert(rows);
  if (error) throw new Error(`insertScenes failed: ${error.message}`);
}

export async function updateScene(taskId, sceneNumber, fields) {
  const sb = getSupabase();
  const { error } = await sb
    .from('scenes')
    .update(fields)
    .eq('task_id', taskId)
    .eq('scene_number', sceneNumber);
  if (error) throw new Error(`updateScene(${sceneNumber}) failed: ${error.message}`);
}

export async function insertYoutubeSeo({ title, description, tags }) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('youtube_seo')
    .insert({ title, description, tags })
    .select('id')
    .single();
  if (error) throw new Error(`insertYoutubeSeo failed: ${error.message}`);
  return data.id;
}

export async function insertEpisodeCharacter(taskId, { character_name, voice_id, image_prompt, reference_image_url, episode_image_url, tweaks, status }) {
  const sb = getSupabase();
  const { error } = await sb
    .from('episode_characters')
    .insert({
      task_id: taskId,
      character_name,
      voice_id: voice_id || null,
      image_prompt: image_prompt || null,
      reference_image_url: reference_image_url || null,
      episode_image_url: episode_image_url || null,
      tweaks: tweaks || null,
      status: status || 'pending',
    });
  if (error) throw new Error(`insertEpisodeCharacter(${character_name}) failed: ${error.message}`);
}

export async function updateEpisodeCharacter(taskId, characterName, fields) {
  const sb = getSupabase();
  const { error } = await sb
    .from('episode_characters')
    .update(fields)
    .eq('task_id', taskId)
    .ilike('character_name', characterName);
  if (error) throw new Error(`updateEpisodeCharacter(${characterName}) failed: ${error.message}`);
}

export async function insertVideoOutput({ local_video_path, video_url, final_duration_seconds }) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('video_output')
    .insert({
      local_video_path: local_video_path || null,
      video_url: video_url || null,
      final_duration_seconds: final_duration_seconds || null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`insertVideoOutput failed: ${error.message}`);
  return data.id;
}

export async function updateVideoOutput(outputId, fields) {
  const sb = getSupabase();
  const { error } = await sb
    .from('video_output')
    .update(fields)
    .eq('id', outputId);
  if (error) throw new Error(`updateVideoOutput failed: ${error.message}`);
}
