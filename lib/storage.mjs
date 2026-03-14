// lib/storage.mjs — Supabase Storage upload/download/signed URLs
import { getSupabase } from './supabase.mjs';

const BUCKETS = {
  characters: 'characters',
  scenes:     'scenes',
  videos:     'videos',
  reports:    'reports',
};

/**
 * Ensure a storage bucket exists (create if missing).
 */
async function ensureBucket(bucket) {
  const sb = getSupabase();
  const { data: existing } = await sb.storage.listBuckets();
  const found = existing?.find(b => b.name === bucket);
  if (!found) {
    const { error } = await sb.storage.createBucket(bucket, { public: false });
    if (error && !error.message.includes('already exists')) {
      throw new Error(`Failed to create bucket ${bucket}: ${error.message}`);
    }
  }
}

/**
 * Upload a Buffer or Blob to Supabase Storage.
 * Returns the storage path.
 */
export async function uploadToStorage({ bucket, path, buffer, contentType = 'application/octet-stream' }) {
  const sb = getSupabase();
  await ensureBucket(bucket);

  const { data, error } = await sb.storage
    .from(bucket)
    .upload(path, buffer, {
      contentType,
      upsert: true,
    });

  if (error) throw new Error(`Storage upload failed (${bucket}/${path}): ${error.message}`);
  return data.path;
}

/**
 * Upload a scene image (PNG) to Supabase Storage.
 */
export async function uploadSceneImage({ videoId, sceneNumber, buffer }) {
  const path = `${videoId}/scene_${String(sceneNumber).padStart(2, '0')}_image.png`;
  return uploadToStorage({ bucket: BUCKETS.scenes, path, buffer, contentType: 'image/png' });
}

/**
 * Upload a scene animation (MP4) to Supabase Storage.
 */
export async function uploadSceneAnimation({ videoId, sceneNumber, buffer }) {
  const path = `${videoId}/scene_${String(sceneNumber).padStart(2, '0')}_anim.mp4`;
  return uploadToStorage({ bucket: BUCKETS.scenes, path, buffer, contentType: 'video/mp4' });
}

/**
 * Upload the final assembled video.
 */
export async function uploadFinalVideo({ videoId, buffer }) {
  const path = `${videoId}/final.mp4`;
  return uploadToStorage({ bucket: BUCKETS.videos, path, buffer, contentType: 'video/mp4' });
}

/**
 * Upload a character reference image.
 */
export async function uploadCharacterImage({ characterId, version, buffer }) {
  const path = `${characterId}/v${version}.png`;
  return uploadToStorage({ bucket: BUCKETS.characters, path, buffer, contentType: 'image/png' });
}

/**
 * Upload a report JSON.
 */
export async function uploadReport({ filename, data }) {
  const buffer = Buffer.from(JSON.stringify(data, null, 2));
  return uploadToStorage({ bucket: BUCKETS.reports, path: filename, buffer, contentType: 'application/json' });
}

/**
 * Get a signed URL for temporary access (1 hour expiry).
 */
export async function getSignedUrl({ bucket, path, expiresInSeconds = 3600 }) {
  const sb = getSupabase();
  const { data, error } = await sb.storage
    .from(bucket)
    .createSignedUrl(path, expiresInSeconds);

  if (error) throw new Error(`getSignedUrl failed (${bucket}/${path}): ${error.message}`);
  return data.signedUrl;
}

/**
 * Get a signed URL for a scene image.
 */
export async function getSceneImageUrl(videoId, sceneNumber, expiresInSeconds = 3600) {
  const path = `${videoId}/scene_${String(sceneNumber).padStart(2, '0')}_image.png`;
  return getSignedUrl({ bucket: BUCKETS.scenes, path, expiresInSeconds });
}

/**
 * Download a file from Supabase Storage as a Buffer.
 */
export async function downloadFromStorage({ bucket, path }) {
  const sb = getSupabase();
  const { data, error } = await sb.storage.from(bucket).download(path);
  if (error) throw new Error(`Storage download failed (${bucket}/${path}): ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

export { BUCKETS };
