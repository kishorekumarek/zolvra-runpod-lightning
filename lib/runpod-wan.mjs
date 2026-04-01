// lib/runpod-wan.mjs — Wan 2.2 image-to-video via RunPod serverless
import 'dotenv/config';

const POLL_INTERVAL_MS = 5000; // 5s — Lightning LoRA jobs complete in ~35s, poll tightly

/**
 * Returns the active endpoint ID.
 * Prefers RUNPOD_LIGHTNING_ENDPOINT_ID (new Lightning endpoint, ~35s/clip)
 * over RUNPOD_WAN_ENDPOINT_ID (legacy endpoint, ~213s/clip).
 *
 * Set RUNPOD_LIGHTNING_ENDPOINT_ID=tb24qkrkeowh5s once the Docker image is pushed
 * and the endpoint passes testing. Keep RUNPOD_WAN_ENDPOINT_ID as fallback.
 */
function getEndpointId() {
  const lightningId = process.env.RUNPOD_LIGHTNING_ENDPOINT_ID;
  if (lightningId) {
    // Use new Lightning endpoint (Seko V1 two-stage LoRA, ~35s)
    return lightningId;
  }
  const legacyId = process.env.RUNPOD_WAN_ENDPOINT_ID;
  if (!legacyId) throw new Error('Neither RUNPOD_LIGHTNING_ENDPOINT_ID nor RUNPOD_WAN_ENDPOINT_ID is set');
  return legacyId;
}

function isLightningEndpoint() {
  return !!process.env.RUNPOD_LIGHTNING_ENDPOINT_ID;
}

function getApiKey() {
  const key = process.env.RUNPOD_API_KEY;
  if (!key) throw new Error('RUNPOD_API_KEY not set');
  return key;
}

function authHeaders() {
  return {
    'Authorization': `Bearer ${getApiKey()}`,
    'Content-Type': 'application/json',
  };
}

function resolutionForAspectRatio(aspectRatio) {
  // 9:16 vertical (Shorts), 16:9 widescreen (Long-form)
  // Uses 480P Lightning LoRA resolution buckets — must not be overridden
  if (aspectRatio === '9:16') return { width: 512, height: 992 };
  return { width: 992, height: 512 };
}

function framesToLength(durationSeconds) {
  // 81 frames ≈ 5s, 161 frames ≈ 10s
  return durationSeconds >= 8 ? 161 : 81;
}

/**
 * Submit a RunPod Wan 2.2 image-to-video job.
 * Image is sent as base64 to avoid Supabase URL auth issues.
 * @param {{ imageUrl: string, prompt: string, aspectRatio: string, duration?: number }} opts
 * @returns {Promise<string>} jobId
 */
export async function submitWanJob({ imageUrl, prompt, aspectRatio, duration = 10 }) {
  const endpointId = getEndpointId();
  const { width, height } = resolutionForAspectRatio(aspectRatio);
  const length = framesToLength(duration);

  // Download image and convert to base64
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Failed to fetch image for base64: ${imgRes.status}`);
  const imgBuf = Buffer.from(await imgRes.arrayBuffer());
  const imgBase64 = imgBuf.toString('base64'); // raw base64, no data URI prefix

  // Resolution comes exclusively from resolutionForAspectRatio() — Lightning LoRA
  // requires fixed 480P buckets (512×992 / 992×512). Image dimensions must not override.
  const endpointLabel = isLightningEndpoint() ? 'Lightning (Seko V1 ~35s)' : 'Legacy (~213s)';
  console.log(`  📐 Output resolution: ${width}×${height} (${aspectRatio} Lightning 480P bucket) — endpoint: ${endpointLabel}`);

  const body = {
    input: {
      image_base64: imgBase64,
      prompt,
      negative_prompt: 'nsfw, violence, blood, scary, dark, horror, blurry, low quality, distorted',
      width,
      height,
      length,
      steps: 4,   // Lightning LoRA — hard-coded 4-step; worker ignores but documents intent
      cfg: 1.0,   // LCM sampler requires CFG=1.0 (guidance disabled)
      seed: 42,
    },
  };

  const url = `https://api.runpod.ai/v2/${endpointId}/run`;
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RunPod submit failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.id) throw new Error(`RunPod submit: no job id in response: ${JSON.stringify(data)}`);

  console.log(`  🎬 RunPod Wan 2.2 job submitted: ${data.id}`);
  return data.id;
}

/**
 * Poll a RunPod Wan job until complete, failed, or timeout.
 * @param {string} jobId
 * @param {number} maxWaitMs
 * @returns {Promise<string>} videoUrl
 */
export async function pollWanJob(jobId, maxWaitMs = 180000) { // 3 min — Lightning jobs complete in ~35-60s
  const endpointId = getEndpointId();
  const start = Date.now();
  let attempts = 0;

  while (Date.now() - start < maxWaitMs) {
    attempts++;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const url = `https://api.runpod.ai/v2/${endpointId}/status/${jobId}`;
    const res = await fetch(url, { headers: authHeaders() });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`RunPod status check failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    console.log(`  🎬 RunPod ${jobId} (attempt ${attempts}): ${data.status}`);

    if (data.status === 'COMPLETED') {
      // Template returns base64 video directly in output.video
      const videoBase64 = data.output?.video;
      if (videoBase64) {
        return { type: 'base64', data: videoBase64 };
      }
      // Fallback: some templates return a URL
      const videoUrl = data.output?.video_url;
      if (videoUrl) {
        return { type: 'url', data: videoUrl };
      }
      throw new Error(`RunPod job completed but no video in output: ${JSON.stringify(Object.keys(data.output || {}))}`);
    }

    if (data.status === 'FAILED' || data.status === 'CANCELLED') {
      throw new Error(`RunPod job ${jobId} ${data.status}: ${data.error || 'unknown error'}`);
    }

    // IN_QUEUE, IN_PROGRESS — keep polling
  }

  throw new Error(`RunPod job ${jobId} timed out after ${maxWaitMs / 1000}s`);
}

/**
 * Download a video from URL and return as Buffer.
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
export async function downloadWanVideo(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download RunPod video: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
